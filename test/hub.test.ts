// The hub against scripted agents, and a real host process linked over TLS on loopback.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hub, titleFrom } from '../src/hub/hub';
import { decodePairCode, encodePairCode } from '../src/shared/pair';
import type { AgentCard, HubEvent, NewTask } from '../src/shared/protocol';

const HOST = path.join(process.env.FLEET_ROOT!, 'dist', 'host', 'fleet-host.cjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const hubs: Hub[] = [];
const procs: ChildProcess[] = [];

function makeHub() {
  const hub = new Hub({ dataDir: tmp('fleet-hub-'), version: 'test', demo: true, hostAppPath: null });
  hubs.push(hub);
  return hub;
}

after(async () => {
  for (const p of procs) p.kill();
  for (const h of hubs) await h.shutdown();
  setTimeout(() => process.exit(0), 200);
});

const task = (demo: string, extra: Partial<NewTask> = {}): NewTask => ({ prompt: `Do ${demo}`, projectFile: null, nodeId: 'master', model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'default', instanceMode: 'headless', demo, ...extra });

async function until<T>(fn: () => T | undefined | false, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  assert.fail(`Timed out waiting for ${what}`);
}

const cardOf = (hub: Hub, id: string): AgentCard => hub.snapshot().cards.find((c) => c.id === id)!;

test('titles come from the first line of the prompt', () => {
  assert.equal(titleFrom('please fix the crash\nmore detail'), 'Fix the crash');
  assert.ok(titleFrom('x'.repeat(80)).length <= 42);
});

test('a task only the agent can verify finishes with no popup and no test list', async () => {
  const hub = makeHub();
  const attention: AgentCard[] = [];
  hub.on('attention', (c) => attention.push(c));
  const id = await hub.createAgent(task('clean'));
  await until(() => cardOf(hub, id).status === 'finished', 'finish');
  assert.equal(attention.length, 0);
  assert.equal(cardOf(hub, id).attention, null);
  assert.equal(hub.testList().length, 0);
  assert.ok(!hub.transcript(id).some((t) => t.kind === 'final'), 'no final message is shown');
  assert.ok(hub.transcript(id).some((t) => t.kind === 'system' && t.text.includes('Checked by the agent')));
});

test('a task needing human testing shows a final message, popup, and test list entries', async () => {
  const hub = makeHub();
  const attention: AgentCard[] = [];
  hub.on('attention', (c) => attention.push(c));
  const id = await hub.createAgent(task('testing'));
  await until(() => cardOf(hub, id).status === 'finished', 'finish');
  assert.equal(attention.at(-1)?.attention?.kind, 'testing');
  assert.equal(hub.testList().length, 2);
  const final = hub.transcript(id).find((t) => t.kind === 'final');
  assert.ok(final);
  hub.dismissAttention(id);
  assert.equal(cardOf(hub, id).attention, null);
  assert.equal(cardOf(hub, id).status, 'finished');
});

test('a report that verified nothing still asks for a look', async () => {
  const hub = makeHub();
  const id = await hub.createAgent(task('long'));
  (hub as any).reduce((hub as any).agents.get(id), { k: 'final', report: { summary: 'Done', verified: [], needsTesting: [], at: Date.now() } });
  assert.equal(cardOf(hub, id).attention?.kind, 'testing');
  await hub.stopAgent(id);
});

test('permission prompts raise attention and clear when answered', async () => {
  const hub = makeHub();
  const id = await hub.createAgent(task('permission'));
  await until(() => cardOf(hub, id).attention?.kind === 'permission', 'permission prompt');
  const c = cardOf(hub, id);
  assert.equal(c.status, 'attention');
  assert.ok(c.attention!.ref);
  hub.dismissAttention(id);
  assert.ok(cardOf(hub, id).attention, 'a real prompt cannot be dismissed away');
  await hub.decide(id, c.attention!.ref!, 'allow');
  await until(() => cardOf(hub, id).attention === null, 'attention to clear');
  await until(() => cardOf(hub, id).status === 'finished', 'finish');
});

test('questions raise attention and clear when answered', async () => {
  const hub = makeHub();
  const id = await hub.createAgent(task('question'));
  await until(() => cardOf(hub, id).attention?.kind === 'question', 'question');
  await hub.answer(id, cardOf(hub, id).attention!.ref!, { q: 'Soak visitors' });
  await until(() => cardOf(hub, id).status === 'finished', 'finish');
  const item = hub.transcript(id).find((t) => t.kind === 'question') as any;
  assert.deepEqual(item.answers, { q: 'Soak visitors' });
});

test('ending a turn without finishing waits on the user', async () => {
  const hub = makeHub();
  const id = await hub.createAgent(task('reply'));
  await until(() => cardOf(hub, id).attention?.kind === 'reply', 'reply attention');
  assert.equal(cardOf(hub, id).final, null);
});

test('a broadcast reaches every target and collects their replies', async () => {
  const hub = makeHub();
  const a = await hub.createAgent(task('long'));
  const b = await hub.createAgent(task('long'));
  const bid = hub.broadcast('stop and commit', [a, b]);
  for (const id of [a, b]) {
    await until(() => hub.transcript(id).some((t) => t.kind === 'user' && t.broadcastId === bid), `broadcast to reach ${id}`);
  }
  await until(() => {
    const br = hub.snapshot().broadcasts.find((x) => x.id === bid)!;
    return br.replies[a] && br.replies[b];
  }, 'both replies');
  await hub.stopAgent(a);
  await hub.stopAgent(b);
});

test('all-done fires only when something still needs testing is known to the UI', async () => {
  const hub = makeHub();
  const events: HubEvent[] = [];
  hub.on('hub', (e) => { if (e.e === 'all-done') events.push(e); });
  await hub.createAgent(task('testing'));
  await hub.createAgent(task('clean'));
  await until(() => events.length > 0, 'all-done event');
  assert.equal((events[0] as any).count, 2);
});

test('state survives a restart', async () => {
  const dataDir = tmp('fleet-restart-');
  const hub = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  const id = await hub.createAgent(task('testing'));
  await until(() => cardOf(hub, id).status === 'finished', 'finish');
  await hub.shutdown();
  const again = new Hub({ dataDir, version: 'test', demo: true, hostAppPath: null });
  hubs.push(again);
  const c = cardOf(again, id);
  assert.equal(c.status, 'finished');
  assert.ok(c.final);
  assert.ok(again.transcript(id).length > 3);
  assert.equal(again.testList().length, 2);
});

function startHost(code: string, dataDir: string) {
  const p = spawn(process.execPath, [HOST, '--pair', code], { env: { ...process.env, FLEET_HOST_DATA: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout!.on('data', (d) => { out += d; });
  p.stderr!.on('data', (d) => { out += d; });
  procs.push(p);
  return { p, log: () => out };
}

test('a host pairs over TLS, runs agents, and the master sees them', async () => {
  const hub = makeHub();
  await hub.start();
  const pairing = hub.snapshot().pairing!;
  const code = encodePairCode({ ...decodePairCode(pairing.code), a: ['127.0.0.1'] });
  const dir = tmp('fleet-host-');
  const host = startHost(code, dir);
  const machine = await until(() => hub.machines().find((m) => m.info.role === 'remote' && m.online), 'host to connect', 25_000).catch((e) => { throw new Error(`${e.message}\n${host.log()}`); });
  await until(() => host.log().includes('Connected'), 'the host to log the connection');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.ok(saved.key, 'the host keeps its own key after pairing');

  const id = await hub.createAgent(task('permission', { nodeId: machine.info.id }));
  assert.equal(cardOf(hub, id).nodeId, machine.info.id);
  await until(() => cardOf(hub, id).attention?.kind === 'permission', 'permission from the remote agent');
  await hub.decide(id, cardOf(hub, id).attention!.ref!, 'allow');
  await until(() => cardOf(hub, id).status === 'finished', 'remote agent to finish');
  assert.ok(hub.transcript(id).some((t) => t.kind === 'tool'));

  // Drop the link and check the host comes back by itself with its stored key.
  const node = hub.link.nodes.get(machine.info.id)!;
  node.ws!.terminate();
  await until(() => !hub.machines().find((m) => m.info.id === machine.info.id)!.online, 'disconnect');
  await until(() => hub.machines().find((m) => m.info.id === machine.info.id)!.online, 'automatic reconnect', 25_000);
  host.p.kill();
});

test('a project pushed to a host arrives and is sent only once', async () => {
  const hub = makeHub();
  await hub.start();
  const code = encodePairCode({ ...decodePairCode(hub.snapshot().pairing!.code), a: ['127.0.0.1'] });
  const dir = tmp('fleet-host-');
  const host = startHost(code, dir);
  const machine = await until(() => hub.machines().find((m) => m.info.role === 'remote' && m.online), 'host to connect', 25_000);

  const src = path.join(tmp('fleet-src-'), 'Pushed Game');
  fs.mkdirSync(path.join(src, 'Content'), { recursive: true });
  fs.mkdirSync(path.join(src, 'Source'), { recursive: true });
  fs.mkdirSync(path.join(src, 'Saved'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Pushed.uproject'), '{"EngineAssociation":"5.8"}');
  fs.writeFileSync(path.join(src, 'Source', 'A.cpp'), 'code');
  fs.writeFileSync(path.join(src, 'Saved', 'junk.log'), 'nope');
  const big = Buffer.alloc(3_500_000);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  fs.writeFileSync(path.join(src, 'Content', 'Big.uasset'), big);

  const id = await hub.createAgent(task('clean', { nodeId: machine.info.id, projectFile: path.join(src, 'Pushed.uproject') }));
  await until(() => cardOf(hub, id).status === 'finished', 'agent to finish', 30_000);
  const landed = path.join(dir, 'projects', 'Pushed');
  assert.deepEqual(fs.readFileSync(path.join(landed, 'Content', 'Big.uasset')), big, 'a multi-chunk file arrives byte for byte');
  assert.equal(fs.readFileSync(path.join(landed, 'Source', 'A.cpp'), 'utf8'), 'code');
  assert.ok(!fs.existsSync(path.join(landed, 'Saved')), 'junk stays behind');

  const mtimeBefore = fs.statSync(path.join(landed, 'Content', 'Big.uasset')).mtimeMs;
  const plan = await (hub as any).nodeCall(machine.info.id, 'project.plan', { name: 'Pushed', manifest: [{ path: 'Content\\Big.uasset', size: big.length, mtime: fs.statSync(path.join(src, 'Content', 'Big.uasset')).mtimeMs }, { path: 'Source\\A.cpp', size: 4, mtime: fs.statSync(path.join(src, 'Source', 'A.cpp')).mtimeMs }, { path: 'Pushed.uproject', size: fs.statSync(path.join(src, 'Pushed.uproject')).size, mtime: fs.statSync(path.join(src, 'Pushed.uproject')).mtimeMs }] });
  assert.deepEqual(plan, [], 'a second push has nothing to send');
  assert.equal(fs.statSync(path.join(landed, 'Content', 'Big.uasset')).mtimeMs, mtimeBefore);
  host.p.kill();
});

test('a host refuses a master whose certificate does not match the code', async () => {
  const hub = makeHub();
  await hub.start();
  const real = decodePairCode(hub.snapshot().pairing!.code);
  const host = startHost(encodePairCode({ ...real, a: ['127.0.0.1'], f: 'f'.repeat(64) }), tmp('fleet-host-'));
  await until(() => host.log().includes("doesn't match"), 'the host to refuse', 25_000);
  assert.equal(hub.machines().filter((m) => m.info.role === 'remote').length, 0, 'it never reached the master');
  host.p.kill();
});

test('the master refuses a wrong or rotated pairing code', async () => {
  const hub = makeHub();
  await hub.start();
  const old = hub.snapshot().pairing!.code;
  hub.rotatePairing();
  const host = startHost(encodePairCode({ ...decodePairCode(old), a: ['127.0.0.1'] }), tmp('fleet-host-'));
  await until(() => host.log().includes('not valid'), 'the master to refuse', 25_000);
  assert.equal(hub.machines().filter((m) => m.info.role === 'remote').length, 0);
});
