// The shipped artifacts, not the dev build: the packaged master app and the single-file host,
// linked to each other, with a scripted agent running on the host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const masterExe = path.join(root, 'release', 'UE Fleet-win32-x64', 'UE Fleet.exe');
const hostExe = path.join(root, 'release', 'UE Fleet-win32-x64', 'resources', 'fleet-host.exe');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const shots = path.join(root, 'test', 'screenshots');

const env = { ...process.env, FLEET_DEMO: '1', FLEET_DATA: tmp('fleet-pkg-') };
for (const k of Object.keys(env)) if (k === 'ELECTRON_RUN_AS_NODE') delete env[k];
const app = await electron.launch({ executablePath: masterExe, args: [], env });
const page = await app.firstWindow();
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
  await page.evaluate((i) => window.fleet.call('dismissAttention', i), id);
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
} catch (e) {
  results.push(`FAIL ${e.message}`);
  console.log('FAIL', e.message);
} finally {
  host?.kill();
  await app.close();
}
const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
assert.ok(results.length);
process.exit(failed.length ? 1 : 0);
