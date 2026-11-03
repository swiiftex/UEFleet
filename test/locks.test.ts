// Packages someone else has locked in source control: finding out who has them, merging in their
// check-in, and a task waiting in the blocked state until that's sorted. Plastic is a stand-in here,
// answering in the exact formats the real cm prints, because nothing here should touch a real workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hub } from '../src/hub/hub';
import { RemoteNode } from '../src/hub/link';
import { readProject } from '../src/node/machine';
import type { CmRun } from '../src/node/plastic';
import { bringInPackages, packageFile, packageLocks, readMergePreview } from '../src/node/sourceControl';
import { describeLock, type NewTask, type PackageLock } from '../src/shared/protocol';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

const HELD = 'Content/Maps/BP_Platform.uasset';
const FREE = 'Content/BlurVHS.uasset';
const lockLine = (file: string, status: string, by: string, workspace = 'Game') => `Game|2243018|570639b5|02/11/2026 15:49:58|/main|2242201|/main/develop/sam|4816722|${status}|${by}|${workspace}|/${file}`;

function fakePlastic(opts: { locked?: Record<string, string>; preview?: string; pending?: string[]; history?: string; lockListFails?: boolean; me?: string; here?: string } = {}) {
  const dir = tmp('fleet-locks-');
  fs.mkdirSync(path.join(dir, '.plastic'));
  const asked: string[][] = [];
  const run: CmRun = async (args) => {
    asked.push(args);
    const [cmd] = args;
    if (cmd === 'fileinfo') return `${args.filter((a) => !a.startsWith('--') && a !== 'fileinfo').map((f) => `/${f}|${opts.locked?.[f] ? 'True' : 'False'}`).join('\n')}\n`;
    if (cmd === 'lock') {
      if (opts.lockListFails) throw new Error("You don't have permissions for operation read.");
      // The real one refuses a whole list over one file that isn't in source control.
      const wanted = args.slice(2).filter((a) => !a.startsWith('--'));
      assert.ok(wanted.every((f) => opts.locked?.[f]), `asked about ${wanted}`);
      return `${wanted.map((f) => opts.locked![f]).join('\n')}\n`;
    }
    if (cmd === 'whoami') return `${opts.me ?? 'me@example.com'}\n`;
    if (cmd === 'getworkspacefrompath') return `${opts.here ?? 'Game'}\n`;
    if (cmd === 'history') return opts.history ?? '2261|/main/develop/kim\n6100|/main/develop/sam\n6214|/main/develop/sam\n6300|/main/develop/kim\n';
    if (cmd === 'merge' && args.includes('--merge')) return '';
    if (cmd === 'merge') return opts.preview ?? 'No merges detected\n';
    if (cmd === 'status') return `${(opts.pending ?? []).map((l) => l.replaceAll('<dir>', dir)).join('\n')}\n`;
    throw new Error(`Unexpected cm ${args.join(' ')}`);
  };
  return { dir, run, asked, did: (cmd: string) => asked.filter((a) => a[0] === cmd), merges: () => asked.filter((a) => a.includes('--merge')) };
}

const CLEAN_PREVIEW = `The file /${HELD}#cs:6214 was modified on source and will replace the destination version\nThe item /Content/New.uasset#cs:6214 has been added on source and will be added as result of the merge\nThe item /Content/Old.uasset#cs:6214 has been deleted on source and will be deleted as result of the merge\nThe item /Source/A.h#cs:6214 was changed on source but it has been discarded during merge because the content is the same on source and destination\n`;
const LOCK: PackageLock = { path: HELD, by: 'sam@example.com', branch: '/main/develop/sam', destination: '/main', status: 'Retained', changeset: '6214' };

test('a merge preview says what would change, and anything it can not vouch for counts as a problem', () => {
  assert.deepEqual(readMergePreview(CLEAN_PREVIEW), { files: [HELD, 'Content/New.uasset', 'Content/Old.uasset'], problems: [] });
  assert.deepEqual(readMergePreview('No merges detected\n'), { files: [], problems: [] });
  const bad = readMergePreview(`The file /Content/L_Tutorial.umap needs to be merged from cs:6214 to cs:6093 base cs:6170. Changed by both contributors.\nChange/Not loaded conflict: \n\tSource: Modified /Certification/State.json\n\tDestination: Deleted /Certification\nSomething new from a later Plastic\n`);
  assert.equal(bad.files.length, 0);
  assert.deepEqual(bad.problems, ['Content/L_Tutorial.umap changed on both sides', 'Change/Not loaded conflict: Source: Modified /Certification/State.json Destination: Deleted /Certification', 'Something new from a later Plastic']);
});

test('packages are named however the agent has them', () => {
  const dir = tmp('fleet-locks-names-');
  fs.mkdirSync(path.join(dir, 'Content', 'Maps'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Content', 'Maps', 'L_Test.umap'), '');
  assert.equal(packageFile(dir, '/Game/Maps/L_Test.L_Test'), 'Content/Maps/L_Test.umap');
  assert.equal(packageFile(dir, '/Game/Maps/BP_Door'), 'Content/Maps/BP_Door.uasset');
  assert.equal(packageFile(dir, path.join(dir, 'Content', 'A.uasset')), 'Content/A.uasset');
  assert.equal(packageFile(dir, 'Content\\A.uasset'), 'Content/A.uasset');
  assert.equal(packageFile(dir, '/Content/A.uasset'), 'Content/A.uasset');
});

test("it finds who holds a lock and which check-in has it, and asks about nothing that isn't a locked package", async () => {
  const p = fakePlastic({ locked: { [HELD]: lockLine(HELD, 'Retained', 'sam@example.com') }, preview: CLEAN_PREVIEW });
  const locks = await packageLocks(p.dir, [HELD, FREE, 'Source/Game.cpp', 'Content/Missing.uasset'], p.run);
  assert.deepEqual(locks, [{ path: HELD, by: 'sam@example.com', branch: '/main/develop/sam', destination: '/main', status: 'Retained', changeset: '6214' }]);
  assert.match(describeLock(locks[0]), /Checked in by sam@example.com on \/main\/develop\/sam, and locked until that reaches \/main/);
  assert.ok(!p.did('fileinfo')[0].includes('Source/Game.cpp'), "code can't be locked this way");
  assert.deepEqual(p.did('lock')[0].slice(2).filter((a) => !a.startsWith('--')), [HELD]);
});

test('with nothing locked it only asks once, and outside Plastic not at all', async () => {
  const p = fakePlastic();
  assert.deepEqual(await packageLocks(p.dir, [FREE], p.run), []);
  assert.deepEqual(p.asked.map((a) => a[0]), ['fileinfo']);
  const asked: string[] = [];
  assert.deepEqual(await packageLocks(tmp('fleet-locks-none-'), [FREE], async (a) => { asked.push(a[0]); return ''; }), []);
  assert.equal(asked.length, 0);
});

test('a lock this workspace holds itself is no problem, but the same name on someone else or another of yours is', async () => {
  const mine = fakePlastic({ locked: { [HELD]: lockLine(HELD, 'Locked', 'ME@example.com') } });
  assert.deepEqual(await packageLocks(mine.dir, [HELD], mine.run), []);
  // Everyone on a team may well call their workspace the same thing.
  const sameName = fakePlastic({ locked: { [HELD]: lockLine(HELD, 'Locked', 'sam@example.com') } });
  assert.equal((await packageLocks(sameName.dir, [HELD], sameName.run)).length, 1);
  const laptop = fakePlastic({ locked: { [HELD]: lockLine(HELD, 'Locked', 'me@example.com', 'Laptop') } });
  assert.equal((await packageLocks(laptop.dir, [HELD], laptop.run)).length, 1);
});

test('someone with it checked out right now has nothing to merge in yet', async () => {
  const p = fakePlastic({ locked: { [HELD]: lockLine(HELD, 'Locked', 'sam@example.com') } });
  const [lock] = await packageLocks(p.dir, [HELD], p.run);
  assert.equal(lock.status, 'Locked');
  assert.equal(lock.changeset, undefined);
  assert.match(describeLock(lock), /Checked out by sam@example.com/);
  assert.equal(p.did('history').length, 0);
  const res = await bringInPackages(p.dir, [lock], undefined, p.run);
  assert.equal(res.outcome, 'refused');
  assert.equal(p.merges().length, 0);
});

test('a retained lock whose check-in this workspace already has is no problem', async () => {
  const p = fakePlastic({ locked: { [HELD]: lockLine(HELD, 'Retained', 'sam@example.com') }, preview: 'No merges detected\n' });
  assert.deepEqual(await packageLocks(p.dir, [HELD], p.run), []);
});

test("it's still locked when the server won't say who has it", async () => {
  const p = fakePlastic({ locked: { [HELD]: 'x' }, lockListFails: true });
  const [lock] = await packageLocks(p.dir, [HELD], p.run);
  assert.deepEqual(lock, { path: HELD, by: '', branch: '', destination: '', status: 'Locked' });
  assert.match(describeLock(lock), /Checked out by someone else/);
});

test('a clean merge goes ahead, editors stop only once it is sure to, and nothing is checked in', async () => {
  const p = fakePlastic({ preview: CLEAN_PREVIEW, pending: ['CH|<dir>\\Source\\Mine.cpp|False|NO_MERGES', 'CO|<dir>\\Content\\Maps|True|NO_MERGES'] });
  let stopped = 0;
  const res = await bringInPackages(p.dir, [LOCK, { ...LOCK, path: 'Content/Other.uasset' }], async () => { stopped++; }, p.run);
  assert.deepEqual(res, { outcome: 'merged', changesets: ['6214'], files: [HELD, 'Content/New.uasset', 'Content/Old.uasset'] });
  assert.equal(stopped, 1);
  assert.deepEqual(p.merges(), [['merge', 'cs:6214', '--cherrypicking', '--merge', '--nointeractiveresolution', '--noprintoperations']]);
  assert.equal(p.did('checkin').length, 0);
});

test('it refuses to merge anything that needs a decision or touches pending changes, without stopping editors', async () => {
  const stop = async () => { throw new Error('editors stopped for nothing'); };
  const conflict = fakePlastic({ preview: 'The file /Content/L_Tutorial.umap needs to be merged from cs:6214 to cs:6093 base cs:6170. Changed by both contributors.\n' });
  const a = await bringInPackages(conflict.dir, [LOCK], stop, conflict.run);
  assert.equal(a.outcome, 'refused');
  assert.match((a as any).why, /Changeset 6214 needs someone to merge it by hand: Content\/L_Tutorial\.umap changed on both sides/);
  assert.equal(conflict.merges().length, 0);

  for (const [pending, what] of [
    [`CH|<dir>\\${HELD.replaceAll('/', '\\')}|False|NO_MERGES`, 'the same file'],
    ['PR|<dir>\\Content\\New.uasset|False|NO_MERGES', 'a private file where a new one would go'],
    ['PR|<dir>\\Content|True|NO_MERGES', 'a private folder over it'],
  ] as const) {
    const p = fakePlastic({ preview: CLEAN_PREVIEW, pending: [pending] });
    const res = await bringInPackages(p.dir, [LOCK], stop, p.run);
    assert.equal(res.outcome, 'refused', what);
    assert.match((res as any).why, /changes in this workspace/, what);
    assert.equal(p.merges().length, 0, what);
  }
});

test('a check-in that can no longer be found is refused, and one already in reports that', async () => {
  const p = fakePlastic();
  assert.equal((await bringInPackages(p.dir, [{ ...LOCK, changeset: undefined }], undefined, p.run)).outcome, 'refused');
  assert.deepEqual(await bringInPackages(p.dir, [LOCK], undefined, p.run), { outcome: 'already' });
});

test('a merge that stops part way reports what cm said', async () => {
  const p = fakePlastic({ preview: CLEAN_PREVIEW });
  const run: CmRun = async (args) => {
    if (args.includes('--merge')) throw Object.assign(new Error('failed'), { stderr: 'first line\nThe file is in use' });
    return p.run(args);
  };
  assert.deepEqual(await bringInPackages(p.dir, [LOCK], undefined, run), { outcome: 'failed', why: 'The file is in use' });
});

// ---- From the master ----

const LAPTOP_FILE = 'D:\\Laptop\\Game\\Game.uproject';

function fleet(respond: (method: string, p: any) => any = () => undefined) {
  const hub = new Hub({ dataDir: tmp('fleet-locks-hub-'), version: 'test', demo: true, hostAppPath: null });
  hubs.push(hub);
  const here = tmp('fleet-locks-here-');
  const file = path.join(here, 'Game.uproject');
  fs.writeFileSync(file, '{"EngineAssociation":"5.8"}');
  (hub as any).local.info.projects.unshift(readProject(file, []));
  const calls: { method: string; p: any }[] = [];
  const node = new RemoteNode('laptop', { id: 'laptop', name: 'LAPTOP', role: 'remote', projects: [{ name: 'Game', file: LAPTOP_FILE, dir: path.dirname(LAPTOP_FILE) }], engines: [], maxInstances: 2 } as any);
  node.ws = { readyState: 1, terminate() {} } as any;
  const answer = (method: string, p: any) => {
    calls.push({ method, p });
    const a = respond(method, p);
    if (a !== undefined) return a;
    if (method === 'machine.refreshProjects') return node.info.projects;
    if (method === 'machine.workspaceState') return null;
    if (method === 'machine.packageLocks') return [];
    if (method === 'agent.changes') return [];
    return { ok: true };
  };
  (node as any).call = async (method: string, p: any) => answer(method, p);
  (hub as any).link.nodes.set('laptop', node);
  const realRpc = (hub as any).local.rpc.bind((hub as any).local);
  (hub as any).local.rpc = (method: string, p: any) => (method.startsWith('machine.packageLocks') || method.startsWith('machine.bringIn') ? Promise.resolve(answer(method, p)) : realRpc(method, p));
  const task = (extra: Partial<NewTask> = {}): NewTask => ({ prompt: 'Do it', projectFile: file, nodeId: 'laptop', model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'default', instanceMode: 'headless', ...extra });
  const start = async (extra?: Partial<NewTask>) => {
    const id = await hub.createAgent(task(extra));
    await until(() => calls.some((c) => c.method === 'agent.spawn' && c.p.id === id), 'the agent to start');
    await until(() => !(hub as any).agents.get(id).launching, 'it to be running');
    return { id, r: (hub as any).agents.get(id), card: (hub as any).agents.get(id).card };
  };
  return {
    hub, calls, start, file,
    act: (hub as any).masterActions(),
    asked: (m: string) => calls.filter((c) => c.method === m),
    told: (id: string) => calls.filter((c) => c.method === 'agent.send' && c.p.agentId === id).map((c) => c.p.text as string),
    event: (id: string, ev: any) => (hub as any).reduce((hub as any).agents.get(id), ev),
    check: (id: string) => (hub as any).checkLocks((hub as any).agents.get(id)),
    says: (id: string, re: RegExp) => hub.transcript(id).some((t) => t.kind === 'system' && re.test(t.text)),
  };
}

// The agent has said so, and its turn is over.
function reportBlocked(f: ReturnType<typeof fleet>, id: string, locks: PackageLock[] = [LOCK]) {
  f.event(id, { k: 'activity', status: 'working' });
  f.event(id, { k: 'blocked', locks, why: 'Nothing else sets the timing.' });
  f.event(id, { k: 'activity', status: 'working', bucket: 'thinking' });
  f.event(id, { k: 'turn-end' });
}

test('a blocked task goes red, says who has it, and stays that way through the end of its turn', async () => {
  const f = fleet((m) => (m === 'machine.packageLocks' ? [LOCK] : m === 'machine.bringInPackages' ? { outcome: 'refused', why: 'Changeset 6214 needs someone to merge it by hand.' } : undefined));
  const { id, card } = await f.start();
  const attention: any[] = [];
  f.hub.on('attention', (c: any) => attention.push(c.attention?.kind));
  f.event(id, { k: 'activity', status: 'working' });
  f.event(id, { k: 'blocked', locks: [LOCK], why: 'Nothing else sets the timing.' });
  assert.equal(card.status, 'blocked');
  assert.equal(card.attention.kind, 'blocked');
  assert.equal(card.attention.text, 'BP_Platform.uasset is locked by sam@example.com.');
  assert.equal(card.blocked.why, 'Nothing else sets the timing.');
  assert.deepEqual(attention, ['blocked']);
  assert.ok(f.says(id, /Blocked:\nContent\/Maps\/BP_Platform\.uasset: Checked in by sam@example\.com/));
  await sleep(50);
  assert.equal(f.asked('machine.packageLocks').length, 0, 'it waits for the turn to end before doing anything about it');

  f.event(id, { k: 'activity', status: 'working', bucket: 'thinking' });
  assert.equal(card.status, 'blocked', 'still working through its last message');
  f.event(id, { k: 'turn-end' });
  assert.equal(card.status, 'blocked');
  await until(() => card.blocked.plan?.includes("Can't merge it in by itself"), 'it to try');
  assert.match(card.blocked.plan, /Changeset 6214 needs someone to merge it by hand\. It's free once sam@example\.com merges \/main\/develop\/sam into \/main\./);

  f.hub.dismissAttention(id);
  assert.equal(card.attention?.kind, 'blocked', "looking at it doesn't settle it");
  assert.equal(attention.length, 1);
  assert.match(JSON.stringify(f.act.agents()), /blockedOn.*sam@example\.com/);
});

test('the lock going away tells the agent to carry on', async () => {
  let locks: PackageLock[] = [{ ...LOCK, status: 'Locked', changeset: undefined }];
  const f = fleet((m) => (m === 'machine.packageLocks' ? locks : undefined));
  const { id, card } = await f.start();
  reportBlocked(f, id, locks);
  await until(() => card.blocked?.plan, 'the first check');
  assert.match(card.blocked.plan, /Waiting for sam@example\.com to check it in/);
  assert.equal(f.asked('machine.bringInPackages').length, 0, "there's no check-in to merge in yet");

  locks = [];
  await f.check(id);
  assert.equal(card.blocked, undefined);
  assert.equal(card.attention, null);
  await until(() => f.told(id).length, 'the agent to hear');
  assert.match(f.told(id)[0], /Content\/Maps\/BP_Platform\.uasset isn't locked any more\. Carry on with your task\./);
  assert.equal(card.status, 'idle');
});

test('a checked-in lock is merged in by itself, and both the agent and the user hear what that means', async () => {
  const f = fleet((m) => (m === 'machine.packageLocks' ? [LOCK] : m === 'machine.bringInPackages' ? { outcome: 'merged', changesets: ['6214'], files: [HELD, 'Content/New.uasset'] } : undefined));
  const { id, card } = await f.start();
  reportBlocked(f, id);
  await until(() => f.told(id).length, 'the agent to hear');
  assert.equal(card.blocked, undefined);
  assert.equal(f.asked('machine.bringInPackages')[0].p.file, LAPTOP_FILE, 'in the workspace the agent is using');
  assert.match(f.told(id)[0], /merged sam@example\.com's check-in \(changeset 6214\) into this workspace, so you have their version of Content\/Maps\/BP_Platform\.uasset, and 2 files changed with it/);
  assert.ok(f.says(id, /Nothing was checked in\. Plastic lists it as "Cherrypicking from cs:6214", and won't check in anything else until those files go in/));
});

test('it never merges under another agent mid-task, and the user can choose to pause them', async () => {
  let merged = false;
  const f = fleet((m) => (m === 'machine.packageLocks' ? (merged ? [] : [LOCK]) : m === 'machine.bringInPackages' ? ((merged = true), { outcome: 'merged', changesets: ['6214'], files: [HELD] }) : undefined));
  const other = await f.start();
  other.card.status = 'working';
  const { id, card } = await f.start();
  reportBlocked(f, id);
  await until(() => card.blocked?.plan, 'the first check');
  assert.match(card.blocked.plan, /merges in once the other agent here stops, so nothing changes mid-task/);
  assert.equal(card.blocked.canPause, true);
  assert.equal(f.asked('machine.bringInPackages').length, 0);

  // Waiting on the user isn't mid-task, and its files are covered by not overlapping pending changes.
  await f.hub.mergeBlockedNow(id);
  assert.equal(f.asked('machine.bringInPackages').length, 1);
  assert.equal(card.blocked, undefined);
  assert.equal(other.card.pausedForWorkspace, false);
  assert.ok(f.says(other.id, /Paused while UE Fleet changes the workspace/));
  assert.equal(card.holdingWorkspace, false);
  await until(() => f.told(other.id).length, 'the other agent to hear');
  assert.match(f.told(other.id)[0], /UE Fleet has finished changing the workspace: someone's check-in of a locked package was merged in\./);
  assert.equal(f.asked('agent.interrupt').filter((c) => c.p.agentId === other.id).length, 1);
});

test('once the other agents have stopped it goes ahead by itself', async () => {
  const f = fleet((m) => (m === 'machine.packageLocks' ? [LOCK] : m === 'machine.bringInPackages' ? { outcome: 'merged', changesets: ['6214'], files: [HELD] } : undefined));
  const other = await f.start();
  other.card.status = 'working';
  const { id, card } = await f.start();
  reportBlocked(f, id);
  await until(() => card.blocked?.plan, 'the first check');
  other.card.status = 'finished';
  await f.check(id);
  assert.equal(f.asked('machine.bringInPackages').length, 1);
  assert.equal(card.blocked, undefined);
});

test('a refused merge waits before trying again, unless you press the button, and a failed one waits for the button', async () => {
  let outcome: any = { outcome: 'refused', why: 'You have an editor open on this project.' };
  const f = fleet((m) => (m === 'machine.packageLocks' ? [LOCK] : m === 'machine.bringInPackages' ? outcome : undefined));
  const { id, r, card } = await f.start();
  reportBlocked(f, id);
  await until(() => f.asked('machine.bringInPackages').length === 1, 'the first try');
  await until(() => !r.checkingLocks, 'it to finish');
  await f.check(id);
  assert.equal(f.asked('machine.bringInPackages').length, 1, 'too soon');
  r.mergeTried.at -= 6 * 60_000;
  await f.check(id);
  assert.equal(f.asked('machine.bringInPackages').length, 2, 'long enough');

  outcome = { outcome: 'failed', why: 'The file is in use' };
  await f.hub.checkBlocked(id);
  assert.equal(f.asked('machine.bringInPackages').length, 3, 'pressed');
  assert.match(card.blocked.plan, /The merge stopped: The file is in use\. Part of it may be in your workspace/);
  assert.ok(f.says(id, /stopped: The file is in use/));
  r.mergeTried.at -= 60 * 60_000;
  await f.check(id);
  assert.equal(f.asked('machine.bringInPackages').length, 3, 'never by itself after that');
  await f.hub.checkBlocked(id);
  assert.equal(f.asked('machine.bringInPackages').length, 4);
});

test('messaging, interrupting or stopping a blocked agent ends its wait', async () => {
  const f = fleet((m) => (m === 'machine.packageLocks' ? [LOCK] : m === 'machine.bringInPackages' ? { outcome: 'refused', why: 'No.' } : undefined));
  const a = await f.start();
  reportBlocked(f, a.id);
  await f.hub.send(a.id, 'Do it another way');
  assert.equal(a.card.blocked, undefined);
  assert.notEqual(a.card.status, 'blocked');
  f.event(a.id, { k: 'turn-end' });
  assert.equal(a.card.status, 'attention', 'and it can end a turn normally again');

  const b = await f.start();
  reportBlocked(f, b.id);
  await f.hub.stopAgent(b.id);
  assert.equal(b.card.blocked, undefined);
  assert.equal(b.card.status, 'stopped');

  const c = await f.start();
  f.event(c.id, { k: 'activity', status: 'working' });
  f.event(c.id, { k: 'blocked', locks: [LOCK] });
  f.event(c.id, { k: 'turn-end', interrupted: true });
  assert.equal(c.card.blocked, undefined);
  assert.equal(c.card.status, 'idle');
});

test('a blocked task means not everything is done yet', async () => {
  const f = fleet((m) => (m === 'machine.packageLocks' ? [LOCK] : m === 'machine.bringInPackages' ? { outcome: 'refused', why: 'No.' } : undefined));
  const allDone: any[] = [];
  f.hub.on('hub', (e: any) => { if (e.e === 'all-done') allDone.push(e); });
  const { id } = await f.start();
  reportBlocked(f, id);
  await sleep(150);
  assert.equal(allDone.length, 0);
});

const FINAL = { summary: 'Done.', verified: ['Compiled'], needsTesting: [], at: 1 };
const SENT = { data: Buffer.from('from the agent').toString('base64'), last: true, mtime: 1 };
const CHANGED = [{ path: HELD, kind: 'modified', binary: true }, { path: 'Source/Game.cpp', kind: 'modified', binary: false }];

test("a finished task's locked package stops it before it merges, and it moves on when the lock goes", async () => {
  let locks: PackageLock[] = [{ ...LOCK, status: 'Locked', changeset: undefined }];
  const f = fleet((m) => (m === 'machine.packageLocks' ? locks : m === 'agent.changes' ? CHANGED : m === 'agent.readFile' ? SENT : undefined));
  const { id, r, card } = await f.start();
  f.event(id, { k: 'final', report: FINAL });
  await until(() => card.blocked, 'it to be blocked');
  assert.equal(card.stage, 'awaiting-merge');
  assert.equal(card.status, 'blocked');
  assert.equal(card.blocked.onMerge, true);
  assert.deepEqual(f.asked('machine.packageLocks')[0].p.paths, [HELD], 'only packages can be locked this way');
  assert.equal(f.asked('machine.packageLocks')[0].p.file, f.file, "it's about the user's own workspace");
  assert.equal(f.asked('agent.readFile').length, 0, 'nothing moved yet');
  f.event(id, { k: 'turn-end' });
  assert.equal(card.status, 'blocked', 'the end of its turn changes nothing');
  assert.ok(card.blocked);
  await until(() => !r.checkingLocks, 'that check to finish');

  locks = [];
  await f.check(id);
  await until(() => f.asked('agent.readFile').length, 'its files to move');
  assert.equal(card.blocked, undefined);
  assert.equal(card.status, 'finished');
  await until(() => card.stage !== 'awaiting-merge', 'it to move on');
  assert.equal(f.told(id).length, 0, 'nothing for the agent to do');
});

test('Carry on anyway moves a finished task past the lock, and it stays past it', async () => {
  const f = fleet((m) => (m === 'machine.packageLocks' ? [{ ...LOCK, status: 'Locked', changeset: undefined }] : m === 'agent.changes' ? CHANGED : m === 'agent.readFile' ? SENT : undefined));
  const { id, card } = await f.start();
  f.event(id, { k: 'final', report: FINAL });
  await until(() => card.blocked, 'it to be blocked');
  await f.hub.carryOnPastBlock(id);
  await until(() => f.asked('agent.readFile').length, 'its files to move');
  assert.equal(card.blocked, undefined);
  assert.ok(f.says(id, /Carrying on past the lock on Content\/Maps\/BP_Platform\.uasset/));
  await until(() => card.stage !== 'awaiting-merge', 'it to move on');
});

test('Carry on anyway tells a waiting agent to go ahead, and it is not stopped again at the merge', async () => {
  const f = fleet((m) => (m === 'machine.packageLocks' ? [{ ...LOCK, status: 'Locked', changeset: undefined }] : m === 'agent.changes' ? CHANGED : m === 'agent.readFile' ? SENT : undefined));
  const { id, card } = await f.start();
  reportBlocked(f, id, [{ ...LOCK, status: 'Locked', changeset: undefined }]);
  await until(() => card.blocked?.plan, 'the first check');
  await f.hub.carryOnPastBlock(id);
  await until(() => f.told(id).length, 'the agent to hear');
  assert.match(f.told(id)[0], /The user says not to wait for the lock on Content\/Maps\/BP_Platform\.uasset\. Go ahead/);
  f.event(id, { k: 'final', report: FINAL });
  await until(() => f.asked('agent.readFile').length, 'its files to move');
  assert.equal(card.blocked, undefined);
});

test('a failed lock check at the merge never holds finished work up', async () => {
  const f = fleet((m) => {
    if (m === 'machine.packageLocks') throw new Error('Plastic is down');
    return m === 'agent.changes' ? CHANGED : m === 'agent.readFile' ? SENT : undefined;
  });
  const { id, card } = await f.start();
  f.event(id, { k: 'final', report: FINAL });
  await until(() => f.asked('agent.readFile').length, 'its files to move');
  assert.equal(card.blocked, undefined);
});

test('being blocked survives a restart of the app, and is looked at again', async () => {
  const f = fleet((m) => (m === 'machine.packageLocks' ? [LOCK] : m === 'machine.bringInPackages' ? { outcome: 'refused', why: 'No.' } : undefined));
  const { id, card } = await f.start();
  reportBlocked(f, id);
  await until(() => card.blocked?.plan, 'the first check');
  (f.hub as any).saveNow();
  const dataDir = (f.hub as any).opts.dataDir;
  const again = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  hubs.push(again);
  const restored = (again as any).agents.get(id);
  assert.equal(restored.card.status, 'blocked');
  assert.equal(restored.card.blocked.locks[0].by, 'sam@example.com');
  assert.equal(restored.card.attention.kind, 'blocked');
  assert.equal(restored.card.runningSince, null, 'so the next check goes ahead');
});
