// Bringing another machine's workspace up to date from the master: when it goes ahead, what it clears
// first and what stops it. Plastic is a stand-in here, because nothing here should change a real
// workspace. Git is real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hub } from '../src/hub/hub';
import { RemoteNode } from '../src/hub/link';
import { readProject } from '../src/node/machine';
import type { CmRun } from '../src/node/plastic';
import { readWorkspace, updateWorkspace, type PendingChange } from '../src/node/sourceControl';
import type { NewTask } from '../src/shared/protocol';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const hubs: Hub[] = [];
after(async () => { for (const h of hubs) await h.shutdown(); setTimeout(() => process.exit(0), 200); });

async function until<T>(fn: () => T | undefined | false, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// ---- On the machine itself ----

function fakePlastic(opts: { status?: string[]; versions?: Record<string, string>; onBranch?: string; changeset?: number } = {}) {
  const dir = tmp('fleet-sync-');
  fs.mkdirSync(path.join(dir, '.plastic'));
  const asked: string[][] = [];
  const run: CmRun = async (args) => {
    asked.push(args);
    const [cmd] = args;
    if (cmd === 'status' && args.includes('--header')) return `STATUS|${opts.changeset ?? 6212}|Night Crew|ssl://server:8088\n`;
    if (cmd === 'status') return `${(opts.status ?? []).map((l) => l.replace('<dir>', dir)).join('\n')}\n`;
    if (cmd === 'find' && args[2].includes('changesetid')) return `${opts.onBranch ?? '/main/owen2'}\n`;
    if (cmd === 'find' && args[2].includes('/main/owen2')) return '6100\n6212\n6227\n';
    if (cmd === 'find' && args[2].includes('/main/owen')) return '6228\n6247\n';
    if (cmd === 'find') return '';
    if (cmd === 'cat') {
      const content = opts.versions?.[args[1]];
      if (content === undefined) throw new Error('The specified revision was not found');
      fs.writeFileSync(args[2].replace('--file=', ''), content);
    }
    return '';
  };
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  return { dir, run, asked, write, did: (cmd: string) => asked.filter((a) => a[0] === cmd) };
}
const FOLLOW = { repo: 'Night Crew', branch: '/main/owen' };

test("a machine follows this PC's branch when it's the same repository, and keeps its own otherwise", async () => {
  const p = fakePlastic();
  const state = (await readWorkspace(p.dir, FOLLOW, [], p.run))!;
  assert.equal(state.branch, '/main/owen2');
  assert.equal(state.changeset, '6212');
  assert.equal(state.targetBranch, '/main/owen');
  assert.equal(state.latest, '6247');
  const other = (await readWorkspace(p.dir, { repo: 'Something Else', branch: '/main/owen' }, [], p.run))!;
  assert.equal(other.targetBranch, '/main/owen2');
  assert.equal(other.latest, '6227');
  const noSuchBranch = (await readWorkspace(p.dir, { repo: 'Night Crew', branch: '/main/gone' }, [], p.run))!;
  assert.equal(noSuchBranch.targetBranch, '/main/owen2', "a branch it can't see isn't one to follow");
});

test('a pending change only counts as safe if a checked-in version is byte for byte the same', async () => {
  const p = fakePlastic({
    status: [
      'CH|<dir>\\Same.cpp|False|NO_MERGES', 'CH|<dir>\\OwnBranch.cpp|False|NO_MERGES', 'CH|<dir>\\Edited.cpp|False|NO_MERGES',
      'LD|<dir>\\GoneEverywhere.cpp|False|NO_MERGES', 'LD|<dir>\\GoneOnlyHere.cpp|False|NO_MERGES', 'AD|<dir>\\Added.cpp|False|NO_MERGES',
      'PR|<dir>\\Unrelated.txt|False|NO_MERGES', 'PR|<dir>\\Delivered.cpp|False|NO_MERGES', 'PR|<dir>\\NewFolder|True|NO_MERGES',
    ],
    versions: {
      'Same.cpp#cs:6247': 'same', 'OwnBranch.cpp#cs:6247': 'newer', 'OwnBranch.cpp#cs:6227': 'on its own branch', 'Edited.cpp#cs:6247': 'original', 'Edited.cpp#cs:6227': 'original', 'GoneOnlyHere.cpp#cs:6247': 'still there', 'GoneOnlyHere.cpp#cs:6227': 'still there',
    },
  });
  p.write('Same.cpp', 'same');
  p.write('OwnBranch.cpp', 'on its own branch');
  p.write('Edited.cpp', 'real work');
  p.write('Added.cpp', 'new');
  p.write('Unrelated.txt', 'junk');
  p.write('Delivered.cpp', 'merged already');
  p.write('NewFolder/Test.cpp', 'merged already');
  const state = (await readWorkspace(p.dir, FOLLOW, ['Delivered.cpp', 'NewFolder\\Test.cpp'], p.run))!;
  const by = new Map(state.pending.map((c) => [c.path.replaceAll('\\', '/'), c]));
  assert.equal(by.get('Same.cpp')?.checkedIn, true);
  assert.equal(by.get('OwnBranch.cpp')?.checkedIn, true, 'its own branch has it, so nothing is lost');
  assert.equal(by.get('Edited.cpp')?.checkedIn, false);
  assert.equal(by.get('GoneEverywhere.cpp')?.checkedIn, true, 'deleted, and not there to lose');
  assert.equal(by.get('GoneOnlyHere.cpp')?.checkedIn, false);
  assert.equal(by.get('Added.cpp')?.checkedIn, false);
  assert.equal(by.has('Unrelated.txt'), false, "a file it doesn't know about isn't its business");
  assert.equal(by.get('Delivered.cpp')?.hash, hash('merged already'));
  assert.equal(by.get('NewFolder/Test.cpp')?.status, 'PR', 'found inside a new folder, which is all Plastic lists');
});

test('updating clears only what it was given, checks each again, and never overrides', async () => {
  const p = fakePlastic();
  p.write('Same.cpp', 'same');
  p.write('Added.cpp', 'new');
  p.write('Private.cpp', 'merged');
  const clear: Pick<PendingChange, 'path' | 'status' | 'hash'>[] = [
    { path: 'Same.cpp', status: 'CH', hash: hash('same') }, { path: 'Added.cpp', status: 'AD', hash: hash('new') }, { path: 'Private.cpp', status: 'PR', hash: hash('merged') },
  ];
  await updateWorkspace(p.dir, { targetBranch: '/main/owen', clear }, p.run);
  assert.deepEqual(p.did('undo'), [['undo', path.join(p.dir, 'Same.cpp'), path.join(p.dir, 'Added.cpp')]]);
  assert.equal(fs.existsSync(path.join(p.dir, 'Private.cpp')), false);
  assert.equal(fs.existsSync(path.join(p.dir, 'Added.cpp')), false, 'undoing an add leaves the file behind');
  assert.deepEqual(p.did('switch'), [['switch', 'br:/main/owen', '--noinput']]);
  assert.equal(p.asked.flat().includes('--override'), false);

  const same = fakePlastic({ onBranch: '/main/owen', changeset: 6228 });
  await updateWorkspace(same.dir, { targetBranch: '/main/owen', clear: [] }, same.run);
  assert.deepEqual(same.did('update'), [['update', '--noinput', '--dontmerge']]);
  assert.deepEqual(same.did('switch'), []);
});

test("if a file changed since it was checked, nothing is undone or updated", async () => {
  const p = fakePlastic();
  p.write('Fine.cpp', 'fine');
  p.write('Moved.cpp', 'someone just saved this');
  await assert.rejects(() => updateWorkspace(p.dir, { targetBranch: '/main/owen', clear: [{ path: 'Fine.cpp', status: 'CH', hash: hash('fine') }, { path: 'Moved.cpp', status: 'CH', hash: hash('what it was') }] }, p.run), /Moved\.cpp changed/);
  assert.deepEqual(p.did('undo'), []);
  assert.deepEqual(p.did('switch'), []);
  assert.deepEqual(p.did('update'), []);
});

test('a git workspace fast-forwards, and keeps what is pending', async () => {
  const origin = tmp('fleet-origin-');
  const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe', encoding: 'utf8' }).trim();
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(origin, 'A.txt'), 'one\n');
  fs.writeFileSync(path.join(origin, 'B.txt'), 'one\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-qm', 'first');
  const parent = tmp('fleet-clone-');
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', origin, path.join(parent, 'w')], { stdio: 'ignore' });
  const dir = path.join(parent, 'w');
  assert.equal((await readWorkspace(dir))!.latest, (await readWorkspace(dir))!.changeset, 'nothing to get yet');
  fs.writeFileSync(path.join(origin, 'A.txt'), 'two\n');
  git(origin, 'commit', '-qam', 'second');
  fs.writeFileSync(path.join(dir, 'B.txt'), 'pending\n');
  const state = (await readWorkspace(dir))!;
  assert.equal(state.vcs, 'git');
  assert.notEqual(state.latest, state.changeset);
  const res = await updateWorkspace(dir, { targetBranch: state.targetBranch, clear: [] });
  assert.equal(res.changeset, state.latest);
  assert.equal(fs.readFileSync(path.join(dir, 'A.txt'), 'utf8').replaceAll('\r', ''), 'two\n');
  assert.equal(fs.readFileSync(path.join(dir, 'B.txt'), 'utf8'), 'pending\n');
  assert.equal(await readWorkspace(tmp('fleet-none-')), null);
});

// ---- From the master ----

const LAPTOP_FILE = 'D:\\Laptop\\Game\\Game.uproject';
const BEHIND = { vcs: 'plastic', repo: 'R', branch: '/main/owen2', changeset: '6212', targetBranch: '/main/owen', latest: '6247', pending: [] as PendingChange[], personEditor: false };

function fleetWithLaptop(respond: (method: string, p: any) => any = () => undefined) {
  const hub = new Hub({ dataDir: tmp('fleet-sync-hub-'), version: 'test', demo: true, hostAppPath: null });
  hubs.push(hub);
  const here = tmp('fleet-sync-here-');
  const file = path.join(here, 'Game.uproject');
  fs.writeFileSync(file, '{"EngineAssociation":"5.8"}');
  (hub as any).local.info.projects.unshift(readProject(file, []));
  const calls: { method: string; p: any }[] = [];
  const node = new RemoteNode('laptop', { id: 'laptop', name: 'LAPTOP', role: 'remote', projects: [{ name: 'Game', file: LAPTOP_FILE, dir: path.dirname(LAPTOP_FILE) }], engines: [], maxInstances: 2 } as any);
  node.ws = { readyState: 1, terminate() {} } as any;
  (node as any).call = async (method: string, p: any) => {
    calls.push({ method, p });
    const answer = respond(method, p);
    if (answer !== undefined) return answer;
    if (method === 'machine.refreshProjects') return node.info.projects;
    if (method === 'machine.workspaceState') return BEHIND;
    if (method === 'machine.updateWorkspace') return { changeset: '6247' };
    return { ok: true };
  };
  (hub as any).link.nodes.set('laptop', node);
  const realRpc = (hub as any).local.rpc.bind((hub as any).local);
  (hub as any).local.rpc = (method: string, p: any) => (method === 'machine.workspaceBranch' ? Promise.resolve({ repo: 'R', branch: '/main/owen' }) : realRpc(method, p));
  const task = (extra: Partial<NewTask> = {}): NewTask => ({ prompt: 'Do it', projectFile: file, nodeId: 'laptop', model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'default', instanceMode: 'headless', demo: 'clean', ...extra });
  return { hub, calls, task, act: (hub as any).masterActions(), rec: (id: string) => (hub as any).agents.get(id), asked: (m: string) => calls.filter((c) => c.method === m) };
}

test('a task on a machine that is behind gets the latest changes first, and not again straight after', async () => {
  const f = fleetWithLaptop();
  const id = await f.hub.createAgent(f.task());
  await until(() => f.asked('agent.spawn').length, 'the agent to start');
  const order = f.calls.map((c) => c.method);
  assert.ok(order.indexOf('machine.updateWorkspace') < order.indexOf('agent.spawn'), order.join());
  assert.deepEqual(f.asked('machine.workspaceState')[0].p.follow, { repo: 'R', branch: '/main/owen' }, "it follows this PC's branch");
  assert.equal(f.asked('machine.updateWorkspace')[0].p.targetBranch, '/main/owen');
  assert.ok(f.hub.transcript(id).some((t) => t.kind === 'system' && /Updated LAPTOP to changeset 6247.*moving it from \/main\/owen2/.test(t.text)));

  f.rec(id).card.stage = 'complete';
  await f.hub.createAgent(f.task());
  await until(() => f.asked('agent.spawn').length === 2, 'the second agent');
  assert.equal(f.asked('machine.updateWorkspace').length, 1, 'it was only just updated');
});

test('a machine already up to date is left alone', async () => {
  const f = fleetWithLaptop((m) => (m === 'machine.workspaceState' ? { ...BEHIND, branch: '/main/owen', changeset: '6247' } : undefined));
  await f.hub.createAgent(f.task());
  await until(() => f.asked('agent.spawn').length, 'the agent to start');
  assert.equal(f.asked('machine.updateWorkspace').length, 0);
});

test('it never updates mid-task: it waits for unfinished work, then goes ahead', async () => {
  const f = fleetWithLaptop();
  (f.hub as any).lastSynced[`laptop|${LAPTOP_FILE.replaceAll('\\', '/').toLowerCase()}`] = Date.now();
  const running = await f.hub.createAgent(f.task());
  await until(() => f.asked('agent.spawn').length, 'the agent to start');
  await until(() => !f.rec(running).launching, 'it to be running');
  f.rec(running).card.status = 'working';

  const said = await f.act.updateWorkspace({ machine: 'LAPTOP' });
  assert.match(said, /work in progress there \(agent \d+\), so it'll update as soon as that's finished/);
  (f.hub as any).runQueuedSyncs();
  await sleep(100);
  assert.equal(f.asked('machine.updateWorkspace').length, 0, 'still working');

  // Waiting on the user counts too, because its files are still pending there.
  f.rec(running).card.status = 'finished';
  f.rec(running).card.stage = 'testing';
  (f.hub as any).runQueuedSyncs();
  await sleep(100);
  assert.equal(f.asked('machine.updateWorkspace').length, 0, 'still waiting to be tested');

  f.rec(running).card.stage = 'complete';
  (f.hub as any).runQueuedSyncs();
  await until(() => f.asked('machine.updateWorkspace').length, 'the update to run');
  await until(() => f.hub.transcript('master-chat').some((t) => t.kind === 'system' && t.text.includes('Updated LAPTOP')), 'the master chat to hear');
});

test('a new task beside unfinished work starts from what is on disk, and the update waits', async () => {
  const f = fleetWithLaptop();
  const busy = await f.hub.createAgent(f.task());
  await until(() => f.asked('agent.spawn').length === 1, 'the first agent');
  await until(() => !f.rec(busy).launching, 'it to be running');
  f.rec(busy).card.status = 'working';
  (f.hub as any).lastSynced = {};
  f.asked('machine.updateWorkspace').length = 0;
  const before = f.asked('machine.updateWorkspace').length;
  const next = await f.hub.createAgent(f.task());
  await until(() => f.asked('agent.spawn').length === 2, 'the second agent');
  assert.equal(f.asked('machine.updateWorkspace').length, before);
  assert.ok(f.hub.transcript(next).some((t) => t.kind === 'system' && /mid-task there/.test(t.text)));
  assert.equal((f.hub as any).queuedSyncs.size, 1);
});

test('pending work it cannot prove safe stops the update, and the task still starts', async () => {
  const pending = [
    { path: 'Edited.cpp', status: 'CH', hash: 'h1', checkedIn: false },
    { path: 'Same.cpp', status: 'CH', hash: 'h2', checkedIn: true },
    { path: 'Delivered.cpp', status: 'CH', hash: hash('merged'), checkedIn: false },
    { path: 'NotDelivered.cpp', status: 'CH', hash: hash('something else'), checkedIn: false },
    { path: 'Junk.txt', status: 'PR', hash: 'h3', checkedIn: false },
  ];
  const f = fleetWithLaptop((m) => (m === 'machine.workspaceState' ? { ...BEHIND, pending } : undefined));
  (f.hub as any).delivered.laptop = { 'Delivered.cpp': [hash('merged')], 'NotDelivered.cpp': [hash('merged')] };
  const said = await f.act.updateWorkspace({ machine: 'LAPTOP' });
  assert.match(said, /wasn't updated, because 2 pending changes/);
  assert.match(said, /Edited\.cpp, NotDelivered\.cpp/);
  assert.equal(f.asked('machine.updateWorkspace').length, 0);

  const status = JSON.parse(await f.act.workspaceStatus({ machine: 'LAPTOP' }));
  assert.equal(status.behind, true);
  assert.deepEqual(status.inTheWay, ['CH Edited.cpp', 'CH NotDelivered.cpp']);
  assert.equal(status.safeToClear, 2);

  const id = await f.hub.createAgent(f.task());
  await until(() => f.asked('agent.spawn').length, 'the agent to start anyway');
  assert.ok(f.hub.transcript(id).some((t) => t.kind === 'system' && /wasn't updated.*starts from what's on disk/.test(t.text)));

  f.rec(id).card.stage = 'complete';
  assert.match(await f.act.updateWorkspace({ machine: 'LAPTOP', discard: ['Edited.cpp', 'NotDelivered.cpp'] }), /Updated LAPTOP/);
  const cleared = f.asked('machine.updateWorkspace')[0].p.clear.map((c: PendingChange) => c.path);
  assert.deepEqual(cleared.sort(), ['Delivered.cpp', 'Edited.cpp', 'NotDelivered.cpp', 'Same.cpp'], 'and never the file it knows nothing about');
  assert.equal((f.hub as any).delivered.laptop, undefined, 'what was delivered has been dealt with');
});

test('someone with an editor open there stops the update', async () => {
  const f = fleetWithLaptop((m) => (m === 'machine.workspaceState' ? { ...BEHIND, personEditor: true } : undefined));
  assert.match(await f.act.updateWorkspace({ machine: 'LAPTOP' }), /open in an editor there/);
  assert.equal(f.asked('machine.updateWorkspace').length, 0);
});

test('this PC is never updated this way, because the user works in it', async () => {
  const f = fleetWithLaptop();
  const name = f.hub.machines()[0].info.name;
  assert.match(await f.act.updateWorkspace({ machine: name }), /open_workspace_chat/);
  assert.equal(f.calls.length, 0);
});

test('a host too old to do this, or an update that fails, never stops the task', async () => {
  const old = fleetWithLaptop((m) => { if (m === 'machine.workspaceState') throw new Error('Unknown method machine.workspaceState'); return undefined; });
  const id = await old.hub.createAgent(old.task());
  await until(() => old.asked('agent.spawn').length, 'the agent to start');
  assert.ok(old.hub.transcript(id).some((t) => t.kind === 'system' && /needs a new fleet-host\.exe/.test(t.text)));

  const failing = fleetWithLaptop((m) => { if (m === 'machine.updateWorkspace') throw new Error('Could not reach the server'); return undefined; });
  const id2 = await failing.hub.createAgent(failing.task());
  await until(() => failing.asked('agent.spawn').length, 'the agent to start');
  assert.ok(failing.hub.transcript(id2).some((t) => t.kind === 'system' && /Could not reach the server/.test(t.text)));
});

test("the machine waits for its update before restarting into a new host, and tasks wait for the update", async () => {
  let finish = (_v: unknown) => {};
  const f = fleetWithLaptop((m) => (m === 'machine.updateWorkspace' ? new Promise((r) => { finish = r; }) : undefined));
  const id = await f.hub.createAgent(f.task());
  await until(() => f.asked('machine.updateWorkspace').length, 'the update to start');
  assert.equal((f.hub as any).busyOn('laptop') > 0, true);
  assert.equal(f.rec(id).card.detail, 'Getting the latest changes');
  const second = f.hub.createAgent(f.task());
  await sleep(100);
  assert.equal(f.asked('machine.updateWorkspace').length, 1, 'one at a time');
  assert.equal(f.asked('agent.spawn').length, 0);
  finish({ changeset: '6247' });
  await second;
  await until(() => f.asked('agent.spawn').length === 2, 'both to start');
  assert.equal((f.hub as any).workspaceSyncs.size, 0);
});
