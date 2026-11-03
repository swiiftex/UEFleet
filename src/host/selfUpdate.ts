// Lets a running host replace its own exe with one sent by the master. Windows won't overwrite a
// running exe but will rename it, so the old one steps aside and the new one takes its name.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Null when it isn't running as its own exe, as in development, where there's nothing to replace.
export function selfExe(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:sea').isSea() ? process.execPath : null;
  } catch {
    return null;
  }
}

export function hashOf(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

export class SelfUpdater {
  private want: { hash: string; size: number } | null = null;
  private verified = false;

  constructor(private exe: string) {}
  private get incoming() { return `${this.exe}.new`; }
  private get previous() { return `${this.exe}.old`; }

  // The previous exe stays renamed until the new one is running, and its process may still be exiting.
  async cleanUp(attempts = 20) {
    for (let i = 0; i < attempts && fs.existsSync(this.previous); i++) {
      await fsp.rm(this.previous, { force: true }).catch(() => {});
      if (fs.existsSync(this.previous)) await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Says if it already has this one, as when a transfer finished but the restart was still waiting.
  async begin(hash: string, size: number) {
    this.want = { hash, size };
    this.verified = false;
    if (fs.existsSync(this.incoming) && fs.statSync(this.incoming).size === size && (await hashOf(this.incoming)) === hash) {
      this.verified = true;
      return { have: true };
    }
    await fsp.rm(this.incoming, { force: true });
    return { have: false };
  }

  async chunk(offset: number, data: string) {
    const fh = await fsp.open(this.incoming, offset === 0 ? 'w' : 'r+');
    try { await fh.write(Buffer.from(data, 'base64'), 0, undefined, offset); } finally { await fh.close(); }
  }

  async finish() {
    if (!this.want) throw new Error('No update in progress.');
    const got = await hashOf(this.incoming);
    if (got !== this.want.hash) throw new Error("The new host didn't arrive intact.");
    this.verified = true;
  }

  // Everything but the pairing code, which is already saved by now.
  private restartArgs() {
    const args = process.argv.slice(2);
    const i = args.indexOf('--pair');
    if (i >= 0) args.splice(i, 2);
    return args;
  }

  swapAndStart(logFile?: string) {
    if (!this.verified) throw new Error('No verified update to install.');
    fs.rmSync(this.previous, { force: true });
    fs.renameSync(this.exe, this.previous);
    try {
      fs.renameSync(this.incoming, this.exe);
      this.start(logFile);
    } catch (e) {
      if (!fs.existsSync(this.exe)) fs.renameSync(this.previous, this.exe);
      throw e;
    }
  }

  private start(logFile?: string) {
    const args = this.restartArgs();
    if (process.stdout.isTTY) {
      // Someone is watching this console, so the new host gets a window of its own to report in.
      const quoted = [`"${this.exe}"`, ...args.map((a) => `"${a}"`)].join(' ');
      const title = `"UE Fleet Host"`;
      spawn('cmd.exe', ['/d', '/s', '/c', `"start ${title} ${quoted}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, cwd: path.dirname(this.exe) }).unref();
      return;
    }
    const log = logFile ? fs.openSync(logFile, 'a') : 'ignore';
    spawn(this.exe, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true, cwd: path.dirname(this.exe) }).unref();
  }
}
