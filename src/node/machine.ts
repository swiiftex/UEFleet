// What this machine has: engines, recent projects, hardware, and the Claude CLI.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EngineInfo, NodeInfo, NodeStats, ProjectInfo } from '../shared/protocol';

const reg = (args: string[]) => {
  try {
    return execFileSync('reg', ['query', ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};

const MCP_PLUGIN = 'Engine/Plugins/Experimental/ModelContextProtocol/ModelContextProtocol.uplugin';

// Why a folder can't be used as an engine, or null if it can.
export function engineProblem(rootRaw: string): string | null {
  const root = path.normalize(rootRaw.trim());
  const bin = path.join(root, 'Engine/Binaries/Win64');
  if (fs.existsSync(path.join(bin, 'UnrealEditor.exe'))) return null;
  if (!fs.existsSync(root)) return "the folder doesn't exist";
  if (!fs.existsSync(path.join(root, 'Engine'))) return "it has no Engine folder, so it isn't an engine's top folder";
  if (fs.existsSync(path.join(bin, 'UE4Editor.exe'))) return "it's a UE4 engine, and only UE5 editors can run here";
  let built: string[] = [];
  try { built = fs.readdirSync(bin); } catch { /* nothing built yet */ }
  const other = built.find((f) => /^UnrealEditor-Win64-\w+\.exe$/i.test(f));
  return other ? `only ${other} is built, and the Development editor is needed` : "UnrealEditor.exe hasn't been built";
}

// People paste the editor's own path as often as the engine's top folder, so accept anything inside it.
export function engineRootOf(given: string): string {
  const start = path.resolve(given.trim().replace(/"+$/, ''));
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'Engine/Binaries'))) return dir;
    if (path.dirname(dir) === dir) return start;
  }
}

export function engineFromRoot(id: string, rootRaw: string): EngineInfo | null {
  const root = path.normalize(rootRaw.trim());
  if (engineProblem(root)) return null;
  let version = id;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, 'Engine/Build/Build.version'), 'utf8'));
    version = `${v.MajorVersion}.${v.MinorVersion}.${v.PatchVersion}`;
  } catch { /* keep the registry id */ }
  return {
    id,
    version,
    root,
    hasMcp: fs.existsSync(path.join(root, MCP_PLUGIN)),
    source: !fs.existsSync(path.join(root, 'Engine/Build/InstalledBuild.txt')),
  };
}

// reg.exe prints `    name    REG_SZ    value`. A build's name has spaces if someone renamed it.
export function parseRegValues(text: string): { id: string; root: string }[] {
  const out: { id: string; root: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s+(.+?)\s+REG_\w+\s+(.+)$/);
    if (m && m[1] !== '(Default)') out.push({ id: m[1], root: m[2] });
  }
  return out;
}

// Launcher installs, then builds registered with UnrealVersionSelector, then folders added by hand.
function knownEngines(extraRoots: string[]): { id: string; root: string }[] {
  const out: { id: string; root: string }[] = [];
  let current = '';
  for (const line of reg(['HKLM\\SOFTWARE\\EpicGames\\Unreal Engine', '/s', '/v', 'InstalledDirectory']).split(/\r?\n/)) {
    const key = line.match(/Unreal Engine\\([^\\]+)\s*$/);
    if (key) current = key[1];
    const val = line.match(/InstalledDirectory\s+REG_\w+\s+(.+)$/);
    if (val && current) out.push({ id: current, root: val[1] });
  }
  out.push(...parseRegValues(reg(['HKCU\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds'])));
  out.push(...extraRoots.map((root) => ({ id: root, root })));
  return out;
}

export function discoverEngines(extraRoots: string[] = []): EngineInfo[] {
  const found = new Map<string, EngineInfo>();
  for (const { id, root } of knownEngines(extraRoots)) {
    const e = engineFromRoot(id, root);
    if (e && !found.has(e.root.toLowerCase())) found.set(e.root.toLowerCase(), e);
  }
  return [...found.values()].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

export function unusableEngines(extraRoots: string[] = []): { root: string; reason: string }[] {
  const found = new Map<string, { root: string; reason: string }>();
  for (const { root: raw } of knownEngines(extraRoots)) {
    const root = path.normalize(raw.trim());
    const reason = engineProblem(root);
    if (reason) found.set(root.toLowerCase(), { root, reason });
  }
  return [...found.values()];
}

export function readProject(file: string, engines: EngineInfo[]): ProjectInfo | null {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const assoc: string | undefined = json.EngineAssociation;
    return {
      name: path.basename(file, '.uproject'),
      file: path.normalize(file),
      dir: path.dirname(path.normalize(file)),
      engineAssociation: assoc,
      engineVersion: engines.find((e) => e.id === assoc)?.version ?? assoc,
    };
  } catch {
    return null;
  }
}

const RECENTS_INI = 'Saved/Config/WindowsEditor/EditorSettings.ini';

// UE records recent projects per user for installed engines, and inside the engine itself for
// source builds. Newest entry wins across all of them.
function recentProjectFiles(engines: EngineInfo[]): string[] {
  const base = path.join(process.env.LOCALAPPDATA ?? '', 'UnrealEngine');
  const list = (d: string) => { try { return fs.readdirSync(d); } catch { return []; } };
  const inis = [
    ...list(base).map((v) => path.join(base, v, RECENTS_INI)),
    ...engines.map((e) => path.join(e.root, 'Engine', RECENTS_INI)),
  ];
  const seen = new Map<string, { file: string; at: string }>();
  for (const file of inis) {
    let ini = '';
    try { ini = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const m of ini.matchAll(/RecentlyOpenedProjectFiles=\(ProjectName="([^"]+)",LastOpenTime=([^)]+)\)/g)) {
      const key = path.normalize(m[1]).toLowerCase();
      if (!seen.has(key) || seen.get(key)!.at < m[2]) seen.set(key, { file: m[1], at: m[2] });
    }
  }
  return [...seen.values()].sort((a, b) => b.at.localeCompare(a.at)).map((p) => p.file);
}

// Plastic's list has one workspace per line: id, name, path, then sometimes "dynamic".
export function parsePlasticWorkspaces(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l && !l.startsWith('//')).map((l) => l.split('\t')[2]).filter(Boolean);
}

// Git clients each store their repo list differently, some as JSON and some in a database. Every
// path they hold looks the same in the bytes though, and anything that isn't a real folder is
// dropped later.
export function pathsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![A-Za-z])[A-Za-z]:(?:\\\\|\\|\/)[^"'<>|?*\x00-\x1f\x7f-￿]*/g)) out.add(m[0].replace(/\\\\/g, '\\').trim());
  return [...out];
}

function perforceRootsNow(): string[] {
  const p4 = (...args: string[]) => {
    try {
      return execFileSync('p4', args, { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  };
  const user = p4('-F', '%userName%', 'info', '-s').trim();
  return user ? p4('-F', '%Root%', 'clients', '-u', user).split(/\r?\n/).filter(Boolean) : [];
}

// Asking means reaching the server, which may be slow or down, so don't ask for every task.
let perforceCache: { at: number; roots: string[] } | null = null;
function perforceRoots(): string[] {
  if (!perforceCache || Date.now() - perforceCache.at > 5 * 60_000) perforceCache = { at: Date.now(), roots: perforceRootsNow() };
  return perforceCache.roots;
}

// Workspaces that version control tools have listed on this machine.
function versionControlFolders(): string[] {
  const local = process.env.LOCALAPPDATA ?? '';
  const roaming = process.env.APPDATA ?? '';
  const read = (f: string, encoding: BufferEncoding = 'latin1') => { try { return fs.readFileSync(f, encoding); } catch { return ''; } };
  const list = (d: string) => { try { return fs.readdirSync(d); } catch { return []; } };
  const desktop = path.join(roaming, 'GitHub Desktop/IndexedDB/file__0.indexeddb.leveldb');
  const kraken = path.join(roaming, '.gitkraken/profiles');
  const gitLists = [
    ...list(desktop).filter((f) => /\.(log|ldb)$/.test(f)).map((f) => path.join(desktop, f)),
    path.join(local, 'Atlassian/SourceTree/opentabs.xml'),
    path.join(local, 'Atlassian/SourceTree/bookmarks.xml'),
    path.join(local, 'Fork/settings.json'),
    ...list(kraken).map((p) => path.join(kraken, p, 'localRepoCache')),
  ];
  return [
    ...parsePlasticWorkspaces(read(path.join(local, 'plastic4/plastic.workspaces'), 'utf8')),
    ...perforceRoots(),
    ...gitLists.flatMap((f) => pathsIn(read(f))),
  ];
}

// Where those tools and Unreal put things unless told otherwise.
function usualProjectFolders(): string[] {
  const home = os.homedir();
  return ['wkspaces', 'Documents/GitHub', 'Documents/Unreal Projects', 'source/repos', 'Perforce', 'p4'].map((d) => path.join(home, d));
}

const NEVER_HOLDS_PROJECTS = new Set(['engine', 'content', 'binaries', 'intermediate', 'saved', 'deriveddatacache', 'plugins', 'source', 'config', 'build', 'node_modules', '.git', '.plastic', '.svn', '.vs', '.fleet']);

// A project sits at the top of its repo or a folder or two inside, and a folder of repos adds one
// more level. Going deeper would only find sample projects and take longer.
export function projectFilesUnder(dir: string, depth = 2): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const here = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.uproject')).map((e) => path.join(dir, e.name));
  if (here.length || depth === 0) return here;
  return entries
    .filter((e) => e.isDirectory() && !NEVER_HOLDS_PROJECTS.has(e.name.toLowerCase()))
    .flatMap((e) => projectFilesUnder(path.join(dir, e.name), depth - 1));
}

// The order decides which copy a task uses when a machine has more than one: the one most recently
// opened in Unreal, then what version control lists, then the usual folders.
export function discoverProjects(engines: EngineInfo[]): ProjectInfo[] {
  // A list can name a whole drive, which is no place to go looking.
  const folders = [...versionControlFolders(), ...usualProjectFolders()].map((f) => path.normalize(f)).filter((f) => path.dirname(f) !== f);
  const seen = new Set<string>();
  const out: ProjectInfo[] = [];
  for (const raw of [...recentProjectFiles(engines), ...[...new Set(folders)].flatMap((f) => projectFilesUnder(f))]) {
    const file = path.normalize(raw);
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!fs.existsSync(file) || isFleetCopy(file)) continue;
    const p = readProject(file, engines);
    if (p) out.push(p);
  }
  return out;
}

// What someone typed into --project: the .uproject itself, or the folder it's in.
export function projectFileFrom(given: string): string | null {
  const p = path.resolve(given.trim().replace(/"+$/, ''));
  if (p.toLowerCase().endsWith('.uproject')) return fs.existsSync(p) ? p : null;
  return projectFilesUnder(p, 0)[0] ?? null;
}

// Optional .uefleet.json beside the .uproject, for what only that project knows.
export interface ProjectSettings {
  editorArgs?: string;
  gameArgs?: string;
  startupMap?: string;
  neverApply?: string[];
  agentNotes?: string;
  mcpServers?: Record<string, any>;
}

export function readProjectSettings(projectDir: string): ProjectSettings {
  try { return JSON.parse(fs.readFileSync(path.join(projectDir, '.uefleet.json'), 'utf8')); } catch { return {}; }
}

// Claude Code keys project memory to the working folder, so a copy would otherwise start with
// none. This is where the real project's notes live, if it has any.
export function projectMemoryDir(projectDir: string): string | null {
  const key = path.resolve(projectDir).replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects', key, 'memory');
  return fs.existsSync(dir) ? dir : null;
}

const isFleetCopy = (projectFile: string) => fs.existsSync(path.join(path.dirname(projectFile), '.fleet'));

// Opening a project adds it to UE's personal recent-projects list. An agent's copy has no place
// there, and enough of them would push the user's real projects off the end.
export function forgetCopiesFromRecents(engineVersion: string) {
  const ini = path.join(process.env.LOCALAPPDATA ?? '', 'UnrealEngine', engineVersion.split('.').slice(0, 2).join('.'), 'Saved/Config/WindowsEditor/EditorSettings.ini');
  let text: string;
  try { text = fs.readFileSync(ini, 'utf8'); } catch { return; }
  const kept = text.split('\n').filter((line) => {
    const m = line.match(/^RecentlyOpenedProjectFiles=\(ProjectName="([^"]+)"/);
    return !m || !isFleetCopy(m[1]);
  }).join('\n');
  if (kept === text) return;
  try {
    fs.writeFileSync(`${ini}.fleet-tmp`, kept);
    fs.renameSync(`${ini}.fleet-tmp`, ini);
  } catch { /* an open editor has it; the next pass catches it */ }
}

export function resolveEngine(project: ProjectInfo, engines: EngineInfo[], hintRoot?: string, hintVersion?: string): EngineInfo | null {
  if (hintRoot) {
    const byRoot = engines.find((e) => e.root.toLowerCase() === path.normalize(hintRoot).toLowerCase());
    if (byRoot) return byRoot;
  }
  const direct = engines.find((e) => e.id === project.engineAssociation);
  if (direct) return direct;
  // A custom-build GUID won't resolve on another machine, so fall back to the same major.minor.
  const want = (hintVersion ?? project.engineVersion ?? '').split('.').slice(0, 2).join('.');
  const sameVersion = engines.filter((e) => e.version.startsWith(want + '.'));
  // A project tied to a custom build should get the custom build here too, not a stock engine that
  // happens to share its version. Stock engines are the ones named by version number.
  const isCustom = (id?: string) => !!id && !/^\d/.test(id);
  return (isCustom(project.engineAssociation) ? sameVersion.find((e) => isCustom(e.id)) : undefined) ?? sameVersion[0] ?? null;
}

function detectVramGb(): number {
  const out = reg(['HKLM\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}', '/s', '/v', 'HardwareInformation.qwMemorySize']);
  let best = 0;
  for (const m of out.matchAll(/qwMemorySize\s+REG_QWORD\s+0x([0-9a-fA-F]+)/g)) best = Math.max(best, parseInt(m[1], 16));
  return Math.round(best / 2 ** 30);
}

function claudeVersion(exe: string): number[] | null {
  try {
    const out = execFileSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], env: agentEnv() });
    return out.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? null;
  } catch {
    return null;
  }
}

// The newest install wins, since the Agent SDK expects a recent CLI. The desktop app keeps its
// own copy, which is often newer than a standalone install that has stopped updating.
export function findClaude(): string | null {
  const candidates = new Set<string>([path.join(os.homedir(), '.local/bin/claude.exe')]);
  try {
    for (const l of execFileSync('where', ['claude'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)) if (l) candidates.add(l);
  } catch { /* not on PATH */ }
  const desktopRoot = path.join(process.env.LOCALAPPDATA ?? '', 'Claude-Data');
  const list = (d: string) => { try { return fs.readdirSync(d); } catch { return []; } };
  for (const install of list(desktopRoot)) {
    const code = path.join(desktopRoot, install, 'claude-code');
    for (const ver of list(code)) for (const hash of list(path.join(code, ver))) candidates.add(path.join(code, ver, hash, 'claude.exe'));
  }
  let best: { exe: string; v: number[] } | null = null;
  for (const exe of candidates) {
    if (!exe.toLowerCase().endsWith('.exe') || !fs.existsSync(exe)) continue;
    const v = claudeVersion(exe);
    if (!v) continue;
    const newer = !best || v[0] - best.v[0] || v[1] - best.v[1] || v[2] - best.v[2];
    if (!best || (typeof newer === 'number' && newer > 0)) best = { exe, v };
  }
  return best?.exe ?? null;
}

// Launched from inside a Claude session, this process inherits that session's identity and
// proxy. Agents must use the machine's own login instead.
export function agentEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (env.CLAUDECODE) {
    for (const k of Object.keys(env)) {
      if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_') || k.startsWith('ANTHROPIC_')) delete env[k];
    }
  }
  return env;
}

// One running editor costs roughly 10 GB of RAM, 3 GB of VRAM and 3 CPU threads under load.
export function defaultMaxInstances(threads: number, ramGb: number, vramGb: number): number {
  const byRam = Math.floor((ramGb - 8) / 10);
  const byCpu = Math.floor(threads / 3);
  const byVram = vramGb > 0 ? Math.floor(vramGb / 3) : byCpu;
  return Math.max(1, Math.min(byRam, byCpu, byVram));
}

export function describeMachine(id: string, role: NodeInfo['role'], version: string, extraProjects: ProjectInfo[] = [], extraEngines: string[] = []): NodeInfo {
  const engines = discoverEngines(extraEngines);
  const cpus = os.cpus();
  const ramGb = Math.round(os.totalmem() / 2 ** 30);
  const vramGb = detectVramGb();
  const projects = [...extraProjects];
  for (const p of discoverProjects(engines)) {
    if (!projects.some((x) => x.file.toLowerCase() === p.file.toLowerCase())) projects.push(p);
  }
  return {
    id,
    name: os.hostname(),
    role,
    platform: process.platform,
    cpuModel: (cpus[0]?.model ?? 'unknown').trim(),
    threads: cpus.length,
    ramGb,
    vramGb,
    maxInstances: defaultMaxInstances(cpus.length, ramGb, vramGb),
    engines,
    unusableEngines: unusableEngines(extraEngines),
    projects,
    claudePath: findClaude(),
    version,
  };
}

export function statsSampler(): () => NodeStats {
  const snap = () => os.cpus().reduce((a, c) => {
    const total = Object.values(c.times).reduce((x, y) => x + y, 0);
    return { idle: a.idle + c.times.idle, total: a.total + total };
  }, { idle: 0, total: 0 });
  let last = snap();
  return () => {
    const now = snap();
    const dt = now.total - last.total || 1;
    const cpu = Math.round(100 * (1 - (now.idle - last.idle) / dt));
    last = now;
    return { cpu, ramUsedGb: Math.round((os.totalmem() - os.freemem()) / 2 ** 30), at: Date.now() };
  };
}

export function dataRoot(appName: string): string {
  return path.join(process.env.LOCALAPPDATA ?? os.homedir(), appName);
}
