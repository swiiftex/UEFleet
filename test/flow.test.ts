// A task's whole way through: the master chat, placement, the stages, testing, merging and the
// Plastic changelist, with scripted agents and a stand-in for Plastic's cm.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hub } from '../src/hub/hub';
import { placeTask } from '../src/hub/placement';
import { Slot, SlotManager, personEditors } from '../src/node/instance';
import { readProject } from '../src/node/machine';
import { assignToChangelist, parseStatus, type CmRun } from '../src/node/plastic';
import { MASTER_CHAT_ID, type AgentCard, type EngineInfo, type MachineView, type NewTask } from '../src/shared/protocol';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const hubs: Hub[] = [];
after(async () => { for (const h of hubs) await h.shutdown(); setTimeout(() => process.exit(0), 200); });

function makeHub(cm?: CmRun) {
  const hub = new Hub({ dataDir: tmp('fleet-flow-'), version: 'test', demo: true, hostAppPath: null, cm });
  hubs.push(hub);
  return hub;
}
const task = (demo: string, extra: Partial<NewTask> = {}): NewTask => ({ prompt: `Do ${demo}`, projectFile: null, nodeId: 'master', model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'default', instanceMode: 'headless', demo, ...extra });
async function until<T>(fn: () => T | undefined | false, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  assert.fail(`Timed out waiting for ${what}`);
}
const cardOf = (hub: Hub, id: string): AgentCard => hub.snapshot().cards.find((c) => c.id === id)!;
const tasks = (hub: Hub) => hub.snapshot().cards.filter((c) => !c.isMaster);

// ---- Placement ----

const machine = (id: string, role: 'master' | 'remote', cpu: number | null, freeRam = 40, projects: string[] = ['Game']): MachineView => ({
  info: { id, name: id.toUpperCase(), role, platform: 'win32', cpuModel: '', threads: 32, ramGb: 64, vramGb: 16, maxInstances: 4, engines: [{ id: '5.8', version: '5.8.0', root: 'C:/UE', hasMcp: true, source: false }], projects: projects.map((name) => ({ name, file: `C:/${name}/${name}.uproject`, dir: `C:/${name}`, engineVersion: '5.8.0' })), claudePath: 'claude', version: '1' },
  online: true,
  stats: cpu === null ? null : { cpu, ramUsedGb: 64 - freeRam, at: 0 },
  slots: [],
  lastSeen: 0,
});
const game = { name: 'Game', file: 'C:/Game/Game.uproject', dir: 'C:/Game', engineVersion: '5.8.0', engineAssociation: '5.8' };
const none = () => 0;

test('work goes to another PC when one is free, even if the master is too', () => {
  const placed = placeTask([machine('master', 'master', 5), machine('laptop', 'remote', 20)], none, game);
  assert.equal(placed.nodeId, 'laptop');
  assert.match(placed.reason, /LAPTOP is free/);
});

test('it stays on the master when the others are too busy, and says why', () => {
  const placed = placeTask([machine('master', 'master', 30), machine('laptop', 'remote', 85)], none, game);
  assert.equal(placed.nodeId, 'master');
  assert.match(placed.reason, /LAPTOP: CPU 85%/);
  assert.equal(placeTask([machine('master', 'master', 30), machine('laptop', 'remote', 20, 4)], none, game).nodeId, 'master', 'too little memory counts as busy');
  assert.equal(placeTask([machine('master', 'master', 30), machine('laptop', 'remote', null)], none, game).nodeId, 'master', 'no readings yet counts as busy');
});

test('the least loaded free PC wins, and tasks just placed count before CPU shows them', () => {
  const list = [machine('master', 'master', 10), machine('a', 'remote', 40), machine('b', 'remote', 15)];
  assert.equal(placeTask(list, none, game).nodeId, 'b');
  assert.equal(placeTask(list, (id) => (id === 'b' ? 3 : 0), game).nodeId, 'a');
  assert.equal(placeTask(list, (id) => (id === 'master' ? 0 : 4), game).nodeId, 'master', 'a full PC is not free');
});

test("a PC without the project isn't chosen unless the master is out of room", () => {
  const list = (cpu: number) => [machine('master', 'master', cpu), machine('laptop', 'remote', 5, 40, [])];
  assert.equal(placeTask(list(30), none, game).nodeId, 'master');
  assert.equal(placeTask(list(95), none, game).nodeId, 'laptop');
});

test('a machine that cannot run it is never picked', () => {
  const noEngine = machine('laptop', 'remote', 5);
  noEngine.info.engines = [];
  assert.equal(placeTask([machine('master', 'master', 30), noEngine], none, game).nodeId, 'master');
  const signedOut = machine('laptop', 'remote', 5);
  signedOut.info.claudePath = null;
  assert.equal(placeTask([machine('master', 'master', 30), signedOut], none, game).nodeId, 'master');
  const offline = machine('laptop', 'remote', 5);
  offline.online = false;
  assert.equal(placeTask([machine('master', 'master', 30), offline], none, game).nodeId, 'master');
});

// ---- The master chat ----

test('a new request goes through the master chat, which starts the agent', async () => {
  const hub = makeHub();
  const started: string[] = [];
  hub.on('hub', (e) => { if (e.e === 'task-started') started.push(e.id); });
  assert.equal(await hub.request(task('clean', { prompt: 'Fix the lantern' })), MASTER_CHAT_ID);
  const id = await until(() => started[0], 'the agent to start');
  assert.equal(cardOf(hub, id).lastPrompt, 'Fix the lantern');
  assert.ok(hub.transcript(MASTER_CHAT_ID).some((t) => t.kind === 'user' && t.text.startsWith('Fix the lantern')));
  assert.equal(cardOf(hub, MASTER_CHAT_ID).isMaster, true);
  assert.equal(cardOf(hub, id).isMaster, undefined);
});

test('the master chat survives a restart with its conversation, and raises no popup for a reply', async () => {
  const dataDir = tmp('fleet-flow-');
  const a = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  const popups: AgentCard[] = [];
  a.on('attention', (c) => popups.push(c));
  await a.request(task('clean', { prompt: 'Remember this' }));
  await until(() => tasks(a).length === 1, 'the agent');
  assert.ok(!popups.some((c) => c.isMaster));
  await a.shutdown();
  const b = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  hubs.push(b);
  assert.ok(b.transcript(MASTER_CHAT_ID).some((t) => t.kind === 'user' && t.text.startsWith('Remember this')));
  assert.equal(b.snapshot().cards.filter((c) => c.isMaster).length, 1);
});

test('an agent asks the master, and carries on with the answer', async () => {
  const hub = makeHub();
  const id = await hub.createAgent(task('ask'));
  await until(() => hub.transcript(id).some((t) => t.kind === 'assistant' && t.text.includes('Scripted answer')), 'the answer to reach the agent');
  const asked = hub.transcript(MASTER_CHAT_ID).find((t) => t.kind === 'user' && t.text.startsWith('[Question from'));
  assert.ok(asked && asked.kind === 'user');
  assert.match(asked.text, /GARDEN-12/);
  assert.match(asked.from ?? '', /agent 01/);
  await until(() => cardOf(hub, id).final, 'it to finish');
});

test("a request still starts if the master can't run, and an agent isn't left waiting on it", async () => {
  const hub = makeHub();
  const rec = (hub as any).masterRec;
  (hub as any).masterBackend = { send() { (hub as any).reduce(rec, { k: 'turn-end', isError: true, text: 'Could not connect' }); }, decide() {}, answer() {}, interrupt() {}, stop() {} };
  await hub.request(task('clean', { prompt: 'Fix the lantern' }));
  await until(() => tasks(hub).length === 1, 'it to start anyway');
  assert.ok(hub.transcript(MASTER_CHAT_ID).some((t) => t.kind === 'system' && t.text.includes("couldn't run")));
  const id = await hub.createAgent(task('ask'));
  await until(() => hub.transcript(id).some((t) => t.kind === 'assistant' && t.text.includes("couldn't run")), 'the agent to hear');
});

test('a question still open when the app restarts is asked again', async () => {
  const dataDir = tmp('fleet-flow-');
  const a = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  const rec = (a as any).masterRec;
  const sent: string[] = [];
  (a as any).masterBackend = { send(text: string) { sent.push(text); }, decide() {}, answer() {}, interrupt() {}, stop() {} };
  await a.createAgent(task('ask'));
  await until(() => sent.some((s) => s.startsWith('[Question from')), 'the question');
  assert.ok(rec);
  a.saveNow();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(saved.openQuestions.length, 1);
  await a.shutdown();
  const b = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  hubs.push(b);
  const again: string[] = [];
  (b as any).masterBackend = { send(text: string) { again.push(text); }, decide() {}, answer() {}, interrupt() {}, stop() {} };
  await b.start();
  await until(() => again.some((s) => s.startsWith('[Question from') && s.includes('sent again')), 'it to be asked again');
});

test('a request the master had not got through when the app restarted is sent again', async () => {
  const dataDir = tmp('fleet-flow-');
  const a = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  (a as any).masterBackend = { send() {}, decide() {}, answer() {}, interrupt() {}, stop() {} };
  await a.request(task('clean', { prompt: 'Do not lose this' }));
  await a.detach();
  const b = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  hubs.push(b);
  const again: string[] = [];
  (b as any).masterBackend = { send(text: string) { again.push(text); }, decide() {}, answer() {}, interrupt() {}, stop() {} };
  await b.start();
  await until(() => again.some((s) => s.startsWith('Do not lose this') && s.includes('list_agents')), 'it to be sent again');
});

// ---- The stages ----

function plasticProject() {
  const dir = path.join(tmp('fleet-flow-'), 'Game');
  fs.mkdirSync(path.join(dir, '.plastic'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Game.uproject'), '{"EngineAssociation":"5.8"}');
  return { dir, file: path.join(dir, 'Game.uproject') };
}

test('a self-verified task goes straight through to complete with no popup', async () => {
  const hub = makeHub();
  const popups: AgentCard[] = [];
  hub.on('attention', (c) => popups.push(c));
  const id = await hub.createAgent(task('clean'));
  assert.equal(cardOf(hub, id).stage, 'preparing');
  await until(() => cardOf(hub, id).stage === 'building', 'building');
  await until(() => cardOf(hub, id).stage === 'testing', 'its own testing');
  await until(() => cardOf(hub, id).stage === 'complete', 'complete');
  assert.deepEqual(popups, []);
});

test('testing pauses for the user, Approve moves it on, and Issue found sends it back', async () => {
  const hub = makeHub();
  const popups: AgentCard[] = [];
  hub.on('attention', (c) => popups.push(c));
  const id = await hub.createAgent(task('testing'));
  await until(() => cardOf(hub, id).final, 'it to finish');
  assert.equal(cardOf(hub, id).stage, 'testing');
  assert.equal(cardOf(hub, id).attention?.kind, 'testing');
  assert.match(cardOf(hub, id).attention!.text, /Ready to test: 2 things/);
  assert.equal(popups.at(-1)?.id, id);
  const steps = hub.testList().filter((t) => t.agentId === id);
  assert.equal(steps.length, 2);
  assert.ok(steps.every((s) => s.test.how && s.test.expect), 'every step says what to do and what to see');

  hub.dismissAttention(id);
  assert.equal(cardOf(hub, id).attention?.kind, 'testing', "looking at it doesn't settle it");
  hub.setTestDone(steps[0].key, true);
  await hub.reportIssue(id, 'The mist never stops');
  assert.equal(cardOf(hub, id).stage, 'building');
  assert.equal(cardOf(hub, id).final, null);
  assert.equal(hub.testList().filter((t) => t.agentId === id).length, 0, 'the checklist goes until there is a new one');
  await until(() => hub.transcript(id).some((t) => t.kind === 'user' && t.text.includes('The mist never stops')), 'the issue to reach the agent');

  // In the real thing the agent fixes it and finishes again.
  const r = (hub as any).agents.get(id);
  (hub as any).reduce(r, { k: 'final', report: { summary: 'Fixed the mist.', verified: ['Ran it'], needsTesting: [{ what: 'Mist stops', how: 'Run it', expect: 'It stops' }], at: Date.now() } });
  assert.equal(cardOf(hub, id).stage, 'testing');
  assert.equal(hub.testList().filter((t) => t.agentId === id && t.done).length, 0, 'the new checklist starts unticked');

  await hub.approve(id);
  assert.equal(cardOf(hub, id).attention, null);
  assert.equal(cardOf(hub, id).stage, 'complete', 'no project means nothing to merge');
  assert.equal(hub.testList().filter((t) => t.agentId === id && !t.done).length, 0);
});

test('merged work goes through the master into a named Plastic changelist', async () => {
  const commands: string[][] = [];
  const hub = makeHub(async (args) => {
    commands.push(args);
    return args[0] === 'status' ? `CH|${path.join(project.dir, 'Source/A.cpp')}|False|NO_MERGES\nPR|${path.join(project.dir, 'Source/New.cpp')}|False|NO_MERGES\n` : '';
  });
  const project = plasticProject();
  const id = await hub.createAgent(task('testing', { projectFile: project.file }));
  await until(() => cardOf(hub, id).final, 'it to finish');
  const r = (hub as any).agents.get(id);
  // What its tools would have recorded in a shared folder here.
  r.card.slot = { shared: true };
  const realChanges = hub.changes.bind(hub);
  (hub as any).changes = async () => [{ path: 'Source/A.cpp', kind: 'modified', binary: false, mine: true }, { path: 'Source/New.cpp', kind: 'added', binary: false, mine: true }];
  await hub.approve(id);
  await until(() => cardOf(hub, id).stage === 'complete', 'complete');
  (hub as any).changes = realChanges;
  assert.equal(cardOf(hub, id).merge?.files, 2);
  assert.equal(cardOf(hub, id).changelist, cardOf(hub, id).title.replaceAll('"', "'"));
  assert.ok(hub.transcript(MASTER_CHAT_ID).some((t) => t.kind === 'user' && t.text.startsWith('[Ready for a changelist]')), 'the master is the one who names it');
  const verbs = commands.map((c) => c.slice(0, 2).join(' '));
  assert.ok(verbs.includes('add --coparent'));
  assert.ok(verbs.includes(`checkout ${path.join(project.dir, 'Source/A.cpp')}`));
  assert.ok(verbs.includes(`changelist create`));
  assert.ok(commands.some((c) => c[0] === 'changelist' && c[2] === 'add' && c.includes(path.join(project.dir, 'Source/New.cpp')) && c.includes(path.join(project.dir, 'Source/A.cpp'))));
  assert.ok(!commands.some((c) => c[0] === 'checkin'), 'it never checks anything in');
});

test('a project outside Plastic goes straight from merged to complete', async () => {
  const hub = makeHub(async () => { throw new Error('cm should not run'); });
  const dir = path.join(tmp('fleet-flow-'), 'Game');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Game.uproject'), '{"EngineAssociation":"5.8"}');
  const id = await hub.createAgent(task('clean', { projectFile: path.join(dir, 'Game.uproject') }));
  await until(() => cardOf(hub, id).stage === 'complete', 'complete');
  assert.equal(cardOf(hub, id).changelist, undefined);
});

test('a conflict pauses the merge until the user picks a side', async () => {
  const hub = makeHub();
  const dir = path.join(tmp('fleet-flow-'), 'Game');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Game.uproject'), '{"EngineAssociation":"5.8"}');
  const id = await hub.createAgent(task('testing', { projectFile: path.join(dir, 'Game.uproject') }));
  await until(() => cardOf(hub, id).final, 'it to finish');
  const conflict = [{ path: 'Source/A.cpp', reason: 'Text merge has conflicts.' }];
  let forced: string[] | undefined;
  (hub as any).changes = async () => [{ path: 'Source/A.cpp', kind: 'modified', binary: false }];
  (hub as any).apply = async (_id: string, _only: string[], force?: string[]) => { forced = force; return force ? { applied: ['Source/A.cpp'], merged: [], conflicts: [] } : { applied: [], merged: [], conflicts: conflict }; };
  await hub.approve(id);
  assert.equal(cardOf(hub, id).stage, 'awaiting-merge');
  assert.deepEqual(cardOf(hub, id).merge?.conflicts, conflict);
  assert.match(cardOf(hub, id).attention!.text, /1 file also changed/);

  await hub.resolveConflicts(id, 'agent');
  assert.deepEqual(forced, ['Source/A.cpp']);
  assert.equal(cardOf(hub, id).stage, 'complete');
  assert.equal(cardOf(hub, id).attention, null);
});

test('keeping your own version leaves the file out from then on', async () => {
  const hub = makeHub();
  const dir = path.join(tmp('fleet-flow-'), 'Game');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Game.uproject'), '{"EngineAssociation":"5.8"}');
  const id = await hub.createAgent(task('testing', { projectFile: path.join(dir, 'Game.uproject') }));
  await until(() => cardOf(hub, id).final, 'it to finish');
  const asked: string[][] = [];
  (hub as any).changes = async () => [{ path: 'Source/A.cpp', kind: 'modified', binary: false }, { path: 'Source/B.cpp', kind: 'modified', binary: false }];
  (hub as any).apply = async (_id: string, only: string[]) => { asked.push(only); return only.includes('Source/A.cpp') ? { applied: ['Source/B.cpp'], merged: [], conflicts: [{ path: 'Source/A.cpp', reason: 'x' }] } : { applied: only, merged: [], conflicts: [] }; };
  await hub.approve(id);
  await hub.resolveConflicts(id, 'mine');
  assert.deepEqual(asked.at(-1), ['Source/B.cpp']);
  assert.equal(cardOf(hub, id).stage, 'complete');
  assert.equal(cardOf(hub, id).merge?.files, 1);
});

test('a follow-up to a complete task sends it back round', async () => {
  const hub = makeHub();
  const id = await hub.createAgent(task('clean'));
  await until(() => cardOf(hub, id).stage === 'complete', 'complete');
  await hub.send(id, 'One more thing');
  assert.equal(cardOf(hub, id).stage, 'building');
  assert.equal(cardOf(hub, id).final, null);
  assert.equal(cardOf(hub, id).progress, undefined);
});

test('a card from before stages existed needs approving rather than merging by itself', async () => {
  const dataDir = tmp('fleet-flow-');
  const a = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  await a.shutdown();
  const old = { card: { id: 'old', index: 9, title: 'Old', nodeId: 'master', project: 'Game', status: 'finished', attention: null, lastText: '', lastTextAt: 0, lastPrompt: '', lastPromptAt: 0, createdAt: 0, sessionMs: 0, runningSince: null, usage: {}, tokens: 0, tps: 0, spark: [], buckets: {}, slot: null, final: { summary: 's', verified: ['v'], needsTesting: [], at: 0 } }, spawn: { id: 'old' } };
  const running = { ...old, card: { ...old.card, id: 'old2', index: 10, final: null, status: 'idle' } };
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  state.agents.push(old, running);
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(state));
  const b = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  hubs.push(b);
  assert.equal(cardOf(b, 'old').stage, 'testing');
  assert.equal(cardOf(b, 'old2').stage, 'building');
});

test('Open editor brings the files in and compiles only when code changed', async () => {
  const hub = makeHub();
  const dir = path.join(tmp('fleet-flow-'), 'Game');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Game.uproject'), '{"EngineAssociation":"5.8"}');
  const file = path.join(dir, 'Game.uproject');
  const id = await hub.createAgent(task('testing', { projectFile: file }));
  await until(() => cardOf(hub, id).final, 'it to finish');
  const calls: any[] = [];
  const nodeCall = (hub as any).nodeCall.bind(hub);
  (hub as any).nodeCall = async (node: string, method: string, p: any) => {
    if (method === 'machine.openTestEditor') { calls.push(p); return { ok: true }; }
    return nodeCall(node, method, p);
  };
  (hub as any).changes = async () => [{ path: 'Content/Map.umap', kind: 'modified', binary: true }];
  (hub as any).apply = async (_id: string, only: string[]) => ({ applied: only, merged: [], conflicts: [] });
  await hub.testChanges(id);
  assert.deepEqual(calls.at(-1), { file, build: false });
  assert.equal(cardOf(hub, id).testRun?.stage, 'open');
  assert.equal(cardOf(hub, id).stage, 'testing', 'testing goes on until you approve it');

  (hub as any).changes = async () => [{ path: 'Source/A.cpp', kind: 'modified', binary: false }];
  await hub.testChanges(id);
  assert.deepEqual(calls.at(-1), { file, build: true });

  (hub as any).nodeCall = async (node: string, method: string, p: any) => (method === 'machine.openTestEditor' ? { ok: false, output: 'error C2065' } : nodeCall(node, method, p));
  await hub.testChanges(id);
  assert.equal(cardOf(hub, id).testRun?.stage, 'failed');
  assert.match(cardOf(hub, id).testRun!.detail!, /error C2065/);
});

// ---- Which files an agent changed ----

function shared() {
  const root = tmp('fleet-flow-');
  const src = path.join(root, 'Game');
  const write = (rel: string, text = 'x') => { fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.writeFileSync(path.join(src, rel), text); };
  write('Game.uproject', '{"EngineAssociation":"5.8"}');
  write('Source/A.cpp');
  write('Source/Old.cpp');
  const old = new Date(Date.now() - 60_000);
  for (const f of ['Source/A.cpp', 'Source/Old.cpp']) fs.utimesSync(path.join(src, f), old, old);
  const project = readProject(path.join(src, 'Game.uproject'), [])!;
  const engine: EngineInfo = { id: '5.8', version: '5.8.0', root: path.join(root, 'engine'), hasMcp: false, source: false };
  const mgr = new SlotManager('test', path.join(root, 'data'), 24, 4);
  return { root, src, write, project, engine, mgr };
}

test("each agent's list holds only what it changed, even in the same folder", async () => {
  const { src, write, project, engine, mgr } = shared();
  const a: Slot = await mgr.acquire(project, engine, 'a', 'headless');
  const b: Slot = await mgr.acquire(project, engine, 'b', 'headless');
  await sleep(30);
  write('Source/A.cpp', 'a changed this');
  write('Source/B.cpp', 'b made this');
  a.noteChanged(path.join(src, 'Source/A.cpp'));
  b.noteChanged(path.join(src, 'Source/B.cpp'));
  assert.deepEqual((await a.myChanges()).map((c) => c.path.replaceAll('\\', '/')), ['Source/A.cpp']);
  assert.deepEqual((await b.myChanges()).map((c) => [c.path.replaceAll('\\', '/'), c.kind]), [['Source/B.cpp', 'added']]);
});

test('assets its editor saved count, but autosaves and files outside the project do not', async () => {
  const { src, write, project, engine, mgr } = shared();
  const a: Slot = await mgr.acquire(project, engine, 'a', 'headless');
  await sleep(30);
  write('Content/Hero.uasset');
  const binaries = path.join(engine.root, 'Engine/Binaries/Win64');
  const rel = (f: string) => path.relative(binaries, f).replaceAll('\\', '/');
  fs.writeFileSync(a.logFile, [
    "LogSavePackage: Moving output files for package: /Temp/Autosaves/X",
    `LogSavePackage: Moving '${rel(path.join(a.own, 'Saved/X.tmp'))}' to '${rel(path.join(a.own, 'Saved/Autosaves/X.uasset'))}'`,
    `[2026.11.03-01.13.13:476][805]LogSavePackage: Moving '${rel(path.join(a.own, 'Saved/Y.tmp'))}' to '${rel(path.join(src, 'Content/Hero.uasset'))}'`,
  ].join('\n'));
  assert.deepEqual((await a.myChanges()).map((c) => c.path.replaceAll('\\', '/')), ['Content/Hero.uasset']);
});

test('an edit that never happened is left out, and only a reported file can count as deleted', async () => {
  const { src, project, engine, mgr } = shared();
  const a: Slot = await mgr.acquire(project, engine, 'a', 'headless');
  a.noteChanged(path.join(src, 'Source/Old.cpp'));
  a.noteChanged(path.join(src, 'Source/NotHere.cpp'));
  a.noteChanged('C:/Somewhere/Else.cpp');
  assert.deepEqual(await a.myChanges(), [], 'untouched, missing and outside the project');
  a.noteChanged(path.join(src, 'Source/Gone.cpp'), 'reported');
  assert.deepEqual((await a.myChanges()).map((c) => [c.path.replaceAll('\\', '/'), c.kind]), [['Source/Gone.cpp', 'deleted']]);
});

test('the list survives a restart, and a new task in the same folder starts empty', async () => {
  const { src, write, project, engine, mgr, root } = shared();
  const a: Slot = await mgr.acquire(project, engine, 'a', 'headless');
  await sleep(30);
  write('Source/A.cpp', 'changed');
  a.noteChanged(path.join(src, 'Source/A.cpp'));
  const later = new SlotManager('test', path.join(root, 'data'), 24, 4).adopt(project, engine, 'a', a.own, 'headless');
  assert.deepEqual((await later.myChanges()).map((c) => c.path.replaceAll('\\', '/')), ['Source/A.cpp']);
  await mgr.release('a');
  const next = await mgr.acquire(project, engine, 'b', 'headless');
  assert.equal(next.own, a.own);
  assert.deepEqual(await next.myChanges(), []);
});

// ---- The test editor ----

test("a person's editor is told apart from agents' editors", () => {
  const file = 'C:\\Work Space\\Game\\Game.uproject';
  const list = [
    { pid: 1, commandLine: '"C:\\UE\\UnrealEditor.exe" "C:/Work Space/Game/Game.uproject" -UserDir="C:\\data\\u\\01" -unattended' },
    { pid: 2, commandLine: '"C:\\UE\\UnrealEditor.exe" "C:\\Work Space\\Game\\Game.uproject"' },
    { pid: 3, commandLine: '"C:\\UE\\UnrealEditor.exe" "C:\\Other\\Other.uproject"' },
  ];
  assert.deepEqual(personEditors(list, file), [2]);
});

test('the test editor is a normal one, with the settings that matter to a person', async () => {
  const { project, engine, mgr } = shared();
  const slot = await mgr.acquire(project, engine, 'test-Game', 'windowed');
  const args = slot.personEditorArgs();
  assert.ok(args[0].includes('Game.uproject'));
  assert.ok(args.includes('-NoLiveCoding'), "or it would block agents' builds");
  assert.ok(!args.some((a) => /UserDir|unattended|RenderOffscreen|AbsLog/i.test(a)), 'none of the agent settings');
  slot.forPerson = true;
  assert.equal(mgr.list().length, 0, "it doesn't take up a place on the machine strip");
});

// ---- Plastic ----

const dir = 'C:\\ws';
const inWs = (rel: string) => path.join(dir, rel);
function fakeCm(status: string, fail: (args: string[]) => string | null = () => null) {
  const calls: string[][] = [];
  const run: CmRun = async (args) => {
    calls.push(args);
    const why = fail(args);
    if (why) throw Object.assign(new Error('cm failed'), { stderr: why });
    return args[0] === 'status' ? status : '';
  };
  return { calls, run };
}

test('status lines are read as Plastic writes them', () => {
  const parsed = parseStatus('CO+RP|c:\\ws\\Source\\A.cpp|False|NO_MERGES\nPR|c:\\ws\\Plugins\\New|True|NO_MERGES\n');
  assert.deepEqual(parsed.get(path.normalize('c:\\ws\\source\\a.cpp')), { code: 'CO+RP', isDir: false });
  assert.deepEqual(parsed.get(path.normalize('c:\\ws\\plugins\\new')), { code: 'PR', isDir: true });
});

test('each kind of change is made ready the way Plastic needs before joining a changelist', async () => {
  const { calls, run } = fakeCm([`CO|${inWs('Source\\Out.cpp')}|False|x`, `AD|${inWs('Source\\Added.cpp')}|False|x`, `CH|${inWs('Source\\Plain.cpp')}|False|x`, `PR|${inWs('Source\\New.cpp')}|False|x`].join('\n'));
  const r = await assignToChangelist(dir, 'NIGH-1 "Fix"\nit', 'Fixes it', ['Source\\Out.cpp', 'Source\\Added.cpp', 'Source\\Plain.cpp', 'Source\\New.cpp'], run);
  assert.equal(r.name, 'NIGH-1  Fix  it');
  assert.equal(r.failed.length, 0);
  assert.equal(r.assigned.length, 4);
  assert.deepEqual(calls.find((c) => c[0] === 'add'), ['add', '--coparent', inWs('Source\\New.cpp')]);
  assert.deepEqual(calls.find((c) => c[0] === 'checkout'), ['checkout', inWs('Source\\Plain.cpp')]);
  assert.deepEqual(calls.find((c) => c[1] === 'create'), ['changelist', 'create', 'NIGH-1  Fix  it', 'Fixes it']);
  assert.deepEqual(calls.find((c) => c[2] === 'add')?.slice(0, 3), ['changelist', 'NIGH-1  Fix  it', 'add']);
  assert.ok(!calls.some((c) => c[0] === 'checkin'));
});

test('a new file in a new folder brings its folders along', async () => {
  const { calls, run } = fakeCm(`PR|${inWs('Source\\Fresh')}|True|x`);
  const r = await assignToChangelist(dir, 'x', 'y', ['Source\\Fresh\\Deep\\New.cpp'], run);
  assert.deepEqual(calls.find((c) => c[0] === 'add')?.slice(2), [inWs('Source\\Fresh'), inWs('Source\\Fresh\\Deep'), inWs('Source\\Fresh\\Deep\\New.cpp')]);
  assert.deepEqual(r.assigned, ['Source\\Fresh\\Deep\\New.cpp'], "only the file goes in the changelist, since its folders follow it");
});

test('one locked file fails alone, and the reason comes back', async () => {
  const { run } = fakeCm([`CH|${inWs('A.cpp')}|False|x`, `CH|${inWs('Locked.cpp')}|False|x`].join('\n'), (args) => (args[0] === 'checkout' && args.includes(inWs('Locked.cpp')) ? 'The item is locked by Someone' : null));
  const r = await assignToChangelist(dir, 'x', 'y', ['A.cpp', 'Locked.cpp'], run);
  assert.deepEqual(r.assigned, ['A.cpp']);
  assert.deepEqual(r.failed, [{ path: 'Locked.cpp', reason: 'The item is locked by Someone' }]);
});

test('a changelist that already exists is reused, as when a task comes back round', async () => {
  const { calls, run } = fakeCm(`CO|${inWs('A.cpp')}|False|x`, (args) => (args[1] === 'create' ? 'A changelist with that name already exists' : null));
  const r = await assignToChangelist(dir, 'x', 'y', ['A.cpp'], run);
  assert.deepEqual(r.assigned, ['A.cpp']);
  assert.ok(calls.some((c) => c[2] === 'add'));
});

test("a file Plastic doesn't list, or one that's deleted, is reported rather than guessed at", async () => {
  const { calls, run } = fakeCm(`LD|${inWs('Gone.cpp')}|False|x`);
  const r = await assignToChangelist(dir, 'x', 'y', ['Gone.cpp', 'Ignored.cpp'], run);
  assert.deepEqual(r.assigned, []);
  assert.deepEqual(r.failed.map((f) => f.path), ['Gone.cpp', 'Ignored.cpp']);
  assert.ok(!calls.some((c) => c[0] === 'changelist'), 'no empty changelist');
});
