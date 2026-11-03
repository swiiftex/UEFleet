// Puts finished work into a Plastic changelist. It never checks anything in: that stays with the
// user, who can see the changelist in Plastic and check it in when they're ready.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const BATCH = 40;

export type CmRun = (args: string[]) => Promise<string>;

export const isPlasticWorkspace = (dir: string) => fs.existsSync(path.join(dir, '.plastic'));

export function realCm(dir: string, timeout = 5 * 60_000): CmRun {
  return async (args) => (await exec('cm', args, { cwd: dir, windowsHide: true, maxBuffer: 1 << 28, timeout })).stdout;
}

// Lines look like CO+RP|c:\workspace\Source\A.cpp|False|NO_MERGES.
export function parseStatus(output: string): Map<string, { code: string; isDir: boolean }> {
  const out = new Map<string, { code: string; isDir: boolean }>();
  for (const line of output.split(/\r?\n/)) {
    const [code, file, isDir] = line.split('|');
    if (code && file) out.set(path.normalize(file).toLowerCase(), { code, isDir: isDir === 'True' });
  }
  return out;
}

export interface ChangelistResult { name: string; assigned: string[]; failed: { path: string; reason: string }[] }

export const reason = (e: any) => String(e?.stderr || e?.stdout || e?.message || e).trim().split(/\r?\n/).pop() ?? 'cm failed';

// A batch stops at its first problem, so going one at a time after a failure finds exactly which
// files can't go through, such as one someone else has locked.
async function inBatches(items: string[], run: (batch: string[]) => Promise<unknown>, onFail: (item: string, why: string) => void) {
  const done: string[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    try {
      await run(batch);
      done.push(...batch);
    } catch {
      for (const item of batch) {
        try { await run([item]); done.push(item); } catch (e) { onFail(item, reason(e)); }
      }
    }
  }
  return done;
}

// Plastic only accepts 'Added' and 'Checked-out' items into a changelist, so a new file has to be
// added and a plain edit checked out first. Both keep the file's contents as they are.
export async function assignToChangelist(dir: string, name: string, description: string, files: string[], run: CmRun = realCm(dir)): Promise<ChangelistResult> {
  const clean = name.replace(/["\r\n]/g, ' ').trim();
  const result: ChangelistResult = { name: clean, assigned: [], failed: [] };
  const rel = (abs: string) => path.relative(dir, abs);
  const fail = (abs: string, why: string) => result.failed.push({ path: rel(abs), reason: why });
  const status = parseStatus(await run(['status', '--machinereadable', '--fieldseparator=|', '--noheader', '--all']));

  const ready: string[] = [];
  const toAdd = new Set<string>();
  const toCheckOut: string[] = [];
  for (const f of files) {
    const abs = path.join(dir, f);
    const code = status.get(path.normalize(abs).toLowerCase())?.code;
    if (code && /^(CO|AD)/.test(code)) ready.push(abs);
    else if (code === 'CH') toCheckOut.push(abs);
    else if (code === 'PR') toAdd.add(abs);
    else if (code && /^(LD|DE)/.test(code)) fail(abs, "It's deleted, and Plastic can't put a deleted file in a changelist from here.");
    else {
      // A new file in a new folder isn't listed itself, only its top new folder is.
      const chain: string[] = [abs];
      let up = path.dirname(abs);
      while (up.length > dir.length && !status.has(path.normalize(up).toLowerCase())) { chain.unshift(up); up = path.dirname(up); }
      if (status.get(path.normalize(up).toLowerCase())?.code === 'PR' && up.length > dir.length) {
        toAdd.add(up);
        chain.forEach((c) => toAdd.add(c));
      } else fail(abs, "Plastic doesn't list it as changed, so it may be ignored or back to its original contents.");
    }
  }
  const fileSet = new Set(files.map((f) => path.join(dir, f)));
  const added = await inBatches([...toAdd], (b) => run(['add', '--coparent', ...b]), fail);
  const checkedOut = await inBatches(toCheckOut, (b) => run(['checkout', ...b]), fail);
  const assignable = [...ready, ...added.filter((a) => fileSet.has(a)), ...checkedOut];
  if (!assignable.length) return result;

  try {
    await run(['changelist', 'create', clean, description]);
  } catch (e) {
    // Reusing a name is fine: this task may have been sent back and merged a second time.
    if (!/exist/i.test(reason(e))) { for (const a of assignable) fail(a, reason(e)); return result; }
  }
  const assigned = await inBatches(assignable, (b) => run(['changelist', clean, 'add', ...b]), fail);
  result.assigned = assigned.map(rel);
  return result;
}
