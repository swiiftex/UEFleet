// The master's brain. Reduces every machine's agent events into cards and transcripts, decides
// when something needs the user, places new tasks, and carries broadcasts and final reports.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { NodeService } from '../node/nodeService';
import { buildManifest, CHUNK, isBinaryPath, readChunk, writeChunk, mergeText } from '../node/projectSync';
import { readProject } from '../node/machine';
import { BUCKETS, type ActivityBucket, type AgentCard, type AgentEvent, type AgentSpawn, type ApplyResult, type Broadcast, type ChangedFile, type FleetSnapshot, type HubEvent, type ImageAttachment, type MachineView, type NewTask, type NewTaskDefaults, type NodeEvent, type ProjectInfo, type SlotInfo, type TranscriptItem } from '../shared/protocol';
import { LinkServer, type RemoteNode } from './link';

const emptyBuckets = () => Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<ActivityBucket, number>;
const SPARK_POINTS = 48;
const LIVE = new Set(['queued', 'provisioning', 'working', 'tools', 'coding', 'building', 'testing', 'waiting-instance']);

interface AgentRec {
  card: AgentCard;
  transcript: TranscriptItem[];
  byId: Map<string, TranscriptItem>;
  bucket: ActivityBucket | null;
  bucketSince: number;
  tokensThisTick: number;
  lastSeq: number;
  pendingItems: Map<string, TranscriptItem>;
  pendingDeltas: Map<string, string>;
  slotDir?: string;
  spawn: AgentSpawn;
  answeringBroadcast?: boolean;
  sourceProjectDir?: string; // the real project on the master, where applied changes land
  notStarted?: boolean; // its project never reached its machine, so the next message tries again
  stopSending?: boolean;
  sendQuestion?: { id: string; answer: (send: boolean) => void };
  applied?: Map<string, number>; // the date each file had when it was last applied here
}

export interface HubOptions { dataDir: string; version: string; demo: boolean; hostAppPath: string | null; askBeforeSendingBytes?: number }

// Sending more than this across a network is worth a question first.
const ASK_BEFORE_SENDING_BYTES = 2 ** 30;
const SEND_IT = 'Send it';
const sizeText = (bytes: number) => (bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : `${Math.round(bytes / 2 ** 20)} MB`);

class SendStopped extends Error {}

export class Hub extends EventEmitter {
  local: NodeService;
  link: LinkServer;
  private agents = new Map<string, AgentRec>();
  private remoteSlots = new Map<string, SlotInfo[]>();
  private remoteStats = new Map<string, MachineView['stats']>();
  private localStats: MachineView['stats'] = null;
  private dirtyCards = new Set<string>();
  private broadcasts: Broadcast[] = [];
  private doneTests = new Set<string>();
  private defaults: NewTaskDefaults = { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'acceptEdits', instanceMode: 'offscreen', projectFile: null };
  private nextIndex = 1;
  private timers: NodeJS.Timeout[] = [];
  private machinesDirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private wasBusy = false;

  constructor(private opts: HubOptions) {
    super();
    this.local = new NodeService({ id: 'master', role: 'master', version: opts.version, dataDir: opts.dataDir });
    this.local.on('event', (ev: NodeEvent) => this.onNodeEvent('master', ev));
    this.link = new LinkServer(path.join(opts.dataDir, 'link.json'), this.local.info.name, (hostId) => this.lastSeqFor(hostId));
    this.link.on('node', (n: RemoteNode) => this.watchRemote(n));
    this.restore();
    this.timers.push(setInterval(() => this.flush(), 120));
    this.timers.push(setInterval(() => this.sampleSpark(), 2000));
  }

  async start() {
    await this.link.start();
    this.machinesDirty = true;
  }

  private watchRemote(n: RemoteNode) {
    n.on('event', (ev: NodeEvent) => this.onNodeEvent(n.hostId, ev));
    n.on('online', () => { this.machinesDirty = true; this.onRemoteOnline(n); });
    n.on('offline', () => {
      this.machinesDirty = true;
      for (const r of this.agents.values()) {
        if (r.card.nodeId === n.hostId && LIVE.has(r.card.status)) this.note(r, `Lost the connection to ${n.info.name}. The agent keeps running there and this card catches up when it reconnects.`, 'warn');
      }
    });
  }

  private onRemoteOnline(_n: RemoteNode) { /* the host replays what we missed from welcome.lastSeq */ }

  private lastSeqFor(hostId: string) {
    const out: Record<string, number> = {};
    for (const r of this.agents.values()) if (r.card.nodeId === hostId) out[r.card.id] = r.lastSeq;
    return out;
  }

  private nodeCall<T = any>(nodeId: string, method: string, params: any): Promise<T> {
    if (nodeId === 'master') return this.local.rpc(method, params) as Promise<T>;
    const n = this.link.nodes.get(nodeId);
    if (!n) return Promise.reject(new Error('That machine is not connected.'));
    return n.call<T>(method, params);
  }

  // ---- Events from machines ----

  private onNodeEvent(nodeId: string, ev: NodeEvent) {
    if (ev.t === 'agent') {
      const r = this.agents.get(ev.agentId);
      if (!r) return;
      if (ev.seq <= r.lastSeq) return;
      r.lastSeq = ev.seq;
      this.reduce(r, ev.ev);
    } else if (ev.t === 'slots') {
      if (nodeId !== 'master') this.remoteSlots.set(nodeId, ev.slots);
      this.machinesDirty = true;
    } else if (ev.t === 'stats') {
      if (nodeId === 'master') this.localStats = ev.stats;
      else this.remoteStats.set(nodeId, ev.stats);
      this.machinesDirty = true;
    }
  }

  private setBucket(r: AgentRec, bucket: ActivityBucket | null) {
    const now = Date.now();
    if (r.bucket) r.card.buckets[r.bucket] += now - r.bucketSince;
    r.bucket = bucket;
    r.bucketSince = now;
  }

  private addItem(r: AgentRec, item: TranscriptItem) {
    const existing = r.byId.get(item.id);
    if (existing) {
      const i = r.transcript.indexOf(existing);
      if (i >= 0) r.transcript[i] = item;
    } else {
      r.transcript.push(item);
    }
    r.byId.set(item.id, item);
    r.pendingItems.set(item.id, item);
    r.pendingDeltas.delete(item.id);
    this.appendLog(r, item);
  }

  private note(r: AgentRec, text: string, tone?: 'info' | 'warn' | 'error') {
    this.addItem(r, { kind: 'system', id: `n-${crypto.randomBytes(4).toString('hex')}`, at: Date.now(), text, tone });
    this.dirtyCards.add(r.card.id);
  }

  private reduce(r: AgentRec, ev: AgentEvent) {
    const c = r.card;
    switch (ev.k) {
      case 'session':
        c.sessionId = ev.sessionId;
        break;
      case 'item': {
        this.addItem(r, ev.item);
        if (ev.item.kind === 'assistant') {
          if (ev.item.text) { c.lastText = ev.item.text; c.lastTextAt = ev.item.at; }
          this.recordBroadcastReply(c.id, ev.item.text, ev.item.at);
        }
        if (ev.item.kind === 'user') { c.lastPrompt = ev.item.text; c.lastPromptAt = ev.item.at; }
        break;
      }
      case 'delta': {
        const item = r.byId.get(ev.id);
        if (item && (item.kind === 'assistant' || item.kind === 'thinking')) {
          item.text += ev.text;
          r.pendingDeltas.set(ev.id, (r.pendingDeltas.get(ev.id) ?? '') + ev.text);
          if (item.kind === 'assistant') { c.lastText = item.text; c.lastTextAt = Date.now(); }
        }
        break;
      }
      case 'activity': {
        if (c.runningSince === null && ev.status !== 'attention') c.runningSince = Date.now();
        if (c.attention && ev.status !== 'attention') { /* attention stays until cleared explicitly */ }
        c.status = c.attention && ev.status !== 'attention' ? 'attention' : ev.status;
        c.detail = ev.detail;
        if (ev.bucket !== undefined) this.setBucket(r, ev.bucket);
        break;
      }
      case 'usage':
        c.usage = { ...c.usage, ...ev.usage };
        break;
      case 'tokens':
        c.tokens += ev.n;
        r.tokensThisTick += ev.n;
        break;
      case 'attention':
        c.attention = { kind: ev.kind, text: ev.text, at: Date.now(), ref: ev.ref };
        c.status = 'attention';
        this.emit('attention', c);
        break;
      case 'attention-clear':
        if (c.attention && (!ev.ref || c.attention.ref === ev.ref)) {
          c.attention = null;
          if (c.status === 'attention') c.status = 'working';
        }
        if (ev.ref) this.markDecided(r, ev.ref);
        break;
      case 'final':
        this.onFinal(r, ev.report);
        break;
      case 'turn-end':
        this.onTurnEnd(r, ev);
        break;
      case 'instance':
        c.slot = ev.slot;
        if (ev.slot) { c.cwd = ev.slot.dir; r.slotDir = ev.slot.own ?? ev.slot.dir; }
        if (ev.slot && (ev.slot.state === 'queued') && LIVE.has(c.status)) { c.status = 'waiting-instance'; c.detail = ev.slot.detail; this.setBucket(r, 'waiting'); }
        else if (ev.slot && c.status === 'waiting-instance' && ev.slot.state !== 'queued') { c.status = 'testing'; this.setBucket(r, 'testing'); }
        if (ev.slot?.state === 'crashed' && LIVE.has(c.status)) this.note(r, `Unreal crashed in this instance. ${ev.slot.detail ?? ''}`, 'warn');
        break;
      case 'ended':
        if (LIVE.has(c.status)) { c.status = 'idle'; this.setBucket(r, null); this.stopClock(r); }
        break;
    }
    this.dirtyCards.add(c.id);
    this.scheduleSave();
  }

  private markDecided(_r: AgentRec, _ref: string) { /* the card itself records the decision when the user makes it */ }

  private onFinal(r: AgentRec, report: AgentCard['final'] & {}) {
    const c = r.card;
    c.final = report;
    const needsUser = report.needsTesting.length > 0 || report.verified.length === 0;
    if (needsUser) {
      this.addItem(r, { kind: 'final', id: `final-${report.at}`, at: report.at, report });
    } else {
      // Fully verified by the agent, so the user isn't asked to look at anything.
      this.note(r, `Finished: ${report.summary}\nChecked by the agent: ${report.verified.join('; ')}`);
    }
    c.status = 'finished';
    c.lastText = report.summary;
    c.lastTextAt = report.at;
    c.detail = undefined;
    this.setBucket(r, null);
    this.stopClock(r);
    if (needsUser) {
      const n = report.needsTesting.length;
      c.attention = { kind: 'testing', text: n ? `Finished. ${n} thing${n === 1 ? '' : 's'} to test by hand.` : 'Finished, but it did not verify anything itself.', at: Date.now() };
      this.emit('attention', c);
      this.emitTests();
    } else {
      c.attention = null;
    }
    this.checkAllDone();
  }

  private onTurnEnd(r: AgentRec, ev: Extract<AgentEvent, { k: 'turn-end' }>) {
    const c = r.card;
    this.stopClock(r);
    this.setBucket(r, null);
    if (c.final) { c.status = 'finished'; if (c.attention?.kind !== 'testing') c.attention = null; return; }
    if (ev.interrupted) {
      // The user just did this, so there's nothing to tell them.
      c.status = 'idle';
      c.attention = null;
      this.checkAllDone();
      return;
    }
    if (ev.isError) {
      c.status = 'attention';
      const signedOut = /authenticat|401|oauth/i.test(ev.text ?? '');
      const machine = this.machines().find((m) => m.info.id === c.nodeId)?.info.name ?? 'that machine';
      const text = signedOut ? `Claude Code isn't signed in on ${machine}. Run "claude auth login" there, then message this agent again.` : (ev.text || 'The agent stopped with an error.');
      c.attention = { kind: 'error', text: text.slice(0, 180), at: Date.now() };
      if (signedOut) this.note(r, text, 'error');
      this.emit('attention', c);
      return;
    }
    if (r.answeringBroadcast) {
      // Its reply is already in the all-agents chat. A popup per agent would just be noise.
      c.status = 'idle';
      this.checkAllDone();
      return;
    }
    c.status = 'attention';
    c.attention = { kind: 'reply', text: oneLine(c.lastText) || 'Waiting on you', at: Date.now() };
    this.emit('attention', c);
    this.checkAllDone();
  }

  private stopClock(r: AgentRec) {
    const c = r.card;
    if (c.runningSince !== null) { c.sessionMs += Date.now() - c.runningSince; c.runningSince = null; }
  }

  private checkAllDone() {
    const cards = [...this.agents.values()].map((r) => r.card).filter((c) => !c.archived);
    const busy = cards.some((c) => LIVE.has(c.status) || (c.status === 'attention' && c.attention?.kind !== 'testing'));
    if (!busy && this.wasBusy && cards.length) {
      this.emitEvent({ e: 'all-done', count: this.testList().filter((t) => !t.done).length });
    }
    this.wasBusy = busy;
  }

  private recordBroadcastReply(agentId: string, text: string, at: number) {
    if (!text) return;
    const b = [...this.broadcasts].reverse().find((x) => x.targets.includes(agentId));
    if (!b || at < b.at) return;
    b.replies[agentId] = { agentId, text, at };
    this.emitEvent({ e: 'broadcasts', broadcasts: this.broadcasts });
  }

  // ---- Pushing state to the UI ----

  private emitEvent(e: HubEvent) { this.emit('hub', e); }

  private flush() {
    if (this.dirtyCards.size) {
      const now = Date.now();
      const cards: AgentCard[] = [];
      for (const id of this.dirtyCards) {
        const r = this.agents.get(id);
        if (r) cards.push(this.cardView(r, now));
      }
      this.dirtyCards.clear();
      this.emitEvent({ e: 'cards', cards });
    }
    for (const r of this.agents.values()) {
      if (!r.pendingItems.size && !r.pendingDeltas.size) continue;
      const items = [...r.pendingItems.values()];
      // A queued item is the live object, so it already includes any deltas for it.
      const deltas = [...r.pendingDeltas].filter(([id]) => !r.pendingItems.has(id)).map(([id, text]) => ({ id, text }));
      r.pendingItems.clear();
      r.pendingDeltas.clear();
      this.emitEvent({ e: 'transcript', agentId: r.card.id, items, deltas });
    }
    if (this.machinesDirty) {
      this.machinesDirty = false;
      this.emitEvent({ e: 'machines', machines: this.machines() });
    }
  }

  private cardView(r: AgentRec, now: number): AgentCard {
    const c = r.card;
    const buckets = { ...c.buckets };
    if (r.bucket) buckets[r.bucket] += now - r.bucketSince;
    return { ...c, buckets, sessionMs: c.sessionMs + (c.runningSince ? now - c.runningSince : 0), lastText: c.lastText.slice(0, 400), lastPrompt: c.lastPrompt.slice(0, 200) };
  }

  private sampleSpark() {
    for (const r of this.agents.values()) {
      const tps = r.tokensThisTick / 2;
      r.tokensThisTick = 0;
      const c = r.card;
      if (tps === 0 && c.tps === 0 && !LIVE.has(c.status)) continue;
      c.tps = tps;
      c.spark.push(tps);
      if (c.spark.length > SPARK_POINTS) c.spark.shift();
      this.dirtyCards.add(c.id);
    }
  }

  machines(): MachineView[] {
    const local: MachineView = { info: this.local.info, online: true, stats: this.localStats, slots: this.local.slots.list(), lastSeen: Date.now() };
    const remote = [...this.link.nodes.values()].map((n) => ({ info: n.info, online: n.online, stats: this.remoteStats.get(n.hostId) ?? null, slots: this.remoteSlots.get(n.hostId) ?? [], lastSeen: Date.now() }));
    return [local, ...remote];
  }

  testList(): FleetSnapshot['testList'] {
    const out: FleetSnapshot['testList'] = [];
    for (const r of this.agents.values()) {
      if (r.card.archived || !r.card.final) continue;
      r.card.final.needsTesting.forEach((test, i) => {
        const key = `${r.card.id}:${i}`;
        out.push({ agentId: r.card.id, title: r.card.title, test, done: this.doneTests.has(key), key });
      });
    }
    return out;
  }

  private emitTests() { this.emitEvent({ e: 'tests', testList: this.testList() }); }

  snapshot(): FleetSnapshot {
    const now = Date.now();
    return {
      cards: [...this.agents.values()].map((r) => this.cardView(r, now)),
      machines: this.machines(),
      broadcasts: this.broadcasts,
      pairing: this.safePairing(),
      testList: this.testList(),
      defaults: this.defaults,
      hostAppPath: this.opts.hostAppPath,
      demo: this.opts.demo,
    };
  }

  private safePairing() { try { return this.link.pairing(); } catch { return null; } }

  // ---- Actions from the UI ----

  private pickNode(task: NewTask): string {
    if (task.nodeId !== 'auto') return task.nodeId;
    const machines = this.machines().filter((m) => m.online);
    const load = (id: string) => [...this.agents.values()].filter((r) => r.card.nodeId === id && !r.card.archived && LIVE.has(r.card.status)).length;
    const hasEngine = (m: MachineView) => !task.projectFile || m.info.id === 'master' || m.info.engines.length > 0;
    const best = machines.filter(hasEngine).sort((a, b) => load(a.info.id) / a.info.maxInstances - load(b.info.id) / b.info.maxInstances)[0];
    return best?.info.id ?? 'master';
  }

  async createAgent(task: NewTask): Promise<string> {
    const id = crypto.randomBytes(5).toString('hex');
    const nodeId = this.pickNode(task);
    this.defaults = { model: task.model, effort: task.effort, permissionMode: task.permissionMode, instanceMode: task.instanceMode, projectFile: task.projectFile };
    const project = task.projectFile ? readProject(task.projectFile, this.local.info.engines) : null;
    const title = titleFrom(task.prompt);
    const card: AgentCard = {
      id, index: this.nextIndex++, title, nodeId, project: project?.name ?? null,
      model: task.model, effort: task.effort, permissionMode: task.permissionMode, instanceMode: task.instanceMode,
      status: 'queued', attention: null, lastText: '', lastTextAt: 0, lastPrompt: task.prompt, lastPromptAt: Date.now(),
      createdAt: Date.now(), sessionMs: 0, runningSince: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, context: 0, costUsd: 0 },
      tokens: 0, tps: 0, spark: [], buckets: emptyBuckets(), slot: null, final: null,
    };
    const spawn: AgentSpawn = {
      id, prompt: task.prompt, images: task.images, title, model: task.model, effort: task.effort, permissionMode: task.permissionMode, instanceMode: task.instanceMode, demo: task.demo,
      project: project ? { name: project.name, file: project.file, engineRoot: nodeId === 'master' ? this.local.info.engines.find((e) => e.id === project.engineAssociation)?.root : undefined } : null,
    };
    const rec: AgentRec = { card, transcript: [], byId: new Map(), bucket: null, bucketSince: Date.now(), tokensThisTick: 0, lastSeq: 0, pendingItems: new Map(), pendingDeltas: new Map(), spawn, sourceProjectDir: project?.dir, notStarted: nodeId !== 'master' && !!project };
    this.agents.set(id, rec);
    this.dirtyCards.add(id);
    this.wasBusy = true;
    this.scheduleSave();
    void this.launch(rec, project?.dir ?? null, project?.engineVersion);
    return id;
  }

  private async launch(rec: AgentRec, projectDir: string | null, engineVersion?: string) {
    const nodeId = rec.card.nodeId;
    try {
      if (nodeId !== 'master' && projectDir && rec.spawn.project) {
        const uproject = path.basename(rec.spawn.project.file);
        const name = rec.spawn.project.name;
        // A copy the user already keeps on that machine (their own Plastic or git workspace) beats
        // sending tens of GB across the network. Only copies this app sent get updated by sending.
        const node = this.link.nodes.get(nodeId);
        // An older host can't be asked again, so what it reported on connecting has to do.
        const projects = await this.nodeCall<ProjectInfo[]>(nodeId, 'machine.refreshProjects', {}).catch(() => node?.info.projects ?? []);
        if (node) { node.info.projects = projects; this.machinesDirty = true; }
        const copies = projects.filter((p) => p.name.toLowerCase() === name.toLowerCase() && !p.received);
        const own = copies[0];
        if (own) {
          const others = copies.slice(1).map((p) => p.dir).join(', ');
          this.note(rec, `Using the copy of ${name} already on ${node!.info.name}: ${own.dir}${others ? `. Also found ${others}. To choose, run fleet-host.exe --project "<folder>" on that machine.` : ''}`);
          rec.spawn.project = { name, file: own.file };
        } else {
          rec.card.status = 'provisioning';
          rec.card.detail = 'Sending project to the machine';
          this.dirtyCards.add(rec.card.id);
          const file = await this.pushProject(rec, nodeId, name, projectDir, uproject, (done, total) => {
            rec.card.detail = `Sending project: ${Math.round(100 * done / Math.max(1, total))}%`;
            this.dirtyCards.add(rec.card.id);
          });
          rec.spawn.project = { name, file };
        }
      }
      if (rec.stopSending) return;
      await this.nodeCall(nodeId, 'agent.spawn', { ...rec.spawn, engineVersion });
      rec.notStarted = false;
    } catch (e: any) {
      if (e instanceof SendStopped) return;
      rec.card.status = 'attention';
      rec.card.attention = { kind: 'error', text: String(e?.message ?? e).slice(0, 160), at: Date.now() };
      this.note(rec, `Couldn't start: ${e?.message ?? e}`, 'error');
      this.emit('attention', rec.card);
    }
  }

  // The answer comes back through answer(), like any other question, though no agent is running yet.
  private askToSend(rec: AgentRec, name: string, uproject: string, total: number): Promise<boolean> {
    const machine = this.link.nodes.get(rec.card.nodeId)?.info.name ?? 'that machine';
    const id = `send-${crypto.randomBytes(4).toString('hex')}`;
    const question = `Send ${sizeText(total)} of ${name} to ${machine}? No copy was found there.`;
    this.addItem(rec, { kind: 'question', id, at: Date.now(), questions: [{ question, header: 'Send project', options: [
      { label: SEND_IT, description: `Copies ${sizeText(total)} across the network. Later tasks only send what changed.` },
      { label: "Don't send", description: `If there's a copy on ${machine}, run fleet-host.exe --project "<path to ${uproject}>" there, then message this card to try again.` },
    ] }] });
    rec.card.status = 'attention';
    rec.card.attention = { kind: 'question', text: question, at: Date.now(), ref: id };
    this.dirtyCards.add(rec.card.id);
    this.emit('attention', rec.card);
    return new Promise((resolve) => { rec.sendQuestion = { id, answer: resolve }; });
  }

  // Stopping a card that's still getting its project also stops the transfer.
  private stopSend(r: AgentRec) {
    r.stopSending = true;
    r.sendQuestion?.answer(false);
    r.sendQuestion = undefined;
  }

  // Sends only what's missing or changed, in parallel, with each chunk acknowledged.
  private async pushProject(rec: AgentRec, nodeId: string, name: string, dir: string, uproject: string, onProgress: (done: number, total: number) => void): Promise<string> {
    const manifest = await buildManifest(dir);
    const need = await this.nodeCall<string[]>(nodeId, 'project.plan', { name, manifest });
    const sizes = new Map(manifest.map((m) => [m.path, m]));
    const total = need.reduce((s, p) => s + (sizes.get(p)?.size ?? 0), 0);
    if (total >= (this.opts.askBeforeSendingBytes ?? ASK_BEFORE_SENDING_BYTES) && !(await this.askToSend(rec, name, uproject, total))) throw new SendStopped();
    let done = 0;
    const queue = [...need];
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const rel = queue.shift()!;
        const m = sizes.get(rel)!;
        let offset = 0;
        while (true) {
          if (rec.stopSending) throw new SendStopped();
          const chunk = await readChunk(path.join(dir, rel), offset);
          await this.nodeCall(nodeId, 'project.put', { name, path: rel, offset, data: chunk.data, last: chunk.last, mtime: m.mtime });
          offset += CHUNK;
          done += Math.min(CHUNK, m.size);
          onProgress(done, total);
          if (chunk.last) break;
        }
      }
    }));
    const project = await this.nodeCall<{ file: string } | null>(nodeId, 'project.done', { name, uproject });
    if (!project) throw new Error('The project did not arrive intact.');
    return project.file;
  }

  async send(agentId: string, text: string, images?: ImageAttachment[], broadcastId?: string) {
    const r = this.need(agentId);
    this.wasBusy = true;
    r.answeringBroadcast = !!broadcastId;
    if (r.card.final) { r.card.final = null; r.card.status = 'working'; this.emitTests(); }
    r.card.attention = null;
    r.card.runningSince = r.card.runningSince ?? Date.now();
    this.dirtyCards.add(agentId);
    if (r.notStarted) {
      // It never reached its machine, so try again from the start, carrying what was just said.
      this.stopSend(r);
      r.stopSending = false;
      r.spawn.prompt = `${r.spawn.prompt}\n\n${text}`;
      r.card.status = 'queued';
      const project = readProject(r.spawn.project!.file, this.local.info.engines);
      void this.launch(r, r.sourceProjectDir ?? null, project?.engineVersion);
      return;
    }
    await this.ensureRunning(r);
    await this.nodeCall(r.card.nodeId, 'agent.send', { agentId, text, images, broadcastId });
  }

  // After an app restart the session is gone from memory, so pick it back up from disk.
  private async ensureRunning(r: AgentRec) {
    const has = await this.nodeCall<boolean>(r.card.nodeId, 'agent.has', { agentId: r.card.id }).catch(() => false);
    if (has) return;
    await this.nodeCall(r.card.nodeId, 'agent.spawn', { ...r.spawn, resumeSessionId: r.card.sessionId, slotDir: r.slotDir, startPrompt: false, seqFrom: r.lastSeq });
  }

  broadcast(text: string, targets: string[]) {
    const b: Broadcast = { id: crypto.randomBytes(4).toString('hex'), at: Date.now(), text, targets, replies: {} };
    this.broadcasts.push(b);
    if (this.broadcasts.length > 30) this.broadcasts.shift();
    this.emitEvent({ e: 'broadcasts', broadcasts: this.broadcasts });
    for (const id of targets) {
      this.send(id, text, undefined, b.id).catch((e) => {
        const r = this.agents.get(id);
        if (r) this.note(r, `Broadcast didn't reach this agent: ${e?.message ?? e}`, 'error');
      });
    }
    return b.id;
  }

  async decide(agentId: string, itemId: string, decision: 'allow' | 'always' | 'deny') {
    const r = this.need(agentId);
    const item = r.byId.get(itemId);
    if (item?.kind === 'permission') this.addItem(r, { ...item, decided: decision });
    await this.nodeCall(r.card.nodeId, 'agent.decide', { agentId, itemId, decision });
  }

  async answer(agentId: string, itemId: string, answers: Record<string, string>) {
    const r = this.need(agentId);
    const item = r.byId.get(itemId);
    if (item?.kind === 'question') this.addItem(r, { ...item, answers });
    if (r.sendQuestion?.id === itemId) {
      const send = Object.values(answers)[0] === SEND_IT;
      const { answer } = r.sendQuestion;
      r.sendQuestion = undefined;
      r.card.attention = null;
      if (send) r.card.status = 'provisioning';
      else {
        this.stopClock(r);
        r.card.status = 'stopped';
        r.card.tps = 0;
        this.note(r, 'Nothing was sent. Message this card to try again.');
      }
      this.dirtyCards.add(agentId);
      this.scheduleSave();
      answer(send);
      if (!send) this.checkAllDone();
      return;
    }
    await this.nodeCall(r.card.nodeId, 'agent.answer', { agentId, itemId, answers });
  }

  interrupt(agentId: string) {
    const r = this.need(agentId);
    if (r.notStarted) return this.stopAgent(agentId);
    return this.nodeCall(r.card.nodeId, 'agent.interrupt', { agentId });
  }

  async stopAgent(agentId: string) {
    const r = this.need(agentId);
    this.stopSend(r);
    await this.nodeCall(r.card.nodeId, 'agent.stop', { agentId }).catch(() => {});
    this.setBucket(r, null);
    this.stopClock(r);
    r.card.status = 'stopped';
    r.card.attention = null;
    r.card.tps = 0;
    this.dirtyCards.add(agentId);
    this.scheduleSave();
    this.checkAllDone();
  }

  async archive(agentId: string) {
    const r = this.need(agentId);
    this.stopSend(r);
    await this.nodeCall(r.card.nodeId, 'agent.stop', { agentId, releaseSlot: true, slotDir: r.slotDir }).catch(() => {});
    r.card.archived = true;
    r.card.attention = null;
    this.dirtyCards.add(agentId);
    this.emitTests();
    this.scheduleSave();
    this.checkAllDone();
  }

  dismissAttention(agentId: string) {
    const r = this.agents.get(agentId);
    if (!r?.card.attention) return;
    // A pending prompt still has to be answered; only "nothing is blocked" attention can be dropped.
    if (r.card.attention.ref) return;
    r.card.attention = null;
    if (r.card.status === 'attention') r.card.status = r.card.final ? 'finished' : 'idle';
    this.dirtyCards.add(agentId);
    this.checkAllDone();
  }

  transcript(agentId: string) { return this.need(agentId).transcript; }
  setTestDone(key: string, done: boolean) { if (done) this.doneTests.add(key); else this.doneTests.delete(key); this.emitTests(); }
  addProject(file: string) { const p = this.local.addProject(file); this.machinesDirty = true; return p; }
  async setMaxInstances(nodeId: string, n: number) {
    const info = await this.nodeCall(nodeId, 'machine.setMaxInstances', { n });
    if (nodeId !== 'master') { const node = this.link.nodes.get(nodeId); if (node) node.info = info; }
    this.machinesDirty = true;
  }
  rotatePairing() { this.link.rotatePairing(); return this.safePairing(); }
  forgetMachine(hostId: string) { this.link.forget(hostId); this.machinesDirty = true; }

  changes(agentId: string) { return this.nodeCall<ChangedFile[]>(this.need(agentId).card.nodeId, 'agent.changes', { agentId }); }
  log(agentId: string, lines = 300) { return this.nodeCall<string>(this.need(agentId).card.nodeId, 'agent.log', { agentId, lines }); }
  stopInstance(agentId: string) { return this.nodeCall(this.need(agentId).card.nodeId, 'agent.stopInstance', { agentId }); }

  async apply(agentId: string, only?: string[], force?: string[]): Promise<ApplyResult> {
    const r = this.need(agentId);
    if (r.card.nodeId === 'master') return this.nodeCall(r.card.nodeId, 'agent.apply', { agentId, only, force });
    return this.applyFromRemote(r, only, force);
  }

  // One action for the usual end of a batch. A failure on one card doesn't stop the others.
  async applyFinished() {
    const out: { agentId: string; title: string; applied: number; conflicts: ApplyResult['conflicts']; error?: string }[] = [];
    for (const r of this.agents.values()) {
      const c = r.card;
      if (c.archived || c.status !== 'finished' || !c.project || (c.slot?.shared && c.nodeId === 'master')) continue;
      try {
        const files = (await this.changes(c.id)).filter((f) => !f.usuallySkipped);
        if (!files.length) continue;
        const res = await this.apply(c.id, files.map((f) => f.path));
        out.push({ agentId: c.id, title: c.title, applied: res.applied.length + res.merged.length, conflicts: res.conflicts });
      } catch (e: any) {
        out.push({ agentId: c.id, title: c.title, applied: 0, conflicts: [], error: String(e?.message ?? e) });
      }
    }
    return out;
  }

  // Pulls changed files from the other machine, then applies them to the real project here.
  private async applyFromRemote(r: AgentRec, only?: string[], force: string[] = []): Promise<ApplyResult> {
    const agentId = r.card.id;
    if (!r.sourceProjectDir) throw new Error(`Don't know where ${r.card.project} lives on this machine.`);
    const dest = r.sourceProjectDir;
    const changes = await this.changes(agentId);
    const result: ApplyResult = { applied: [], merged: [], conflicts: [] };
    const inbox = path.join(this.opts.dataDir, 'inbox', agentId);
    for (const c of changes) {
      if (only && !only.includes(c.path)) continue;
      const target = path.join(dest, c.path);
      if (c.kind === 'deleted') { await fsp.rm(target, { force: true }); result.applied.push(c.path); continue; }
      // A shared folder keeps no base version to merge from, so a file that also changed here since
      // the task started is left for the user to decide about.
      const here = await fsp.stat(target).catch(() => null);
      if (r.card.slot?.shared && here && here.mtimeMs >= r.card.createdAt && here.mtimeMs !== r.applied?.get(c.path) && !force.includes(c.path)) {
        result.conflicts.push({ path: c.path, reason: 'Also changed on this machine since the task started.' });
        continue;
      }
      let offset = 0;
      while (true) {
        const chunk = await this.nodeCall<{ data: string; last: boolean; mtime: number }>(r.card.nodeId, 'agent.readFile', { agentId, path: c.path, offset });
        await writeChunk(inbox, c.path, offset, chunk.data, chunk.last);
        offset += CHUNK;
        if (chunk.last) break;
      }
      const incoming = path.join(inbox, c.path);
      const exists = fs.existsSync(target);
      const base = !isBinaryPath(c.path) && exists ? await this.nodeCall<string | null>(r.card.nodeId, 'agent.baseText', { agentId, path: c.path }) : null;
      try {
        if (exists && base !== null && !force.includes(c.path)) {
          const merged = await mergeText(target, Buffer.from(base, 'base64'), incoming);
          if (!merged.clean) { result.conflicts.push({ path: c.path, reason: 'Text merge has conflicts.' }); continue; }
          await fsp.writeFile(`${target}.fleet-merge`, merged.text);
          await fsp.rename(`${target}.fleet-merge`, target);
          result.merged.push(c.path);
        } else {
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.copyFile(incoming, `${target}.fleet-in`);
          await fsp.rename(`${target}.fleet-in`, target);
          result.applied.push(c.path);
        }
        (r.applied ??= new Map()).set(c.path, (await fsp.stat(target)).mtimeMs);
      } catch (e: any) {
        result.conflicts.push({ path: c.path, reason: String(e?.message ?? e) });
      }
    }
    await fsp.rm(inbox, { recursive: true, force: true });
    return result;
  }

  private need(agentId: string) {
    const r = this.agents.get(agentId);
    if (!r) throw new Error('Unknown agent.');
    return r;
  }

  // ---- Persistence ----

  private stateFile() { return path.join(this.opts.dataDir, 'state.json'); }
  private transcriptFile(id: string) { return path.join(this.opts.dataDir, 'transcripts', `${id}.jsonl`); }

  private appendLog(r: AgentRec, item: TranscriptItem) {
    if ((item.kind === 'assistant' || item.kind === 'thinking') && item.streaming) return;
    if (item.kind === 'tool' && item.state === 'running') return;
    const stored = item.kind === 'tool' && item.images ? { ...item, images: undefined } : item;
    fs.mkdirSync(path.dirname(this.transcriptFile(r.card.id)), { recursive: true });
    fs.appendFile(this.transcriptFile(r.card.id), `${JSON.stringify(stored)}\n`, () => {});
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 1000);
  }

  saveNow() {
    const agents = [...this.agents.values()].map((r) => ({ card: r.card, spawn: { ...r.spawn, images: undefined }, slotDir: r.slotDir, lastSeq: r.lastSeq, sourceProjectDir: r.sourceProjectDir, notStarted: r.notStarted }));
    fs.mkdirSync(this.opts.dataDir, { recursive: true });
    const tmp = `${this.stateFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ agents, nextIndex: this.nextIndex, defaults: this.defaults, doneTests: [...this.doneTests], broadcasts: this.broadcasts }));
    fs.renameSync(tmp, this.stateFile());
  }

  private restore() {
    let saved: any;
    try { saved = JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')); } catch { return; }
    this.nextIndex = saved.nextIndex ?? 1;
    this.defaults = saved.defaults ?? this.defaults;
    this.doneTests = new Set(saved.doneTests ?? []);
    this.broadcasts = saved.broadcasts ?? [];
    for (const a of saved.agents ?? []) {
      const card: AgentCard = a.card;
      if (card.archived) continue;
      const transcript = this.readTranscript(card.id);
      const byId = new Map(transcript.map((t) => [t.id, t]));
      // Local runs ended with the app, so show them as idle. Remote ones report in when they reconnect.
      if (card.nodeId === 'master' && LIVE.has(card.status)) card.status = 'idle';
      if (card.attention?.ref) card.attention = null;
      // Whatever was sending or asking died with the app, and a message picks it up again.
      if (a.notStarted) card.status = 'stopped';
      card.runningSince = null;
      card.tps = 0;
      this.agents.set(card.id, { card, transcript, byId, bucket: null, bucketSince: Date.now(), tokensThisTick: 0, lastSeq: a.lastSeq ?? 0, pendingItems: new Map(), pendingDeltas: new Map(), slotDir: a.slotDir, spawn: a.spawn, sourceProjectDir: a.sourceProjectDir, notStarted: a.notStarted });
    }
  }

  private readTranscript(id: string): TranscriptItem[] {
    let raw = '';
    try { raw = fs.readFileSync(this.transcriptFile(id), 'utf8'); } catch { return []; }
    const map = new Map<string, TranscriptItem>();
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { const it = JSON.parse(line) as TranscriptItem; map.set(it.id, it); } catch { /* torn final line */ }
    }
    return [...map.values()];
  }

  async shutdown() {
    this.saveNow();
    for (const t of this.timers) clearInterval(t);
    this.link.stop();
    await this.local.shutdown();
  }
}

function oneLine(s: string) { return s.replace(/\s+/g, ' ').trim().slice(0, 140); }

export function titleFrom(prompt: string) {
  const first = prompt.split(/\r?\n/).find((l) => l.trim()) ?? 'New task';
  const clean = first.trim().replace(/^(please|pls|can you|could you)\s+/i, '');
  const t = clean.charAt(0).toUpperCase() + clean.slice(1);
  return t.length > 42 ? `${t.slice(0, 40)}…` : t;
}
