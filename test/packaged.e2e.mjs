// The shipped artifacts, not the dev build: the packaged master app and the single-file host,
// linked to each other, with a scripted agent running on the host.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
// A build goes in release/next while the real app has the usual folder open.
const appFolder = fs.existsSync(path.join(root, 'release', 'next', 'UE Fleet-win32-x64')) ? path.join(root, 'release', 'next', 'UE Fleet-win32-x64') : path.join(root, 'release', 'UE Fleet-win32-x64');
const masterExe = path.join(appFolder, 'UE Fleet.exe');
const hostExe = path.join(appFolder, 'resources', 'fleet-host.exe');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const shots = path.join(root, 'test', 'screenshots');

const env = { ...process.env, FLEET_DEMO: '1', FLEET_DATA: tmp('fleet-pkg-'), FLEET_TEST_UNSEEN: '1', FLEET_TEST_NO_RELAUNCH: '1' };
for (const k of Object.keys(env)) if (k === 'ELECTRON_RUN_AS_NODE') delete env[k];
const stopLocalHost = () => { try { process.kill(Number(fs.readFileSync(path.join(env.FLEET_DATA, 'local-host.pid'), 'utf8'))); } catch { /* already gone */ } };
// Anything that never finishes should fail, not sit there looking busy.
setTimeout(() => { console.log('FAIL the test hung'); stopLocalHost(); process.exit(1); }, 10 * 60_000).unref();
let app = await electron.launch({ executablePath: masterExe, args: [], env });
let page = await app.firstWindow();
await page.waitForSelector('.topbar');
const results = [];
const check = (name, ok, info) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}`); console.log(ok ? 'ok  ' : 'FAIL', name, ok || info === undefined ? '' : JSON.stringify(info)); };
const until = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await page.waitForTimeout(100); }
  throw new Error(`Timed out waiting for ${what}`);
};

let host;
let hostLog = '';
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const snapshot = () => page.evaluate(() => window.fleet.call('snapshot'));
const processesFrom = (dir) => execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='fleet-host.exe'" | Where-Object { $_.ExecutablePath -like '${dir}*' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean).map(Number);
const hostDir = tmp('fleet-pkg-update-');
try {
  const snap = await page.evaluate(() => window.fleet.call('snapshot'));
  check('the master finds the host app it ships with', !!snap.hostAppPath && fs.existsSync(snap.hostAppPath), snap.hostAppPath);
  const decoded = JSON.parse(Buffer.from(snap.pairing.code, 'base64url').toString());
  const code = Buffer.from(JSON.stringify({ ...decoded, a: ['127.0.0.1'] })).toString('base64url');

  const clean = { ...process.env, FLEET_HOST_DATA: tmp('fleet-pkg-host-') };
  host = spawn(hostExe, ['--pair', code], { env: clean, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.on('data', (d) => { hostLog += d; });
  host.stderr.on('data', (d) => { hostLog += d; });
  const machine = await until(async () => (await page.evaluate(() => window.fleet.call('snapshot'))).machines.find((m) => m.info.role === 'remote' && m.online), 'the host to link').catch((e) => { throw new Error(`${e.message}\n${hostLog}`); });
  check('the single-file host links to the packaged master', !!machine);

  const id = await page.evaluate((nodeId) => window.fleet.call('createAgent', { prompt: 'Hello from the master', projectFile: null, nodeId, model: 'claude-opus-5-5', effort: 'low', permissionMode: 'default', instanceMode: 'headless', demo: 'testing' }), machine.info.id);
  await until(() => page.evaluate((i) => document.querySelector(`[data-card="${i}"]`)?.classList.contains('s-finished'), id), 'the remote agent to finish');
  check('an agent running on the host shows on a card', true);
  const groups = await page.evaluate(() => [...document.querySelectorAll('.group-head')].map((e) => e.innerText));
  check('the card sits under its machine', groups.length >= 1, groups);
  const strip = await page.evaluate(() => document.querySelectorAll('.mach').length);
  check('both machines are listed', strip === 2, strip);
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, '10-packaged-linked.png') });

  // A real 1.1 GB file, not a test setting, so this is the threshold that ships. Answering no never
  // moves it, and with no file data written it costs almost nothing.
  await page.evaluate((i) => window.fleet.call('approve', i), id);
  const big = path.join(tmp('fleet-pkg-big-'), 'BigSendProbe');
  fs.mkdirSync(path.join(big, 'Content'), { recursive: true });
  fs.writeFileSync(path.join(big, 'BigSendProbe.uproject'), '{"EngineAssociation":"5.8"}');
  const fd = fs.openSync(path.join(big, 'Content', 'Big.uasset'), 'w');
  fs.ftruncateSync(fd, Math.floor(1.1 * 2 ** 30));
  fs.closeSync(fd);
  const bigId = await page.evaluate(([nodeId, projectFile]) => window.fleet.call('createAgent', { prompt: 'Needs a big project', projectFile, nodeId, model: 'claude-opus-5-5', effort: 'low', permissionMode: 'default', instanceMode: 'headless', demo: 'clean' }), [machine.info.id, path.join(big, 'BigSendProbe.uproject')]);
  await until(() => page.evaluate((i) => document.querySelector('.popup')?.dataset.popup === i, bigId), 'the popup asking to send').catch(async (e) => {
    const card = await page.evaluate((i) => window.fleet.call('snapshot').then((s) => s.cards.find((c) => c.id === i)), bigId);
    throw new Error(`${e.message}: status ${card?.status}, detail ${card?.detail}, attention ${JSON.stringify(card?.attention)}, popup ${await page.evaluate(() => document.querySelector('.popup')?.innerText)}`);
  });
  const popupText = await page.evaluate(() => document.querySelector('.popup').innerText);
  check('a large send asks first, with its size', popupText.includes('1.1 GB') && popupText.includes('BigSendProbe'), popupText);
  await page.screenshot({ path: path.join(shots, '11-ask-before-sending.png') });
  await page.keyboard.press('Tab');
  await page.waitForSelector('[data-question]');
  const choices = await page.evaluate(() => [...document.querySelectorAll('[data-question] .q-option')].map((b) => b.innerText));
  check('it offers sending or not', choices[0]?.includes('Send it') && choices[1]?.includes("Don't send"), choices);
  await page.click('[data-composer]');
  await page.keyboard.press('2');
  await until(() => page.evaluate((i) => document.querySelector(`[data-card="${i}"]`)?.classList.contains('s-stopped'), bigId), 'the card to stop');
  check('answering no with a key press stops the card', true);
  const received = path.join(clean.FLEET_HOST_DATA, 'projects', 'BigSendProbe', 'Content', 'Big.uasset');
  check('and the file was never sent', !fs.existsSync(received) && !fs.existsSync(`${received}.part`));
  host.kill();

  // ---- A new version reaching a host on another machine ----
  // An extra byte makes this exe "out of date", and it still runs.
  const oldHost = path.join(hostDir, 'fleet-host.exe');
  fs.copyFileSync(hostExe, oldHost);
  fs.appendFileSync(oldHost, 'x');
  const before = sha(oldHost);
  const dataForOld = tmp('fleet-pkg-oldhost-');
  await page.evaluate(() => window.fleet.call('rotatePairing'));
  const fresh = await snapshot();
  const code2 = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(fresh.pairing.code, 'base64url').toString()), a: ['127.0.0.1'] })).toString('base64url');
  const oldProc = spawn(oldHost, ['--pair', code2], { env: { ...clean, FLEET_HOST_DATA: dataForOld }, stdio: ['ignore', 'ignore', 'ignore'] });
  const isCurrent = async () => { const m = (await snapshot()).machines.find((x) => x.info.role === 'remote' && x.online && x.info.build === sha(hostExe)); return m && !m.update ? m : null; };
  const updated = await until(isCurrent, 'the old host to update itself and come back', 90_000);
  check('an out-of-date host is sent the new one, restarts into it, and links back', !!updated);
  check('it replaced its own exe', sha(oldHost) === sha(hostExe) && sha(oldHost) !== before);
  check('with the old process gone', oldProc.exitCode !== null || !processesFrom(hostDir).includes(oldProc.pid));
  await until(() => !fs.existsSync(`${oldHost}.old`), 'the old exe to be cleaned up', 20_000);
  check('and nothing left beside it', fs.readdirSync(hostDir).join() === 'fleet-host.exe', fs.readdirSync(hostDir));

  // ---- A busy machine waits, unless told otherwise ----
  fs.appendFileSync(oldHost, 'y');
  for (const pid of processesFrom(hostDir)) process.kill(pid);
  const busyProc = spawn(oldHost, [], { env: { ...clean, FLEET_HOST_DATA: dataForOld }, stdio: ['ignore', 'ignore', 'ignore'] });
  await until(async () => (await snapshot()).machines.some((x) => x.info.role === 'remote' && x.online && x.info.selfUpdate), 'it to link', 30_000);
  const onHost = (await snapshot()).machines.find((x) => x.info.role === 'remote' && x.online).info.id;
  const busyId = await page.evaluate((nodeId) => window.fleet.call('createAgent', { prompt: 'Keep busy', projectFile: null, nodeId, model: 'claude-opus-5-5', effort: 'low', permissionMode: 'default', instanceMode: 'headless', demo: 'long' }), onHost);
  const waiting = await until(async () => { const m = (await snapshot()).machines.find((x) => x.info.id === onHost); return m?.update?.stage === 'waiting' ? m : null; }, 'the update to wait for its agent', 60_000);
  check('a host with a running agent waits instead of restarting under it', waiting.update.busy === 1, waiting.update);
  await page.evaluate((id) => window.fleet.call('restartHost', id), onHost);
  const resumed = await until(async () => {
    const m = (await snapshot()).machines.find((x) => x.info.id === onHost);
    const t = await page.evaluate((id) => window.fleet.call('transcript', id), busyId);
    return m?.online && m.info.build === sha(hostExe) && t.some((x) => x.kind === 'user' && x.text.includes('restarted to update')) ? t : null;
  }, 'the agent to carry on after a forced restart', 90_000);
  check('told to restart now, its agent carries on afterwards', !!resumed);
  void busyProc;
  await page.evaluate((id) => window.fleet.call('stopAgent', id), busyId);
  for (const pid of processesFrom(hostDir)) process.kill(pid);

  // ---- A new version reaching the app itself ----
  const localPid = Number(fs.readFileSync(path.join(env.FLEET_DATA, 'local-host.pid'), 'utf8'));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  check("this PC's agents run in a host of their own", alive(localPid) && localPid !== (await app.evaluate(() => process.pid)));
  const longId = await page.evaluate(() => window.fleet.call('createAgent', { prompt: 'Keep going through a restart', projectFile: null, nodeId: 'master', model: 'claude-opus-5-5', effort: 'low', permissionMode: 'default', instanceMode: 'headless', demo: 'long' }));
  await until(() => page.evaluate((i) => document.querySelector(`[data-card="${i}"] .progress-text`)?.innerText.endsWith('%'), longId), 'it to get going');
  const repoDist = path.join(root, 'dist');
  const publish = (id, change) => {
    const dir = path.join(env.FLEET_DATA, 'app', id);
    fs.mkdirSync(path.join(dir, 'renderer'), { recursive: true });
    for (const f of ['main.cjs', 'preload.cjs']) fs.copyFileSync(path.join(repoDist, f), path.join(dir, f));
    for (const f of fs.readdirSync(path.join(repoDist, 'renderer'))) fs.copyFileSync(path.join(repoDist, 'renderer', f), path.join(dir, 'renderer', f));
    const version = JSON.parse(fs.readFileSync(path.join(repoDist, 'version.json'), 'utf8'));
    change(version, dir);
    version.id = id;
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify(version));
    fs.writeFileSync(path.join(env.FLEET_DATA, 'app', 'current.json'), JSON.stringify({ id }));
  };
  publish('new-screens', (v, dir) => {
    v.renderer = 'changed';
    const html = path.join(dir, 'renderer', 'index.html');
    fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('</head>', '<meta name="fleet-test" content="new-screens"></head>'));
  });
  await until(() => page.evaluate(() => document.querySelector('meta[name="fleet-test"]')?.content === 'new-screens').catch(() => false), 'the new screens to load by themselves', 20_000);
  await page.waitForSelector('.topbar');
  check('new screens load by themselves, with no restart', true);
  check('and the agent is still running', await until(() => page.evaluate((i) => window.fleet.call('snapshot').then((s) => s.cards.find((c) => c.id === i).status !== 'stopped'), longId), 'the card'));

  const said = async () => (await page.evaluate((i) => window.fleet.call('transcript', i), longId)).filter((x) => x.kind === 'assistant').length;
  publish('new-logic', (v) => { v.main = 'changed'; v.renderer = 'changed'; });
  await page.waitForSelector('[data-app-update]', { timeout: 20_000 });
  check('new logic asks for a restart', (await page.evaluate(() => document.querySelector('[data-app-update]').innerText)).includes('restart'));
  // The process ending, not Playwright's close, which never fires while the host outlives the app.
  const closed = new Promise((r) => app.process().once('exit', r));
  await page.click('[data-app-update]');
  await closed;
  check('restarting leaves its host running', alive(localPid));
  app = await electron.launch({ executablePath: masterExe, args: [], env });
  page = await app.firstWindow();
  await page.waitForSelector('.topbar');
  check('and the app starts from the new version', await page.evaluate(() => !document.querySelector('[data-app-update]')));
  const version = await app.evaluate(({ app: a }) => a.getPath('exe'));
  check('from the same exe', !!version);
  const before2 = await until(said, 'the agent to show up again', 30_000);
  await until(async () => (await said()) > before2, 'the agent to keep talking after the restart', 30_000);
  check('the agent never stopped, and the chat caught up', true);
  check('it is the same host', Number(fs.readFileSync(path.join(env.FLEET_DATA, 'local-host.pid'), 'utf8')) === localPid && alive(localPid));
  await page.evaluate((i) => window.fleet.call('stopAgent', i), longId);
} catch (e) {
  results.push(`FAIL ${e.message}`);
  console.log('FAIL', e.message);
} finally {
  host?.kill();
  for (const pid of processesFrom(hostDir)) { try { process.kill(pid); } catch { /* already gone */ } }
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))]);
  stopLocalHost();
}
const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
assert.ok(results.length);
process.exit(failed.length ? 1 : 0);
