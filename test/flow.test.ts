// A task's whole way through: the master chat, placement, the stages, testing, merging and the
// Plastic changelist, with scripted agents and a stand-in for Plastic's cm.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hub } from '../src/hub/hub';
import { masterPrompt } from '../src/hub/masterChat';
import { placeTask } from '../src/hub/placement';
import { Slot, SlotManager, personEditors } from '../src/node/instance';
import { readProject } from '../src/node/machine';
import { assignToChangelist, parseStatus, type CmRun } from '../src/node/plastic';
import { metersFrom } from '../src/node/planUsage';
import { readChunk } from '../src/node/projectSync';
import { checkedInVersion } from '../src/node/sourceControl';
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

test('a preferred machine gets the work whenever it can take it, and says why when it cannot', () => {
  const fleet = [machine('master', 'master', 5), machine('laptop', 'remote', 40), machine('desk', 'remote', 10)];
  assert.equal(placeTask(fleet, none, game).nodeId, 'desk', 'with no preference it goes by load');
  const placed = placeTask(fleet, none, game, 'laptop');
  assert.equal(placed.nodeId, 'laptop', 'even though another is less busy');
  assert.match(placed.reason, /LAPTOP is your preferred machine\./);
  assert.equal(placeTask(fleet, none, game, 'master').nodeId, 'master', 'this PC can be the one');

  const refused = (m: MachineView, running: (id: string) => number = none) => placeTask([machine('master', 'master', 5), machine('desk', 'remote', 10), m], running, game, m.info.id);
  const busy = refused(machine('laptop', 'remote', 95));
  assert.equal(busy.nodeId, 'desk');
  assert.match(busy.reason, /LAPTOP is your preferred machine, but its CPU is at 95%\. DESK is free/);
  assert.match(refused({ ...machine('laptop', 'remote', 5), online: false }).reason, /but it's offline/);
  assert.match(refused(machine('laptop', 'remote', 5, 4)).reason, /but it only has 4 GB free/);
  assert.match(refused(machine('laptop', 'remote', 5, 40, ['Other'])).reason, /but it doesn't have Game/);
  assert.match(refused(machine('laptop', 'remote', 5), (id) => (id === 'laptop' ? 4 : 0)).reason, /already running 4 tasks/);
  assert.equal(placeTask(fleet, none, game, 'gone').nodeId, 'desk', 'one that has since gone is ignored');
});

test('the preferred machine is kept, reaches placement and the master, and clears if it is forgotten', async () => {
  const dataDir = tmp('fleet-flow-');
  const hub = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  assert.equal(hub.snapshot().preferredMachine, null);
  assert.throws(() => hub.setPreferredMachine('nowhere'), /isn't linked/);
  hub.setPreferredMachine('master');
  assert.equal(hub.snapshot().preferredMachine, 'master');
  assert.equal((hub as any).masterActions().machines()[0].preferred, true);
  const id = await hub.createAgent(task('clean', { nodeId: 'auto' }));
  assert.equal(cardOf(hub, id).nodeId, 'master');
  await hub.shutdown();
  const again = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  hubs.push(again);
  assert.equal(again.snapshot().preferredMachine, 'master');
  (again as any).link.forget = () => {};
  again.forgetMachine('master');
  assert.equal(again.snapshot().preferredMachine, null);
});

test('usage left comes straight from the server, and anything unexpected shows nothing', () => {
  const meters = metersFrom({
    subscription_type: 'max', rate_limits_available: true,
    rate_limits: { limits: [
      { kind: 'session', group: 'session', percent: 80, severity: 'warning', resets_at: '2026-11-03T19:40:00+00:00', scope: null, is_active: true },
      { kind: 'weekly_all', group: 'weekly', percent: 46.4, severity: 'normal', resets_at: '2026-11-04T23:00:00+00:00', scope: null, is_active: false },
      { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resets_at: null, scope: { model: { display_name: 'Fable' }, surface: null }, is_active: false },
    ] },
  })!;
  assert.deepEqual(meters.map((m) => [m.label, m.percentLeft, m.main, m.severity]), [['Session', 20, true, 'warning'], ['Week', 54, true, 'normal'], ['Fable weekly', 100, false, 'normal']]);
  assert.equal(meters[0].resetsAt, '2026-11-03T19:40:00+00:00');
  assert.equal(meters[2].resetsAt, undefined);
  assert.equal(metersFrom({ subscription_type: null, rate_limits_available: false, rate_limits: null }), null, 'an API key has no plan');
  assert.equal(metersFrom({ rate_limits: { limits: [] } }), null);
  assert.equal(metersFrom(undefined), null);
  assert.equal(metersFrom({ rate_limits: { limits: 'something new' } }), null);
  assert.deepEqual(metersFrom({ rate_limits: { limits: [{ kind: 'session', group: 'session', percent: 120 }] } })?.[0].percentLeft, 0);
});

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

test('agents the master starts run on auto, and another pick lasts for that request only', async () => {
  const dataDir = tmp('fleet-flow-');
  // Left behind by a version that remembered the last pick.
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ defaults: { model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'acceptEdits', instanceMode: 'headless', projectFile: null } }));
  const hub = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  hubs.push(hub);
  const started: string[] = [];
  hub.on('hub', (e) => { if (e.e === 'task-started') started.push(e.id); });
  assert.equal(hub.snapshot().defaults.permissionMode, 'auto');
  await hub.send(MASTER_CHAT_ID, 'Fix the lantern');
  const typed = await until(() => started[0], 'a task typed into the master chat');
  assert.equal(cardOf(hub, typed).permissionMode, 'auto');
  await hub.request(task('clean', { prompt: 'Fix the gate' }));
  const picked = await until(() => started[1], 'a task with its own pick');
  assert.equal(cardOf(hub, picked).permissionMode, 'default');
  assert.equal(hub.snapshot().defaults.permissionMode, 'auto', "the pick isn't remembered");
});

test('the master chat changes running agents by number, and one bad number leaves the rest alone', async () => {
  const hub = makeHub();
  const act = (hub as any).masterActions();
  const rec = (id: string) => (hub as any).agents.get(id);
  const id = await hub.createAgent(task('long'));
  const n = cardOf(hub, id).index;
  await until(() => (hub as any).local.agents.get(id)?.runner, 'the agent to start');

  const said = await act.setAgentOptions({ agents: [n, 99], model: 'claude-sonnet-5-5', effort: 'xhigh', permission_mode: 'auto' });
  assert.match(said, new RegExp(`0?${n}: changed`));
  assert.match(said, /99: There's no agent 99/);
  const { model, effort, permissionMode } = cardOf(hub, id);
  assert.deepEqual({ model, effort, permissionMode }, { model: 'claude-sonnet-5-5', effort: 'xhigh', permissionMode: 'auto' });
  assert.equal(rec(id).spawn.effort, 'xhigh', 'so a restart picks it back up on these');
  assert.equal((hub as any).local.agents.get(id).spawn.model, 'claude-sonnet-5-5', 'so its machine has them too');
  await act.setAgentOptions({ agents: [n], effort: 'low' });
  assert.equal(cardOf(hub, id).model, 'claude-sonnet-5-5', 'what is not mentioned stays');
  assert.equal(cardOf(hub, id).effort, 'low');
  assert.equal(act.agents()[0].permissions, 'auto');
  await assert.rejects(() => act.setAgentOptions({ agents: [n] }), /Pass a model/);

  // A host from before this can't change a running agent, but it still applies when the agent next starts.
  const realCall = (hub as any).nodeCall;
  (hub as any).nodeCall = async () => { throw new Error('Unknown method agent.setOptions'); };
  assert.match(await act.setAgentOptions({ agents: [n], effort: 'high' }), /saved for when it next runs/);
  (hub as any).nodeCall = realCall;
  assert.equal(rec(id).spawn.effort, 'high');

  assert.match(await act.stopAgents({ agents: [n] }), /stopped/);
  assert.equal(cardOf(hub, id).status, 'stopped');
  assert.equal(cardOf(hub, id).archived, undefined, 'stopping keeps the card');
});

test('the master chat asks before archiving work that would be lost', async () => {
  const hub = makeHub();
  const act = (hub as any).masterActions();
  const id = await hub.createAgent(task('clean'));
  const n = cardOf(hub, id).index;
  (hub as any).changes = async () => [{ path: 'Source/Lantern.cpp' }];
  assert.match(await act.archiveAgents({ agents: [n] }), /not archived.*Source\/Lantern\.cpp/);
  assert.equal(cardOf(hub, id).archived, undefined);
  assert.match(await act.archiveAgents({ agents: [n], discard_unmerged: true }), /archived/);
  assert.equal((hub as any).agents.get(id).card.archived, true);
  assert.match(await act.stopAgents({ agents: [n] }), /There's no agent/, 'and it is gone from the numbers');
});

test('the master chat approves only what is waiting, and reports where it got to', async () => {
  const hub = makeHub();
  const act = (hub as any).masterActions();
  const busy = await hub.createAgent(task('long'));
  assert.match(await act.approveAgents({ agents: [cardOf(hub, busy).index] }), /nothing to approve/);
  const id = await hub.createAgent(task('testing'));
  const n = cardOf(hub, id).index;
  await until(() => cardOf(hub, id).status === 'finished', 'it to finish');
  assert.equal(cardOf(hub, id).stage, 'testing');
  const details = JSON.parse(await act.agentDetails({ agent: n }));
  assert.equal(details.finalReport.needsTesting.length, 2);
  assert.ok(details.recent.some((m: { text: string }) => m.text.includes('Do testing')));
  assert.match(await act.approveAgents({ agents: [n] }), /approved, now at complete/);
  assert.equal(cardOf(hub, id).stage, 'complete');
  await hub.stopAgent(busy);
});

test("a one-off model from the master doesn't become the default for later tasks", async () => {
  const hub = makeHub();
  const act = (hub as any).masterActions();
  const before = hub.snapshot().defaults.model;
  await act.startTask({ prompt: 'Fix the lantern', model: 'claude-haiku-5-5', effort: 'low', permission_mode: 'default' });
  const card = hub.snapshot().cards.at(-1)!;
  assert.equal(card.model, 'claude-haiku-5-5');
  assert.equal(card.permissionMode, 'default');
  assert.equal(hub.snapshot().defaults.model, before);
});

test('an agent that hits the usage limit carries on with API credits, and goes back when told', async () => {
  const hub = makeHub();
  hub.setApiKey('sk-test-never-saved');
  hub.setApiCreditsEnabled(true);
  const id = await hub.createAgent(task('long'));
  const r = (hub as any).agents.get(id);
  await until(() => (hub as any).local.agents.get(id)?.runner, 'the agent to start');
  const calls: any[] = [];
  const realCall = (hub as any).nodeCall.bind(hub);
  (hub as any).nodeCall = (node: string, method: string, p: any) => { if (method === 'agent.useCredits') calls.push(p); return realCall(node, method, p); };

  (hub as any).reduce(r, { k: 'usage-limit', resetsAt: Date.now() + 3_600_000 });
  (hub as any).reduce(r, { k: 'turn-end', isError: true, text: "You've hit your limit" });
  assert.equal(cardOf(hub, id).attention, null, "it isn't reported as a failure, because it's carrying on");
  assert.equal(cardOf(hub, id).onApiCredits, true);
  await until(() => calls.length === 1, 'the switch');
  assert.equal(calls[0].apiKey, 'sk-test-never-saved');
  assert.match(calls[0].carryOn, /carry on/);
  assert.ok(hub.transcript(id).some((t) => t.kind === 'system' && t.text.includes('carrying on with API credits')));

  hub.saveNow();
  assert.ok(!fs.readFileSync((hub as any).stateFile(), 'utf8').includes('sk-test-never-saved'), 'the key is never written with the state');
  assert.ok(!JSON.stringify(hub.snapshot()).includes('sk-test-never-saved'), 'and never reaches the screens');
  assert.equal(hub.snapshot().apiCredits?.enabled, true);
  assert.equal(hub.snapshot().apiCredits?.hasKey, true);

  (hub as any).endCredits();
  assert.equal(cardOf(hub, id).onApiCredits, true, 'not before the limit resets');
  hub.setApiCreditsEnabled(false);
  (hub as any).endCredits();
  assert.equal(cardOf(hub, id).onApiCredits, true, 'and not in the middle of a turn');
  await hub.stopAgent(id);
  (hub as any).endCredits();
  assert.equal(cardOf(hub, id).onApiCredits, false);
  assert.equal(calls[1].apiKey, null);
});

test('with API credits off, or no key, the limit stops the agent and says so', async () => {
  const hub = makeHub();
  const id = await hub.createAgent(task('long'));
  const r = (hub as any).agents.get(id);
  (hub as any).reduce(r, { k: 'usage-limit' });
  (hub as any).reduce(r, { k: 'turn-end', isError: true, text: "You've hit your limit" });
  assert.equal(cardOf(hub, id).onApiCredits, undefined);
  assert.match(cardOf(hub, id).attention?.text ?? '', /hit your limit/);
  hub.setApiCreditsEnabled(true);
  assert.equal((hub as any).canUseCredits(), false, 'a key is needed too');
  await hub.stopAgent(id);
});

test('when the credits run out, the fleet stops trying rather than failing one agent at a time', async () => {
  const hub = makeHub();
  hub.setApiKey('sk-test');
  hub.setApiCreditsEnabled(true);
  const id = await hub.createAgent(task('long'));
  const r = (hub as any).agents.get(id);
  await until(() => (hub as any).local.agents.get(id)?.runner, 'the agent to start');
  r.card.onApiCredits = true;
  (hub as any).reduce(r, { k: 'credits-failed', why: 'Your credit balance is too low' });
  (hub as any).reduce(r, { k: 'turn-end', isError: true, text: 'Your credit balance is too low' });
  assert.equal(cardOf(hub, id).onApiCredits, false);
  assert.match(cardOf(hub, id).attention?.text ?? '', /credit balance/, 'the user is told');
  assert.match(hub.snapshot().apiCredits?.problem ?? '', /credit balance/);
  assert.equal((hub as any).canUseCredits(), false);
  hub.setApiCreditsEnabled(true);
  assert.equal((hub as any).canUseCredits(), true, 'turning it on again tries again');
  await hub.stopAgent(id);
});

function hubWithProject() {
  const hub = makeHub();
  const dir = tmp('fleet-workspace-');
  const file = path.join(dir, 'Game.uproject');
  fs.writeFileSync(file, '{"EngineAssociation":"5.8"}');
  (hub as any).local.info.projects.unshift(readProject(file, []));
  return { hub, file, act: (hub as any).masterActions(), rec: (id: string) => (hub as any).agents.get(id) };
}

test('the workspace chat runs on this PC in the real project, and a project only ever has one', async () => {
  const { hub, act } = hubWithProject();
  assert.match(await act.openWorkspaceChat({ prompt: 'Merge main into this branch' }), /as the workspace chat for Game/);
  const card = hub.snapshot().cards.find((c) => c.isWorkspace)!;
  assert.equal(card.nodeId, 'master');
  assert.equal(card.permissionMode, 'auto');
  assert.equal(card.stage, undefined, "it's a chat, so it has no stages");
  assert.equal(card.title, 'Workspace: Game');
  assert.match(await act.openWorkspaceChat({ prompt: 'Now update' }), /already the workspace chat/);
  assert.equal(hub.snapshot().cards.filter((c) => c.isWorkspace).length, 1);
  await until(() => hub.transcript(card.id).some((t) => t.kind === 'user' && t.text === 'Now update'), 'the request to reach it');
});

test('holding the workspace pauses agents in it, holds back new ones, and tells them afterwards', async () => {
  const { hub, file, act, rec } = hubWithProject();
  await act.openWorkspaceChat({ prompt: 'Merge main' });
  const chat = hub.snapshot().cards.find((c) => c.isWorkspace)!.id;
  const inFolder = await hub.createAgent(task('long', { projectFile: file }));
  const elsewhere = await hub.createAgent(task('long'));
  await until(() => cardOf(hub, inFolder).status !== 'queued' && (hub as any).local.agents.get(inFolder)?.runner, 'it to start');

  const held = JSON.parse(await (hub as any).holdWorkspace(rec(chat)));
  assert.deepEqual(held.agents.map((a: { agent: number; paused: boolean }) => [a.agent, a.paused]), [[cardOf(hub, inFolder).index, true]], 'only the agent in that folder');
  assert.equal(typeof held.personEditorOpen, 'boolean');
  assert.equal(cardOf(hub, inFolder).pausedForWorkspace, true);
  assert.equal(cardOf(hub, chat).holdingWorkspace, true);
  assert.notEqual(cardOf(hub, elsewhere).pausedForWorkspace, true);
  await until(() => cardOf(hub, inFolder).status === 'idle', 'it to stop');

  const late = await hub.createAgent(task('clean', { projectFile: file }));
  assert.equal(rec(late).heldNew, true, 'a new task waits');
  assert.equal((hub as any).local.agents.has(late), false);
  let merged = false;
  const merging = (hub as any).merge(rec(inFolder)).then(() => { merged = true; });
  await sleep(150);
  assert.equal(merged, false, 'and so does work coming back to the workspace');

  assert.match(await hub.releaseWorkspace(chat, 'merged main into dev'), /2 agents/);
  await merging;
  assert.equal(cardOf(hub, chat).holdingWorkspace, false);
  assert.equal(cardOf(hub, inFolder).pausedForWorkspace, false);
  await until(() => hub.transcript(inFolder).some((t) => t.kind === 'user' && t.text.includes('merged main into dev')), 'the agent to be told what changed');
  await until(() => (hub as any).local.agents.has(late), 'the new task to start');
  for (const id of [inFolder, elsewhere, late]) await hub.stopAgent(id);
});

test('archiving the workspace chat lets the agents go, and all-done ignores it', async () => {
  const { hub, file, act, rec } = hubWithProject();
  await act.openWorkspaceChat({ prompt: 'Merge main' });
  const chat = hub.snapshot().cards.find((c) => c.isWorkspace)!.id;
  await (hub as any).holdWorkspace(rec(chat));
  const late = await hub.createAgent(task('clean', { projectFile: file }));
  assert.equal(rec(late).heldNew, true);
  await hub.archive(chat);
  await until(() => (hub as any).local.agents.has(late), 'the held task to start');
  assert.equal((hub as any).workspaceHolds.size, 0);
  await hub.stopAgent(late);
});

// An agent on another machine, in that machine's own workspace, coming back to this one.
async function mergeFromLaptop(base: Record<string, string | null>) {
  const hub = makeHub();
  const here = tmp('fleet-here-');
  const there = tmp('fleet-there-');
  const id = await hub.createAgent(task('clean'));
  await hub.stopAgent(id);
  const r = (hub as any).agents.get(id);
  r.card.nodeId = 'laptop';
  r.card.slot = { shared: true };
  r.card.createdAt = 0;
  r.sourceProjectDir = here;
  const put = (root: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  (hub as any).nodeCall = async (_node: string, method: string, p: any) => {
    if (method === 'agent.changes') return fs.readdirSync(there, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ path: path.relative(there, path.join(e.parentPath, e.name)), kind: 'modified' }));
    if (method === 'agent.readFile') return readChunk(path.join(there, p.path), p.offset);
    if (method === 'agent.baseText') return base[p.path] == null ? null : Buffer.from(base[p.path]!).toString('base64');
    return null;
  };
  return { hub, id, here: (rel: string, text: string) => put(here, rel, text), there: (rel: string, text: string) => put(there, rel, text), read: (rel: string) => fs.readFileSync(path.join(here, rel), 'utf8'), r };
}
const ORIGINAL = 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\neight\r\n';

test('edits to different parts of a file both land, like a version control merge', async () => {
  const m = await mergeFromLaptop({ 'A.cpp': ORIGINAL });
  m.here('A.cpp', ORIGINAL.replace('one', 'one edited here'));
  m.there('A.cpp', ORIGINAL.replace('eight', 'eight edited by the agent'));
  const res = await m.hub.apply(m.id);
  assert.deepEqual(res.conflicts, []);
  assert.deepEqual(res.merged, ['A.cpp']);
  assert.equal(m.read('A.cpp'), ORIGINAL.replace('one', 'one edited here').replace('eight', 'eight edited by the agent'), 'both, with the line endings kept');

  m.here('A.cpp', ORIGINAL.replace('one', 'one edited again').replace('eight', 'eight edited by the agent'));
  const again = await m.hub.apply(m.id);
  assert.deepEqual(again.merged, [], 'with nothing new from the agent there is nothing to merge');
  assert.equal(m.read('A.cpp'), ORIGINAL.replace('one', 'one edited again').replace('eight', 'eight edited by the agent'));
});

test('an agent resumed on another machine is told the engine version, which is how that machine finds its engine', async () => {
  const { hub, file, rec } = hubWithProject();
  const id = await hub.createAgent(task('clean', { projectFile: file }));
  await hub.stopAgent(id);
  const r = rec(id);
  r.card.nodeId = 'laptop';
  r.sourceProjectDir = path.dirname(file);
  const spawned: any[] = [];
  (hub as any).nodeCall = async (_node: string, method: string, p: any) => {
    if (method === 'agent.spawn') spawned.push(p);
    return method === 'agent.has' ? false : null;
  };
  await (hub as any).ensureRunning(r);
  assert.equal(spawned[0].engineVersion, readProject(file, [])?.engineVersion);
  assert.ok(spawned[0].engineVersion);
});

test('merges of the same card that overlap take turns', async () => {
  const m = await mergeFromLaptop({ 'A.cpp': ORIGINAL });
  m.here('A.cpp', ORIGINAL.replace('one', 'one edited here'));
  m.there('A.cpp', ORIGINAL.replace('eight', 'eight edited by the agent'));
  const all = await Promise.all([m.hub.apply(m.id), m.hub.apply(m.id), m.hub.apply(m.id)]);
  assert.deepEqual(all.flatMap((r) => r.conflicts), []);
  assert.equal(m.read('A.cpp'), ORIGINAL.replace('one', 'one edited here').replace('eight', 'eight edited by the agent'));
});

test('edits to the same lines stop for a decision and leave the file alone', async () => {
  const m = await mergeFromLaptop({ 'A.cpp': ORIGINAL });
  const mine = ORIGINAL.replace('four', 'four edited here');
  m.here('A.cpp', mine);
  m.there('A.cpp', ORIGINAL.replace('four', 'four edited by the agent'));
  const res = await m.hub.apply(m.id);
  assert.match(res.conflicts[0].reason, /same lines/);
  assert.equal(m.read('A.cpp'), mine);
  await m.hub.apply(m.id, undefined, ['A.cpp']);
  assert.equal(m.read('A.cpp'), ORIGINAL.replace('four', 'four edited by the agent'), "choosing the agent's changes takes them");
});

test("choosing the agent's changes settles the disputed lines, and can't undo newer code elsewhere in the file", async () => {
  const m = await mergeFromLaptop({ 'A.cpp': ORIGINAL });
  // The agent's machine is on an older changeset, so its whole file doesn't have what was checked in since.
  const newerCheckIn = `${ORIGINAL}seven hundred more lines\r\n`;
  m.here('A.cpp', newerCheckIn.replace('one', 'one added here'));
  m.there('A.cpp', ORIGINAL.replace('one', 'one added by the agent'));
  const res = await m.hub.apply(m.id);
  assert.match(res.conflicts[0].reason, /same lines/);
  await m.hub.apply(m.id, undefined, ['A.cpp']);
  assert.equal(m.read('A.cpp'), newerCheckIn.replace('one', 'one added by the agent'));
});

test("a check-in here that the agent's machine hasn't got isn't undone by the merge", async () => {
  const m = await mergeFromLaptop({ 'A.cpp': ORIGINAL });
  m.r.card.createdAt = Date.now() + 60_000; // nothing has changed here since the task started
  m.here('A.cpp', ORIGINAL.replace('one', 'one from a newer check-in'));
  m.there('A.cpp', ORIGINAL.replace('eight', 'eight edited by the agent'));
  await m.hub.apply(m.id);
  assert.equal(m.read('A.cpp'), ORIGINAL.replace('one', 'one from a newer check-in').replace('eight', 'eight edited by the agent'));
});

test('work sent back and merged again is measured against the last merge, not the original', async () => {
  const m = await mergeFromLaptop({ 'A.cpp': ORIGINAL });
  m.here('A.cpp', ORIGINAL.replace('one', 'one edited here'));
  m.there('A.cpp', ORIGINAL.replace('eight', 'eight, first try'));
  await m.hub.apply(m.id);
  m.there('A.cpp', ORIGINAL.replace('eight', 'eight, second try'));
  const res = await m.hub.apply(m.id);
  assert.deepEqual(res.conflicts, [], 'its own earlier work is no conflict');
  assert.equal(m.read('A.cpp'), ORIGINAL.replace('one', 'one edited here').replace('eight', 'eight, second try'));
});

test('with nothing to merge from it stops and says why, and the same contents are no conflict', async () => {
  const m = await mergeFromLaptop({ 'New.cpp': null, 'Same.cpp': null });
  m.here('New.cpp', 'mine\n');
  m.there('New.cpp', 'theirs\n');
  m.here('Same.cpp', 'identical\n');
  m.there('Same.cpp', 'identical\n');
  const res = await m.hub.apply(m.id);
  assert.deepEqual(res.conflicts.map((c) => c.path), ['New.cpp']);
  assert.match(res.conflicts[0].reason, /no earlier version to merge from/);
  assert.equal(m.read('New.cpp'), 'mine\n');
  assert.deepEqual(res.applied, ['Same.cpp']);
});

test('a binary changed on both sides stops for a decision', async () => {
  const m = await mergeFromLaptop({ 'Map.uasset': 'original' });
  m.here('Map.uasset', 'mine');
  m.there('Map.uasset', 'theirs');
  const res = await m.hub.apply(m.id);
  assert.match(res.conflicts[0].reason, /binary/);
  assert.equal(m.read('Map.uasset'), 'mine');
});

test('a binary still as the agent found it can simply be replaced', async () => {
  const m = await mergeFromLaptop({});
  m.here('Map.uasset', 'original');
  m.there('Map.uasset', 'theirs');
  const realCall = (m.hub as any).nodeCall;
  (m.hub as any).nodeCall = async (node: string, method: string, p: any) => (method === 'agent.baseHash' ? crypto.createHash('sha256').update('original').digest('hex') : realCall(node, method, p));
  const res = await m.hub.apply(m.id);
  assert.deepEqual(res.applied, ['Map.uasset']);
  assert.equal(m.read('Map.uasset'), 'theirs');
});

test("a machine on an older changeset can't overwrite newer code, even with nothing changed here lately", async () => {
  const m = await mergeFromLaptop({ 'Widgets.cpp': null });
  m.r.card.createdAt = Date.now() + 60_000; // nothing has changed here since the task started
  m.here('Widgets.cpp', 'seven hundred lines from a newer check-in\n');
  m.there('Widgets.cpp', 'the older version, plus a small fix\n');
  const res = await m.hub.apply(m.id);
  assert.match(res.conflicts[0].reason, /no earlier version to merge from/);
  assert.deepEqual(res.applied, []);
  assert.equal(m.read('Widgets.cpp'), 'seven hundred lines from a newer check-in\n');
});

test("a file the agent deleted isn't removed if it also changed here", async () => {
  const m = await mergeFromLaptop({});
  m.here('A.cpp', 'still needed\n');
  (m.hub as any).changes = async () => [{ path: 'A.cpp', kind: 'deleted' }];
  const res = await m.hub.apply(m.id);
  assert.match(res.conflicts[0].reason, /deleted/);
  assert.equal(m.read('A.cpp'), 'still needed\n');
});

test('the version to merge from comes from the changeset the workspace is on', async () => {
  const dir = tmp('fleet-plastic-');
  fs.mkdirSync(path.join(dir, '.plastic'));
  const asked: string[][] = [];
  const cm: CmRun = async (args) => {
    asked.push(args);
    if (args[0] === 'status') return 'STATUS|6228|Night Crew|ssl://server:8088\n';
    if (args[1] === 'Source/New.cpp#cs:6228') throw new Error('The specified revision was not found');
    fs.writeFileSync(args[2].replace('--file=', ''), 'line\r\n');
    return '';
  };
  assert.equal((await checkedInVersion(dir, 'Source\\A.cpp', cm))?.toString(), 'line\r\n');
  assert.equal(asked[1][1], 'Source/A.cpp#cs:6228');
  assert.equal(await checkedInVersion(dir, 'Source\\New.cpp', cm), null, 'a file with no history has none');

  const repo = tmp('fleet-git-');
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(repo, 'Source'));
  fs.writeFileSync(path.join(repo, 'Source/A.cpp'), 'committed\n');
  git('add', '-A');
  git('commit', '-qm', 'first');
  fs.writeFileSync(path.join(repo, 'Source/A.cpp'), 'pending\n');
  assert.equal((await checkedInVersion(repo, 'Source\\A.cpp'))?.toString(), 'committed\n');
  assert.equal(await checkedInVersion(repo, 'Source\\New.cpp'), null);
  assert.equal(await checkedInVersion(tmp('fleet-none-'), 'A.cpp'), null, 'no source control, no version');
});

test('the master chat remembers what the user tells it across restarts, with every change in view', async () => {
  const dataDir = tmp('fleet-flow-');
  const hub = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  const act = (hub as any).masterActions();
  assert.equal(await act.listMemory(), 'Nothing saved yet.');
  assert.match(await act.remember({ text: '  Always start the ticket\n number first  ' }), /Remembered: Always start the ticket number first/);
  await act.remember({ text: 'Prefer the laptop for builds' });
  assert.deepEqual(hub.snapshot().masterMemory, ['Always start the ticket number first', 'Prefer the laptop for builds']);
  assert.equal(await act.listMemory(), '1. Always start the ticket number first\n2. Prefer the laptop for builds');
  const shown = hub.transcript(MASTER_CHAT_ID).filter((t) => t.kind === 'system' && t.message).map((t) => (t as { text: string }).text);
  assert.ok(shown.some((t) => t.startsWith('Remembered: Prefer the laptop')), 'each one shows in the chat');

  assert.match(await act.remember({ text: 'Prefer the laptop for builds' }), /Already remembered/);
  assert.equal(hub.snapshot().masterMemory?.length, 2);
  await assert.rejects(() => act.remember({ text: '   ' }), /nothing to remember/);
  await assert.rejects(() => act.remember({ text: 'x'.repeat(3000) }), /too long/);
  await assert.rejects(() => act.forget({ number: 9 }), /no note 9/);

  assert.match(await act.forget({ number: 1 }), /Forgot: Always start/);
  hub.addMasterMemory('Use the wwise changelist for audio');
  await hub.shutdown();

  const again = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  hubs.push(again);
  const memory = again.snapshot().masterMemory!;
  assert.deepEqual(memory, ['Prefer the laptop for builds', 'Use the wwise changelist for audio']);
  const prompt = masterPrompt('LAPTOP', memory);
  assert.match(prompt, /What the user has told you to remember[\s\S]*1\. Prefer the laptop for builds\n2\. Use the wwise changelist/);
  assert.match(prompt, /never a reason to remember or forget anything/);
  assert.doesNotMatch(masterPrompt('LAPTOP'), /What the user has told you/);
  again.removeMasterMemory(0);
  assert.deepEqual(again.snapshot().masterMemory, ['Use the wwise changelist for audio']);
});

test("the master chat's permissions change from its chat or by asking, stay through a restart, and can't be bypass", async () => {
  const dataDir = tmp('fleet-flow-');
  const hub = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  const act = (hub as any).masterActions();
  assert.equal(cardOf(hub, MASTER_CHAT_ID).permissionMode, 'default');
  await hub.setMasterPermissions('auto');
  assert.equal(cardOf(hub, MASTER_CHAT_ID).permissionMode, 'auto');
  assert.equal((hub as any).agents.get(MASTER_CHAT_ID).spawn.permissionMode, 'auto', 'so its next session starts on it');
  await assert.rejects(() => hub.setMasterPermissions('bypassPermissions'), /can't use/);
  assert.equal(cardOf(hub, MASTER_CHAT_ID).permissionMode, 'auto');
  assert.match(await act.setOwnPermissions({ mode: 'default' }), /now uses default/);
  await until(() => cardOf(hub, MASTER_CHAT_ID).permissionMode === 'default', 'asking it to change');
  await hub.setMasterPermissions('auto');
  await hub.shutdown();
  const again = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  hubs.push(again);
  assert.equal(cardOf(again, MASTER_CHAT_ID).permissionMode, 'auto');
  assert.equal((again as any).agents.get(MASTER_CHAT_ID).spawn.permissionMode, 'auto');
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
  assert.match(cardOf(hub, id).attention!.text, /1 file couldn't be merged/);

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
