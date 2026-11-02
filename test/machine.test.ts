// Finding engines: what Windows reports, folders added by hand, and which engine a project gets.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hub } from '../src/hub/hub';
import { discoverEngines, engineProblem, engineRootOf, parseRegValues, resolveEngine, unusableEngines } from '../src/node/machine';
import { decodePairCode, encodePairCode } from '../src/shared/pair';
import type { EngineInfo, ProjectInfo } from '../src/shared/protocol';

const HOST = path.join(process.env.FLEET_ROOT!, 'dist', 'host', 'fleet-host.cjs');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

after(() => { setTimeout(() => process.exit(0), 200); });

function fakeEngine(parent: string, name: string, version: [number, number, number], exe = 'UnrealEditor.exe') {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, 'Engine/Binaries/Win64'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Engine/Build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Engine/Binaries/Win64', exe), '');
  fs.writeFileSync(path.join(root, 'Engine/Build/Build.version'), JSON.stringify({ MajorVersion: version[0], MinorVersion: version[1], PatchVersion: version[2] }));
  return root;
}

test('registry values are read even when a build was renamed with spaces', () => {
  const text = [
    'HKEY_CURRENT_USER\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds',
    '    {099324DB-4A3E-6AE3-4BC2-688FA91B39D5}    REG_SZ    F:/Unreal Engine/UE_5.8',
    '    My Custom Engine    REG_SZ    D:/UE Custom',
    '    (Default)    REG_SZ    (value not set)',
    '',
  ].join('\r\n');
  assert.deepEqual(parseRegValues(text), [
    { id: '{099324DB-4A3E-6AE3-4BC2-688FA91B39D5}', root: 'F:/Unreal Engine/UE_5.8' },
    { id: 'My Custom Engine', root: 'D:/UE Custom' },
  ]);
});

test('an unusable folder says why', () => {
  const dir = tmp('fleet-eng-');
  assert.equal(engineProblem(fakeEngine(dir, 'good', [5, 8, 2])), null);
  assert.match(engineProblem(path.join(dir, 'missing'))!, /doesn't exist/);
  fs.mkdirSync(path.join(dir, 'empty'));
  assert.match(engineProblem(path.join(dir, 'empty'))!, /no Engine folder/);
  assert.match(engineProblem(fakeEngine(dir, 'old', [4, 27, 2], 'UE4Editor.exe'))!, /UE4/);
  assert.match(engineProblem(fakeEngine(dir, 'debug', [5, 8, 2], 'UnrealEditor-Win64-DebugGame.exe'))!, /only UnrealEditor-Win64-DebugGame\.exe is built/);
  const unbuilt = path.join(dir, 'unbuilt');
  fs.mkdirSync(path.join(unbuilt, 'Engine'), { recursive: true });
  assert.match(engineProblem(unbuilt)!, /hasn't been built/);
});

test('any path inside an engine finds its top folder', () => {
  const root = fakeEngine(tmp('fleet-eng-'), 'custom', [5, 8, 2]);
  assert.equal(engineRootOf(root), root);
  assert.equal(engineRootOf(path.join(root, 'Engine/Binaries/Win64/UnrealEditor.exe')), root);
  assert.equal(engineRootOf(`${root}\\"`), root);
  const elsewhere = tmp('fleet-eng-');
  assert.equal(engineRootOf(elsewhere), elsewhere);
});

test('a folder added by hand is found, and a bad one is reported', () => {
  const dir = tmp('fleet-eng-');
  const good = fakeEngine(dir, 'custom', [5, 8, 2]);
  const bad = path.join(dir, 'gone');
  const engine = discoverEngines([good, bad]).find((e) => e.root === good);
  assert.equal(engine?.version, '5.8.2');
  assert.ok(!discoverEngines([good, bad]).some((e) => e.root === bad));
  assert.match(unusableEngines([good, bad]).find((u) => u.root === bad)?.reason ?? '', /doesn't exist/);
  assert.ok(!unusableEngines([good, bad]).some((u) => u.root === good));
});

test('a project tied to a custom build gets the custom build here', () => {
  const engine = (id: string, version: string): EngineInfo => ({ id, version, root: `D:\\${id}`, hasMcp: true, source: false });
  const project = (engineAssociation: string): ProjectInfo => ({ name: 'Game', file: 'D:\\Game\\Game.uproject', dir: 'D:\\Game', engineAssociation });
  const stock = engine('5.8', '5.8.3');
  const custom = engine('D:\\UE\\Custom', '5.8.2');
  const engines = [stock, custom, engine('5.7', '5.7.4')];
  // The GUID only means something on the machine that registered it.
  assert.equal(resolveEngine(project('{67C10D49-4EB5-855C-44EC-CB8EFFB2B8DD}'), engines, undefined, '5.8.2'), custom);
  assert.equal(resolveEngine(project('5.8'), engines), stock);
  assert.equal(resolveEngine(project('5.7'), engines), engines[2]);
  // No custom build here, so the nearest engine still runs it, rather than nothing.
  assert.equal(resolveEngine(project('{67C10D49-4EB5-855C-44EC-CB8EFFB2B8DD}'), [stock], undefined, '5.8.2'), stock);
  assert.equal(resolveEngine(project('{67C10D49-4EB5-855C-44EC-CB8EFFB2B8DD}'), [stock], undefined, '5.6.1'), null);
});

test('the host adds an engine and tells the master about it', async () => {
  const dir = tmp('fleet-eng-');
  const dataDir = tmp('fleet-host-');
  const env = { ...process.env, FLEET_HOST_DATA: dataDir };
  const custom = fakeEngine(dir, 'My Custom Build', [5, 8, 2]);
  const run = (...args: string[]) => spawnSync(process.execPath, [HOST, ...args], { env, encoding: 'utf8' });

  const rejected = run('--engine', path.join(dir, 'nothing here'));
  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout, /doesn't exist/);

  const added = run('--engine', path.join(custom, 'Engine/Binaries/Win64/UnrealEditor.exe'));
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /Added Unreal 5\.8\.2/);
  assert.match(added.stdout, /no ModelContextProtocol plugin/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).engines, [custom]);
  // Adding it again must not list it twice.
  run('--engine', custom);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).engines, [custom]);

  const hub = new Hub({ dataDir: tmp('fleet-hub-'), version: 'test', demo: true, hostAppPath: null });
  await hub.start();
  const code = encodePairCode({ ...decodePairCode(hub.snapshot().pairing!.code), a: ['127.0.0.1'] });
  const p = spawn(process.execPath, [HOST, '--pair', code], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout!.on('data', (d) => { log += d; });
  p.stderr!.on('data', (d) => { log += d; });
  try {
    let seen: EngineInfo | undefined;
    for (let i = 0; i < 1000 && !seen; i++) {
      seen = hub.machines().find((m) => m.info.role === 'remote' && m.online)?.info.engines.find((e) => e.root === custom);
      if (!seen) await sleep(25);
    }
    assert.ok(seen, `the master should see the added engine\n${log}`);
    assert.equal(seen.version, '5.8.2');
    assert.ok(log.includes(`5.8.2  ${custom}`), log);
  } finally {
    p.kill();
    await hub.shutdown();
  }

  const removed = run('--remove-engine', custom);
  assert.equal(removed.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).engines, []);
});
