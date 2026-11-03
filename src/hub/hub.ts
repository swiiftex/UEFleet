// The master's brain. Reduces every machine's agent events into cards and transcripts, decides
// when something needs the user, places new tasks, and carries broadcasts and final reports.
import { spawn as spawnProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { hashOf } from '../host/selfUpdate';
import { NodeService } from '../node/nodeService';
import { assignToChangelist, isPlasticWorkspace, realCm, type CmRun } from '../node/plastic';
import { buildManifest, CHUNK, isBinaryPath, readChunk, writeChunk, mergeText } from '../node/projectSync';
import { describeMachine, readProject } from '../node/machine';
import type { PendingChange, WorkspaceState } from '../node/sourceControl';
import { BUCKETS, DEFAULT_PERMISSION_MODE, MASTER_CHAT_ID, MASTER_PERMISSION_MODES, modelLabel, type ActivityBucket, type AgentCard, type AgentEvent, type AgentOptions, type AgentSpawn, type ApiCreditsView, type AgentStatus, type AppUpdate, type ApplyResult, type Broadcast, type ChangedFile, type FleetSnapshot, type FlowStage, type HubEvent, type ImageAttachment, type MachineView, type NewTask, type NewTaskDefaults, type NodeEvent, type NodeInfo, type ProjectInfo, type SlotInfo, type TranscriptItem } from '../shared/protocol';
import { HostUpdates } from './hostUpdates';
import { LinkServer, LOCAL_HOST_ID, type RemoteNode } from './link';
import { chosenOptions, DemoMaster, MASTER_EFFORT, MASTER_MODEL, RealMaster, type MasterActions, type MasterBackend } from './masterChat';
import { placeTask } from './placement';

const emptyBuckets = () => Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<ActivityBucket, number>;
const SPARK_POINTS = 48;
const LIVE = new Set(['queued', 'provisioning', 'working', 'tools', 'coding', 'building', 'testing', 'waiting-instance']);
// From here on the agent has finished, and a new message to it starts the work again.
const AFTER_AGENT = new Set<FlowStage>(['awaiting-merge', 'merged', 'checking-in', 'complete']);
const TEST_RUN_BUSY = new Set(['pulling', 'building', 'opening']);
const CODE_FILE = /\.(cpp|cc|c|h|hpp|inl|cs|uplugin|uproject)$/i;
const pad2 = (n: number) => String(n).padStart(2, '0');

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
  applying?: Promise<unknown>; // the merge from its machine that's in progress
  switchingCredits?: boolean; // its failed turn is ending, and it's about to carry on
  heldNew?: boolean; // hasn't started, because a workspace chat has the project on hold
  applied?: Map<string, number>; // the date each file had when it was last applied here
  pulled?: string[]; // its files that are in the user's workspace
  keepMine?: string[]; // files the user chose to keep their own version of
  assigning?: boolean;
  askedForChangelist?: boolean;
  advancing?: boolean;
  launching?: boolean; // on its way to its machine, so that machine won't have heard of it yet
  resumeOnReturn?: boolean; // its machine was told to restart under it, so it carries on afterwards
}

interface OpenQuestion { agentId: string; askId: string; label: string; question: string }

// How to run the master's own host as a process of its own, so agents and editors here keep running
// through an app restart. Without this they run inside the hub, as they do in most tests.
export interface LocalHostCommand { command: string; args: string[]; env?: Record<string, string>; installFrom?: string }

export interface HubOptions { dataDir: string; version: string; demo: boolean; hostAppPath: string | null; askBeforeSendingBytes?: number; cm?: CmRun; localHost?: LocalHostCommand }

const LOCAL_HOST_WAIT_MS = 30_000;

// Sending more than this across a network is worth a question first.
const ASK_BEFORE_SENDING_BYTES = 2 ** 30;
const SEND_IT = 'Send it';
const CREDITS_RETRY_MS = 30 * 60_000;
const WORKSPACE_FRESH_MS = 30 * 60_000; // how long a machine's workspace counts as recent before a new task
const SYNC_WAIT_MS = 60_000;

type SyncResult = { outcome: 'updated' | 'current' | 'blocked' | 'failed'; message: string };
const NO_MERGE_BASE = "there's no earlier version to merge from";
const sizeText = (bytes: number) => (bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : `${Math.round(bytes / 2 ** 20)} MB`);

class SendStopped extends Error {}

export class Hub extends EventEmitter {
  local: NodeService | null = null;
  link: LinkServer;
  private placeholderInfo: NodeInfo | null = null;
  private hostUpdates: HostUpdates;
  private appUpdate: AppUpdate | null = null;
  private lastStartedLocalHost = 0;
  private agents = new Map<string, AgentRec>();
  private remoteSlots = new Map<string, SlotInfo[]>();
  private remoteStats = new Map<string, MachineView['stats']>();
  private dirtyCards = new Set<string>();
  private broadcasts: Broadcast[] = [];
  private doneTests = new Set<string>();
  private defaults: NewTaskDefaults = { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: DEFAULT_PERMISSION_MODE, instanceMode: 'offscreen', projectFile: null };
  private nextIndex = 1;
  private timers: NodeJS.Timeout[] = [];
  private machinesDirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private wasBusy = false;
  private masterRec!: AgentRec;
  private masterBackend: MasterBackend | null = null;
  private masterOptions: NewTask | null = null;
  // The key is only ever in memory here. The app keeps it encrypted on disk.
  private apiCredits: { enabled: boolean; key: string | null; problem?: string; failedAt?: number } = { enabled: false, key: null };
  private workspaceHolds = new Map<string, string>(); // project file to the workspace chat holding it
  private holdWaiters: (() => void)[] = [];
  private workspaceSyncs = new Map<string, Promise<SyncResult>>(); // updates running now, by machine and project
  private queuedSyncs = new Map<string, { nodeId: string; file: string; project: string }>(); // waiting for work there to finish
  private lastSynced: Record<string, number> = {};
  private delivered: Record<string, Record<string, string[]>> = {}; // by machine: the hash of each file that reached this PC from it
  private unrouted: NewTask[] = []; // requests the master hasn't got through yet, for if it can't
  private openQuestions = new Map<string, OpenQuestion>();

  constructor(private opts: HubOptions) {
    super();
    if (opts.localHost) this.placeholderInfo = describeMachine(LOCAL_HOST_ID, 'master', opts.version);
    else {
      this.local = new NodeService({ id: LOCAL_HOST_ID, role: 'master', version: opts.version, dataDir: opts.dataDir });
      this.local.on('event', (ev: NodeEvent) => this.onNodeEvent(LOCAL_HOST_ID, ev));
    }
    this.link = new LinkServer(path.join(opts.dataDir, 'link.json'), (this.local?.info ?? this.placeholderInfo!).name, (hostId) => this.lastSeqFor(hostId));
    this.link.on('node', (n: RemoteNode) => this.watchRemote(n));
    this.hostUpdates = new HostUpdates({
      nodes: () => [...this.link.nodes.values()],
      busy: (id) => this.busyOn(id),
      beforeRestart: (id) => {
        if (id === LOCAL_HOST_ID) this.lastStartedLocalHost = Date.now();
        for (const r of this.agents.values()) if (r.card.nodeId === id && !r.card.archived && LIVE.has(r.card.status)) r.resumeOnReturn = true;
        this.saveNow();
      },
      changed: () => { this.machinesDirty = true; },
    });
    this.restore();
    this.ensureMasterCard();
    this.timers.push(setInterval(() => this.flush(), 120));
    this.timers.push(setInterval(() => this.sampleSpark(), 2000));
    this.timers.push(setInterval(() => { this.hostUpdates.checkAll(); this.watchLocalHost(); this.endCredits(); this.runQueuedSyncs(); }, 5000));
  }

  private get localNode() { return this.link.nodes.get(LOCAL_HOST_ID); }
  private get localInfo(): NodeInfo { return this.local?.info ?? this.localNode?.info ?? this.placeholderInfo!; }

  async start() {
    await this.link.start();
    this.machinesDirty = true;
    if (this.opts.localHost) await this.startLocalHost();
    void this.hostUpdates.setExe(this.opts.hostAppPath);
    if (this.local) this.resumeFlows(LOCAL_HOST_ID);
    const sentAgain = 'This was sent again after the app restarted, so you may have seen it before.';
    for (const q of this.openQuestions.keys()) this.sendQuestion(q, sentAgain);
    for (const t of this.unrouted) void this.route(t, ` ${sentAgain} Check list_agents first, in case it's already started.`).catch(() => {});
  }

  // ---- The master's own host ----

  private get localPidFile() { return path.join(this.opts.dataDir, 'local-host.pid'); }

  private localHostAlive() {
    try { process.kill(Number(fs.readFileSync(this.localPidFile, 'utf8')), 0); return true; } catch { return false; }
  }

  // One that outlived the last app run is already trying to reconnect, so it only needs telling how.
  private async startLocalHost() {
    const config = path.join(this.opts.dataDir, 'config.json');
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(config, 'utf8')); } catch { /* first run */ }
    fs.mkdirSync(this.opts.dataDir, { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ ...existing, ...this.link.localHostConfig(this.localInfo.name) }, null, 2));
    if (!this.localHostAlive()) await this.launchLocalHost();
  }

  private async launchLocalHost() {
    const { command, args, env, installFrom } = this.opts.localHost!;
    this.lastStartedLocalHost = Date.now();
    // Runs from a copy, so the file the app ships with is never locked by it.
    if (installFrom) {
      fs.mkdirSync(path.dirname(command), { recursive: true });
      const current = fs.existsSync(command) ? await hashOf(command) : '';
      if (current !== await hashOf(installFrom)) await fsp.copyFile(installFrom, command).catch(() => {});
    }
    const log = fs.openSync(path.join(this.opts.dataDir, 'local-host.log'), 'a');
    const child = spawnProcess(command, [...args, '--local'], { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: { ...process.env, FLEET_HOST_DATA: this.opts.dataDir, ...env } });
    child.on('error', (e) => console.error('The local host failed to start:', e));
    if (child.pid) fs.writeFileSync(this.localPidFile, String(child.pid));
    child.unref();
    fs.closeSync(log);
  }

  // If it's gone, every local agent and editor went with it. Bring it back so the app keeps working.
  private watchLocalHost() {
    if (!this.opts.localHost || this.localNode?.online || this.localHostAlive()) return;
    if (Date.now() - this.lastStartedLocalHost < 10_000) return;
    void this.launchLocalHost();
  }

  private busyOn(nodeId: string) {
    const cards = [...this.agents.values()].map((r) => r.card).filter((c) => !c.archived && c.nodeId === nodeId);
    const testing = nodeId === LOCAL_HOST_ID ? [...this.agents.values()].filter((r) => r.card.testRun && TEST_RUN_BUSY.has(r.card.testRun.stage)).length : 0;
    const updating = [...this.workspaceSyncs.keys()].filter((k) => k.startsWith(`${nodeId}|`)).length;
    return testing + updating + cards.filter((c) => LIVE.has(c.status) || !!c.attention?.ref).length;
  }

  restartHost(nodeId: string) { return this.hostUpdates.restartNow(nodeId); }
  setHostExe(exe: string) { return this.hostUpdates.setExe(exe); }
  setAppUpdate(update: AppUpdate | null) {
    this.appUpdate = update;
    this.emitEvent({ e: 'app-update', update });
  }

  // An agent the app thinks is running may have gone while the app or its machine restarted.
  private async reconcile(n: RemoteNode) {
    for (const r of [...this.agents.values()]) {
      const c = r.card;
      if (c.archived || c.nodeId !== n.hostId || !LIVE.has(c.status) || r.notStarted || r.launching) continue;
      if (await n.call<boolean>('agent.has', { agentId: c.id }).catch(() => true)) continue;
      if (r.resumeOnReturn) {
        r.resumeOnReturn = false;
        await this.send(c.id, `${n.info.name} restarted to update UE Fleet while you were working, so whatever was in progress stopped. Check where you'd got to and carry on.`).catch(() => {});
        continue;
      }
      this.setBucket(r, null);
      this.stopClock(r);
      c.status = 'idle';
      c.attention = { kind: 'error', text: `This agent stopped when ${n.info.name} restarted. Message it to carry on.`, at: Date.now() };
      this.note(r, c.attention.text, 'warn');
      this.emit('attention', c);
    }
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

  // The host replays what we missed from welcome.lastSeq. A merge waiting on it can carry on now.
  private onRemoteOnline(n: RemoteNode) {
    this.resumeFlows(n.hostId);
    void this.reconcile(n);
    void this.hostUpdates.check(n);
  }

  private resumeFlows(nodeId: string) {
    for (const r of this.agents.values()) {
      const c = r.card;
      if (c.archived || c.nodeId !== nodeId) continue;
      const conflicts = c.merge?.conflicts ?? [];
      // A machine that can now provide a version to merge from settles what it couldn't before.
      const canMergeNow = !!this.nodeInfo(nodeId)?.sharedMergeBase && conflicts.some((f) => f.reason.includes(NO_MERGE_BASE) || f.reason.startsWith('Also changed on this machine'));
      if (c.stage === 'merged' || c.stage === 'checking-in' || (c.stage === 'awaiting-merge' && (!conflicts.length || canMergeNow))) void this.advance(r);
    }
  }

  private nodeInfo(nodeId: string) { return nodeId === LOCAL_HOST_ID ? this.localInfo : this.link.nodes.get(nodeId)?.info; }

  private lastSeqFor(hostId: string) {
    const out: Record<string, number> = {};
    for (const r of this.agents.values()) if (r.card.nodeId === hostId) out[r.card.id] = r.lastSeq;
    return out;
  }

  private async nodeCall<T = any>(nodeId: string, method: string, params: any): Promise<T> {
    if (nodeId === MASTER_CHAT_ID) return this.masterRpc(method, params) as Promise<T>;
    if (nodeId === LOCAL_HOST_ID && this.local) return this.local.rpc(method, params) as Promise<T>;
    // The app can get going a moment before its own host has linked.
    if (nodeId === LOCAL_HOST_ID && !this.localNode?.online) await this.localHostLinked();
    const n = this.link.nodes.get(nodeId);
    if (!n) throw new Error('That machine is not connected.');
    return n.call<T>(method, params);
  }

  private async localHostLinked() {
    const end = Date.now() + LOCAL_HOST_WAIT_MS;
    while (Date.now() < end && !this.localNode?.online) await new Promise((r) => setTimeout(r, 100));
    if (!this.localNode?.online) throw new Error("This PC's own host didn't start. See local-host.log in the app's data folder.");
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
      this.remoteSlots.set(nodeId, ev.slots);
      this.machinesDirty = true;
    } else if (ev.t === 'stats') {
      this.remoteStats.set(nodeId, ev.stats);
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

  private note(r: AgentRec, text: string, tone?: 'info' | 'warn' | 'error', message?: boolean) {
    this.addItem(r, { kind: 'system', id: `n-${crypto.randomBytes(4).toString('hex')}`, at: Date.now(), text, tone, message });
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
        this.stageFromActivity(r, ev.status);
        if (c.isMaster && ev.status === 'error') this.masterFailed(ev.detail ?? 'it hit an error');
        break;
      }
      case 'ask-master':
        this.questionForMaster(r, ev.id, ev.question);
        break;
      case 'usage-limit':
        if (this.canUseCredits()) {
          r.switchingCredits = true;
          void this.switchToCredits(r, ev.resetsAt);
        }
        break;
      case 'credits-failed':
        this.creditsFailed(r, ev.why);
        break;
      case 'workspace-hold':
        void (ev.on ? this.holdWorkspace(r) : this.releaseWorkspace(c.id, ev.summary))
          .catch((e) => String(e?.message ?? e))
          .then((answer) => this.nodeCall(c.nodeId, 'agent.masterReply', { agentId: c.id, id: ev.id, answer }))
          .catch(() => {});
        break;
      case 'usage':
        c.usage = { ...c.usage, ...ev.usage };
        break;
      case 'tokens':
        c.tokens += ev.n;
        r.tokensThisTick += ev.n;
        break;
      case 'progress':
        // Full is for finishing, so a bar can't read as done while the agent is still working.
        c.progress = Math.max(0, Math.min(99, Math.round(ev.percent)));
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

  // The stages the agent itself moves through, read from what it's doing. Once it has finished, the
  // stage only changes through approve, merge and check-in.
  private stageFromActivity(r: AgentRec, status: AgentStatus) {
    const c = r.card;
    if (c.isMaster || c.isWorkspace || c.final || (c.stage && AFTER_AGENT.has(c.stage))) return;
    if (status === 'coding' || status === 'building') c.stage = 'building';
    else if (status === 'testing') c.stage = 'testing';
  }

  private clearTests(agentId: string) {
    for (const key of [...this.doneTests]) if (key.startsWith(`${agentId}:`)) this.doneTests.delete(key);
  }

  private onFinal(r: AgentRec, report: AgentCard['final'] & {}) {
    const c = r.card;
    c.final = report;
    c.testRun = undefined;
    this.clearTests(c.id);
    const needsUser = report.needsTesting.length > 0 || report.verified.length === 0;
    if (needsUser) {
      this.addItem(r, { kind: 'final', id: `final-${report.at}`, at: report.at, report });
    } else {
      // Fully verified by the agent, so the user isn't asked to look at anything.
      this.note(r, `Finished: ${report.summary}\nChecked by the agent: ${report.verified.join('; ')}`, undefined, true);
    }
    c.status = 'finished';
    c.lastText = report.summary;
    c.lastTextAt = report.at;
    c.detail = undefined;
    this.setBucket(r, null);
    this.stopClock(r);
    if (needsUser) {
      const n = report.needsTesting.length;
      c.stage = 'testing';
      c.attention = { kind: 'testing', text: n ? `Ready to test: ${n} thing${n === 1 ? '' : 's'} to check.` : "Ready to test, but it didn't verify anything itself.", at: Date.now() };
      this.emit('attention', c);
      this.emitTests();
    } else {
      // It proved the change works, so there's nothing to wait for.
      c.attention = null;
      c.stage = 'awaiting-merge';
      void this.advance(r);
    }
    this.checkAllDone();
  }

  private onTurnEnd(r: AgentRec, ev: Extract<AgentEvent, { k: 'turn-end' }>) {
    const c = r.card;
    this.stopClock(r);
    this.setBucket(r, null);
    // The limit it hit isn't news, because it's carrying on with API credits.
    if (r.switchingCredits) { r.switchingCredits = false; return; }
    if (c.isMaster && !ev.isError) {
      // Its replies aren't worth a popup. When it needs the user it asks a question, which raises one.
      this.unrouted = [];
      c.status = c.attention ? 'attention' : 'idle';
      return;
    }
    if (c.final) { c.status = 'finished'; if (c.attention?.kind !== 'testing' && !c.merge?.conflicts?.length) c.attention = null; return; }
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
      if (c.isMaster) this.masterFailed(text);
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
    if (this.workspaceHolds.size) return;
    const cards = [...this.agents.values()].map((r) => r.card).filter((c) => !c.archived && !c.isMaster && !c.isWorkspace);
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
    const view = (id: string, info: NodeInfo, online: boolean): MachineView => ({ info, online, stats: this.remoteStats.get(id) ?? null, slots: this.remoteSlots.get(id) ?? [], lastSeen: Date.now(), update: this.hostUpdates.view(id) });
    const local = view(LOCAL_HOST_ID, this.localInfo, this.local ? true : !!this.localNode?.online);
    if (this.local) local.slots = this.local.slots.list();
    const remote = [...this.link.nodes.values()].filter((n) => n.hostId !== LOCAL_HOST_ID).map((n) => view(n.hostId, n.info, n.online));
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
      appUpdate: this.appUpdate,
      apiCredits: this.creditsView(),
    };
  }

  // ---- API credits ----

  private creditsView(): ApiCreditsView {
    const { enabled, key, problem } = this.apiCredits;
    return { enabled, hasKey: !!key, problem };
  }

  private creditsChanged() {
    this.emitEvent({ e: 'api-credits', view: this.creditsView() });
    this.scheduleSave();
  }

  setApiCreditsEnabled(on: boolean) {
    this.apiCredits.enabled = on;
    if (on) this.apiCredits = { ...this.apiCredits, problem: undefined, failedAt: undefined };
    this.creditsChanged();
  }

  setApiKey(key: string | null) {
    this.apiCredits = { enabled: this.apiCredits.enabled && !!key, key };
    this.creditsChanged();
  }

  private canUseCredits() {
    const { enabled, key, failedAt } = this.apiCredits;
    return enabled && !!key && (!failedAt || Date.now() - failedAt > CREDITS_RETRY_MS);
  }

  private async switchToCredits(r: AgentRec, resetsAt?: number) {
    const c = r.card;
    c.onApiCredits = true;
    c.creditsUntil = resetsAt ?? Date.now() + CREDITS_RETRY_MS;
    const until = resetsAt ? ` until it resets at ${new Date(resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    this.note(r, `Hit the subscription's usage limit, so carrying on with API credits${until}.`, 'warn', true);
    const carryOn = "Your last request was cut off by the subscription's usage limit. You're now on API credits, so carry on from where you stopped.";
    try {
      const live = await this.nodeCall<boolean>(c.nodeId, 'agent.useCredits', { agentId: c.id, apiKey: this.apiCredits.key, carryOn });
      if (!live) {
        await this.ensureRunning(r);
        await this.send(c.id, carryOn, undefined, undefined, 'UE Fleet');
      }
    } catch (e: any) {
      c.onApiCredits = false;
      c.creditsUntil = undefined;
      c.attention = { kind: 'error', text: `It hit the usage limit and couldn't switch to API credits: ${e?.message ?? e}`.slice(0, 180), at: Date.now() };
      c.status = 'attention';
      this.emit('attention', c);
    }
    this.dirtyCards.add(c.id);
    this.scheduleSave();
  }

  private stopUsingCredits(r: AgentRec) {
    const c = r.card;
    c.onApiCredits = false;
    c.creditsUntil = undefined;
    this.dirtyCards.add(c.id);
    this.scheduleSave();
    void this.nodeCall(c.nodeId, 'agent.useCredits', { agentId: c.id, apiKey: null }).catch(() => {});
  }

  // The key was refused or the credits ran out. The turn's own error tells the user, and nothing else
  // tries for a while, so a whole fleet doesn't fail on it one agent at a time.
  private creditsFailed(r: AgentRec, why: string) {
    this.apiCredits = { ...this.apiCredits, problem: why.slice(0, 200), failedAt: Date.now() };
    this.creditsChanged();
    this.note(r, `API credits aren't available, so it's stopped until the subscription's limit resets: ${why}`, 'error', true);
    this.stopUsingCredits(r);
  }

  // Once the limit has reset, or the option's been turned off. Never in the middle of a turn, because
  // restarting the session would cut it off.
  private endCredits() {
    for (const r of this.agents.values()) {
      const c = r.card;
      if (!c.onApiCredits || c.archived || (this.apiCredits.enabled && Date.now() < (c.creditsUntil ?? 0))) continue;
      if (LIVE.has(c.status) || c.attention?.ref) continue;
      this.note(r, 'Back on the subscription.');
      this.stopUsingCredits(r);
    }
  }

  // ---- Keeping other machines' workspaces up to date ----

  private syncKey(nodeId: string, file: string) { return `${nodeId}|${normalPath(file)}`; }
  private machineName(nodeId: string) { return this.nodeInfo(nodeId)?.name ?? 'that machine'; }

  // Anything in that workspace that isn't done. Its files are pending there until it's merged, and it's
  // working from what's on disk, so nothing moves underneath it. Tasks still starting wait for the update.
  private unfinishedIn(nodeId: string, file: string) {
    const folder = normalPath(file);
    return [...this.agents.values()].filter((o) => !o.card.archived && !o.launching && o.card.nodeId === nodeId && normalPath(o.spawn.project?.file ?? '') === folder && o.card.stage !== 'complete' && o.card.status !== 'stopped');
  }

  // What has already reached this PC from that machine, so its copy there has nothing left to lose.
  private async deliveredFrom(nodeId: string) {
    const hashes = new Map<string, Set<string>>();
    const paths: string[] = [];
    const add = (rel: string, hash: string) => {
      const key = normalPath(rel);
      if (!hashes.has(key)) { hashes.set(key, new Set()); paths.push(rel); }
      hashes.get(key)!.add(hash);
    };
    for (const [rel, list] of Object.entries(this.delivered[nodeId] ?? {})) for (const h of list) add(rel, h);
    for (const r of this.agents.values()) {
      if (r.card.nodeId !== nodeId) continue;
      const dir = this.mergedDir(r.card.id);
      for (const e of await fsp.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
        if (e.isFile()) add(path.relative(dir, path.join(e.parentPath, e.name)), await hashOf(path.join(e.parentPath, e.name)));
      }
    }
    return { paths, has: (rel: string, hash?: string) => !!hash && !!hashes.get(normalPath(rel))?.has(hash) };
  }

  // Sorts what's pending into what can go and what's in the way. Files that aren't under source control
  // never hold an update up, because an update leaves them alone.
  private async workspaceOutlook(nodeId: string, file: string, project: string, discard: string[] = []) {
    const here = this.localInfo.projects.find((p) => !p.received && p.name.toLowerCase() === project.toLowerCase());
    const follow = here ? await this.nodeCall<{ repo: string; branch: string } | null>(LOCAL_HOST_ID, 'machine.workspaceBranch', { file: here.file }).catch(() => null) : null;
    const delivered = await this.deliveredFrom(nodeId);
    const state = await this.nodeCall<(WorkspaceState & { personEditor: boolean }) | null>(nodeId, 'machine.workspaceState', { file, follow, delivered: delivered.paths });
    if (!state) return null;
    const dropped = new Set(discard.map(normalPath));
    const safe = (p: PendingChange) => p.checkedIn || delivered.has(p.path, p.hash) || dropped.has(normalPath(p.path));
    return {
      state,
      behind: state.branch !== state.targetBranch || state.changeset !== state.latest,
      clear: state.pending.filter(safe),
      inTheWay: state.pending.filter((p) => !safe(p) && p.status !== 'PR'),
    };
  }

  private async syncWorkspace(nodeId: string, file: string, project: string, discard: string[]): Promise<SyncResult> {
    const name = this.machineName(nodeId);
    const outlook = await this.workspaceOutlook(nodeId, file, project, discard);
    if (!outlook) return { outcome: 'current', message: `${project} on ${name} isn't under source control, so there's nothing to update.` };
    const { state, behind, clear, inTheWay } = outlook;
    if (!behind) {
      this.lastSynced[this.syncKey(nodeId, file)] = Date.now();
      return { outcome: 'current', message: `${name} is already up to date, on changeset ${state.changeset} of ${state.targetBranch}.` };
    }
    if (state.personEditor) return { outcome: 'blocked', message: `${name} wasn't updated, because someone has ${project} open in an editor there. It would keep its old assets in memory and could save over what arrives.` };
    if (inTheWay.length) {
      const list = inTheWay.slice(0, 15).map((p) => p.path).join(', ');
      return { outcome: 'blocked', message: `${name} wasn't updated, because ${inTheWay.length} pending change${inTheWay.length === 1 ? '' : 's'} there aren't checked in or merged to this PC: ${list}${inTheWay.length > 15 ? ', and more' : ''}.` };
    }
    const res = await this.nodeCall<{ changeset: string }>(nodeId, 'machine.updateWorkspace', { file, targetBranch: state.targetBranch, clear: clear.map((p) => ({ path: p.path, status: p.status, hash: p.hash })) });
    this.lastSynced[this.syncKey(nodeId, file)] = Date.now();
    delete this.delivered[nodeId];
    const moved = state.branch !== state.targetBranch ? `, moving it from ${state.branch}` : '';
    const cleared = clear.length ? `, clearing ${clear.length} pending change${clear.length === 1 ? '' : 's'} that were already checked in or merged here` : '';
    return { outcome: 'updated', message: `Updated ${name} to changeset ${res.changeset} of ${state.targetBranch}${moved}${cleared}.` };
  }

  private runSync(nodeId: string, file: string, project: string, discard: string[] = []) {
    const key = this.syncKey(nodeId, file);
    const running = this.workspaceSyncs.get(key);
    if (running) return running;
    const work = this.syncWorkspace(nodeId, file, project, discard)
      .catch((e): SyncResult => ({ outcome: 'failed', message: /Unknown method/.test(String(e?.message)) ? `${this.machineName(nodeId)}'s host is too old to update its workspace, so it needs a new fleet-host.exe first.` : `${this.machineName(nodeId)} couldn't update its workspace: ${e?.message ?? e}` }))
      .finally(() => { this.workspaceSyncs.delete(key); this.scheduleSave(); });
    this.workspaceSyncs.set(key, work);
    return work;
  }

  // A task starts from recent code if it can, and always starts: nothing here is worth stopping it for.
  private async freshenWorkspace(rec: AgentRec, file: string, project: string) {
    const nodeId = rec.card.nodeId;
    const key = this.syncKey(nodeId, file);
    const running = this.workspaceSyncs.get(key);
    if (!running && Date.now() - (this.lastSynced[key] ?? 0) < WORKSPACE_FRESH_MS) return;
    const unfinished = this.unfinishedIn(nodeId, file);
    if (!running && unfinished.length) {
      this.queuedSyncs.set(key, { nodeId, file, project });
      this.note(rec, `${this.machineName(nodeId)} is due for an update, but agent ${unfinished.map((o) => pad2(o.card.index)).join(', ')} is mid-task there, so this starts from what's on disk. It'll update once they're done.`);
      return;
    }
    rec.card.status = 'provisioning';
    rec.card.detail = 'Getting the latest changes';
    this.dirtyCards.add(rec.card.id);
    const res = await (running ?? this.runSync(nodeId, file, project));
    if (res.outcome === 'updated') this.note(rec, res.message);
    else if (res.outcome !== 'current') this.note(rec, `${res.message} This starts from what's on disk.`, 'warn', true);
  }

  private runQueuedSyncs() {
    for (const [key, q] of this.queuedSyncs) {
      if (this.workspaceSyncs.has(key) || !this.link.nodes.get(q.nodeId)?.online || this.unfinishedIn(q.nodeId, q.file).length) continue;
      this.queuedSyncs.delete(key);
      this.scheduleSave();
      void this.runSync(q.nodeId, q.file, q.project).then((res) => this.reportSync(res));
    }
  }

  private reportSync(res: SyncResult) {
    if (res.outcome !== 'current') this.note(this.masterRec, res.message, res.outcome === 'updated' ? undefined : 'warn', true);
  }

  // ---- The workspace chat ----

  private holdOn(file?: string | null) { return !!file && this.workspaceHolds.has(normalPath(file)); }

  private othersInFolder(r: AgentRec) {
    const file = normalPath(r.spawn.project?.file ?? '');
    return [...this.agents.values()].filter((o) => o !== r && !o.card.archived && o.card.nodeId === r.card.nodeId && normalPath(o.spawn.project?.file ?? '') === file);
  }

  // Another agent carrying on while its files change underneath it could lose work, or get swept up
  // in what's being merged. A work in progress can't be paused, so it's interrupted and told afterwards.
  private async holdWorkspace(r: AgentRec): Promise<string> {
    const file = r.spawn.project?.file;
    if (!file) return "This chat has no project, so there's nothing to hold.";
    this.workspaceHolds.set(normalPath(file), r.card.id);
    r.card.holdingWorkspace = true;
    this.dirtyCards.add(r.card.id);
    this.scheduleSave();
    const others = this.othersInFolder(r);
    await Promise.all(others.map(async (o) => {
      const c = o.card;
      if (LIVE.has(c.status) || c.attention?.ref) {
        c.pausedForWorkspace = true;
        this.note(o, 'Paused while the workspace chat changes the workspace.', 'warn', true);
        await this.interrupt(c.id).catch(() => {});
      }
      await this.stopInstance(c.id).catch(() => {});
    }));
    const { personEditor } = await this.nodeCall<{ personEditor: boolean }>(r.card.nodeId, 'machine.projectQuiet', { file });
    const agents = await Promise.all(others.map(async (o) => ({
      agent: o.card.index, title: o.card.title, stage: o.card.stage, paused: !!o.card.pausedForWorkspace,
      changedFiles: (await this.changes(o.card.id).catch(() => [] as ChangedFile[])).map((f) => f.path),
    })));
    return JSON.stringify({ agents, personEditorOpen: personEditor }, null, 2);
  }

  async releaseWorkspace(agentId: string, summary?: string): Promise<string> {
    const r = this.need(agentId);
    const file = r.spawn.project?.file;
    if (!file || !r.card.holdingWorkspace) return 'Nothing was on hold.';
    this.workspaceHolds.delete(normalPath(file));
    r.card.holdingWorkspace = false;
    this.dirtyCards.add(agentId);
    this.scheduleSave();
    for (const wake of this.holdWaiters.splice(0)) wake();
    const changed = summary ? `: ${summary}` : '';
    let carrying = 0;
    for (const o of this.othersInFolder(r)) {
      if (o.heldNew) {
        o.heldNew = false;
        void this.launch(o, o.sourceProjectDir ?? null);
        carrying++;
      } else if (o.card.pausedForWorkspace) {
        o.card.pausedForWorkspace = false;
        void this.send(o.card.id, `The workspace chat has finished changing the workspace${changed}. Files may have changed under you, and your editor was stopped. Re-read anything you were relying on, rebuild if code changed, and carry on.`, undefined, undefined, 'UE Fleet').catch(() => {});
        carrying++;
      }
    }
    this.checkAllDone();
    return `${carrying} agents are carrying on.`;
  }

  // Work coming back from another machine waits too, or it would land in the middle of a merge.
  private async workspaceFree(r: AgentRec) {
    const file = this.masterProjectFile(r) ?? r.spawn.project?.file;
    while (this.holdOn(file)) await new Promise<void>((wake) => this.holdWaiters.push(wake));
  }

  private safePairing() { try { return this.link.pairing(); } catch { return null; } }

  // ---- Actions from the UI ----

  private liveOn = (nodeId: string) => [...this.agents.values()].filter((r) => r.card.nodeId === nodeId && !r.card.archived && LIVE.has(r.card.status)).length;

  // ---- The master chat ----

  private ensureMasterCard() {
    const existing = this.agents.get(MASTER_CHAT_ID);
    if (existing) { this.masterRec = existing; return; }
    const card: AgentCard = {
      id: MASTER_CHAT_ID, index: 0, title: 'Master chat', nodeId: MASTER_CHAT_ID, project: null, isMaster: true,
      model: MASTER_MODEL, effort: MASTER_EFFORT, permissionMode: 'default', instanceMode: 'headless',
      status: 'idle', attention: null, lastText: '', lastTextAt: 0, lastPrompt: '', lastPromptAt: 0,
      createdAt: Date.now(), sessionMs: 0, runningSince: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, context: 0, costUsd: 0 },
      tokens: 0, tps: 0, spark: [], buckets: emptyBuckets(), slot: null, final: null,
    };
    const spawn: AgentSpawn = { id: MASTER_CHAT_ID, prompt: '', title: card.title, model: card.model, effort: card.effort, permissionMode: card.permissionMode, instanceMode: card.instanceMode };
    this.masterRec = { card, transcript: [], byId: new Map(), bucket: null, bucketSince: Date.now(), tokensThisTick: 0, lastSeq: 0, pendingItems: new Map(), pendingDeltas: new Map(), spawn };
    this.agents.set(MASTER_CHAT_ID, this.masterRec);
  }

  private master(): MasterBackend {
    if (this.masterBackend) return this.masterBackend;
    const r = this.masterRec;
    const emit = (ev: AgentEvent) => this.reduce(r, ev);
    if (this.opts.demo) return (this.masterBackend = new DemoMaster(this.masterActions(), emit));
    const info = this.localInfo;
    const projects = info.projects.filter((p) => !p.received);
    const main = projects.find((p) => p.file === this.defaults.projectFile) ?? projects[0];
    // In the project it picks up whatever the user's own Claude has there. The session stays with
    // this folder from then on, because a conversation can only resume from where it started.
    r.slotDir ??= main?.dir ?? path.join(this.opts.dataDir, 'master');
    this.masterBackend = new RealMaster({
      spawn: { ...r.spawn, resumeSessionId: r.card.sessionId }, cwd: r.slotDir, claudePath: info.claudePath, machineName: info.name,
      actions: this.masterActions(), otherDirs: projects.map((p) => p.dir).filter((d) => d !== r.slotDir), emit,
    });
    return this.masterBackend;
  }

  private async masterRpc(method: string, p: any): Promise<unknown> {
    switch (method) {
      case 'agent.send': return this.master().send(p.text, p.images, p.from);
      case 'agent.decide': return this.master().decide(p.itemId, p.decision);
      case 'agent.answer': return this.master().answer(p.itemId, p.answers);
      case 'agent.interrupt':
      case 'agent.stop': return this.master().interrupt();
      case 'agent.has': return true;
      case 'agent.useCredits': this.master().useCredits(p.apiKey, p.carryOn); return true;
      case 'agent.setOptions': await this.master().setOptions(p.options); return true;
      case 'agent.changes': return [];
      case 'agent.log': return '';
      default: return null;
    }
  }

  private masterActions(): MasterActions {
    const nameOf = (nodeId: string) => this.machines().find((m) => m.info.id === nodeId)?.info.name ?? nodeId;
    const byNumber = (n: number) => {
      const r = [...this.agents.values()].find((x) => x.card.index === n && !x.card.archived && !x.card.isMaster);
      if (!r) throw new Error(`There's no agent ${n}.`);
      return r;
    };
    const machineNamed = (name: string) => {
      const m = this.machines().find((x) => x.info.name.toLowerCase() === name.toLowerCase());
      if (!m) throw new Error(`There's no machine called ${name}. Connected: ${this.machines().map((x) => x.info.name).join(', ')}.`);
      return m;
    };
    // One line per agent, so one that fails doesn't hide what happened to the rest.
    const each = async (agents: number[], act: (r: AgentRec) => Promise<string>) => (await Promise.all(agents.map(async (n) => {
      try { return `${pad2(n)}: ${await act(byNumber(n))}`; } catch (e: any) { return `${pad2(n)}: ${e?.message ?? e}`; }
    }))).join('\n');
    const workspaceOn = (a: { machine: string; project?: string }) => {
      const m = machineNamed(a.machine);
      const wanted = a.project ?? (this.defaults.projectFile ? path.basename(this.defaults.projectFile, '.uproject') : undefined);
      const own = m.info.projects.filter((p) => !p.received);
      const project = own.find((p) => p.name.toLowerCase() === wanted?.toLowerCase()) ?? (a.project ? undefined : own[0]);
      if (!project) throw new Error(`${m.info.name} has no workspace for ${wanted ?? 'that project'}. It has: ${own.map((p) => p.name).join(', ') || 'none'}.`);
      return { m, project };
    };
    return {
      // Not waited for, because the session being changed is the one waiting on this tool.
      setOwnPermissions: async (a) => {
        void this.setMasterPermissions(a.mode);
        return `This chat now uses ${a.mode} permissions.`;
      },
      workspaceStatus: async (a) => {
        const { m, project } = workspaceOn(a);
        const outlook = await this.workspaceOutlook(m.info.id, project.file, project.name);
        if (!outlook) return `${project.name} on ${m.info.name} isn't under source control.`;
        const { state, behind, clear, inTheWay } = outlook;
        const key = this.syncKey(m.info.id, project.file);
        return JSON.stringify({
          machine: m.info.name, project: project.name, branch: state.branch, changeset: state.changeset, targetBranch: state.targetBranch, latest: state.latest, behind,
          personEditorOpen: state.personEditor, unfinishedAgents: this.unfinishedIn(m.info.id, project.file).map((o) => o.card.index), updateWaiting: this.queuedSyncs.has(key), updating: this.workspaceSyncs.has(key),
          lastUpdated: this.lastSynced[key] ? new Date(this.lastSynced[key]).toLocaleString() : null,
          safeToClear: clear.length, inTheWay: inTheWay.map((p) => `${p.status} ${p.path}`),
        }, null, 2);
      },
      updateWorkspace: async (a) => {
        const { m, project } = workspaceOn(a);
        const nodeId = m.info.id;
        if (nodeId === LOCAL_HOST_ID) return "That's this PC, where the user works, so it isn't updated this way. Use open_workspace_chat, which checks with them first.";
        const key = this.syncKey(nodeId, project.file);
        const unfinished = this.unfinishedIn(nodeId, project.file);
        if (unfinished.length && !this.workspaceSyncs.has(key)) {
          this.queuedSyncs.set(key, { nodeId, file: project.file, project: project.name });
          this.scheduleSave();
          return `${m.info.name} has work in progress there (agent ${unfinished.map((o) => pad2(o.card.index)).join(', ')}), so it'll update as soon as that's finished.`;
        }
        const work = this.runSync(nodeId, project.file, project.name, a.discard);
        const done = await Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), SYNC_WAIT_MS))]);
        if (done) return done.message;
        void work.then((res) => this.reportSync(res));
        return `${m.info.name} is still updating, which can take a while. The result will appear in this chat.`;
      },
      machines: () => this.machines().map((m) => ({ name: m.info.name, online: m.online, cpuPercent: m.stats?.cpu, freeRamGb: m.stats ? m.info.ramGb - m.stats.ramUsedGb : undefined, agents: this.liveOn(m.info.id), maxEditors: m.info.maxInstances, projects: m.info.projects.map((p) => p.name), update: m.update?.stage })),
      agents: () => [...this.agents.values()].map((r) => r.card).filter((c) => !c.archived && !c.isMaster).map((c) => ({ number: c.index, title: c.title, stage: c.stage, status: c.status, machine: nameOf(c.nodeId), project: c.project, model: c.model, effort: c.effort, permissions: c.permissionMode, onApiCredits: c.onApiCredits, workspaceChat: c.isWorkspace, pausedForWorkspace: c.pausedForWorkspace, progress: c.progress, needsUser: c.attention?.text, said: c.lastText.slice(0, 300) })),
      startTask: async (a) => {
        const opts = this.masterOptions ?? { ...this.defaults, nodeId: 'auto', prompt: '' };
        const known = this.localInfo.projects;
        const named = a.project ? known.find((p) => p.name.toLowerCase() === a.project!.toLowerCase()) : undefined;
        if (a.project && !named) throw new Error(`There's no project called ${a.project} on this PC. It has: ${known.map((p) => p.name).join(', ')}.`);
        const machine = a.machine ? machineNamed(a.machine) : undefined;
        const images = opts.images;
        if (this.masterOptions) this.masterOptions.images = undefined;
        this.unrouted = [];
        const id = await this.createAgent({ ...opts, ...chosenOptions(a), prompt: a.prompt, images, projectFile: named?.file ?? opts.projectFile, nodeId: machine?.info.id ?? opts.nodeId }, a.title);
        const c = this.need(id).card;
        return `Started agent ${pad2(c.index)} "${c.title}" on ${nameOf(c.nodeId)}.`;
      },
      messageAgent: async (a) => {
        const r = byNumber(a.agent);
        this.unrouted = [];
        await this.send(r.card.id, a.text);
        return `Sent to agent ${pad2(r.card.index)}.`;
      },
      answerAgent: async (a) => this.answerQuestion(a.request_id, a.answer),
      assignChangelist: async (a) => this.assignChangelist(byNumber(a.agent), a.name, a.description),
      openWorkspaceChat: async (a) => {
        const known = this.localInfo.projects.filter((p) => !p.received);
        const project = a.project ? known.find((p) => p.name.toLowerCase() === a.project!.toLowerCase()) : known.find((p) => p.file === this.defaults.projectFile) ?? known[0];
        if (!project) throw new Error(`There's no ${a.project ? `project called ${a.project}` : 'project'} on this PC to open it on. It has: ${known.map((p) => p.name).join(', ') || 'none'}.`);
        const open = [...this.agents.values()].find((r) => r.card.isWorkspace && !r.card.archived && normalPath(r.spawn.project?.file ?? '') === normalPath(project.file));
        if (open) {
          await this.send(open.card.id, a.prompt);
          return `Agent ${pad2(open.card.index)} is already the workspace chat for ${project.name}, so this went to it.`;
        }
        const opts = this.masterOptions ?? { ...this.defaults, nodeId: 'auto', prompt: '' };
        const id = await this.createAgent({ ...opts, images: undefined, permissionMode: DEFAULT_PERMISSION_MODE, prompt: a.prompt, projectFile: project.file, nodeId: LOCAL_HOST_ID, workspace: true, demo: this.opts.demo ? 'reply' : undefined }, a.title ?? `Workspace: ${project.name}`);
        return `Opened agent ${pad2(this.need(id).card.index)} as the workspace chat for ${project.name}.`;
      },
      agentDetails: async (a) => {
        const { card: c } = byNumber(a.agent);
        const files = await this.changes(c.id).catch(() => [] as ChangedFile[]);
        const recent = this.transcript(c.id).filter((t) => t.kind === 'user' || t.kind === 'assistant').slice(-8).map((t) => ({ from: t.kind, text: (t as { text: string }).text.slice(0, 1000) }));
        return JSON.stringify({ number: c.index, title: c.title, stage: c.stage, status: c.status, machine: nameOf(c.nodeId), project: c.project, model: c.model, effort: c.effort, permissions: c.permissionMode, progress: c.progress, needsUser: c.attention?.text, finalReport: c.final, merge: c.merge, changelist: c.changelist, filesChanged: files.map((f) => f.path), recent }, null, 2);
      },
      setAgentOptions: async (a) => {
        const options = chosenOptions(a);
        if (!Object.keys(options).length) throw new Error('Pass a model, effort or permission_mode to change.');
        return each(a.agents, (r) => this.setAgentOptions(r.card.id, options));
      },
      interruptAgents: (a) => each(a.agents, async (r) => { await this.interrupt(r.card.id); return 'interrupted'; }),
      stopAgents: (a) => each(a.agents, async (r) => { await this.stopAgent(r.card.id); return 'stopped'; }),
      archiveAgents: (a) => each(a.agents, async (r) => {
        const lost = a.discard_unmerged ? [] : await this.unmergedFiles(r);
        if (lost.length) return `not archived, because ${lost.length} changed files haven't been merged and would be lost: ${lost.slice(0, 10).join(', ')}`;
        await this.archive(r.card.id);
        return 'archived';
      }),
      approveAgents: (a) => each(a.agents, async (r) => {
        const c = r.card;
        if (c.stage !== 'testing') return `it's at ${c.stage ?? 'no stage'}, so there's nothing to approve`;
        await this.approve(c.id);
        const conflicts = c.merge?.conflicts?.length;
        return conflicts ? `approved, but ${conflicts} files conflict, so resolve_conflicts has to settle them` : `approved, now at ${c.stage}`;
      }),
      reportIssue: async (a) => {
        const r = byNumber(a.agent);
        await this.reportIssue(r.card.id, a.text);
        return `Sent it back to agent ${pad2(r.card.index)}.`;
      },
      openTestEditor: async (a) => {
        const r = byNumber(a.agent);
        void this.testChanges(r.card.id).catch((e) => this.note(r, `Couldn't open the editor: ${e?.message ?? e}`, 'error'));
        return "Pulling its changes and opening the editor. Its card shows how that's going.";
      },
      resolveConflicts: async (a) => {
        const r = byNumber(a.agent);
        if (!r.card.merge?.conflicts?.length) return `Agent ${pad2(r.card.index)} has no conflicts.`;
        await this.resolveConflicts(r.card.id, a.keep);
        return `Kept ${a.keep === 'agent' ? "the agent's" : "the user's"} version, and agent ${pad2(r.card.index)} is now at ${r.card.stage}.`;
      },
      stopEditors: (a) => each(a.agents, async (r) => { await this.stopInstance(r.card.id); return 'editor stopped'; }),
      setMaxEditors: async (a) => {
        const m = machineNamed(a.machine);
        await this.setMaxInstances(m.info.id, a.max);
        return `${m.info.name} can now run ${a.max} editors at once.`;
      },
      restartHost: async (a) => {
        const m = machineNamed(a.machine);
        if (m.update?.stage !== 'waiting') return `${m.info.name} has no new version waiting.`;
        await this.restartHost(m.info.id);
        return `Restarting ${m.info.name} into its new version. Its agents carry on when it's back.`;
      },
    };
  }

  // From the top of its chat, or by asking it.
  async setMasterPermissions(mode: string) {
    if (!MASTER_PERMISSION_MODES.includes(mode)) throw new Error(`The master chat can't use ${mode}.`);
    return this.setAgentOptions(MASTER_CHAT_ID, { permissionMode: mode });
  }

  // Takes effect from the agent's next model call, and stays through a restart.
  private async setAgentOptions(agentId: string, o: AgentOptions) {
    const r = this.need(agentId);
    Object.assign(r.card, o);
    Object.assign(r.spawn, o);
    this.dirtyCards.add(agentId);
    this.scheduleSave();
    const c = r.card;
    this.note(r, `Now on ${modelLabel(c.model)} at ${c.effort} effort, with ${c.permissionMode} permissions.`);
    const saved = 'saved for when it next runs';
    if (r.notStarted) return saved;
    try {
      const live = await this.nodeCall<boolean>(c.nodeId, 'agent.setOptions', { agentId, options: o });
      return live ? 'changed' : saved;
    } catch (e: any) {
      return `${saved}, because its machine couldn't change it now: ${e?.message ?? e}. If that machine has an update waiting, restart_host applies both.`;
    }
  }

  // Archiving frees a private copy, which would wipe anything not merged yet. Work in a shared folder
  // stays where it is.
  private async unmergedFiles(r: AgentRec) {
    const merged = ['merged', 'checking-in', 'complete'].includes(r.card.stage ?? '');
    if (r.card.slot?.shared || merged) return [];
    return (await this.changes(r.card.id)).map((f) => f.path);
  }

  // A new task from the user. It always gets somewhere: if the master can't run, it starts directly.
  async request(task: NewTask): Promise<string> {
    this.defaults = { model: task.model, effort: task.effort, permissionMode: DEFAULT_PERMISSION_MODE, instanceMode: task.instanceMode, projectFile: task.projectFile };
    this.unrouted.push(task);
    this.scheduleSave();
    await this.route(task);
    return MASTER_CHAT_ID;
  }

  private async route(task: NewTask, extra = '') {
    this.masterOptions = { ...task };
    const project = task.projectFile ? readProject(task.projectFile, this.localInfo.engines)?.name : null;
    const machine = this.machines().find((m) => m.info.id === task.nodeId)?.info.name;
    await this.send(MASTER_CHAT_ID, `${task.prompt}\n\n(Options: project ${project ?? 'none chosen'}, machine ${machine ?? 'automatic'}.${extra})`, task.images);
  }

  private masterFailed(why: string) {
    const tasks = this.unrouted.splice(0);
    for (const t of tasks) {
      this.note(this.masterRec, `Started "${titleFrom(t.prompt)}" directly, because the master chat couldn't run: ${why}`, 'warn');
      void this.createAgent(t);
    }
    for (const id of [...this.openQuestions.keys()]) void this.answerQuestion(id, `The master chat couldn't run, so nobody can look this up right now: ${why}. Carry on with what you have, and say in your final message what you couldn't find out.`);
    // A changelist still gets made, named after the task.
    for (const r of this.agents.values()) if (r.card.stage === 'checking-in' && !r.card.changelist) void this.assignChangelist(r, r.card.title, r.card.final?.summary ?? r.card.title);
  }

  private questionForMaster(r: AgentRec, askId: string, question: string) {
    const c = r.card;
    const machine = this.machines().find((m) => m.info.id === c.nodeId)?.info.name ?? 'another machine';
    const id = `${c.id}:${askId}`;
    this.openQuestions.set(id, { agentId: c.id, askId, label: `agent ${pad2(c.index)} "${c.title}" on ${machine}`, question });
    this.sendQuestion(id);
  }

  private sendQuestion(id: string, extra?: string) {
    const q = this.openQuestions.get(id);
    if (!q) return;
    void this.send(MASTER_CHAT_ID, `[Question from ${q.label}]\nrequest_id: ${id}\n\n${q.question}${extra ? `\n\n(${extra})` : ''}`, undefined, undefined, q.label).catch(() => {});
  }

  private async answerQuestion(id: string, answer: string) {
    const q = this.openQuestions.get(id);
    if (!q) return `Nothing is waiting on ${id}.`;
    const r = this.need(q.agentId);
    const delivered = await this.nodeCall<boolean>(r.card.nodeId, 'agent.masterReply', { agentId: q.agentId, id: q.askId, answer });
    this.openQuestions.delete(id);
    this.scheduleSave();
    return delivered ? `Answered ${q.label}.` : `${q.label} isn't waiting any more, so the answer went nowhere.`;
  }

  // ---- A task's way through testing, merging and checking in ----

  private masterProjectFile(r: AgentRec) {
    return r.sourceProjectDir && r.spawn.project ? path.join(r.sourceProjectDir, path.basename(r.spawn.project.file)) : null;
  }

  // Brings the agent's files into the user's workspace. Work in a shared folder here is already
  // there, so this only notes which files they are. Returns false if it needs the user first.
  private async merge(r: AgentRec, force?: string[]): Promise<boolean> {
    const c = r.card;
    try {
      await this.workspaceFree(r);
      const files = (await this.changes(c.id)).filter((f) => !f.usuallySkipped && !r.keepMine?.includes(f.path)).map((f) => f.path);
      const add = (list: string[]) => { r.pulled = [...new Set([...(r.pulled ?? []), ...list])]; };
      if (c.slot?.shared && c.nodeId === 'master') add(files);
      else if (files.length) {
        const res = await this.apply(c.id, files, force);
        add([...res.applied, ...res.merged]);
        if (res.merged.length) this.note(r, `Merged ${res.merged.length} file${res.merged.length === 1 ? '' : 's'} with what was already in your workspace, keeping both sets of changes:\n${res.merged.join('\n')}`, undefined, true);
        if (res.conflicts.length) {
          c.merge = { files: r.pulled?.length ?? 0, conflicts: res.conflicts };
          c.attention = { kind: 'error', text: `${res.conflicts.length} file${res.conflicts.length === 1 ? '' : 's'} couldn't be merged with your workspace. Choose which to keep.`, at: Date.now() };
          this.emit('attention', c);
          return false;
        }
      }
      c.merge = { files: r.pulled?.length ?? 0 };
      return true;
    } catch (e: any) {
      c.merge = { files: r.pulled?.length ?? 0, error: String(e?.message ?? e) };
      return false;
    } finally {
      this.dirtyCards.add(c.id);
      this.scheduleSave();
    }
  }

  // Moves a finished task along until it's complete or something needs the user.
  private async advance(r: AgentRec, force?: string[]) {
    if (r.advancing) return;
    r.advancing = true;
    try {
      const c = r.card;
      if (c.stage === 'awaiting-merge') {
        if (c.project && !(await this.merge(r, force))) return;
        c.stage = c.project ? 'merged' : 'complete';
        this.dirtyCards.add(c.id);
      }
      if (c.stage === 'merged') {
        const dir = r.sourceProjectDir;
        if (!r.pulled?.length || !dir || !isPlasticWorkspace(dir)) c.stage = 'complete';
        else c.stage = 'checking-in';
        this.dirtyCards.add(c.id);
      }
      if (c.stage === 'checking-in' && !c.changelist) this.askForChangelist(r);
      this.scheduleSave();
      this.checkAllDone();
    } finally {
      r.advancing = false;
    }
  }

  private askForChangelist(r: AgentRec) {
    if (r.askedForChangelist) return;
    r.askedForChangelist = true;
    const c = r.card;
    const files = r.pulled ?? [];
    const list = files.slice(0, 60).map((f) => `- ${f}`).join('\n');
    const more = files.length > 60 ? `\n...and ${files.length - 60} more` : '';
    const title = c.title.replaceAll('"', "'");
    void this.send(MASTER_CHAT_ID, `[Ready for a changelist] Agent ${c.index} "${title}"\nIts request: ${r.spawn.prompt.slice(0, 800)}\nWhat it did: ${c.final?.summary ?? 'not recorded'}\n${files.length} files:\n${list}${more}`, undefined, undefined, `agent ${pad2(c.index)}`).catch(() => {});
  }

  private async assignChangelist(r: AgentRec, name: string, description: string): Promise<string> {
    const c = r.card;
    const dir = r.sourceProjectDir;
    if (!dir || !isPlasticWorkspace(dir)) return `${c.project ?? 'That task'} isn't in a Plastic workspace here.`;
    if (!r.pulled?.length) return `Agent ${pad2(c.index)} has nothing merged yet.`;
    if (r.assigning) return 'That changelist is already being made.';
    r.assigning = true;
    try {
      const res = await assignToChangelist(dir, name, description, r.pulled, this.opts.cm ?? realCm(dir));
      if (res.failed.length) this.note(r, `Couldn't put ${res.failed.length} file${res.failed.length === 1 ? '' : 's'} in the changelist:\n${res.failed.map((f) => `${f.path}: ${f.reason}`).join('\n')}`, 'warn');
      if (!res.assigned.length) {
        c.attention = { kind: 'error', text: 'Couldn\'t make the Plastic changelist. See the chat for why.', at: Date.now() };
        this.emit('attention', c);
        return `Nothing went into the changelist. ${res.failed.map((f) => `${f.path}: ${f.reason}`).join('; ')}`;
      }
      c.changelist = res.name;
      c.stage = 'complete';
      this.note(r, `Put ${res.assigned.length} file${res.assigned.length === 1 ? '' : 's'} in the Plastic changelist "${res.name}". Check it in from Plastic when you're ready.`, undefined, true);
      this.checkAllDone();
      return `Assigned ${res.assigned.length} files to "${res.name}".${res.failed.length ? ` ${res.failed.length} couldn't go in.` : ''}`;
    } finally {
      r.assigning = false;
      this.dirtyCards.add(c.id);
      this.scheduleSave();
    }
  }

  // The one button: brings the files in, compiles if any code changed, and opens a real editor here.
  async testChanges(agentId: string, force?: string[]) {
    const r = this.need(agentId);
    const c = r.card;
    if (c.testRun && TEST_RUN_BUSY.has(c.testRun.stage)) return;
    const set = (stage: NonNullable<AgentCard['testRun']>['stage'], detail?: string) => { c.testRun = { stage, detail }; this.dirtyCards.add(c.id); };
    set('pulling');
    if (!(await this.merge(r, force))) {
      if (c.merge?.error) set('failed', c.merge.error);
      else c.testRun = undefined;
      return;
    }
    const file = this.masterProjectFile(r);
    if (!file) { set('failed', "This task's project isn't on this PC."); return; }
    const build = (r.pulled ?? []).some((f) => CODE_FILE.test(f));
    set(build ? 'building' : 'opening');
    try {
      const res = await this.nodeCall<{ ok: boolean; output?: string; alreadyOpen?: boolean }>('master', 'machine.openTestEditor', { file, build });
      if (!res.ok) set('failed', `The build failed:\n${res.output ?? ''}`);
      else set(res.alreadyOpen ? 'already-open' : 'open');
    } catch (e: any) {
      set('failed', String(e?.message ?? e));
    }
  }

  async approve(agentId: string) {
    const r = this.need(agentId);
    const c = r.card;
    if (!c.final) return;
    c.final.needsTesting.forEach((_, i) => this.doneTests.add(`${agentId}:${i}`));
    c.attention = null;
    if (c.status === 'attention') c.status = 'finished';
    c.testRun = undefined;
    c.stage = 'awaiting-merge';
    this.dirtyCards.add(agentId);
    this.emitTests();
    await this.advance(r);
  }

  async reportIssue(agentId: string, text: string) {
    this.clearTests(agentId);
    this.need(agentId).card.testRun = undefined;
    await this.send(agentId, `I tested this and found a problem:\n\n${text}\n\nFix it, test what you can yourself, and call finish_task again with a fresh checklist.`);
  }

  async resolveConflicts(agentId: string, choice: 'agent' | 'mine' | 'retry') {
    const r = this.need(agentId);
    const c = r.card;
    const paths = (c.merge?.conflicts ?? []).map((f) => f.path);
    if (choice === 'mine') r.keepMine = [...new Set([...(r.keepMine ?? []), ...paths])];
    const force = choice === 'agent' ? paths : undefined;
    c.attention = null;
    if (c.stage === 'awaiting-merge') await this.advance(r, force);
    else await this.testChanges(agentId, force);
  }

  async createAgent(task: NewTask, givenTitle?: string): Promise<string> {
    const id = crypto.randomBytes(5).toString('hex');
    const project = task.projectFile ? readProject(task.projectFile, this.localInfo.engines) : null;
    const placed = task.nodeId === 'auto' ? placeTask(this.machines(), this.liveOn, project) : { nodeId: task.nodeId, reason: '' };
    const nodeId = placed.nodeId;
    const title = givenTitle ?? titleFrom(task.prompt);
    const card: AgentCard = {
      id, index: this.nextIndex++, title, nodeId, project: project?.name ?? null, stage: task.workspace ? undefined : 'preparing', isWorkspace: task.workspace,
      model: task.model, effort: task.effort, permissionMode: task.permissionMode, instanceMode: task.instanceMode,
      status: 'queued', attention: null, lastText: '', lastTextAt: 0, lastPrompt: task.prompt, lastPromptAt: Date.now(),
      createdAt: Date.now(), sessionMs: 0, runningSince: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, context: 0, costUsd: 0 },
      tokens: 0, tps: 0, spark: [], buckets: emptyBuckets(), slot: null, final: null,
    };
    const spawn: AgentSpawn = {
      id, prompt: task.prompt, images: task.images, title, model: task.model, effort: task.effort, permissionMode: task.permissionMode, instanceMode: task.instanceMode, demo: task.demo, workspace: task.workspace,
      project: project ? { name: project.name, file: project.file, engineRoot: nodeId === 'master' ? this.localInfo.engines.find((e) => e.id === project.engineAssociation)?.root : undefined } : null,
    };
    const rec: AgentRec = { card, transcript: [], byId: new Map(), bucket: null, bucketSince: Date.now(), tokensThisTick: 0, lastSeq: 0, pendingItems: new Map(), pendingDeltas: new Map(), spawn, sourceProjectDir: project?.dir, notStarted: nodeId !== 'master' && !!project };
    this.agents.set(id, rec);
    this.dirtyCards.add(id);
    this.wasBusy = true;
    this.scheduleSave();
    if (placed.reason && this.machines().length > 1) this.note(rec, `Placed here: ${placed.reason}`);
    if (nodeId === LOCAL_HOST_ID && !task.workspace && this.holdOn(project?.file)) {
      rec.heldNew = true;
      card.detail = 'Waiting for the workspace chat';
      this.note(rec, "Waiting for the workspace chat to finish changing the workspace. It'll start after that.", 'warn', true);
    } else void this.launch(rec, project?.dir ?? null, project?.engineVersion);
    this.emitEvent({ e: 'task-started', id });
    return id;
  }

  private async launch(rec: AgentRec, projectDir: string | null, engineVersion?: string) {
    const nodeId = rec.card.nodeId;
    rec.launching = true;
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
          await this.freshenWorkspace(rec, own.file, name);
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
    } finally {
      rec.launching = false;
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

  async send(agentId: string, text: string, images?: ImageAttachment[], broadcastId?: string, from?: string) {
    const r = this.need(agentId);
    if (!r.card.isMaster) this.wasBusy = true;
    r.answeringBroadcast = !!broadcastId;
    if (r.card.final || (r.card.stage && AFTER_AGENT.has(r.card.stage))) {
      // More to do, so back to the agent. What's already merged stays, and goes around again with it.
      r.card.final = null;
      r.card.progress = undefined;
      r.card.status = 'working';
      r.card.stage = 'building';
      r.card.testRun = undefined;
      r.card.merge = undefined;
      r.card.changelist = undefined;
      r.askedForChangelist = false;
      this.emitTests();
    }
    r.card.attention = null;
    r.card.runningSince = r.card.runningSince ?? Date.now();
    this.dirtyCards.add(agentId);
    if (r.heldNew) {
      r.spawn.prompt = `${r.spawn.prompt}\n\n${text}`;
      return;
    }
    if (r.notStarted) {
      // It never reached its machine, so try again from the start, carrying what was just said.
      this.stopSend(r);
      r.stopSending = false;
      r.spawn.prompt = `${r.spawn.prompt}\n\n${text}`;
      r.card.status = 'queued';
      const project = readProject(r.spawn.project!.file, this.localInfo.engines);
      void this.launch(r, r.sourceProjectDir ?? null, project?.engineVersion);
      return;
    }
    const updating = r.spawn.project ? this.workspaceSyncs.get(this.syncKey(r.card.nodeId, r.spawn.project.file)) : undefined;
    if (updating) await updating;
    await this.ensureRunning(r);
    await this.nodeCall(r.card.nodeId, 'agent.send', { agentId, text, images, broadcastId, from });
  }

  // After an app restart the session is gone from memory, so pick it back up from disk.
  private async ensureRunning(r: AgentRec) {
    const has = await this.nodeCall<boolean>(r.card.nodeId, 'agent.has', { agentId: r.card.id }).catch(() => false);
    if (has) return;
    // Another machine may know this engine by another name, as it does a custom build, so it needs the version too.
    const file = this.masterProjectFile(r);
    const engineVersion = file ? readProject(file, this.localInfo.engines)?.engineVersion : undefined;
    await this.nodeCall(r.card.nodeId, 'agent.spawn', { ...r.spawn, engineVersion, apiKey: r.card.onApiCredits ? this.apiCredits.key ?? undefined : undefined, resumeSessionId: r.card.sessionId, slotDir: r.slotDir, startPrompt: false, seqFrom: r.lastSeq });
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
    r.card.status = r.card.isMaster ? 'idle' : 'stopped';
    r.card.attention = null;
    r.card.tps = 0;
    this.dirtyCards.add(agentId);
    this.scheduleSave();
    this.checkAllDone();
  }

  async archive(agentId: string) {
    const r = this.need(agentId);
    if (r.card.isMaster) return;
    this.stopSend(r);
    if (r.card.holdingWorkspace) await this.releaseWorkspace(agentId).catch(() => {});
    await this.nodeCall(r.card.nodeId, 'agent.stop', { agentId, releaseSlot: true, slotDir: r.slotDir }).catch(() => {});
    await fsp.rm(this.mergedDir(agentId), { recursive: true, force: true }).catch(() => {});
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
    // Looking at these doesn't settle them. The card keeps saying it needs you until you've decided.
    if (r.card.attention.kind === 'testing' || r.card.merge?.conflicts?.length) return;
    r.card.attention = null;
    if (r.card.status === 'attention') r.card.status = r.card.final ? 'finished' : 'idle';
    this.dirtyCards.add(agentId);
    this.checkAllDone();
  }

  transcript(agentId: string) { return this.need(agentId).transcript; }
  setTestDone(key: string, done: boolean) { if (done) this.doneTests.add(key); else this.doneTests.delete(key); this.emitTests(); }
  async addProject(file: string) {
    const p = await this.nodeCall<ProjectInfo | null>(LOCAL_HOST_ID, 'machine.addProject', { file });
    const list = this.localNode?.info.projects;
    if (p && list && !list.some((x) => x.file.toLowerCase() === p.file.toLowerCase())) list.unshift(p);
    this.machinesDirty = true;
    return p;
  }
  async setMaxInstances(nodeId: string, n: number) {
    const info = await this.nodeCall(nodeId, 'machine.setMaxInstances', { n });
    const node = this.link.nodes.get(nodeId);
    if (node) node.info = info;
    this.machinesDirty = true;
  }
  rotatePairing() { this.link.rotatePairing(); return this.safePairing(); }
  forgetMachine(hostId: string) { this.link.forget(hostId); this.machinesDirty = true; }

  // Enough for a machine to find this card's folder even with no agent running there.
  private whereOf(r: AgentRec) {
    return { agentId: r.card.id, slotDir: r.slotDir, projectFile: r.spawn.project?.file };
  }

  changes(agentId: string, all = false) {
    const r = this.need(agentId);
    return this.nodeCall<ChangedFile[]>(r.card.nodeId, 'agent.changes', { ...this.whereOf(r), all });
  }
  log(agentId: string, lines = 300) { return this.nodeCall<string>(this.need(agentId).card.nodeId, 'agent.log', { agentId, lines }); }
  stopInstance(agentId: string) { return this.nodeCall(this.need(agentId).card.nodeId, 'agent.stopInstance', { agentId }); }

  async apply(agentId: string, only?: string[], force?: string[]): Promise<ApplyResult> {
    const r = this.need(agentId);
    if (r.card.nodeId === 'master') return this.nodeCall(r.card.nodeId, 'agent.apply', { ...this.whereOf(r), only, force });
    // One at a time. A merge on reconnecting can overlap with Open editor, and both write the same files.
    const turn = (r.applying ?? Promise.resolve()).then(() => this.applyFromRemote(r, only, force));
    r.applying = turn.catch(() => {});
    return turn;
  }

  private mergedDir(agentId: string) { return path.join(this.opts.dataDir, 'merged', agentId); }

  // What both sides started from, as in a version control merge. Once this agent's work has come over
  // that's the version that came last time, or a task sent back would conflict with its own earlier
  // work. Before that it's what source control has on the agent's machine.
  private async mergeBase(r: AgentRec, rel: string, lastMerged: string): Promise<Buffer | null> {
    const last = await fsp.readFile(lastMerged).catch(() => null);
    if (last) return last;
    const base = await this.nodeCall<string | null>(r.card.nodeId, 'agent.baseText', { ...this.whereOf(r), path: rel }).catch(() => null);
    return base === null ? null : Buffer.from(base, 'base64');
  }

  // A binary can't be merged, but replacing it is safe if it's still what the agent started from.
  private async unchangedSinceBase(r: AgentRec, rel: string, target: string, lastMerged: string) {
    if (fs.existsSync(lastMerged)) return sameBytes(target, lastMerged);
    const hash = await this.nodeCall<string | null>(r.card.nodeId, 'agent.baseHash', { ...this.whereOf(r), path: rel }).catch(() => null);
    return !!hash && hash === await hashOf(target);
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
      const forced = force.includes(c.path);
      const here = await fsp.stat(target).catch(() => null);
      const changedHere = !forced && !!r.card.slot?.shared && !!here && here.mtimeMs >= r.card.createdAt && here.mtimeMs !== r.applied?.get(c.path);
      if (c.kind === 'deleted') {
        if (changedHere) { result.conflicts.push({ path: c.path, reason: 'The agent deleted it, but it also changed on this machine.' }); continue; }
        await fsp.rm(target, { force: true });
        result.applied.push(c.path);
        continue;
      }
      let offset = 0;
      while (true) {
        const chunk = await this.nodeCall<{ data: string; last: boolean; mtime: number }>(r.card.nodeId, 'agent.readFile', { ...this.whereOf(r), path: c.path, offset });
        await writeChunk(inbox, c.path, offset, chunk.data, chunk.last);
        offset += CHUNK;
        if (chunk.last) break;
      }
      const incoming = path.join(inbox, c.path);
      const lastMerged = path.join(this.mergedDir(agentId), c.path);
      const binary = isBinaryPath(c.path);
      const existing = !!here && !forced;
      try {
        // Choosing the agent's side still merges. That machine's whole file may be from an older
        // changeset, and only the lines in dispute are what was chosen.
        const base = here && !binary ? await this.mergeBase(r, c.path, lastMerged) : null;
        // Nothing new from the agent means nothing to do, whatever else has changed here since.
        if ((here && await sameBytes(target, incoming)) || (base && (await fsp.readFile(incoming)).equals(base))) {
          result.applied.push(c.path);
        } else if (base) {
          const merged = await mergeText(target, base, incoming, forced);
          if (!merged.clean) { result.conflicts.push({ path: c.path, reason: merged.text.length ? 'Both sides changed the same lines, so it needs a decision.' : "It can't be merged as text." }); continue; }
          await fsp.writeFile(`${target}.fleet-merge`, merged.text);
          await fsp.rename(`${target}.fleet-merge`, target);
          result.merged.push(c.path);
        } else if (existing && r.card.slot?.shared && !(binary && await this.unchangedSinceBase(r, c.path, target, lastMerged))) {
          // That machine may be on an older changeset, so its whole file can hold far more than this
          // agent's work, and copying it over could undo newer check-ins here.
          result.conflicts.push({ path: c.path, reason: binary ? "It's a binary file that's different on both sides, so it can't be merged." : `It's different on this machine, and ${NO_MERGE_BASE}.` });
          continue;
        } else {
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.copyFile(incoming, `${target}.fleet-in`);
          await fsp.rename(`${target}.fleet-in`, target);
          result.applied.push(c.path);
        }
        (r.applied ??= new Map()).set(c.path, (await fsp.stat(target)).mtimeMs);
        const fromThere = (this.delivered[r.card.nodeId] ??= {});
        fromThere[c.path] = [...new Set([...(fromThere[c.path] ?? []), await hashOf(incoming)])];
        await fsp.mkdir(path.dirname(lastMerged), { recursive: true });
        await fsp.copyFile(incoming, lastMerged);
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
    // Straight away, or the newest lines could be lost when the app restarts for a new version.
    fs.appendFileSync(this.transcriptFile(r.card.id), `${JSON.stringify(stored)}\n`);
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 1000);
  }

  saveNow() {
    const agents = [...this.agents.values()].map((r) => ({ card: r.card, spawn: { ...r.spawn, images: undefined }, slotDir: r.slotDir, lastSeq: r.lastSeq, sourceProjectDir: r.sourceProjectDir, notStarted: r.notStarted, pulled: r.pulled, keepMine: r.keepMine, resumeOnReturn: r.resumeOnReturn, heldNew: r.heldNew }));
    fs.mkdirSync(this.opts.dataDir, { recursive: true });
    const tmp = `${this.stateFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ agents, nextIndex: this.nextIndex, defaults: this.defaults, doneTests: [...this.doneTests], broadcasts: this.broadcasts, openQuestions: [...this.openQuestions], unrouted: this.unrouted.map((t) => ({ ...t, images: undefined })), creditsEnabled: this.apiCredits.enabled, workspaceHolds: [...this.workspaceHolds], queuedSyncs: [...this.queuedSyncs], lastSynced: this.lastSynced, delivered: this.delivered }));
    fs.renameSync(tmp, this.stateFile());
  }

  private restore() {
    let saved: any;
    try { saved = JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')); } catch { return; }
    this.nextIndex = saved.nextIndex ?? 1;
    this.defaults = { ...(saved.defaults ?? this.defaults), permissionMode: DEFAULT_PERMISSION_MODE };
    this.doneTests = new Set(saved.doneTests ?? []);
    this.broadcasts = saved.broadcasts ?? [];
    this.openQuestions = new Map(saved.openQuestions ?? []);
    this.unrouted = saved.unrouted ?? [];
    this.apiCredits.enabled = !!saved.creditsEnabled;
    this.workspaceHolds = new Map(saved.workspaceHolds ?? []);
    this.queuedSyncs = new Map(saved.queuedSyncs ?? []);
    this.lastSynced = saved.lastSynced ?? {};
    this.delivered = saved.delivered ?? {};
    for (const a of saved.agents ?? []) {
      const card: AgentCard = a.card;
      if (card.archived) continue;
      const transcript = this.readTranscript(card.id);
      const byId = new Map(transcript.map((t) => [t.id, t]));
      // A card from before stages existed. A finished one still needs approving before it merges.
      if (!card.isMaster && !card.isWorkspace) card.stage ??= card.final ? 'testing' : 'building';
      // It starts a new session on the subscription, and goes back to credits if it hits the limit.
      if (card.isMaster) card.onApiCredits = undefined;
      // Runs inside the app ended with it, so show them as idle. Ones on a host, including this PC's
      // own, report in when it links, and reconcile catches any that didn't survive.
      if (((card.nodeId === LOCAL_HOST_ID && this.local) || card.isMaster) && LIVE.has(card.status)) card.status = 'idle';
      if (card.attention?.ref) card.attention = null;
      // Whatever was sending or asking died with the app, and a message picks it up again.
      if (a.notStarted) card.status = 'stopped';
      card.runningSince = null;
      card.tps = 0;
      this.agents.set(card.id, { card, transcript, byId, bucket: null, bucketSince: Date.now(), tokensThisTick: 0, lastSeq: a.lastSeq ?? 0, pendingItems: new Map(), pendingDeltas: new Map(), slotDir: a.slotDir, spawn: a.spawn, sourceProjectDir: a.sourceProjectDir, notStarted: a.notStarted, pulled: a.pulled, keepMine: a.keepMine, resumeOnReturn: a.resumeOnReturn, heldNew: a.heldNew });
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
    this.masterBackend?.stop();
    await this.localNode?.call('host.shutdown', {}).catch(() => {});
    await this.link.stop();
    await this.local?.shutdown();
  }

  // For a restart into a new version: this PC's own host keeps its agents and editors running, and
  // links back to whatever comes next.
  async detach() {
    this.saveNow();
    for (const t of this.timers) clearInterval(t);
    this.masterBackend?.stop();
    await this.link.stop();
  }
}

function oneLine(s: string) { return s.replace(/\s+/g, ' ').trim().slice(0, 140); }
const normalPath = (p: string) => p.replaceAll('\\', '/').toLowerCase();

async function sameBytes(a: string, b: string) {
  const [x, y] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
  return x.size === y.size && (await fsp.readFile(a)).equals(await fsp.readFile(b));
}

export function titleFrom(prompt: string) {
  const first = prompt.split(/\r?\n/).find((l) => l.trim()) ?? 'New task';
  const clean = first.trim().replace(/^(please|pls|can you|could you)\s+/i, '');
  const t = clean.charAt(0).toUpperCase() + clean.slice(1);
  return t.length > 42 ? `${t.slice(0, 40)}…` : t;
}
