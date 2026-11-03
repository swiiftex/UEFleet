// Everything one machine can do, independent of who's asking. The master calls this
// in-process; the remote host exposes the same methods over its link to the master.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent, AgentSpawn, ApplyResult, ChangedFile, ImageAttachment, NodeEvent, NodeInfo, ProjectInfo } from '../shared/protocol';
import { AgentRunner } from './agentRunner';
import { DemoRunner } from './demoRunner';
import { appendPrompt, FLEET_TOOLS, fleetServer } from './fleetTools';
import { Slot, SlotManager } from './instance';
import { describeMachine, discoverProjects, projectMemoryDir, readProject, readProjectSettings, resolveEngine, statsSampler } from './machine';
import { applyChanges, baseText, buildManifest, changedSince, listChanges, planReceive, readChunk, writeChunk, type ManifestEntry } from './projectSync';

interface Live {
  runner: AgentRunner | DemoRunner;
  slot: Slot | null;
  seq: number;
  log: { seq: number; ev: AgentEvent }[];
  spawn: AgentSpawn;
}

const REPLAY_LIMIT = 20_000;
// Long enough for the master to ask the user, who may be away.
const MASTER_ANSWER_TIMEOUT_MS = 45 * 60_000;

// What identifies a card's folder when no agent is running there, after a restart or a Stop.
interface AgentFolder { agentId: string; slotDir?: string; projectFile?: string }

export class NodeService extends EventEmitter {
  info: NodeInfo;
  slots: SlotManager;
  private agents = new Map<string, Live>();
  private stats = statsSampler();
  private timers: NodeJS.Timeout[] = [];
  private slotDirty = false;
  private questions = new Map<string, (answer: string) => void>();
  private nextQuestion = 1;

  constructor(private opts: { id: string; role: NodeInfo['role']; version: string; dataDir: string; pinnedProjects?: () => string[]; extraEngines?: string[] }) {
    super();
    this.info = describeMachine(opts.id, opts.role, opts.version, this.receivedProjects(), opts.extraEngines);
    if (opts.pinnedProjects) this.refreshProjects();
    this.slots = new SlotManager(opts.id, opts.dataDir, this.info.threads, this.info.maxInstances);
    void this.slots.removeUnusedCopies(this.info.projects);
    this.slots.on('changed', () => { this.slotDirty = true; });
    this.timers.push(setInterval(() => {
      if (!this.slotDirty) return;
      this.slotDirty = false;
      this.out({ t: 'slots', slots: this.slots.list() });
      for (const [agentId, a] of this.agents) {
        if (a.slot) this.emitAgent(agentId, { k: 'instance', slot: a.slot.info() });
      }
    }, 250));
    this.timers.push(setInterval(() => this.out({ t: 'stats', stats: this.stats() }), 2000));
  }

  private out(ev: NodeEvent) { this.emit('event', ev); }

  private emitAgent(agentId: string, ev: AgentEvent) {
    const a = this.agents.get(agentId);
    if (!a) return;
    a.seq++;
    a.log.push({ seq: a.seq, ev });
    if (a.log.length > REPLAY_LIMIT) a.log.splice(0, 2000);
    this.out({ t: 'agent', agentId, seq: a.seq, ev });
  }

  // After a dropped link the master asks for whatever it missed.
  replay(lastSeq: Record<string, number>) {
    for (const [agentId, a] of this.agents) {
      const from = lastSeq[agentId] ?? 0;
      for (const e of a.log) if (e.seq > from) this.out({ t: 'agent', agentId, seq: e.seq, ev: e.ev });
    }
    this.out({ t: 'slots', slots: this.slots.list() });
  }

  // Projects come and go while this runs: one gets opened in Unreal, a workspace gets created, or
  // --project is run in another terminal. Pinned ones come first, since someone chose them.
  refreshProjects(): ProjectInfo[] {
    const engines = this.info.engines;
    const pinned = (this.opts.pinnedProjects?.() ?? []).map((f) => readProject(f, engines)).filter((p): p is ProjectInfo => !!p);
    const merged = new Map<string, ProjectInfo>();
    for (const p of [...pinned, ...discoverProjects(engines), ...this.info.projects]) {
      if (!fs.existsSync(p.file)) continue;
      const key = p.file.toLowerCase();
      const had = merged.get(key);
      if (had) had.received ||= p.received;
      else merged.set(key, { ...p });
    }
    this.info.projects = [...merged.values()];
    return this.info.projects;
  }

  addProject(file: string): ProjectInfo | null {
    const p = readProject(file, this.info.engines);
    if (p && !this.info.projects.some((x) => x.file.toLowerCase() === p.file.toLowerCase())) this.info.projects.unshift(p);
    return p;
  }

  private projectFor(spawn: AgentSpawn): ProjectInfo | null {
    if (!spawn.project) return null;
    return this.info.projects.find((p) => p.file.toLowerCase() === spawn.project!.file.toLowerCase())
      ?? readProject(spawn.project.file, this.info.engines);
  }

  async spawnAgent(spawn: AgentSpawn & { slotDir?: string; engineVersion?: string; startPrompt?: boolean; seqFrom?: number }) {
    if (this.agents.has(spawn.id)) throw new Error(`Agent ${spawn.id} is already running here.`);
    // A resumed agent carries on numbering from where the master got to, or the master would treat
    // everything it says as already seen.
    const live: Live = { runner: null as any, slot: null, seq: spawn.seqFrom ?? 0, log: [], spawn };
    this.agents.set(spawn.id, live);
    try {
      return await this.startAgent(spawn, live);
    } catch (e) {
      this.agents.delete(spawn.id);
      throw e;
    }
  }

  private async startAgent(spawn: AgentSpawn & { slotDir?: string; engineVersion?: string; startPrompt?: boolean }, live: Live) {
    const emit = (ev: AgentEvent) => this.emitAgent(spawn.id, ev);

    if (spawn.demo) {
      live.runner = new DemoRunner(spawn, emit, (q) => this.askMaster(spawn.id, q));
      live.runner.start({ text: spawn.prompt, images: spawn.images });
      return { ok: true };
    }

    emit({ k: 'activity', status: 'provisioning', bucket: 'waiting', detail: 'Preparing workspace' });
    let cwd = path.join(this.opts.dataDir, 'scratch', spawn.id);
    const project = this.projectFor(spawn);
    if (spawn.project && !project) throw new Error(`${spawn.project.file} isn't on ${this.info.name}.`);
    if (project) {
      const engine = resolveEngine(project, this.info.engines, spawn.project?.engineRoot, spawn.engineVersion);
      if (!engine) emit({ k: 'item', item: { kind: 'system', id: `no-engine-${spawn.id}`, at: Date.now(), tone: 'warn', text: `No Unreal Engine ${project.engineVersion ?? ''} on ${this.info.name}. The agent can edit code but can't run the editor.` } });
      if (spawn.slotDir && fs.existsSync(spawn.slotDir)) live.slot = this.slots.adopt(project, engine, spawn.id, spawn.slotDir, spawn.instanceMode);
      else {
        const pending = this.slots.acquire(project, engine, spawn.id, spawn.instanceMode);
        const t = setInterval(() => { const s = this.slots.get(spawn.id); if (s) emit({ k: 'instance', slot: s.info() }); }, 500);
        try { live.slot = await pending; } finally { clearInterval(t); }
        if (live.slot.shared) emit({ k: 'item', item: { kind: 'system', id: `shared-${spawn.id}`, at: Date.now(), text: `Working in your project folder: ${project.dir}. What it saves is in your workspace straight away, and other agents on ${this.info.name} see it too.` } });
      }
      live.slot.task = spawn.title;
      cwd = live.slot.dir;
      emit({ k: 'instance', slot: live.slot.info() });
    } else {
      await fsp.mkdir(cwd, { recursive: true });
    }

    const server = fleetServer(live.slot, (report) => {
      emit({ k: 'final', report });
      void live.slot?.stopEditor();
    }, (percent) => emit({ k: 'progress', percent }), (q) => this.askMaster(spawn.id, q));
    const settings = project ? readProjectSettings(project.dir) : {};
    live.runner = new AgentRunner({
      spawn,
      cwd,
      claudePath: this.info.claudePath,
      // Only what the project explicitly lists joins the agent's own tools. Everything else stays
      // out, so nothing can reach the user's real editor by accident.
      mcpServers: { ...settings.mcpServers, fleet: server },
      allowedTools: FLEET_TOOLS,
      appendPrompt: appendPrompt(live.slot, settings.agentNotes),
      memoryDir: project ? projectMemoryDir(project.dir) : null,
      emit,
      onFileEdited: (f) => live.slot?.noteChanged(f),
    });
    (live.runner as AgentRunner).start(spawn.startPrompt === false ? undefined : { text: spawn.prompt, images: spawn.images });
    return { ok: true, cwd };
  }

  private need(agentId: string) {
    const a = this.agents.get(agentId);
    if (!a) throw new Error('That agent isn\'t running on this machine.');
    return a;
  }

  has(agentId: string) { return this.agents.has(agentId); }

  send(agentId: string, text: string, images?: ImageAttachment[], broadcastId?: string) {
    this.need(agentId).runner.send(text, images, broadcastId);
  }
  decide(agentId: string, itemId: string, decision: 'allow' | 'always' | 'deny') { this.need(agentId).runner.decide(itemId, decision); }
  answer(agentId: string, itemId: string, answers: Record<string, string>) { this.need(agentId).runner.answer(itemId, answers); }
  interrupt(agentId: string) { return this.need(agentId).runner.interrupt(); }

  async stop(agentId: string, releaseSlot = false, slotDir?: string) {
    const a = this.agents.get(agentId);
    a?.runner?.stop();
    await a?.slot?.stopEditor();
    this.agents.delete(agentId);
    if (!releaseSlot) return;
    await this.slots.release(agentId, slotDir);
    void this.slots.removeUnusedCopies(this.info.projects);
  }

  // A finished card's files are still there after a restart, with no agent running, so its folder
  // can be picked back up without one.
  private folderOf({ agentId, slotDir, projectFile }: AgentFolder): Slot | null {
    const live = this.agents.get(agentId)?.slot ?? this.slots.get(agentId);
    if (live) return live;
    if (!slotDir || !projectFile || !fs.existsSync(slotDir)) return null;
    const project = this.info.projects.find((p) => p.file.toLowerCase() === projectFile.toLowerCase()) ?? readProject(projectFile, this.info.engines);
    return project ? this.slots.adopt(project, resolveEngine(project, this.info.engines), agentId, slotDir, 'headless') : null;
  }

  // In a shared folder this is the agent's own work, which is quick to find. Everything that changed
  // there, whoever by, means scanning the whole project.
  async changes(where: AgentFolder, all = false): Promise<ChangedFile[]> {
    const slot = this.folderOf(where);
    if (!slot) return [];
    const never = readProjectSettings(slot.project.dir).neverApply ?? [];
    const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase();
    let list: ChangedFile[];
    if (!slot.shared) list = await listChanges(slot.dir);
    else if (!all) list = await slot.myChanges();
    else {
      const mine = new Set((await slot.myChanges()).map((c) => c.path));
      list = (await changedSince(slot.dir, slot.startedAt())).map((c) => ({ ...c, mine: mine.has(c.path) }));
    }
    return list.map((c) => ({ ...c, usuallySkipped: never.some((n) => norm(c.path) === norm(n)) }));
  }
  async apply(where: AgentFolder, only?: string[], force?: string[]): Promise<ApplyResult> {
    const slot = this.folderOf(where);
    // Work in a shared folder is already in the project.
    if (!slot || slot.shared) return { applied: [], merged: [], conflicts: [] };
    return applyChanges(slot.dir, slot.project.dir, only, force);
  }
  async readAgentFile(where: AgentFolder, rel: string, offset: number) {
    const slot = this.folderOf(where);
    if (!slot) throw new Error('No project on this task.');
    return readChunk(path.join(slot.dir, rel), offset);
  }
  // Base64, because this crosses the machine link as JSON and has to arrive byte for byte.
  async agentBaseText(where: AgentFolder, rel: string) {
    const slot = this.folderOf(where);
    const base = slot && !slot.shared ? await baseText(slot.dir, rel) : null;
    return base ? base.toString('base64') : null;
  }

  // The agent waits on its tool call. The answer comes back from the master through masterReply.
  private askMaster(agentId: string, question: string): Promise<string> {
    const id = `q${this.nextQuestion++}-${Date.now().toString(36)}`;
    const key = `${agentId}:${id}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.questions.delete(key);
        resolve("The master didn't answer in time. Carry on with what you have, and say in your final message what you couldn't find out.");
      }, MASTER_ANSWER_TIMEOUT_MS);
      this.questions.set(key, (answer) => { clearTimeout(timer); resolve(answer); });
      this.emitAgent(agentId, { k: 'activity', status: 'working', bucket: 'waiting', detail: 'Asking the master' });
      this.emitAgent(agentId, { k: 'ask-master', id, question });
    });
  }
  masterReply(agentId: string, id: string, answer: string) {
    const key = `${agentId}:${id}`;
    const resolve = this.questions.get(key);
    if (!resolve) return false;
    this.questions.delete(key);
    resolve(answer);
    return true;
  }

  // Compiles if asked, then opens a real editor window on this machine for a person to test in.
  async openTestEditor(file: string, build: boolean): Promise<{ ok: boolean; output?: string; alreadyOpen?: boolean; pid?: number }> {
    const project = this.info.projects.find((p) => p.file.toLowerCase() === file.toLowerCase()) ?? readProject(file, this.info.engines);
    if (!project) throw new Error(`${file} isn't on ${this.info.name}.`);
    const engine = resolveEngine(project, this.info.engines);
    if (!engine) throw new Error(`No Unreal Engine ${project.engineVersion ?? ''} on ${this.info.name} for ${project.name}.`);
    const id = `test-${project.name}`;
    let slot = this.slots.get(id);
    if (!slot) {
      slot = await this.slots.acquire({ ...project, received: false }, engine, id, 'windowed');
      slot.forPerson = true;
    }
    if (build) {
      const r = await slot.build({});
      if (!r.ok) return { ok: false, output: r.output };
    }
    return { ok: true, ...(await slot.openForPerson()) };
  }
  async logTail(agentId: string, lines: number) {
    const a = this.need(agentId);
    return a.slot ? a.slot.tail(lines) : '(no instance)';
  }
  async stopInstance(agentId: string) { await this.need(agentId).slot?.stopEditor(); }

  // ---- Receiving a project pushed from the master ----

  private receivedDir(name: string) { return path.join(this.opts.dataDir, 'projects', name); }

  private receivedProjects(): ProjectInfo[] {
    const root = path.join(this.opts.dataDir, 'projects');
    const out: ProjectInfo[] = [];
    for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const dir = path.join(root, name);
      const f = fs.existsSync(dir) ? fs.readdirSync(dir).find((x) => x.endsWith('.uproject')) : undefined;
      if (f) {
        const p = readProject(path.join(dir, f), []);
        if (p) out.push({ ...p, received: true });
      }
    }
    return out;
  }

  async projectPlan(name: string, manifest: ManifestEntry[]) {
    const dir = this.receivedDir(name);
    await fsp.mkdir(dir, { recursive: true });
    return planReceive(dir, manifest);
  }
  async projectPut(name: string, rel: string, offset: number, data: string, last: boolean, mtime?: number) {
    await writeChunk(this.receivedDir(name), rel, offset, data, last, mtime);
  }
  projectDone(name: string, uprojectName: string) {
    const file = path.join(this.receivedDir(name), uprojectName);
    const p = this.addProject(file);
    const listed = this.info.projects.find((x) => x.file.toLowerCase() === file.toLowerCase());
    if (listed) listed.received = true;
    return p;
  }

  // The method table a remote master can call. Nothing else is reachable over the link.
  async rpc(method: string, p: any): Promise<unknown> {
    switch (method) {
      case 'agent.spawn': return this.spawnAgent(p);
      case 'agent.send': return this.send(p.agentId, p.text, p.images, p.broadcastId);
      case 'agent.decide': return this.decide(p.agentId, p.itemId, p.decision);
      case 'agent.answer': return this.answer(p.agentId, p.itemId, p.answers);
      case 'agent.interrupt': return this.interrupt(p.agentId);
      case 'agent.stop': return this.stop(p.agentId, p.releaseSlot, p.slotDir);
      case 'agent.has': return this.has(p.agentId);
      case 'agent.changes': return this.changes(p, p.all);
      case 'agent.apply': return this.apply(p, p.only, p.force);
      case 'agent.readFile': return this.readAgentFile(p, p.path, p.offset);
      case 'agent.baseText': return this.agentBaseText(p, p.path);
      case 'agent.masterReply': return this.masterReply(p.agentId, p.id, p.answer);
      case 'machine.openTestEditor': return this.openTestEditor(p.file, p.build);
      case 'machine.addProject': return this.addProject(p.file);
      case 'agent.log': return this.logTail(p.agentId, p.lines);
      case 'agent.stopInstance': return this.stopInstance(p.agentId);
      case 'project.plan': return this.projectPlan(p.name, p.manifest);
      case 'project.put': return this.projectPut(p.name, p.path, p.offset, p.data, p.last, p.mtime);
      case 'project.done': return this.projectDone(p.name, p.uproject);
      case 'machine.info': return this.info;
      case 'machine.refreshProjects': return this.refreshProjects();
      case 'machine.setMaxInstances': this.info.maxInstances = p.n; this.slots.setMaxInstances(p.n); return this.info;
      default: throw new Error(`Unknown method ${method}`);
    }
  }

  async shutdown() {
    for (const t of this.timers) clearInterval(t);
    for (const a of this.agents.values()) a.runner?.stop();
    await this.slots.shutdown();
  }
}

export { buildManifest };
