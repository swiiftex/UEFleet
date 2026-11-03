// Most agents work directly in the project folder, and this holds what that needs. A project sent
// from the master gets fast per-agent copies instead, with no dependency on version control.
// Content is hardlinked (UE saves by replacing the file, so a save in one copy can't leak
// into another); everything an agent can edit in place is a real copy.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ApplyResult, ChangedFile } from '../shared/protocol';

const exec = promisify(execFile);

export type FileAction = 'skip' | 'link' | 'copy';

const SKIP_TOP = new Set([
  'saved', 'intermediate', 'deriveddatacache', 'backup', '.git', '.plastic', '.svn', '.vs', '.idea', '.vscode',
  '.codex', '.cursor', '.gemini', '.sentry-native', '.fleet', '.mcp.json',
]);
const SKIP_ANYWHERE = new Set(['.git', '.plastic', '.svn']);
const SKIP_EXT = new Set(['.sln', '.slnx', '.suo', '.dotsettings', '.user', '.vcxproj', '.filters']);
const BINARY_EXT = /\.(uasset|umap|ubulk|uexp|upk|png|jpe?g|tga|exr|hdr|bmp|dds|psd|fbx|obj|wav|wem|bnk|mp3|ogg|mp4|mov|dll|so|dylib|exe|pdb|lib|a|prx|prof|exp|bin|pak|zip|7z|gz|ttf|otf)$/i;
// Always a real copy, however large, because agents edit these in place.
const TEXT_EXTENSIONS = ['cpp', 'cc', 'c', 'h', 'hpp', 'inl', 'cs', 'py', 'ini', 'json', 'txt', 'md', 'uplugin', 'uproject', 'xml', 'yml', 'yaml', 'usf', 'ush', 'hlsl', 'js', 'ts', 'bat', 'cmd', 'sh', 'ps1', 'toml', 'csv', 'tsv', 'html', 'css', 'm', 'mm', 'java', 'kt', 'gradle', 'lua', 'cfg', 'natvis', 'rc', 'def', 'plist'];
const TEXT_EXT = new RegExp(`\\.(${TEXT_EXTENSIONS.join('|')})$`, 'i');
const LINK_ABOVE_BYTES = 4 * 1024 * 1024;

export const isBinaryPath = (rel: string) => BINARY_EXT.test(rel);

// Hardlink anything immutable; really copy only what can be edited in place. Build outputs are
// the exception: a running editor locks its DLLs across every link to them, which would stop
// another copy from rebuilding. PDBs are safe because UBT deletes them before linking.
export function classify(rel: string, size = 0): FileAction {
  const parts = rel.split(/[\\/]/).map((p) => p.toLowerCase());
  const top = parts[0];
  if (SKIP_TOP.has(top) || parts.some((p) => SKIP_ANYWHERE.has(p))) return 'skip';
  if (parts.length === 1 && SKIP_EXT.has(path.extname(top))) return 'skip';
  if (top === 'plugins' && (parts.includes('intermediate') || parts.includes('saved'))) return 'skip';
  if (parts.includes('binaries')) return rel.toLowerCase().endsWith('.pdb') ? 'link' : 'copy';
  if (parts.includes('content')) return 'link';
  if (TEXT_EXT.test(rel)) return 'copy';
  if (BINARY_EXT.test(rel) || size >= LINK_ABOVE_BYTES) return 'link';
  return 'copy';
}

export interface BaselineEntry { size: number; mtime: number; srcSize: number; srcMtime: number }
export type Baseline = Record<string, BaselineEntry>;

const baselinePath = (slotDir: string) => path.join(slotDir, '.fleet', 'baseline.json');

async function* walk(root: string, rel = ''): AsyncGenerator<string> {
  let entries: fs.Dirent[];
  try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (classify(e.isDirectory() ? path.join(r, 'x') : r) === 'skip') continue;
    if (e.isDirectory()) yield* walk(root, r);
    else if (e.isFile()) yield r;
  }
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

export interface SyncProgress { done: number; total: number; linked: number; copied: number; skipped: number; removed: number; ms: number }

// Idempotent: a warm copy only touches what changed in the source since last time.
export async function syncProject(src: string, dst: string, onProgress?: (p: SyncProgress) => void): Promise<SyncProgress> {
  const t0 = Date.now();
  await fsp.mkdir(path.join(dst, '.fleet'), { recursive: true });
  const files: string[] = [];
  for await (const f of walk(src)) files.push(f);
  const stat: SyncProgress = { done: 0, total: files.length, linked: 0, copied: 0, skipped: 0, removed: 0, ms: 0 };
  const baseline: Baseline = {};
  const dirs = new Set<string>();
  let lastTick = 0;

  await pool(files, 24, async (rel) => {
    const s = path.join(src, rel);
    const d = path.join(dst, rel);
    const dir = path.dirname(d);
    if (!dirs.has(dir)) { await fsp.mkdir(dir, { recursive: true }); dirs.add(dir); }
    const ss = await fsp.stat(s, { bigint: true });
    const ds = await fsp.stat(d, { bigint: true }).catch(() => null);
    // A read-only source (Perforce-style) can't be saved over through a link, so it gets a real copy.
    const wantLink = classify(rel, Number(ss.size)) === 'link' && (Number(ss.mode) & 0o200) !== 0;
    const same = ds && ds.size === ss.size && ds.mtimeMs === ss.mtimeMs;
    const sameInode = ds && ds.ino === ss.ino;
    if (wantLink) {
      if (sameInode) stat.skipped++;
      else if (same) stat.skipped++;
      else {
        if (ds) await fsp.rm(d, { force: true });
        try { await fsp.link(s, d); stat.linked++; }
        catch { await fsp.copyFile(s, d); await fsp.utimes(d, ss.atimeMs ? new Date(Number(ss.atimeMs)) : new Date(), new Date(Number(ss.mtimeMs))); stat.copied++; }
      }
    } else if (same) {
      stat.skipped++;
    } else {
      if (ds) await fsp.rm(d, { force: true });
      await fsp.copyFile(s, d);
      await fsp.chmod(d, 0o666).catch(() => {});
      await fsp.utimes(d, new Date(), new Date(Number(ss.mtimeMs)));
      stat.copied++;
    }
    // Plain stats here: listChanges and applyChanges compare against these exact float values.
    const [after, srcAfter] = await Promise.all([fsp.stat(d), fsp.stat(s)]);
    baseline[rel] = { size: after.size, mtime: after.mtimeMs, srcSize: srcAfter.size, srcMtime: srcAfter.mtimeMs };
    stat.done++;
    if (onProgress && Date.now() - lastTick > 300) { lastTick = Date.now(); onProgress({ ...stat, ms: Date.now() - t0 }); }
  });

  // Anything left over in the copy that the source no longer has.
  const srcSet = new Set(files);
  const old = await readBaseline(dst);
  for (const rel of Object.keys(old)) {
    if (!srcSet.has(rel)) { await fsp.rm(path.join(dst, rel), { force: true }).catch(() => {}); stat.removed++; }
  }
  await fsp.writeFile(baselinePath(dst), JSON.stringify(baseline));
  stat.ms = Date.now() - t0;
  await seedSaves(src, dst);
  await snapshotText(dst).catch(() => {});
  onProgress?.(stat);
  return stat;
}

// Agents start from the user's real progress and settings instead of a fresh first run. Saved/ is
// never listed as a change, so nothing an agent does to these can reach the real saves.
export async function seedSaves(src: string, dst: string) {
  const from = path.join(src, 'Saved', 'SaveGames');
  if (!fs.existsSync(from)) return;
  await fsp.rm(path.join(dst, 'Saved', 'SaveGames'), { recursive: true, force: true });
  await fsp.cp(from, path.join(dst, 'Saved', 'SaveGames'), { recursive: true }).catch(() => {});
}

async function readBaseline(slotDir: string): Promise<Baseline> {
  try { return JSON.parse(await fsp.readFile(baselinePath(slotDir), 'utf8')); } catch { return {}; }
}

// Only text is tracked. Plugins can ship gigabytes of libraries, Wwise for one, and none of them
// could be merged anyway. The last matching line wins, so the plugin folders stay out.
const GIT_EXCLUDE = `/*
!/Source/
!/Config/
!/Plugins/
/Source/**
/Config/**
/Plugins/**
!/Source/**/
!/Config/**/
!/Plugins/**/
${TEXT_EXTENSIONS.map((e) => `!*.${e}`).join('\n')}
!/CLAUDE.md
/Plugins/*/Content/
/Plugins/*/Binaries/
/Plugins/*/Intermediate/
/.fleet/
`;

// Marks a repo made with the rules above. One without it may hold those libraries.
const TEXT_ONLY_MARKER = 'fleet-text-only';

// A private repo over the text files gives the agent normal git tools and gives us a merge base.
async function snapshotText(slotDir: string) {
  // Git's automatic repack is a problem here even for an agent's own commits: it holds the commit
  // up until it finishes, and several copies repacking at once can use all of the machine's memory.
  const git = (...a: string[]) => exec('git', ['-C', slotDir, '-c', 'user.name=ue-fleet', '-c', 'user.email=ue-fleet@localhost', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...a], { windowsHide: true, maxBuffer: 1 << 26 });
  const repo = path.join(slotDir, '.git');
  if (!fs.existsSync(path.join(repo, TEXT_ONLY_MARKER))) await fsp.rm(repo, { recursive: true, force: true });
  if (!fs.existsSync(repo)) {
    await git('init', '-q');
    // Agents run plain `git diff` here, so the repo itself must not rewrite line endings either.
    await git('config', 'core.autocrlf', 'false');
    await git('config', 'gc.auto', '0');
    await git('config', 'maintenance.auto', 'false');
    await fsp.writeFile(path.join(repo, TEXT_ONLY_MARKER), '');
  }
  await fsp.writeFile(path.join(slotDir, '.git', 'info', 'exclude'), GIT_EXCLUDE);
  await git('add', '-A');
  await git('commit', '-q', '--allow-empty', '-m', 'Baseline for this task');
  await git('tag', '-f', 'fleet-baseline');
}

// Bytes, never strings: decoding would garble any file that isn't clean UTF-8, and a merge must
// keep each file's encoding and line endings exactly.
export async function baseText(slotDir: string, rel: string): Promise<Buffer | null> {
  try {
    const { stdout } = await exec('git', ['-C', slotDir, '-c', 'core.autocrlf=false', 'show', `fleet-baseline:${rel.replaceAll('\\', '/')}`], { windowsHide: true, maxBuffer: 1 << 28, encoding: 'buffer' });
    return stdout;
  } catch {
    return null;
  }
}

export async function listChanges(slotDir: string): Promise<ChangedFile[]> {
  const baseline = await readBaseline(slotDir);
  const out: ChangedFile[] = [];
  const seen = new Set<string>();
  for await (const rel of walk(slotDir)) {
    if (rel.startsWith('Binaries') || /[\\/]Binaries[\\/]/.test(rel)) continue;
    seen.add(rel);
    const st = await fsp.stat(path.join(slotDir, rel));
    const b = baseline[rel];
    if (!b) out.push({ path: rel, kind: 'added', binary: isBinaryPath(rel), size: st.size });
    else if (b.size !== st.size || b.mtime !== st.mtimeMs) out.push({ path: rel, kind: 'modified', binary: isBinaryPath(rel), size: st.size });
  }
  for (const rel of Object.keys(baseline)) {
    if (!seen.has(rel) && !rel.startsWith('Binaries') && !/[\\/]Binaries[\\/]/.test(rel)) out.push({ path: rel, kind: 'deleted', binary: isBinaryPath(rel) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// Replace, never write through: the destination may be hardlinked into other agents' copies.
async function replaceFile(from: string, to: string) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  const tmp = `${to}.fleet-${crypto.randomBytes(3).toString('hex')}`;
  await fsp.copyFile(from, tmp);
  await fsp.rename(tmp, to);
}

// With favorTheirs, lines both sides changed go their way, and everything else from both sides stays.
export async function mergeText(ours: string, base: Buffer, theirs: string, favorTheirs = false): Promise<{ clean: boolean; text: Buffer }> {
  const dir = await fsp.mkdtemp(path.join(path.dirname(theirs), '.fleet-merge-'));
  try {
    const [a, b, c] = ['ours', 'base', 'theirs'].map((n) => path.join(dir, n));
    await fsp.copyFile(ours, a);
    await fsp.writeFile(b, base);
    await fsp.copyFile(theirs, c);
    try {
      const { stdout } = await exec('git', ['merge-file', '-p', ...(favorTheirs ? ['--theirs'] : []), a, b, c], { windowsHide: true, maxBuffer: 1 << 28, encoding: 'buffer' });
      return { clean: true, text: stdout };
    } catch (e: any) {
      return { clean: false, text: e.stdout ?? Buffer.alloc(0) };
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// Copies an agent's changes into the real project. A file someone else changed since this
// copy was taken gets a three-way merge if it's text, otherwise it's reported as a conflict.
export async function applyChanges(slotDir: string, sourceDir: string, only?: string[], force: string[] = []): Promise<ApplyResult> {
  const changes = await listChanges(slotDir);
  const baseline = await readBaseline(slotDir);
  const result: ApplyResult = { applied: [], merged: [], conflicts: [] };
  for (const c of changes) {
    if (only && !only.includes(c.path)) continue;
    const slotFile = path.join(slotDir, c.path);
    const srcFile = path.join(sourceDir, c.path);
    const b = baseline[c.path];
    const srcStat = await fsp.stat(srcFile).catch(() => null);
    const moved = b ? (!srcStat || srcStat.size !== b.srcSize || srcStat.mtimeMs !== b.srcMtime) : !!srcStat;
    const forced = force.includes(c.path);
    try {
      if (c.kind === 'deleted') {
        if (moved && !forced) { result.conflicts.push({ path: c.path, reason: 'Changed in the project since this copy was made, but the agent deleted it.' }); continue; }
        await fsp.rm(srcFile, { force: true });
        delete baseline[c.path];
        result.applied.push(c.path);
        continue;
      }
      if (moved && !forced) {
        const base = c.binary || !srcStat ? null : await baseText(slotDir, c.path);
        if (base === null) { result.conflicts.push({ path: c.path, reason: c.binary ? 'Binary file also changed in the project.' : 'Also changed in the project, and no base version to merge from.' }); continue; }
        const merged = await mergeText(srcFile, base, slotFile);
        if (!merged.clean) { result.conflicts.push({ path: c.path, reason: 'Text merge has conflicts.' }); continue; }
        const tmp = `${srcFile}.fleet-merge`;
        await fsp.writeFile(tmp, merged.text);
        await fsp.rename(tmp, srcFile);
        result.merged.push(c.path);
      } else {
        await replaceFile(slotFile, srcFile);
        result.applied.push(c.path);
      }
      const [st, ss] = await Promise.all([fsp.stat(slotFile), fsp.stat(srcFile)]);
      baseline[c.path] = { size: st.size, mtime: st.mtimeMs, srcSize: ss.size, srcMtime: ss.mtimeMs };
    } catch (e: any) {
      const locked = e?.code === 'EBUSY' || e?.code === 'EPERM';
      result.conflicts.push({ path: c.path, reason: locked ? 'File is locked. Close it in the editor that has it open and try again.' : String(e?.message ?? e) });
    }
  }
  await fsp.writeFile(baselinePath(slotDir), JSON.stringify(baseline));
  return result;
}

// ---- Agents sharing one project folder ----

// There's no copy to compare against, so what changed is whatever is newer than the task.
export async function changedSince(dir: string, since: number): Promise<ChangedFile[]> {
  const files: string[] = [];
  for await (const rel of walk(dir)) {
    if (!rel.startsWith('Binaries') && !/[\\/]Binaries[\\/]/.test(rel)) files.push(rel);
  }
  const out: ChangedFile[] = [];
  await pool(files, 24, async (rel) => {
    const st = await fsp.stat(path.join(dir, rel)).catch(() => null);
    if (st && st.mtimeMs >= since) out.push({ path: rel, kind: st.birthtimeMs >= since ? 'added' : 'modified', binary: isBinaryPath(rel), size: st.size });
  });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// An editor with no asset registry cache spends minutes reading every asset, and the project's cache
// is as good as its own would be, since it's reading the same files. Unreal never rewrites a cache
// file, it only adds new ones and removes old ones, so a link is safe and costs no disk.
export async function seedAssetCache(src: string, dst: string) {
  const from = path.join(src, 'Intermediate');
  const to = path.join(dst, 'Intermediate');
  const folder = 'CachedAssetRegistry';
  if (fs.existsSync(path.join(to, folder))) return;
  const names = await fsp.readdir(path.join(from, folder)).catch(() => [] as string[]);
  for (const ref of names.filter((n) => n.endsWith('.ref'))) {
    const bin = (await fsp.readFile(path.join(from, folder, ref), 'utf8').catch(() => '')).trim();
    if (!names.includes(bin)) continue;
    await fsp.mkdir(path.join(to, folder), { recursive: true });
    await fsp.link(path.join(from, folder, bin), path.join(to, folder, bin))
      .catch(() => fsp.copyFile(path.join(from, folder, bin), path.join(to, folder, bin)))
      .catch(() => {});
    await fsp.writeFile(path.join(to, folder, ref), bin);
  }
  await fsp.copyFile(path.join(from, `${folder}Discovery.bin`), path.join(to, `${folder}Discovery.bin`)).catch(() => {});
}

const NO_MODULES_UNDER = new Set(['content', 'source', 'intermediate', 'saved', 'resources', 'config', 'thirdparty', 'shaders']);

async function moduleFolders(projectDir: string): Promise<string[]> {
  const found = [path.join(projectDir, 'Binaries', 'Win64')];
  const visit = async (dir: string) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
      if (!e.isDirectory()) continue;
      const name = e.name.toLowerCase();
      if (name === 'binaries') found.push(path.join(dir, e.name, 'Win64'));
      else if (!NO_MODULES_UNDER.has(name)) await visit(path.join(dir, e.name));
    }
  };
  await visit(path.join(projectDir, 'Plugins'));
  return found;
}

const isLoaded = (file: string) => fsp.open(file, 'r+').then((h) => h.close().then(() => false), () => true);

const LEFT_BY_A_BUILD = /\.fleet-(old-\w+|new)$/;

// Windows lets a loaded DLL be renamed but not overwritten, so each one is swapped for an unlocked
// copy. The linker can then replace it, and editors already running carry on with what they loaded,
// the user's own included. The copy keeps the file's date, so a build doesn't think it's out of date.
async function swapIfLoaded(file: string) {
  if (!/\.(dll|exe|pdb)$/i.test(file) || !(await isLoaded(file))) return;
  const fresh = `${file}.fleet-new`;
  try {
    await fsp.copyFile(file, fresh);
    await fsp.rename(file, `${file}.fleet-old-${crypto.randomBytes(3).toString('hex')}`);
    await fsp.rename(fresh, file);
  } catch {
    // The build's own error says more than this could.
    await fsp.rm(fresh, { force: true }).catch(() => {});
  }
}

export async function freeLoadedModules(projectDir: string) {
  for (const folder of await moduleFolders(projectDir)) {
    for (const name of await fsp.readdir(folder).catch(() => [] as string[])) {
      const file = path.join(folder, name);
      // One left by an earlier build goes once nothing has it loaded any more.
      if (LEFT_BY_A_BUILD.test(name)) await fsp.rm(file, { force: true }).catch(() => {});
      else await swapIfLoaded(file);
    }
  }
}

// The same for particular files, such as the engine's own when a build is about to replace them.
// An engine has far too many modules to look through them all.
export async function freeFiles(files: string[]) {
  for (const folder of new Set(files.map((f) => path.dirname(f)))) {
    for (const name of await fsp.readdir(folder).catch(() => [] as string[])) {
      if (LEFT_BY_A_BUILD.test(name)) await fsp.rm(path.join(folder, name), { force: true }).catch(() => {});
    }
  }
  for (const file of files) await swapIfLoaded(file);
}

// ---- Pushing a project to another machine ----

export interface ManifestEntry { path: string; size: number; mtime: number }

export async function buildManifest(src: string): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  for await (const rel of walk(src)) {
    if (rel.toLowerCase().endsWith('.pdb')) continue;
    const st = await fsp.stat(path.join(src, rel));
    out.push({ path: rel, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

export async function planReceive(dir: string, manifest: ManifestEntry[]): Promise<string[]> {
  const need: string[] = [];
  const keep = new Set(manifest.map((m) => m.path));
  await pool(manifest, 24, async (m) => {
    const st = await fsp.stat(path.join(dir, m.path)).catch(() => null);
    if (!st || st.size !== m.size || Math.abs(st.mtimeMs - m.mtime) > 2) need.push(m.path);
  });
  for await (const rel of walk(dir)) {
    if (!keep.has(rel)) await fsp.rm(path.join(dir, rel), { force: true }).catch(() => {});
  }
  return need;
}

export const CHUNK = 1024 * 1024;

export async function writeChunk(dir: string, rel: string, offset: number, b64: string, last: boolean, mtime?: number) {
  const safe = path.normalize(rel);
  if (safe.startsWith('..') || path.isAbsolute(safe)) throw new Error(`Refusing path outside the project: ${rel}`);
  const file = path.join(dir, safe);
  const tmp = `${file}.part`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const fh = await fsp.open(tmp, offset === 0 ? 'w' : 'r+');
  try { await fh.write(Buffer.from(b64, 'base64'), 0, undefined, offset); } finally { await fh.close(); }
  if (last) {
    await fsp.rename(tmp, file);
    if (mtime) await fsp.utimes(file, new Date(), new Date(mtime));
  }
}

export async function readChunk(file: string, offset: number): Promise<{ data: string; last: boolean; mtime: number }> {
  const fh = await fsp.open(file, 'r');
  try {
    const st = await fh.stat();
    const buf = Buffer.alloc(Math.min(CHUNK, Math.max(0, st.size - offset)));
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    return { data: buf.subarray(0, bytesRead).toString('base64'), last: offset + bytesRead >= st.size, mtime: st.mtimeMs };
  } finally {
    await fh.close();
  }
}
