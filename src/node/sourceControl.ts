// What source control knows about a workspace, and bringing one up to date. It's careful about
// pending changes, because undoing one in Plastic can't be taken back.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isPlasticWorkspace, realCm, type CmRun } from './plastic';

const exec = promisify(execFile);
const UNDO_BATCH = 40;
const MAX_COMPARED = 400;

const slashes = (rel: string) => rel.replaceAll('\\', '/');
const lowerSlashes = (rel: string) => slashes(rel).toLowerCase();
const hashBytes = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

async function plasticFile(rel: string, changeset: string, run: CmRun) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fleet-base-'));
  try {
    const file = path.join(dir, 'base');
    await run(['cat', `${slashes(rel)}#cs:${changeset}`, `--file=${file}`]);
    return await fsp.readFile(file);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function plasticHeader(run: CmRun) {
  const m = (await run(['status', '--header', '--machinereadable', '--fieldseparator=|'])).match(/^STATUS\|(\d+)\|([^|\r\n]*)\|/m);
  return m ? { changeset: m[1], repo: m[2] } : null;
}

const plasticBranchOf = async (changeset: string, run: CmRun) => (await run(['find', 'changeset', `where changesetid = ${changeset}`, '--format={branch}', '--nototal'])).trim().split(/\r?\n/).pop()?.trim() ?? '';

async function plasticLatest(branch: string, run: CmRun) {
  const ids = (await run(['find', 'changeset', `where branch = '${branch}'`, '--format={changesetid}', '--nototal'])).split(/\r?\n/).map(Number).filter(Boolean);
  return ids.length ? String(Math.max(...ids)) : null;
}

// Null when there's no such version, as with a new file or a project outside source control.
export async function checkedInVersion(dir: string, rel: string, run: CmRun = realCm(dir)): Promise<Buffer | null> {
  try {
    if (isPlasticWorkspace(dir)) {
      // The workspace's own changeset, not the branch's latest. Anything newer would look like the
      // agent had undone it, and the merge would take it out again.
      const header = await plasticHeader(run);
      return header ? await plasticFile(rel, header.changeset, run) : null;
    }
    const { stdout } = await exec('git', ['-C', dir, 'cat-file', '--filters', `HEAD:./${slashes(rel)}`], { windowsHide: true, maxBuffer: 1 << 28, encoding: 'buffer' });
    return stdout;
  } catch {
    return null;
  }
}

export interface PendingChange {
  path: string;
  status: string; // source control's own name for it, such as CH, AD or PR
  hash?: string; // none if it's gone from disk
  checkedIn: boolean; // it's identical to a checked-in version, so clearing it loses nothing
}

export interface WorkspaceState {
  vcs: 'plastic' | 'git';
  repo: string;
  branch: string;
  changeset: string;
  targetBranch: string; // the branch it should be on, its own unless told to follow another
  latest: string; // the newest changeset on that branch
  pending: PendingChange[];
}

export async function workspaceBranch(dir: string, run: CmRun = realCm(dir)): Promise<{ repo: string; branch: string } | null> {
  try {
    if (!isPlasticWorkspace(dir)) return null;
    const header = await plasticHeader(run);
    return header ? { repo: header.repo, branch: await plasticBranchOf(header.changeset, run) } : null;
  } catch {
    return null;
  }
}

// A new file in a new folder isn't listed itself, only its top new folder is, so what's known to have
// been delivered is looked for under those too.
async function plasticPending(dir: string, delivered: string[], versions: string[], run: CmRun): Promise<PendingChange[]> {
  const wanted = new Set(delivered.map(lowerSlashes));
  const found = new Map<string, string>();
  const newFolders: string[] = [];
  for (const line of (await run(['status', '--machinereadable', '--fieldseparator=|', '--noheader', '--all'])).split(/\r?\n/)) {
    const [status, file, isDir] = line.split('|');
    if (!status || !file) continue;
    const rel = path.relative(dir, file);
    if (isDir === 'True') { if (status === 'PR') newFolders.push(lowerSlashes(rel)); continue; }
    if (status !== 'PR' || wanted.has(lowerSlashes(rel))) found.set(rel, status);
  }
  for (const rel of delivered) {
    const inNewFolder = newFolders.some((f) => lowerSlashes(rel).startsWith(`${f}/`));
    if (inNewFolder && ![...found.keys()].some((k) => lowerSlashes(k) === lowerSlashes(rel)) && fs.existsSync(path.join(dir, rel))) found.set(rel, 'PR');
  }

  const pending: PendingChange[] = [];
  for (const [rel, status] of found) {
    const bytes = await fsp.readFile(path.join(dir, rel)).catch(() => null);
    const hash = bytes ? hashBytes(bytes) : undefined;
    let checkedIn = false;
    if (pending.length < MAX_COMPARED) {
      for (const changeset of versions) {
        const version = await plasticFile(rel, changeset, run).catch(() => null);
        if (bytes ? !!version && version.equals(bytes) : !version) { checkedIn = true; break; }
      }
    }
    pending.push({ path: rel, status, hash, checkedIn });
  }
  return pending;
}

async function plasticState(dir: string, follow: { repo: string; branch: string } | null | undefined, delivered: string[], run: CmRun): Promise<WorkspaceState | null> {
  const header = await plasticHeader(run);
  if (!header) return null;
  const branch = await plasticBranchOf(header.changeset, run);
  const followed = follow && follow.repo === header.repo ? await plasticLatest(follow.branch, run) : null;
  const targetBranch = followed ? follow!.branch : branch;
  const ownLatest = await plasticLatest(branch, run) ?? header.changeset;
  const latest = followed ?? ownLatest;
  return { vcs: 'plastic', repo: header.repo, branch, changeset: header.changeset, targetBranch, latest, pending: await plasticPending(dir, delivered, [...new Set([latest, ownLatest])], run) };
}

const git = async (dir: string, ...args: string[]) => (await exec('git', ['-C', dir, ...args], { windowsHide: true, maxBuffer: 1 << 26 })).stdout.trim();

// A fast-forward leaves pending changes alone and stops if they're in the way, so they don't need sorting out first.
async function gitState(dir: string): Promise<WorkspaceState | null> {
  const branch = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  await git(dir, 'fetch', '--quiet').catch(() => {});
  const changeset = await git(dir, 'rev-parse', '--short', 'HEAD');
  const behind = Number(await git(dir, 'rev-list', '--count', 'HEAD..@{upstream}').catch(() => '0'));
  const latest = behind ? await git(dir, 'rev-parse', '--short', '@{upstream}') : changeset;
  return { vcs: 'git', repo: await git(dir, 'config', '--get', 'remote.origin.url').catch(() => ''), branch, changeset, targetBranch: branch, latest, pending: [] };
}

export async function readWorkspace(dir: string, follow?: { repo: string; branch: string } | null, delivered: string[] = [], run: CmRun = realCm(dir)): Promise<WorkspaceState | null> {
  if (isPlasticWorkspace(dir)) return plasticState(dir, follow, delivered, run);
  return gitState(dir).catch(() => null);
}

// Only what the caller has decided is safe to clear gets cleared. Each is checked again first, because
// it could have changed since, and an update never overwrites what's left: it stops instead.
export async function updateWorkspace(dir: string, plan: { targetBranch: string; clear: Pick<PendingChange, 'path' | 'status' | 'hash'>[] }, run: CmRun = realCm(dir, 0)): Promise<{ changeset: string }> {
  if (!isPlasticWorkspace(dir)) {
    await git(dir, 'pull', '--ff-only', '--quiet');
    return { changeset: await git(dir, 'rev-parse', '--short', 'HEAD') };
  }
  for (const c of plan.clear) {
    const bytes = await fsp.readFile(path.join(dir, c.path)).catch(() => null);
    if ((bytes ? hashBytes(bytes) : undefined) !== c.hash) throw new Error(`${c.path} changed while this was being prepared, so nothing was updated.`);
  }
  const tracked = plan.clear.filter((c) => c.status !== 'PR').map((c) => path.join(dir, c.path));
  for (let i = 0; i < tracked.length; i += UNDO_BATCH) await run(['undo', ...tracked.slice(i, i + UNDO_BATCH)]);
  for (const c of plan.clear) if (c.status === 'PR' || c.status.startsWith('AD')) await fsp.rm(path.join(dir, c.path), { force: true });

  const header = await plasticHeader(run);
  const branch = header ? await plasticBranchOf(header.changeset, run) : plan.targetBranch;
  // No merging by itself, and no stopping at a question nobody is there to answer.
  await run(branch === plan.targetBranch ? ['update', '--noinput', '--dontmerge'] : ['switch', `br:${plan.targetBranch}`, '--noinput']);
  const after = await plasticHeader(run);
  return { changeset: after?.changeset ?? '' };
}
