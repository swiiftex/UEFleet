// Gets the current fleet-host.exe onto every machine, and restarts each one once nothing is running
// there. Agents that are busy keep the old version until they're done, or until told to restart now.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { hashOf } from '../host/selfUpdate';
import { CHUNK } from '../node/projectSync';
import type { HostUpdate } from '../shared/protocol';
import type { RemoteNode } from './link';

export interface HostUpdateDeps {
  nodes: () => RemoteNode[];
  busy: (nodeId: string) => number;
  beforeRestart: (nodeId: string) => void;
  changed: () => void;
}

export class HostUpdates {
  private exe: string | null = null;
  private build: string | null = null;
  private states = new Map<string, HostUpdate>();
  private delivered = new Map<string, string>(); // which build each machine has ready to switch to
  private working = new Set<string>();

  constructor(private deps: HostUpdateDeps) {}

  view(nodeId: string) { return this.states.get(nodeId); }

  private set(nodeId: string, state: HostUpdate | null) {
    if (state) this.states.set(nodeId, state);
    else this.states.delete(nodeId);
    this.deps.changed();
  }

  async setExe(exe: string | null) {
    this.exe = exe && fs.existsSync(exe) ? exe : null;
    this.build = this.exe ? await hashOf(this.exe) : null;
    this.delivered.clear();
    this.checkAll();
  }

  checkAll() { for (const n of this.deps.nodes()) void this.check(n); }

  async check(node: RemoteNode) {
    const id = node.hostId;
    if (!this.build || !this.exe || !node.online || !node.info.selfUpdate) return;
    if (node.info.build === this.build) {
      this.delivered.delete(id);
      if (this.states.has(id)) this.set(id, null);
      return;
    }
    if (this.working.has(id) || this.states.get(id)?.stage === 'restarting') return;
    this.working.add(id);
    try {
      if (this.delivered.get(id) !== this.build) {
        await this.send(node);
        this.delivered.set(id, this.build);
      }
      const busy = this.deps.busy(id);
      if (busy) this.set(id, { stage: 'waiting', busy });
      else await this.restart(node);
    } catch (e: any) {
      this.set(id, { stage: 'failed', detail: String(e?.message ?? e) });
    } finally {
      this.working.delete(id);
    }
  }

  // Doesn't wait for the machine's agents to finish. The hub picks them back up when it returns.
  async restartNow(nodeId: string) {
    const node = this.deps.nodes().find((n) => n.hostId === nodeId);
    if (!node || this.delivered.get(nodeId) !== this.build) return;
    await this.restart(node);
  }

  private async restart(node: RemoteNode) {
    this.deps.beforeRestart(node.hostId);
    this.set(node.hostId, { stage: 'restarting' });
    await node.call('host.restart', {});
  }

  private async send(node: RemoteNode) {
    const id = node.hostId;
    const exe = this.exe!;
    const { size } = await fsp.stat(exe);
    const { have } = await node.call<{ have: boolean }>('host.updateBegin', { hash: this.build, size });
    if (have) return;
    this.set(id, { stage: 'sending', percent: 0 });
    const fh = await fsp.open(exe, 'r');
    try {
      const buf = Buffer.alloc(CHUNK);
      let shown = 0;
      for (let offset = 0; offset < size; offset += CHUNK) {
        const { bytesRead } = await fh.read(buf, 0, CHUNK, offset);
        await node.call('host.updateChunk', { offset, data: buf.subarray(0, bytesRead).toString('base64') });
        const percent = Math.floor((100 * (offset + bytesRead)) / size);
        if (percent >= shown + 5) { shown = percent; this.set(id, { stage: 'sending', percent }); }
      }
    } finally {
      await fh.close();
    }
    await node.call('host.updateFinish', {});
  }
}
