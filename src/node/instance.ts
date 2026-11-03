// One Unreal instance per agent: its own editor process, its own MCP and PIE ports, and its own
// Saved and Intermediate folders. Agents on a machine work from the same project files, unless the
// project was sent from the master, where each gets a copy so its changes can be sent back.
// Running editors are the scarce resource and are capped per machine.
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ChangedFile, EngineInfo, InstanceMode, ProjectInfo, SlotInfo, SlotState } from '../shared/protocol';
import { forgetCopiesFromRecents, readProjectSettings } from './machine';
import { freeFiles, freeLoadedModules, isBinaryPath, seedAssetCache, seedSaves, syncProject, type SyncProgress } from './projectSync';

const q = (s: string) => `"${s}"`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MCP_SECTION = '[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]';
const PIE_SECTION = '[/Script/UnrealEd.LevelEditorPlaySettings]';
const LIVE_SECTION = '[/Script/LiveCoding.LiveCodingSettings]';
const BOOT_TIMEOUT_MS = 20 * 60_000;
// Long enough for an editor to have loaded its modules, which happens early in a boot.
const BUILD_WAITS_FOR_BOOTS_MS = 2 * 60_000;
const WAITING_FOR_BUILD = "Waiting for another agent's build";
const OWNER_FILE = 'owner';
const TOUCHED_FILE = 'touched.json';
const SAVE_LINE = /LogSavePackage: Moving '[^']*' to '([^']+)'/g;
const safeProjectName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || 'project';

// Agents sharing a project folder share its build outputs too, so they compile one at a time and
// nothing new starts loading modules until the compile is done.
class BuildGate {
  private tail: Promise<unknown> = Promise.resolve();
  private turns = 0;
  builtAt = 0;
  get busy() { return this.turns > 0; }
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.turns++;
    const turn = this.tail.then(fn).finally(() => { this.turns--; });
    this.tail = turn.catch(() => {});
    return turn;
  }
  async idle() { while (this.busy) await this.tail; }
}

export class Semaphore {
  private waiting: (() => void)[] = [];
  private used = 0;
  constructor(public limit: number) {}
  get inUse() { return this.used; }
  async acquire(onWait?: () => void) {
    if (this.used < this.limit) { this.used++; return; }
    onWait?.();
    await new Promise<void>((r) => this.waiting.push(r));
  }
  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.used = Math.max(0, this.used - 1);
  }
}

export class McpClient {
  private id = 1;
  private session: string | null = null;
  constructor(public url: string) {}

  private async rpc(method: string, params: unknown, timeoutMs: number) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: this.id++, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    this.session = res.headers.get('mcp-session-id') ?? this.session;
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    const parsed = JSON.parse(line ? line.slice(5) : text);
    if (parsed.error) throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
    return parsed.result;
  }

  init(timeoutMs = 3000) {
    return this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ue-fleet', version: '1' } }, timeoutMs);
  }

  async tool(name: string, args: Record<string, unknown>, timeoutMs = 10 * 60_000) {
    if (!this.session) await this.init(10_000);
    return this.rpc('tools/call', { name, arguments: args }, timeoutMs);
  }
}

export class Slot {
  state: SlotState = 'empty';
  detail?: string;
  agentId?: string;
  proc: ChildProcess | null = null;
  pid?: number;
  mode: InstanceMode = 'offscreen';
  progress?: number;
  mcp: McpClient;
  private booting: Promise<void> | null = null;
  private stopped: Promise<void> = Promise.resolve();
  private stopping = false;
  private holdsToken = false;
  private games: ChildProcess[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private bootedAt = 0;
  // Which files this agent changed: what its tools edited, what its editor saved, and what it says
  // it changed. A shared folder can't tell one agent's work from another's otherwise.
  private touched = new Map<string, 'edited' | 'reported'>();
  lastCrash: string | null = null;
  task?: string;
  forPerson = false; // only here to build and open an editor for someone testing, so not listed

  constructor(
    public id: string,
    public index: number,
    public project: ProjectInfo,
    public dir: string,
    public engine: EngineInfo | null,
    private mgr: SlotManager,
    // What's this agent's alone. A copy holds it; beside a shared folder it lives elsewhere.
    public own: string = dir,
  ) {
    this.mcp = new McpClient(`http://127.0.0.1:${this.port}/mcp`);
    try { this.touched = new Map(JSON.parse(fs.readFileSync(this.touchedFile, 'utf8'))); } catch { /* nothing yet */ }
  }

  get shared() { return this.own !== this.dir; }
  get port() { return this.mgr.basePort + this.index; }
  get piePort() { return this.mgr.basePiePort + this.index * 10; }
  private get touchedFile() { return path.join(this.fleetDir, TOUCHED_FILE); }
  get projectFile() { return path.join(this.dir, path.basename(this.project.file)); }
  get fleetDir() { return path.join(this.own, '.fleet'); }
  get logFile() { return path.join(this.fleetDir, 'editor.log'); }
  get isRunning() { return !!this.proc && this.proc.exitCode === null; }
  // Saved and Intermediate move here, which is what lets editors share a project folder.
  private get userDirArgs() { return this.shared ? [`-UserDir=${q(this.own)}`] : []; }
  private get gate() { return this.mgr.gate(this.project.dir); }

  info(): SlotInfo {
    return { id: this.id, nodeId: this.mgr.nodeId, project: this.project.name, dir: this.dir, own: this.own, shared: this.shared, port: this.port, state: this.state, agentId: this.agentId, detail: this.detail, pid: this.pid, mode: this.mode, progress: this.progress };
  }

  // When this agent claimed its place, which is where "changed since the task started" counts from.
  startedAt() {
    try { return fs.statSync(path.join(this.fleetDir, OWNER_FILE)).mtimeMs; } catch { return Date.now(); }
  }

  // Who else is in this folder, for the agent to see before it blames itself for their work.
  sharing() {
    if (!this.shared) return {};
    return {
      sharedFolder: true,
      otherAgentsHere: this.mgr.sharingWith(this).map((s) => ({ task: s.task, editor: s.state })),
      newerBuildThanYourEditor: this.isRunning && this.gate.builtAt > this.bootedAt,
    };
  }

  noteChanged(file: string, how: 'edited' | 'reported' = 'edited') {
    const rel = path.relative(this.dir, path.resolve(this.dir, file));
    if (rel.startsWith('..') || path.isAbsolute(rel) || this.touched.get(rel) === 'reported') return;
    if (this.touched.get(rel) === how) return;
    this.touched.set(rel, how);
    try { fs.writeFileSync(this.touchedFile, JSON.stringify([...this.touched])); } catch { /* it still has the list in memory */ }
  }

  // The editor logs every real save, and its autosaves land in its own folder, so they don't match.
  private async collectSaves() {
    if (!this.engine) return;
    const log = await fsp.readFile(this.logFile, 'utf8').catch(() => '');
    const from = path.join(this.engine.root, 'Engine/Binaries/Win64');
    for (const m of log.matchAll(SAVE_LINE)) this.noteChanged(path.resolve(from, m[1]));
  }

  // Quick, because it only looks at the files this agent is known to have touched. A file its tools
  // aimed at but never changed is left out, and only one it reported itself can count as deleted,
  // because a failed edit of a file that isn't here must never delete that file somewhere else.
  async myChanges(): Promise<ChangedFile[]> {
    await this.collectSaves();
    const since = this.startedAt();
    const out: ChangedFile[] = [];
    for (const [rel, how] of this.touched) {
      const st = await fsp.stat(path.join(this.dir, rel)).catch(() => null);
      if (!st) {
        if (how === 'reported') out.push({ path: rel, kind: 'deleted', binary: isBinaryPath(rel), mine: true });
      } else if (st.mtimeMs >= since) {
        out.push({ path: rel, kind: st.birthtimeMs >= since ? 'added' : 'modified', binary: isBinaryPath(rel), size: st.size, mine: true });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  // Waits out a build of this folder, then puts the state back for whatever comes next.
  private async buildsDone() {
    if (!this.shared || !this.gate.busy) return;
    const { state, detail } = this;
    this.setState('queued', WAITING_FOR_BUILD);
    await this.gate.idle();
    this.setState(state, detail);
  }

  setState(state: SlotState, detail?: string) {
    this.state = state;
    this.detail = detail;
    this.mgr.changed(this);
  }

  async sync() {
    if (this.shared) {
      await Promise.all([seedSaves(this.project.dir, this.own), seedAssetCache(this.project.dir, this.own)]);
      this.setState('cold');
      return;
    }
    this.setState('syncing', 'Copying project');
    const fmt = (p: SyncProgress) => `${p.done.toLocaleString()} / ${p.total.toLocaleString()} files`;
    const stat = await syncProject(this.project.dir, this.dir, (p) => {
      this.progress = p.total ? p.done / p.total : 0;
      this.detail = fmt(p);
      this.mgr.changed(this);
    });
    this.progress = undefined;
    this.setState('cold');
    return stat;
  }

  editorArgs(mode: InstanceMode) {
    const hasMcp = !!this.engine?.hasMcp;
    const ini = [
      `${LIVE_SECTION}:bEnabled=False`,
      `${PIE_SECTION}:ServerPort=${this.piePort}`,
      ...(hasMcp ? [`${MCP_SECTION}:ServerPortNumber=${this.port}`, `${MCP_SECTION}:bAutoStartServer=True`] : []),
    ].join(',');
    const settings = readProjectSettings(this.project.dir);
    return [
      q(this.projectFile),
      ...(settings.startupMap ? [settings.startupMap] : []),
      // No -nosound: audio features can't be tested without a running audio device. The engine
      // already outputs silence while unfocused, and these instances never have focus.
      ...this.userDirArgs,
      `-AbsLog=${q(this.logFile)}`, '-log', '-nosplash', '-unattended', '-NoLiveCoding', '-AutoDeclinePackageRecovery',
      ...(hasMcp ? ['-EnablePlugins=ModelContextProtocol,AllToolsets'] : []),
      ...(mode === 'offscreen' ? ['-RenderOffscreen', '-ResX=1280', '-ResY=720'] : []),
      ...(mode === 'headless' ? ['-nullrhi'] : []),
      ...(mode === 'windowed' ? ['-Windowed', '-ResX=1280', '-ResY=720'] : []),
      `-ini:EditorPerProjectUserSettings:${ini}`,
      // An unfocused editor throttles itself, and captures then return stale frames.
      '-ini:EditorSettings:[/Script/UnrealEd.EditorPerformanceSettings]:bThrottleCPUWhenNotForeground=False',
      `-ini:Engine:[URL]:Port=${this.piePort}`,
      ...(settings.editorArgs ? [settings.editorArgs] : []),
    ];
  }

  // Boots the editor if needed and resolves once its MCP endpoint answers.
  ensureEditor(mode?: InstanceMode): Promise<void> {
    if (this.booting) return this.booting;
    if (this.isRunning && !this.stopping) { this.touch(); return Promise.resolve(); }
    if (!this.engine) return Promise.reject(new Error(`No matching Unreal Engine on this machine for ${this.project.name}.`));
    if (mode) this.mode = mode;
    // An editor on its way down still counts as running, so let it finish before starting another.
    const dying = this.stopped;
    this.booting = dying.then(() => this.boot()).finally(() => { this.booting = null; });
    return this.booting;
  }

  private async boot() {
    await this.mgr.editors.acquire(() => this.setState('queued', 'Waiting for a free instance'));
    this.holdsToken = true;
    await this.buildsDone();
    this.setState('booting', 'Starting editor');
    await fsp.mkdir(this.fleetDir, { recursive: true });
    await this.collectSaves();
    await fsp.rm(this.logFile, { force: true });
    const exe = path.join(this.engine!.root, 'Engine/Binaries/Win64/UnrealEditor.exe');
    const p = spawn(exe, this.editorArgs(this.mode), { argv0: q(exe), windowsVerbatimArguments: true, stdio: 'ignore', windowsHide: this.mode !== 'windowed' });
    this.proc = p;
    this.pid = p.pid;
    this.bootedAt = Date.now();
    this.stopping = false;
    this.mcp = new McpClient(`http://127.0.0.1:${this.port}/mcp`);
    let exited = false;
    p.on('exit', (code) => {
      exited = true;
      this.proc = null;
      this.pid = undefined;
      this.releaseToken();
      forgetCopiesFromRecents(this.engine!.version);
      if (this.stopping) { this.setState('cold'); return; }
      this.lastCrash = `Editor exited with code ${code}.`;
      this.setState('crashed', this.lastCrash);
    });
    p.on('error', (e) => { this.lastCrash = String(e); });
    if (!this.engine!.hasMcp) { this.setState('ready', 'Engine has no MCP plugin'); this.touch(); return; }
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`Editor exited during startup. Last log lines:\n${await this.tail(30)}`);
      try {
        await this.mcp.init();
        forgetCopiesFromRecents(this.engine!.version);
        this.setState('ready');
        this.touch();
        return;
      } catch { await sleep(1500); }
    }
    await this.stopEditor();
    throw new Error(`Editor didn't come up within ${BOOT_TIMEOUT_MS / 60000} minutes. Last log lines:\n${await this.tail(30)}`);
  }

  private releaseToken() {
    if (this.holdsToken) { this.holdsToken = false; this.mgr.editors.release(); }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  // Idle editors give their place back; the next tool call boots a new one.
  touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.stopEditor('Stopped after being idle'); }, this.mgr.idleStopMs);
  }

  async stopEditor(_why?: string) {
    this.stopping = true;
    for (const g of this.games.splice(0)) killTree(g.pid);
    const p = this.proc;
    if (!p) { this.releaseToken(); if (this.state !== 'crashed') this.setState('cold'); return; }
    killTree(p.pid);
    this.stopped = new Promise<void>((r) => { p.once('exit', () => r()); setTimeout(r, 8000); });
    await this.stopped;
  }

  async tail(lines = 80, grep?: string): Promise<string> {
    let text = '';
    try { text = await fsp.readFile(this.logFile, 'utf8'); } catch { return '(no editor log yet)'; }
    let all = text.split(/\r?\n/);
    if (grep) { const re = new RegExp(grep, 'i'); all = all.filter((l) => re.test(l)); }
    return all.slice(-lines).join('\n');
  }

  async build(opts: { target?: string; config?: string; clean?: boolean }): Promise<{ ok: boolean; output: string; ms: number }> {
    if (!this.engine) throw new Error('No matching engine on this machine.');
    if (this.isRunning) await this.stopEditor();
    if (!this.shared) return this.compile(opts);
    if (this.gate.busy) this.setState('queued', WAITING_FOR_BUILD);
    return this.gate.run(async () => {
      await this.mgr.bootsSettled(this);
      await freeLoadedModules(this.project.dir);
      const r = await this.compile(opts);
      if (r.ok) this.gate.builtAt = Date.now();
      return r;
    });
  }

  private async compile(opts: { target?: string; config?: string; clean?: boolean }): Promise<{ ok: boolean; output: string; ms: number }> {
    await this.mgr.builds.acquire(() => this.setState('queued', 'Waiting for a build slot'));
    const t0 = Date.now();
    this.setState('building', opts.target ?? 'Editor');
    try {
      const bat = path.join(this.engine!.root, 'Engine/Build/BatchFiles', opts.clean ? 'Clean.bat' : 'Build.bat');
      const target = opts.target ?? `${path.basename(this.project.file, '.uproject')}Editor`;
      const share = Math.max(2, Math.floor(this.mgr.threads / Math.max(1, this.mgr.builds.inUse)));
      // UBT's mutex is per engine, not per project. Each copy has its own Intermediate, so it's safe
      // to skip, as long as nothing relinks a source engine's DLLs under every running editor. A
      // shared folder keeps it, so this waits for a build the user started from Visual Studio.
      const args = [target, 'Win64', opts.config ?? 'Development', `-Project=${q(this.projectFile)}`, this.shared ? '-WaitMutex' : '-NoMutex', `-MaxParallelActions=${share}`, '-NoHotReload'];
      let out = await runCaptured(bat, this.engine!.source ? [...args, '-NoEngineChanges'] : args, this.dir);
      let rebuilt = '';
      // A source engine that's out of date gets rebuilt, the same as building from an IDE. Only from
      // the real project: a copy is refused because of its own path, and building would tie the engine
      // to that copy and break it for everything else.
      if (out.code !== 0 && this.shared && ENGINE_CHANGE.test(out.text)) {
        this.setState('building', 'Rebuilding the editor');
        await freeFiles(engineFilesToReplace(out.text));
        out = await runCaptured(bat, args, this.dir);
        rebuilt = 'The engine was out of date, so the editor was rebuilt as well.\n';
      }
      const ok = out.code === 0;
      this.setState('cold');
      return { ok, output: rebuilt + summarizeBuild(out.text), ms: Date.now() - t0 };
    } finally {
      this.mgr.builds.release();
    }
  }

  // Runs automation tests in a separate process, so the editor can stay up or down. Unit tests
  // don't need a GPU; visual and flow tests do, so rendering is the caller's choice.
  async runTests(filter: string, render = false): Promise<{ ok: boolean; output: string; report?: string }> {
    if (!this.engine) throw new Error('No matching engine on this machine.');
    // A running editor already holds this slot's place; waiting for another could wait on itself.
    const ownPlace = this.holdsToken;
    if (!ownPlace) await this.mgr.editors.acquire(() => this.setState('queued', 'Waiting for a free instance'));
    await this.buildsDone();
    this.setState('testing', filter);
    try {
      const exe = path.join(this.engine.root, 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe');
      const reportDir = path.join(this.fleetDir, 'test-report');
      await fsp.rm(reportDir, { recursive: true, force: true });
      const args = [
        q(this.projectFile), ...this.userDirArgs, '-unattended', '-nosplash', render ? '-RenderOffscreen' : '-nullrhi', '-stdout', '-FullStdOutLogOutput',
        `-ExecCmds=${q(`Automation RunTests ${filter};Quit`)}`, `-ReportExportPath=${q(reportDir)}`, '-TestExit=Automation Test Queue Empty',
      ];
      const out = await runCaptured(exe, args, this.dir);
      const report = await fsp.readFile(path.join(reportDir, 'index.json'), 'utf8').catch(() => undefined);
      return { ok: out.code === 0, output: out.text.split(/\r?\n/).filter((l) => /LogAutomation|Error:|Test Completed|Fatal/.test(l)).slice(-120).join('\n'), report };
    } finally {
      if (!ownPlace) this.mgr.editors.release();
      this.setState(this.isRunning ? 'ready' : 'cold');
    }
  }

  // Standalone game processes, for testing real networking between separate clients.
  async launchGame(opts: { map?: string; extraArgs?: string; count?: number; server?: boolean }) {
    if (!this.engine) throw new Error('No matching engine on this machine.');
    await this.buildsDone();
    const exe = path.join(this.engine.root, 'Engine/Binaries/Win64/UnrealEditor.exe');
    const started: { pid?: number; log: string; role: string }[] = [];
    const count = Math.min(opts.count ?? 1, 4);
    const launchOne = (role: string, url: string, i: number) => {
      const log = path.join(this.fleetDir, `game-${role}-${i}.log`);
      const settings = readProjectSettings(this.project.dir);
      const args = [q(this.projectFile), url, '-game', ...this.userDirArgs, `-AbsLog=${q(log)}`, '-log', '-nosplash', '-unattended', '-RenderOffscreen', '-ResX=640', '-ResY=360', ...(settings.gameArgs ? [settings.gameArgs] : []), ...(opts.extraArgs ? [opts.extraArgs] : [])];
      const p = spawn(exe, args, { argv0: q(exe), windowsVerbatimArguments: true, stdio: 'ignore', windowsHide: true });
      this.games.push(p);
      started.push({ pid: p.pid, log, role });
    };
    const map = opts.map ?? '';
    if (opts.server) launchOne('server', `${map}?listen?port=${this.piePort}`, 0);
    for (let i = 0; i < count; i++) launchOne('client', opts.server ? `127.0.0.1:${this.piePort}` : map, i);
    return started;
  }

  stopGames() {
    for (const g of this.games.splice(0)) killTree(g.pid);
  }

  // Modules built for a different build of the engine. Opening an editor on those makes it offer to
  // rebuild them itself, which it can't do for a source engine.
  binariesOutOfDate() {
    if (!this.engine || !fs.existsSync(path.join(this.project.dir, 'Source'))) return false;
    const buildId = (root: string) => {
      try { return JSON.parse(fs.readFileSync(path.join(root, 'Binaries/Win64/UnrealEditor.modules'), 'utf8')).BuildId as string; } catch { return null; }
    };
    return buildId(this.project.dir) !== buildId(path.join(this.engine.root, 'Engine'));
  }

  // A real editor for a person to test in, using their own settings, so it stays connected to source
  // control. Live Coding stays off, or Unreal would refuse every agent's build while this is open.
  // It isn't tied to this process, so restarting the app or the host leaves it open.
  personEditorArgs() {
    const settings = readProjectSettings(this.project.dir);
    return [q(this.projectFile), ...(settings.startupMap ? [settings.startupMap] : []), '-NoLiveCoding', ...(settings.editorArgs ? [settings.editorArgs] : [])];
  }

  async openForPerson(): Promise<{ pid?: number; alreadyOpen: boolean }> {
    if (!this.engine) throw new Error(`No matching Unreal Engine on this machine for ${this.project.name}.`);
    await this.buildsDone();
    const open = personEditors(await unrealProcesses(), this.projectFile);
    if (open.length) return { pid: open[0], alreadyOpen: true };
    const exe = path.join(this.engine.root, 'Engine/Binaries/Win64/UnrealEditor.exe');
    const p = spawn(exe, this.personEditorArgs(), { argv0: q(exe), windowsVerbatimArguments: true, stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
    return { pid: p.pid, alreadyOpen: false };
  }

  async crashInfo(): Promise<string> {
    const dir = path.join(this.own, 'Saved', 'Crashes');
    let newest: string | null = null;
    let newestAt = 0;
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
      if (!e.isDirectory()) continue;
      const st = await fsp.stat(path.join(dir, e.name));
      if (st.mtimeMs > newestAt) { newestAt = st.mtimeMs; newest = e.name; }
    }
    const tailLog = await this.tail(60, 'Error|Fatal|Assert|Ensure|Critical');
    if (!newest) return `${this.lastCrash ?? 'No crash folder found.'}\n--- log errors ---\n${tailLog}`;
    const ctx = await fsp.readFile(path.join(dir, newest, 'CrashContext.runtime-xml'), 'utf8').catch(() => '');
    const pick = (tag: string) => ctx.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? '';
    return [`Crash folder: ${path.join(dir, newest)}`, `When: ${new Date(newestAt).toISOString()}`, pick('ErrorMessage'), pick('CallStack'), '--- log errors ---', tailLog].filter(Boolean).join('\n');
  }
}

export function killTree(pid?: number) {
  if (!pid) return;
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

// Agents' editors all carry -UserDir, so an editor on this project without it is a person's.
export function personEditors(processes: { pid: number; commandLine: string }[], projectFile: string): number[] {
  const norm = (s: string) => s.replaceAll('\\', '/').toLowerCase();
  const file = norm(projectFile);
  return processes.filter((p) => norm(p.commandLine).includes(file) && !/-UserDir=/i.test(p.commandLine)).map((p) => p.pid);
}

export function unrealProcesses(): Promise<{ pid: number; commandLine: string }[]> {
  return new Promise((resolve) => {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='UnrealEditor.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }";
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout!.on('data', (d) => { out += d; });
    p.on('error', () => resolve([]));
    p.on('exit', () => resolve(out.split(/\r?\n/).filter(Boolean).map((l) => { const [pid, ...rest] = l.split('\t'); return { pid: Number(pid), commandLine: rest.join('\t') }; })));
  });
}

function runCaptured(exe: string, args: string[], cwd: string): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    const isBat = exe.toLowerCase().endsWith('.bat');
    const p = isBat
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${q(exe)} ${args.join(' ')}"`], { cwd, windowsVerbatimArguments: true, windowsHide: true })
      : spawn(exe, args, { argv0: q(exe), cwd, windowsVerbatimArguments: true, windowsHide: true });
    let text = '';
    const add = (d: Buffer) => { text += d.toString(); if (text.length > 8_000_000) text = text.slice(-4_000_000); };
    p.stdout?.on('data', add);
    p.stderr?.on('data', add);
    p.on('error', reject);
    p.on('exit', (code) => resolve({ code: code ?? 1, text }));
  });
}

const ENGINE_CHANGE = /FailedDueToEngineChange/;

// What a build, refused for changing a source engine, says it would have replaced.
export function engineFilesToReplace(text: string) {
  const lines = text.split(/\r?\n/);
  const from = lines.findIndex((l) => /Building would modify/i.test(l));
  return from < 0 ? [] : lines.slice(from + 1).map((l) => l.trim()).filter((l) => /^[a-z]:[\\/]/i.test(l));
}

export function summarizeBuild(text: string): string {
  const lines = text.split(/\r?\n/);
  const errors = lines.filter((l) => /\b(error|fatal)\b[ :]|: error |Unable to build|ERROR:/i.test(l));
  const head = errors.length ? `${errors.length} error lines:\n${errors.slice(0, 60).join('\n')}\n--- end of output ---\n` : '';
  return head + lines.slice(-25).join('\n');
}

export class SlotManager extends EventEmitter {
  editors: Semaphore;
  builds: Semaphore;
  // Moved aside for tests, so they can run on a PC that's also running real agents.
  basePort = Number(process.env.FLEET_BASE_PORT) || 8300;
  basePiePort = Number(process.env.FLEET_BASE_PIE_PORT) || 17800;
  idleStopMs = 10 * 60_000;
  private slots = new Map<string, Slot>();
  private gates = new Map<string, BuildGate>();
  private claiming: Promise<unknown> = Promise.resolve();

  constructor(public nodeId: string, private dataRoot: string, public threads: number, maxInstances: number) {
    super();
    this.editors = new Semaphore(maxInstances);
    this.builds = new Semaphore(Math.max(1, Math.floor(threads / 6)));
  }

  setMaxInstances(n: number) { this.editors.limit = n; }
  list(): SlotInfo[] { return [...this.slots.values()].filter((s) => !s.forPerson).map((s) => s.info()); }
  changed(_s: Slot) { this.emit('changed'); }

  gate(projectDir: string) {
    const key = projectDir.toLowerCase();
    let g = this.gates.get(key);
    if (!g) { g = new BuildGate(); this.gates.set(key, g); }
    return g;
  }

  sharingWith(slot: Slot) {
    const key = slot.project.dir.toLowerCase();
    return [...this.slots.values()].filter((s) => s !== slot && s.shared && s.project.dir.toLowerCase() === key);
  }

  // An editor part way through loading modules could pick up one mid-link.
  async bootsSettled(slot: Slot) {
    const end = Date.now() + BUILD_WAITS_FOR_BOOTS_MS;
    while (Date.now() < end && this.sharingWith(slot).some((s) => s.state === 'booting')) await sleep(1000);
  }

  // Copies have to live on the project's drive for hardlinks to work.
  private slotsRoot(project: ProjectInfo) {
    const drive = path.parse(project.dir).root;
    if (path.parse(this.dataRoot).root.toLowerCase() === drive.toLowerCase()) return path.join(this.dataRoot, 's');
    return path.join(drive, '.uefleet', 's');
  }

  private nextIndex() {
    const used = new Set([...this.slots.values()].map((s) => s.index));
    let i = 1;
    while (used.has(i)) i++;
    return i;
  }

  async acquire(project: ProjectInfo, engine: EngineInfo | null, agentId: string, mode: InstanceMode): Promise<Slot> {
    // One at a time: agents started together must not both claim the same copy.
    const claim = this.claiming.then(() => this.claimSlot(project, engine, agentId, mode));
    this.claiming = claim.catch(() => {});
    const slot = await claim;
    await slot.sync();
    return slot;
  }

  private async claimSlot(project: ProjectInfo, engine: EngineInfo | null, agentId: string, mode: InstanceMode): Promise<Slot> {
    const safeName = safeProjectName(project.name);
    // A project sent from the master has to get each agent's changes back to it, and sending it again
    // would overwrite the folder, so that's the one case where agents can't share.
    const shared = !project.received;
    const root = shared ? path.join(this.dataRoot, 'u', safeName) : path.join(this.slotsRoot(project), safeName);
    // Reuse a free folder on disk. In a copy, its Intermediate and Binaries make the next build
    // incremental. Beside a shared folder, its asset registry cache makes the next boot quicker.
    // The owner file survives restarts, so a copy with unapplied work is never picked up and wiped.
    const names = await fsp.readdir(root).catch(() => [] as string[]);
    let reuse: string | null = null;
    for (const name of names) {
      if (/^\d+$/.test(name) && !fs.existsSync(path.join(root, name, '.fleet', OWNER_FILE))) { reuse = path.join(root, name); break; }
    }
    const index = this.nextIndex();
    let dir = reuse;
    if (!dir) {
      let n = index;
      while (names.includes(String(n).padStart(2, '0'))) n++;
      dir = path.join(root, String(n).padStart(2, '0'));
    }
    await fsp.mkdir(path.join(dir, '.fleet'), { recursive: true });
    await fsp.writeFile(path.join(dir, '.fleet', OWNER_FILE), agentId);
    await fsp.rm(path.join(dir, '.fleet', TOUCHED_FILE), { force: true });
    const slot = new Slot(`${safeName}-${path.basename(dir)}`, index, project, shared ? project.dir : dir, engine, this, dir);
    slot.agentId = agentId;
    slot.mode = mode;
    this.slots.set(agentId, slot);
    this.changed(slot);
    return slot;
  }

  // Re-attach (app restart) without touching what the agent changed. A copy holds the project file;
  // anything else is an agent's own folder beside a shared project.
  adopt(project: ProjectInfo, engine: EngineInfo | null, agentId: string, dir: string, mode: InstanceMode): Slot {
    const isCopy = fs.existsSync(path.join(dir, path.basename(project.file)));
    const slot = new Slot(`${project.name.slice(0, 16)}-${path.basename(dir)}`, this.nextIndex(), project, isCopy ? dir : project.dir, engine, this, dir);
    slot.agentId = agentId;
    slot.mode = mode;
    slot.state = 'cold';
    this.slots.set(agentId, slot);
    this.changed(slot);
    return slot;
  }

  get(agentId: string) { return this.slots.get(agentId); }

  // A card restored after a restart has no live slot until it's messaged, so its folder is named
  // here instead. The owner file has to agree, so this can't free a folder belonging to anyone else.
  async release(agentId: string, dir?: string) {
    const s = this.slots.get(agentId);
    if (s) {
      await s.stopEditor();
      this.slots.delete(agentId);
      this.emit('changed');
    }
    const own = s?.own ?? dir;
    if (!own) return;
    const owner = path.join(own, '.fleet', OWNER_FILE);
    if (await fsp.readFile(owner, 'utf8').then((id) => id === agentId, () => false)) await fsp.rm(owner, { force: true });
  }

  // Copies are only for projects sent here now. Any others are left from before, and a free one
  // holds nothing that isn't in the project, so all they do is take up disk.
  async removeUnusedCopies(projects: ProjectInfo[]) {
    const keep = new Set(projects.filter((p) => p.received).map((p) => safeProjectName(p.name)));
    const roots = new Set([path.join(this.dataRoot, 's'), ...projects.map((p) => this.slotsRoot(p))]);
    for (const root of roots) {
      for (const name of await fsp.readdir(root).catch(() => [] as string[])) {
        if (keep.has(name)) continue;
        for (const n of await fsp.readdir(path.join(root, name)).catch(() => [] as string[])) {
          const dir = path.join(root, name, n);
          if (/^\d+$/.test(n) && !fs.existsSync(path.join(dir, '.fleet', OWNER_FILE))) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  }

  async shutdown() {
    await Promise.all([...this.slots.values()].map((s) => s.stopEditor()));
  }
}
