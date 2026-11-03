import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub/hub';
import { appendPrompt } from '../src/node/fleetTools';
import { SlotManager } from '../src/node/instance';
import { readProject } from '../src/node/machine';
import { changedSince, freeLoadedModules, listChanges } from '../src/node/projectSync';
import type { EngineInfo } from '../src/shared/protocol';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-share-'));
  const src = path.join(root, 'Game');
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), text);
  };
  write('Game.uproject', '{"EngineAssociation":"5.8"}');
  write('Source/Game/A.cpp', 'one\n');
  write('Content/Hero.uasset', 'HERO');
  write('Saved/SaveGames/Slot1.sav', 'progress');
  const project = readProject(path.join(src, 'Game.uproject'), [])!;
  const mgr = new SlotManager('test', path.join(root, 'data'), 24, 4);
  return { root, src, write, project, mgr };
}

// Enough of an engine to run ue_build and start an "editor" without any of Unreal.
function fakeEngine(root: string, seconds = 2): EngineInfo {
  const dir = path.join(root, 'engine');
  fs.mkdirSync(path.join(dir, 'Engine/Build/BatchFiles'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Engine/Binaries/Win64'), { recursive: true });
  const log = path.join(root, 'builds.log');
  fs.writeFileSync(path.join(dir, 'Engine/Build/BatchFiles/Build.bat'), `@echo off\r\necho start>>"${log}"\r\nping -n ${seconds + 1} 127.0.0.1 >nul\r\necho end>>"${log}"\r\necho %*>>"${log}.args"\r\n`);
  fs.copyFileSync('C:\\Windows\\System32\\whoami.exe', path.join(dir, 'Engine/Binaries/Win64/UnrealEditor.exe'));
  return { id: '5.8', version: '5.8.0', root: dir, hasMcp: false, source: false };
}

test('agents work in the project folder itself, each with a place of its own', async () => {
  const { src, project, mgr } = setup();
  const before = fs.readdirSync(src).sort();
  const a = await mgr.acquire(project, null, 'a', 'headless');
  const b = await mgr.acquire(project, null, 'b', 'headless');
  assert.equal(a.dir, src);
  assert.equal(b.dir, src);
  assert.ok(a.shared && b.shared);
  assert.notEqual(a.own, b.own);
  assert.notEqual(a.port, b.port);
  assert.equal(a.projectFile, project.file);
  assert.deepEqual(fs.readdirSync(src).sort(), before, 'nothing is added to the project');
  assert.equal(a.state, 'cold', 'no copying, so it is ready straight away');
  assert.ok(a.editorArgs('headless').includes(`-UserDir="${a.own}"`));
  assert.ok(a.logFile.startsWith(a.own));
  assert.equal(fs.readFileSync(path.join(a.own, 'Saved/SaveGames/Slot1.sav'), 'utf8'), 'progress', 'each starts from the real saves');
  assert.equal(a.info().shared, true);
  assert.equal(a.info().own, a.own);
});

test("an agent's editor starts from the project's asset cache, without touching it", async () => {
  const { src, write, project, mgr } = setup();
  const cache = 'Intermediate/CachedAssetRegistry';
  write(`${cache}/CachedAssetRegistry_0.ref`, 'CachedAssetRegistry_0_NEW.bin');
  write(`${cache}/CachedAssetRegistry_0_NEW.bin`, 'the cache');
  write(`${cache}/CachedAssetRegistry_0_OLD.bin`, 'left behind');
  write('Intermediate/CachedAssetRegistryDiscovery.bin', 'discovery');
  const a = await mgr.acquire(project, null, 'a', 'headless');
  const own = path.join(a.own, cache);
  assert.equal(fs.readFileSync(path.join(own, 'CachedAssetRegistry_0.ref'), 'utf8'), 'CachedAssetRegistry_0_NEW.bin');
  assert.equal(fs.statSync(path.join(own, 'CachedAssetRegistry_0_NEW.bin')).nlink, 2, 'linked, so it costs no disk');
  assert.ok(!fs.existsSync(path.join(own, 'CachedAssetRegistry_0_OLD.bin')), 'only what the pointer names');
  assert.equal(fs.statSync(path.join(a.own, 'Intermediate/CachedAssetRegistryDiscovery.bin')).nlink, 1);

  // The same steps Unreal takes when it writes a newer cache: a new file, the pointer moved, the old one gone.
  fs.writeFileSync(path.join(own, 'CachedAssetRegistry_0_MINE.bin'), 'newer');
  fs.writeFileSync(path.join(own, 'CachedAssetRegistry_0.ref.tmp'), 'CachedAssetRegistry_0_MINE.bin');
  fs.renameSync(path.join(own, 'CachedAssetRegistry_0.ref.tmp'), path.join(own, 'CachedAssetRegistry_0.ref'));
  fs.rmSync(path.join(own, 'CachedAssetRegistry_0_NEW.bin'));
  assert.equal(fs.readFileSync(path.join(src, cache, 'CachedAssetRegistry_0_NEW.bin'), 'utf8'), 'the cache');
  assert.equal(fs.readFileSync(path.join(src, cache, 'CachedAssetRegistry_0.ref'), 'utf8'), 'CachedAssetRegistry_0_NEW.bin');

  // Its own cache is kept when the folder is used again.
  await mgr.release('a');
  const b = await mgr.acquire(project, null, 'b', 'headless');
  assert.equal(b.own, a.own);
  assert.equal(fs.readFileSync(path.join(own, 'CachedAssetRegistry_0.ref'), 'utf8'), 'CachedAssetRegistry_0_MINE.bin');
});

test('a project sent from the master still gets a copy per agent', async () => {
  const { src, project, mgr } = setup();
  const a = await mgr.acquire({ ...project, received: true }, null, 'a', 'headless');
  assert.ok(!a.shared);
  assert.notEqual(a.dir, src);
  assert.ok(fs.existsSync(a.projectFile));
  assert.ok(!a.editorArgs('headless').some((x) => x.startsWith('-UserDir')));
  fs.writeFileSync(path.join(a.dir, 'Source/Game/A.cpp'), 'changed\n');
  assert.equal(fs.readFileSync(path.join(src, 'Source/Game/A.cpp'), 'utf8'), 'one\n', 'its changes stay in the copy');
  assert.deepEqual((await listChanges(a.dir)).map((c) => c.path.replaceAll('\\', '/')), ['Source/Game/A.cpp']);
});

test('after a restart each kind picks up where it was', async () => {
  const { src, project, mgr } = setup();
  const shared = await mgr.acquire(project, null, 'a', 'headless');
  const copy = await mgr.acquire({ ...project, received: true }, null, 'b', 'headless');
  const later = new SlotManager('test', path.join(path.dirname(src), 'data'), 24, 4);
  const again = later.adopt(project, null, 'a', shared.own, 'headless');
  assert.ok(again.shared);
  assert.equal(again.dir, src);
  assert.equal(again.own, shared.own);
  const copyAgain = later.adopt({ ...project, received: true }, null, 'b', copy.own, 'headless');
  assert.ok(!copyAgain.shared);
  assert.equal(copyAgain.dir, copy.dir);
});

test('what changed in a shared folder is whatever is newer than the task', async () => {
  const { src, write, project, mgr } = setup();
  const old = new Date(Date.now() - 60_000);
  for (const f of ['Source/Game/A.cpp', 'Content/Hero.uasset']) fs.utimesSync(path.join(src, f), old, old);
  const a = await mgr.acquire(project, null, 'a', 'headless');
  assert.deepEqual(await changedSince(a.dir, a.startedAt()), []);
  await sleep(50);
  write('Source/Game/A.cpp', 'two\n');
  write('Source/Game/New.cpp', 'new\n');
  write('Saved/Logs/x.log', 'not a change');
  write('Binaries/Win64/Game.dll', 'not a change');
  const changes = await changedSince(a.dir, a.startedAt());
  assert.deepEqual(changes.map((c) => c.path.replaceAll('\\', '/')).sort(), ['Source/Game/A.cpp', 'Source/Game/New.cpp']);
  assert.equal(changes.find((c) => c.path.endsWith('New.cpp'))!.kind, 'added');
  assert.equal(changes.find((c) => c.path.endsWith('A.cpp'))!.kind, 'modified');
});

test('builds of a shared folder take turns, and nothing starts until they finish', async () => {
  const { root, project, mgr } = setup();
  const engine = fakeEngine(root);
  const a = await mgr.acquire(project, engine, 'a', 'headless');
  const b = await mgr.acquire(project, engine, 'b', 'headless');
  const c = await mgr.acquire(project, engine, 'c', 'headless');
  const builds = Promise.all([a.build({}), b.build({})]);
  await sleep(300);
  assert.equal(b.state, 'queued');
  assert.match(b.detail ?? '', /another agent's build/);
  const boot = c.ensureEditor();
  await sleep(300);
  assert.equal(c.pid, undefined, 'no editor loads modules during a build');
  assert.equal(c.state, 'queued');
  const results = await builds;
  assert.ok(results.every((r) => r.ok));
  await boot;
  assert.deepEqual(fs.readFileSync(path.join(root, 'builds.log'), 'utf8').trim().split(/\r?\n/), ['start', 'end', 'start', 'end']);
  assert.match(fs.readFileSync(path.join(root, 'builds.log.args'), 'utf8'), /-WaitMutex/, 'and waits for one started outside the app');
  await mgr.shutdown();
});

test('copies of a project still build at the same time', async () => {
  const { root, project, mgr } = setup();
  const engine = fakeEngine(root);
  const sent = { ...project, received: true };
  const a = await mgr.acquire(sent, engine, 'a', 'headless');
  const b = await mgr.acquire(sent, engine, 'b', 'headless');
  await Promise.all([a.build({}), b.build({})]);
  assert.deepEqual(fs.readFileSync(path.join(root, 'builds.log'), 'utf8').trim().split(/\r?\n/).slice(0, 2), ['start', 'start']);
  assert.match(fs.readFileSync(path.join(root, 'builds.log.args'), 'utf8'), /-NoMutex/);
});

test('a module loaded by a running process can be replaced, and that process carries on', async () => {
  const { src } = setup();
  const folder = path.join(src, 'Plugins/Group/P/Binaries/Win64');
  fs.mkdirSync(folder, { recursive: true });
  const loaded = path.join(folder, 'UnrealEditor-P.exe');
  fs.copyFileSync('C:\\Windows\\System32\\cmd.exe', loaded);
  const idle = path.join(folder, 'UnrealEditor-Q.dll');
  fs.writeFileSync(idle, 'not loaded');
  const stamp = new Date(Date.now() - 3_600_000);
  fs.utimesSync(loaded, stamp, stamp);
  const inoIdle = fs.statSync(idle, { bigint: true }).ino;
  const mtime = fs.statSync(loaded).mtimeMs;

  const proc = spawn(loaded, [], { stdio: 'pipe', windowsHide: true });
  await new Promise((r) => proc.once('spawn', r));
  await sleep(200);
  try {
    assert.throws(() => fs.writeFileSync(loaded, 'overwrite'), /EBUSY|EPERM|EACCES/, 'Windows really does lock it');
    await freeLoadedModules(src);
    assert.equal(fs.statSync(loaded).mtimeMs, mtime, 'a build must not see it as out of date');
    assert.deepEqual(fs.readFileSync(loaded).subarray(0, 2).toString(), 'MZ', 'the copy is the real file');
    fs.writeFileSync(loaded, 'linked by a new build');
    assert.equal(proc.exitCode, null, 'the running process is untouched');
    assert.equal(fs.statSync(idle, { bigint: true }).ino, inoIdle, 'a file nothing has loaded is left alone');
    const left = fs.readdirSync(folder).filter((f) => f.includes('.fleet-old-'));
    assert.equal(left.length, 1);
    await freeLoadedModules(src);
    assert.ok(fs.existsSync(path.join(folder, left[0])), 'still in use, so it stays');
  } finally {
    proc.kill();
    await new Promise((r) => proc.once('exit', r));
  }
  await sleep(200);
  await freeLoadedModules(src);
  assert.deepEqual(fs.readdirSync(folder).filter((f) => f.includes('.fleet-')), [], 'gone once nothing has it loaded');
});

test('releasing checks the owner, and only free copies of unsent projects get removed', async () => {
  const { root, project, mgr } = setup();
  const copies = path.join(root, 'data', 's');
  const copy = (name: string, n: string, owner?: string) => {
    const dir = path.join(copies, name, n);
    fs.mkdirSync(path.join(dir, '.fleet'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
    if (owner) fs.writeFileSync(path.join(dir, '.fleet', 'owner'), owner);
    return dir;
  };
  const free = copy('Game', '01');
  const owned = copy('Game', '02', 'someone');
  const restored = copy('Game', '03', 'restored');
  const sent = copy('Sent', '01');

  await mgr.release('not-them', owned);
  assert.ok(fs.existsSync(path.join(owned, '.fleet', 'owner')), "another card can't free it");
  await mgr.release('restored', restored);
  assert.ok(!fs.existsSync(path.join(restored, '.fleet', 'owner')), 'a card with no live slot still frees its folder');

  await mgr.removeUnusedCopies([project, { ...project, name: 'Sent', received: true }]);
  assert.ok(!fs.existsSync(free));
  assert.ok(!fs.existsSync(restored));
  assert.ok(fs.existsSync(owned), 'unapplied work may be in there');
  assert.ok(fs.existsSync(sent), 'still used for projects sent here');
  assert.ok(fs.existsSync(project.file));
  assert.equal(fs.readFileSync(path.join(project.dir, 'Content/Hero.uasset'), 'utf8'), 'HERO');
});

test('an agent in a shared folder is told what that means, and one in a copy is not', async () => {
  const { project, mgr } = setup();
  const shared = await mgr.acquire(project, null, 'a', 'headless');
  const text = appendPrompt(shared);
  assert.ok(text.includes(project.dir));
  assert.match(text, /Never run anything that reverts/);
  assert.match(text, /last save wins/);
  assert.match(text, /Live Coding is active/);
  assert.doesNotMatch(text, /private copy|git repository over this copy/);
  const copy = appendPrompt(await mgr.acquire({ ...project, received: true }, null, 'b', 'headless'));
  assert.match(copy, /private copy/);
  assert.doesNotMatch(copy, /Never run anything that reverts/);
  assert.equal(shared.sharing().sharedFolder, true);
});

test('agents can see who else is in the folder', async () => {
  const { project, mgr } = setup();
  const a = await mgr.acquire(project, null, 'a', 'headless');
  const b = await mgr.acquire(project, null, 'b', 'headless');
  b.task = 'Fix the sprinkler';
  await mgr.acquire({ ...project, received: true }, null, 'in-a-copy', 'headless');
  assert.deepEqual(a.sharing().otherAgentsHere, [{ task: 'Fix the sprinkler', editor: 'cold' }]);
});

test('bringing work back from a shared folder on another machine leaves a file that also changed here', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-share-hub-'));
  const hub = new Hub({ dataDir: path.join(root, 'data'), version: 'test', demo: true, hostAppPath: null });
  const dest = path.join(root, 'Game');
  fs.mkdirSync(dest, { recursive: true });
  const untouched = path.join(dest, 'Untouched.cpp');
  const changedHere = path.join(dest, 'ChangedHere.cpp');
  fs.writeFileSync(untouched, 'old');
  fs.writeFileSync(changedHere, 'edited on this machine');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(untouched, old, old);
  const id = 'remote-card';
  const rec = { card: { id, nodeId: 'laptop', project: 'Game', createdAt: Date.now() - 30_000, slot: { shared: true } }, spawn: {}, sourceProjectDir: dest };
  (hub as any).agents.set(id, rec);
  const content: Record<string, string> = { 'Untouched.cpp': 'from the laptop', 'ChangedHere.cpp': 'from the laptop' };
  (hub as any).nodeCall = async (_node: string, method: string, p: any) => {
    if (method === 'agent.changes') return Object.keys(content).map((f) => ({ path: f, kind: 'modified', binary: false }));
    if (method === 'agent.readFile') return { data: Buffer.from(content[p.path]).toString('base64'), last: true, mtime: Date.now() };
    if (method === 'agent.baseText') return null;
    throw new Error(`Unexpected ${method}`);
  };
  try {
    const first = await hub.apply(id);
    assert.deepEqual(first.applied, ['Untouched.cpp']);
    assert.deepEqual(first.conflicts.map((c) => c.path), ['ChangedHere.cpp']);
    assert.equal(fs.readFileSync(changedHere, 'utf8'), 'edited on this machine');
    assert.equal(fs.readFileSync(untouched, 'utf8'), 'from the laptop');

    content['Untouched.cpp'] = 'from the laptop again';
    const second = await hub.apply(id);
    assert.deepEqual(second.applied, ['Untouched.cpp'], "applying it earlier doesn't count as changing it here");
    assert.equal(fs.readFileSync(untouched, 'utf8'), 'from the laptop again');

    const forced = await hub.apply(id, ['ChangedHere.cpp'], ['ChangedHere.cpp']);
    assert.deepEqual(forced.applied, ['ChangedHere.cpp']);
    assert.equal(fs.readFileSync(changedHere, 'utf8'), 'from the laptop');
  } finally {
    await hub.shutdown();
  }
});
