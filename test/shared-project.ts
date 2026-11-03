// Two real editors on a real project folder, started the way agents start them, then a check that
// nothing in the folder changed. It never builds or saves, so it's safe on a project you work in:
// set FLEET_PROJECT to the .uproject, then run `node scripts/real-test.mjs shared-project`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SlotManager } from '../src/node/instance';
import { discoverEngines, readProject, resolveEngine } from '../src/node/machine';
import { changedSince } from '../src/node/projectSync';

const file = process.env.FLEET_PROJECT;
if (!file) throw new Error('Set FLEET_PROJECT to a .uproject file.');
const engines = discoverEngines();
const project = readProject(file, engines)!;
const engine = resolveEngine(project, engines)!;

const results: string[] = [];
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s]`, ...a);
const check = (name: string, ok: boolean, info?: unknown) => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  log(ok ? 'ok  ' : 'FAIL', name, ok || info === undefined ? '' : JSON.stringify(info).slice(0, 1500));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TOOLSET = 'EditorToolset.EditorAppToolset';

// Everything newer than the start, with nothing skipped except the cache meant to be shared.
function newerFiles(dir: string, since: number, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (r === 'DerivedDataCache' || e.name === '.plastic') continue;
    if (e.isDirectory()) out.push(...newerFiles(dir, since, r));
    else if (e.isFile() && fs.statSync(path.join(dir, r)).mtimeMs >= since) out.push(r);
  }
  return out;
}
function folderSize(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? folderSize(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size;
  return n;
}

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-shared-'));
const mgr = new SlotManager('test', data, os.cpus().length, 4);
try {
  log(`${project.name} at ${project.dir}, engine ${engine.version} at ${engine.root}`);
  const startedAt = Date.now();
  const a = await mgr.acquire(project, engine, 'a', 'offscreen');
  const b = await mgr.acquire(project, engine, 'b', 'offscreen');
  log(`Both tasks ready in ${Date.now() - startedAt} ms`);
  check('neither copied anything', a.dir === project.dir && b.dir === project.dir && a.shared && b.shared);

  const bootAt = Date.now();
  const booted = (await Promise.allSettled([a, b].map(async (s) => { await s.ensureEditor(); log(`  ${s.id} ready after ${Math.round((Date.now() - bootAt) / 1000)}s`); })));
  check('two editors boot on the same folder', booted.every((r) => r.status === 'fulfilled') && a.isRunning && b.isRunning, booted);

  const call = (s: typeof a, tool_name: string, args: Record<string, unknown> = {}) => s.mcp.tool('call_tool', { toolset_name: TOOLSET, tool_name, arguments: args });
  check('and both answer', [JSON.stringify(await call(a, 'IsPIERunning')), JSON.stringify(await call(b, 'IsPIERunning'))].every((r) => r.includes('false')));

  log('Play In Editor in both at once');
  const pie = { options: { bSimulate: false, playMode: 'PlayMode_InViewPort', warmupSeconds: 20 } };
  await Promise.all([call(a, 'StartPIE', pie), call(b, 'StartPIE', pie)]);
  await sleep(5000);
  const running = [JSON.stringify(await call(a, 'IsPIERunning')), JSON.stringify(await call(b, 'IsPIERunning'))];
  check('both are playing', running.every((r) => r.includes('true')), running);
  await Promise.all([call(a, 'StopPIE'), call(b, 'StopPIE')]);

  await a.stopEditor();
  await b.stopEditor();
  await sleep(3000);

  log('Own folders');
  for (const s of [a, b]) log(`  ${s.own}: ${(folderSize(s.own) / 2 ** 20).toFixed(0)} MB: ${fs.readdirSync(s.own).join(', ')}`);
  check('each editor wrote to its own folder', [a, b].every((s) => fs.existsSync(path.join(s.own, 'Saved'))));

  const scanAt = Date.now();
  const listed = await changedSince(project.dir, startedAt);
  log(`Scanning for changes took ${Math.round((Date.now() - scanAt) / 1000)}s`);
  const newer = newerFiles(project.dir, startedAt);
  // A project's own plugins can write to its folder when any editor starts, so those are only listed.
  const unreal = newer.filter((f) => /^(Saved|Intermediate|Config|Content|\.fleet)[\\/]/.test(f));
  check("the editors wrote nothing of their own to the project's folders", unreal.length === 0, unreal.slice(0, 60));
  log(`Written by something else: ${newer.filter((f) => !unreal.includes(f)).join(', ') || 'nothing'}. The Changes tab lists ${listed.length}.`);
} catch (e: any) {
  results.push(`FAIL ${e.message}`);
  log('FAIL', e.stack ?? e);
} finally {
  await mgr.shutdown();
  const failed = results.filter((r) => r.startsWith('FAIL'));
  console.log(`\n${results.join('\n')}\n\n${results.length - failed.length}/${results.length} passed`);
  setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
}
