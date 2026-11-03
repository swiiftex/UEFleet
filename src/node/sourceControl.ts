// What source control knows about a workspace, and bringing one up to date. It's careful about
// pending changes, because undoing one in Plastic can't be taken back.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { lockHolder, type PackageLock } from '../shared/protocol';
import { isPlasticWorkspace, realCm, reason, type CmRun } from './plastic';

const exec = promisify(execFile);
const PATH_BATCH = 40;
const MAX_COMPARED = 400;
const HISTORY_LOOKED_AT = 200;
const MERGE_TIMEOUT_MS = 20 * 60_000;

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
  for (let i = 0; i < tracked.length; i += PATH_BATCH) await run(['undo', ...tracked.slice(i, i + PATH_BATCH)]);
  // Undoing these leaves the file behind.
  for (const c of plan.clear) if (c.status === 'PR' || c.status.startsWith('AD') || c.status.startsWith('CP')) await fsp.rm(path.join(dir, c.path), { force: true });

  const header = await plasticHeader(run);
  const branch = header ? await plasticBranchOf(header.changeset, run) : plan.targetBranch;
  // No merging by itself, and no stopping at a question nobody is there to answer.
  await run(branch === plan.targetBranch ? ['update', '--noinput', '--dontmerge'] : ['switch', `br:${plan.targetBranch}`, '--noinput']);
  const after = await plasticHeader(run);
  return { changeset: after?.changeset ?? '' };
}

// ---- Locks on packages ----

export const isPackage = (rel: string) => /\.(uasset|umap)$/i.test(rel);

// Agents name packages the way their tools do: /Game/Maps/L_Test.L_Test, a full path, or one relative to the project.
export function packageFile(dir: string, name: string) {
  const plain = slashes(name);
  if (plain.startsWith('/Game/')) {
    const rel = `Content/${plain.slice('/Game/'.length).split('.')[0]}`;
    return fs.existsSync(path.join(dir, `${rel}.umap`)) ? `${rel}.umap` : `${rel}.uasset`;
  }
  const root = `${slashes(dir).replace(/\/$/, '')}/`;
  return plain.toLowerCase().startsWith(root.toLowerCase()) ? plain.slice(root.length) : plain.replace(/^\/+/, '');
}

const mergeOf = (changeset: string) => ['merge', `cs:${changeset}`, '--cherrypicking'];

// A merge asked to go ahead with anything other than these can stop to ask a question nobody is there
// to answer, so whatever else turns up here is treated as a reason not to.
const WILL_CHANGE = [
  /^The file (.+?)#cs:\d+ was modified on source and will replace the destination version/,
  /^The item (.+?)#cs:\d+ has been added on source and will be added as result of the merge/,
  /^The item (.+?)#cs:\d+ has been deleted on source and will be deleted as result of the merge/,
];
const NOTHING_TO_DO = /^(No merges detected|The item .+ was changed on source but it has been discarded during merge because the content is the same)/;

export function readMergePreview(output: string) {
  const files: string[] = [];
  const problems: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim() || NOTHING_TO_DO.test(line)) continue;
    // The details of the line before.
    if (/^\s/.test(line) && problems.length) { problems[problems.length - 1] += ` ${line.trim()}`; continue; }
    const change = WILL_CHANGE.map((re) => line.match(re)).find(Boolean);
    const both = line.match(/^The file (.+?) needs to be merged from /);
    if (change) files.push(change[1].replace(/^\/+/, ''));
    else problems.push(both ? `${both[1].replace(/^\/+/, '')} changed on both sides` : line.trim());
  }
  return { files, problems };
}

function nothingToMerge(output: string) {
  const { files, problems } = readMergePreview(output);
  return !!output.trim() && !files.length && !problems.length;
}

const LOCK_FIELDS = 12;

function parseLocks(output: string) {
  const out: (PackageLock & { workspace: string })[] = [];
  for (const line of output.split(/\r?\n/)) {
    const f = line.split('|');
    if (f.length < LOCK_FIELDS) continue;
    const [, , , , destination, , branch, , status, by, workspace, file] = f;
    out.push({ path: file.replace(/^\/+/, ''), by, workspace, branch, destination, status: status === 'Retained' ? 'Retained' : 'Locked' });
  }
  return out;
}

async function holderCheckIn(lock: PackageLock, run: CmRun) {
  const output = await run(['history', lock.path, '--format={changesetid}|{branch}', `--limit=${HISTORY_LOOKED_AT}`]);
  const ids = output.split(/\r?\n/).map((l) => l.split('|')).filter(([, branch]) => branch === lock.branch).map(([id]) => Number(id)).filter(Boolean);
  return ids.length ? String(Math.max(...ids)) : undefined;
}

// Locks other people hold on these files, leaving out what this workspace already has. Listing locks
// fails outright on a file that isn't in source control, and fileinfo doesn't, so fileinfo goes first.
export async function packageLocks(dir: string, rels: string[], run: CmRun = realCm(dir)): Promise<PackageLock[]> {
  if (!isPlasticWorkspace(dir)) return [];
  const packages = [...new Set(rels.filter(isPackage))];
  const locked: string[] = [];
  for (let i = 0; i < packages.length; i += PATH_BATCH) {
    const output = await run(['fileinfo', ...packages.slice(i, i + PATH_BATCH), '--format={RelativePath}|{IsLocked}']);
    for (const line of output.split(/\r?\n/)) {
      const [file, isLocked] = line.split('|');
      if (isLocked === 'True') locked.push(file.replace(/^[\\/]+/, ''));
    }
  }
  if (!locked.length) return [];

  const listed: ReturnType<typeof parseLocks> = [];
  const unknown: string[] = [];
  for (let i = 0; i < locked.length; i += PATH_BATCH) {
    const batch = locked.slice(i, i + PATH_BATCH);
    // The server can refuse to say who has it, and it's still locked.
    const output = await run(['lock', 'list', ...batch, '--anystatus', '--machinereadable', '--smartlocks', '--fieldseparator=|']).catch(() => null);
    if (output === null) unknown.push(...batch);
    else listed.push(...parseLocks(output));
  }
  const me = (await run(['whoami'])).trim().toLowerCase();
  const here = (await run(['getworkspacefrompath', dir, '--format={wkname}'])).trim().toLowerCase();

  const out: PackageLock[] = unknown.map((p) => ({ path: p, by: '', branch: '', destination: '', status: 'Locked' }));
  // The workspace has to match too. Everyone may call theirs the same thing, and the user may have another.
  for (const { workspace, ...lock } of listed) {
    if (lock.by.toLowerCase() === me && workspace.toLowerCase() === here) continue;
    if (lock.status === 'Retained') {
      lock.changeset = await holderCheckIn(lock, run).catch(() => undefined);
      // Merged in already, whether or not that's been checked in yet.
      if (lock.changeset && nothingToMerge(await run(mergeOf(lock.changeset)).catch(() => ''))) continue;
    }
    out.push(lock);
  }
  return out;
}

export type BringIn =
  | { outcome: 'merged'; changesets: string[]; files: string[] }
  | { outcome: 'already' }
  | { outcome: 'refused'; why: string } // nothing changed, and it may work later
  | { outcome: 'failed'; why: string }; // it started, so part of it may be in the workspace

async function pendingPaths(dir: string, run: CmRun) {
  const out: string[] = [];
  for (const line of (await run(['status', '--machinereadable', '--fieldseparator=|', '--noheader', '--all'])).split(/\r?\n/)) {
    const [status, file, isDir] = line.split('|');
    // A checked-out folder only says something in it changed. A private one could clash with what arrives.
    if (status && file && (isDir !== 'True' || status === 'PR')) out.push(lowerSlashes(path.relative(dir, file)));
  }
  return out;
}

const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

// Merges in the check-ins these locks came from. A merge brings a whole changeset, not one file, so it
// only goes ahead if nothing it touches has changes here and it needs no decisions: both of those can
// leave a merge stuck on a question part way through. Nothing is checked in.
export async function bringInPackages(dir: string, locks: PackageLock[], beforeMerge: () => Promise<unknown> = async () => {}, run: CmRun = realCm(dir, MERGE_TIMEOUT_MS)): Promise<BringIn> {
  const held = locks.find((l) => l.status !== 'Retained');
  if (held) return { outcome: 'refused', why: `${lockHolder(held)} still has ${held.path} checked out.` };
  const lost = locks.find((l) => !l.changeset);
  if (lost) return { outcome: 'refused', why: `Couldn't find ${lockHolder(lost)}'s check-in of ${lost.path} on ${lost.branch}.` };

  const changesets = [...new Set(locks.map((l) => l.changeset!))];
  const files: string[] = [];
  for (const changeset of changesets) {
    const { files: touched, problems } = readMergePreview(await run(mergeOf(changeset)));
    if (problems.length) {
      const more = problems.length > 3 ? `, and ${problems.length - 3} more` : '';
      return { outcome: 'refused', why: `Changeset ${changeset} needs someone to merge it by hand: ${problems.slice(0, 3).join('; ')}${more}.` };
    }
    files.push(...touched);
  }
  if (!files.length) return { outcome: 'already' };

  const pending = await pendingPaths(dir, run);
  const clash = files.filter((f) => pending.some((p) => overlaps(lowerSlashes(f), p)));
  if (clash.length) {
    const more = clash.length > 3 ? `, and ${clash.length - 3} more` : '';
    return { outcome: 'refused', why: `It would change files that have changes in this workspace: ${clash.slice(0, 3).join(', ')}${more}.` };
  }

  await beforeMerge();
  try {
    for (const changeset of changesets) await run([...mergeOf(changeset), '--merge', '--nointeractiveresolution', '--noprintoperations']);
  } catch (e) {
    return { outcome: 'failed', why: reason(e) };
  }
  return { outcome: 'merged', changesets, files };
}
