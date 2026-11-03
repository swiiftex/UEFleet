// Finding engines: what Windows reports, folders added by hand, and which engine a project gets.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { lidActions } from '../src/host/keepAwake';
import { Hub } from '../src/hub/hub';
import { discoverEngines, discoverProjects, engineProblem, engineRootOf, parsePlasticWorkspaces, parseRegValues, pathsIn, projectFileFrom, projectFilesUnder, resolveEngine, unusableEngines } from '../src/node/machine';
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

function fakeProject(dir: string, name: string) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.uproject`);
  fs.writeFileSync(file, '{"EngineAssociation":"5.8"}');
  return file;
}

test("Plastic's workspace list is read", () => {
  const text = [
    '// Known Unity VCS workspaces',
    '// Workspace ID\tWorkspace name\tWorkspace path\t[dynamic]',
    'e03bb8ad-3717-4357-902b-71c3c43fe161\tGame\tc:\\Users\\me\\wkspaces\\Game_2',
    'aaaabbbb-3717-4357-902b-71c3c43fe161\tOther\tD:\\work spaces\\Other\tdynamic',
    '',
  ].join('\r\n');
  assert.deepEqual(parsePlasticWorkspaces(text), ['c:\\Users\\me\\wkspaces\\Game_2', 'D:\\work spaces\\Other']);
});

test('repo paths are pulled out of JSON, XML and database bytes', () => {
  assert.deepEqual(pathsIn('{"Repositories":[{"Path":"C:\\\\Users\\\\me\\\\My Repo"},{"Path":"D:/code/two"}]}'), ['C:\\Users\\me\\My Repo', 'D:/code/two']);
  assert.deepEqual(pathsIn('<string>C:\\repos\\three</string>'), ['C:\\repos\\three']);
  assert.deepEqual(pathsIn('"\x04path"\x1fC:\\Users\\me\\Documents\\GitHub\\Four"\x07missingF'), ['C:\\Users\\me\\Documents\\GitHub\\Four']);
  assert.deepEqual(pathsIn('https://github.com/me/five'), [], 'a web address is not a folder');
});

test('a project is found near the top of a folder, but not deep inside it', () => {
  const root = tmp('fleet-proj-');
  const top = fakeProject(path.join(root, 'RepoA'), 'A');
  const inside = fakeProject(path.join(root, 'RepoB', 'Game'), 'B');
  fakeProject(path.join(root, 'RepoC', 'one', 'two'), 'TooDeep');
  fakeProject(path.join(root, 'RepoD', 'Plugins'), 'InPlugins');
  fakeProject(path.join(root, 'RepoA', 'Samples'), 'BelowAProject');
  assert.deepEqual(projectFilesUnder(root).sort(), [top, inside].sort());
  assert.equal(projectFileFrom(path.join(root, 'RepoA')), top);
  assert.equal(projectFileFrom(top), top);
  assert.equal(projectFileFrom(`${path.join(root, 'RepoA')}\\"`), top);
  assert.equal(projectFileFrom(path.join(root, 'nothing')), null);
  assert.equal(projectFileFrom(root), null);
});

test('projects are found through engines, version control and the usual folders, in that order', () => {
  const home = tmp('fleet-home-');
  const roaming = path.join(home, 'roaming');
  const local = path.join(home, 'local');
  const saved = { USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  Object.assign(process.env, { USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local });
  try {
    const engineRoot = fakeEngine(home, 'SourceBuild', [5, 8, 2]);
    const ini = 'Saved/Config/WindowsEditor/EditorSettings.ini';
    const recents = (dir: string, entries: [string, string][]) => {
      fs.mkdirSync(path.dirname(path.join(dir, ini)), { recursive: true });
      fs.writeFileSync(path.join(dir, ini), `[Recent]\n${entries.map(([f, at]) => `RecentlyOpenedProjectFiles=(ProjectName="${f.replaceAll('\\', '/')}",LastOpenTime=${at})`).join('\n')}\n`);
    };
    const older = fakeProject(path.join(home, 'old'), 'OpenedLongAgo');
    const opened = fakeProject(path.join(home, 'elsewhere'), 'OpenedInSourceBuild');
    const gone = path.join(home, 'gone', 'Gone.uproject');
    recents(path.join(local, 'UnrealEngine', '5.8'), [[older, '2020.01.01-00.00.00'], [gone, '2026.01.01-00.00.00']]);
    recents(path.join(engineRoot, 'Engine'), [[opened, '2026.11.02-16.26.47']]);

    const plastic = fakeProject(path.join(home, 'D drive', 'Plastic Game'), 'InPlastic');
    fs.mkdirSync(path.join(local, 'plastic4'), { recursive: true });
    fs.writeFileSync(path.join(local, 'plastic4/plastic.workspaces'), `// Known\r\nabc\tPlastic Game\t${path.dirname(plastic)}\r\n`);

    const desktop = fakeProject(path.join(home, 'D drive', 'Desktop Game'), 'InDesktop');
    fs.mkdirSync(path.join(roaming, 'GitHub Desktop/IndexedDB/file__0.indexeddb.leveldb'), { recursive: true });
    fs.writeFileSync(path.join(roaming, 'GitHub Desktop/IndexedDB/file__0.indexeddb.leveldb/000001.log'), `"\x04path"\x1f${path.dirname(desktop)}"\x07missingF`, 'latin1');

    const sourcetree = fakeProject(path.join(home, 'D drive', 'Tree Game'), 'InSourcetree');
    fs.mkdirSync(path.join(local, 'Atlassian/SourceTree'), { recursive: true });
    fs.writeFileSync(path.join(local, 'Atlassian/SourceTree/opentabs.xml'), `<ArrayOfString><string>${path.dirname(sourcetree)}</string></ArrayOfString>`);

    const wkspace = fakeProject(path.join(home, 'wkspaces', 'Night Shift_2'), 'InWkspaces');
    const github = fakeProject(path.join(home, 'Documents', 'GitHub', 'Repo'), 'InGitHubFolder');
    const copy = fakeProject(path.join(home, 'wkspaces', 'SlotCopy'), 'AgentCopy');
    fs.mkdirSync(path.join(path.dirname(copy), '.fleet'));

    const engines = discoverEngines([engineRoot]).filter((e) => e.root === engineRoot);
    const found = discoverProjects(engines).map((p) => p.file);
    const position = (f: string) => found.indexOf(f);
    for (const f of [opened, older, plastic, desktop, sourcetree, wkspace, github]) assert.ok(found.includes(f), `${f} should be found in\n${found.join('\n')}`);
    assert.ok(!found.includes(gone), 'a recent project that no longer exists is dropped');
    assert.ok(!found.includes(copy), "an agent's copy is not a project of yours");
    assert.ok(position(opened) < position(older), 'newest first');
    assert.ok(position(older) < position(plastic), 'what was opened in Unreal comes before what is only listed');
    assert.ok(position(plastic) < position(wkspace), 'listed workspaces come before the usual folders');
    assert.equal(new Set(found).size, found.length, 'nothing is listed twice');
  } finally {
    Object.assign(process.env, saved);
  }
});

test("the lid setting is read from powercfg's output", () => {
  const laptop = [
    'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)',
    '  GUID Alias: SCHEME_BALANCED',
    '  Subgroup GUID: 4f971e89-eebd-4455-a8de-9e59040e7347  (Power buttons and lid)',
    '    Power Setting GUID: 5ca83367-6e45-459f-a27b-476b1d01c936  (Lid close action)',
    '      Possible Setting Index: 000',
    '      Possible Setting Friendly Name: Do nothing',
    '      Possible Setting Index: 001',
    '    Current AC Power Setting Index: 0x00000000',
    '    Current DC Power Setting Index: 0x00000001',
  ].join('\r\n');
  assert.deepEqual(lidActions(laptop), [0, 1]);
  // A desktop has no such setting, so there's nothing to warn about.
  assert.deepEqual(lidActions('Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (High performance)\r\n  GUID Alias: SCHEME_MIN\r\n'), []);
});

test('the host holds the machine awake, and lets go when it ends', async () => {
  const hub = new Hub({ dataDir: tmp('fleet-hub-'), version: 'test', demo: true, hostAppPath: null });
  await hub.start();
  const code = encodePairCode({ ...decodePairCode(hub.snapshot().pairing!.code), a: ['127.0.0.1'] });
  const p = spawn(process.execPath, [HOST, '--pair', code], { env: { ...process.env, FLEET_HOST_DATA: tmp('fleet-host-') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout!.on('data', (d) => { log += d; });
  p.stderr!.on('data', (d) => { log += d; });
  const helpers = () => spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${p.pid}" | Where-Object Name -eq 'powershell.exe').ProcessId`], { encoding: 'utf8' }).stdout.split(/\r?\n/).filter(Boolean);
  try {
    for (let i = 0; i < 1000 && !/Keeping this (machine|laptop)/.test(log); i++) await sleep(25);
    assert.match(log, /Keeping this (machine|laptop)/);
    assert.ok(!log.includes("Couldn't keep"), log);
    const [helper] = helpers();
    assert.ok(helper, 'a helper holds the request');
    p.kill();
    const alive = () => spawnSync('powershell', ['-NoProfile', '-Command', `[bool](Get-Process -Id ${helper} -ErrorAction SilentlyContinue)`], { encoding: 'utf8' }).stdout.trim() === 'True';
    for (let i = 0; i < 40 && alive(); i++) await sleep(250);
    assert.ok(!alive(), 'the helper ends with the host, even when the host is killed');
  } finally {
    p.kill();
    await hub.shutdown();
  }
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
