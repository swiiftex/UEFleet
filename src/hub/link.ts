// The master's end of machine linking. Hosts dial out to this TLS listener, so a remote
// machine never opens a port. The pairing code carries the certificate fingerprint, and hosts
// pin it, so nobody on the network can impersonate the master.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { encodePairCode } from '../shared/pair';
import type { LinkFrame, NodeEvent, NodeInfo } from '../shared/protocol';

export const fingerprintOf = (certPem: string) => crypto.createHash('sha256').update(new crypto.X509Certificate(certPem).raw).digest('hex');
export const LOCAL_HOST_ID = 'master';
const PORT_WAIT_MS = 4000;

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue;
      // Real adapters first; virtual switches last. 192.168.56.x is VirtualBox's host-only network.
      if (/vEthernet|VirtualBox|VMware|Loopback/i.test(name) || i.address.startsWith('192.168.56.')) out.push(i.address);
      else out.unshift(i.address);
    }
  }
  return out;
}

export class RemoteNode extends EventEmitter {
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws: WebSocket | null = null;
  constructor(public hostId: string, public info: NodeInfo) { super(); }

  get online() { return !!this.ws && this.ws.readyState === 1; }

  attach(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw) => {
      let frame: LinkFrame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      if (frame.f === 'res') {
        const w = this.waiting.get(frame.id);
        if (!w) return;
        this.waiting.delete(frame.id);
        if (frame.ok) w.resolve(frame.result);
        else w.reject(new Error(frame.error ?? 'Remote call failed'));
      } else if (frame.f === 'ev') {
        this.emit('event', frame.ev as NodeEvent);
      } else if (frame.f === 'ping') {
        ws.send(JSON.stringify({ f: 'pong' }));
      }
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      for (const w of this.waiting.values()) w.reject(new Error(`${this.info.name} disconnected.`));
      this.waiting.clear();
      this.emit('offline');
    });
    this.emit('online');
  }

  call<T = any>(method: string, params: unknown): Promise<T> {
    if (!this.online) return Promise.reject(new Error(`${this.info.name} is offline.`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ f: 'req', id, method, params } satisfies LinkFrame));
    });
  }
}

interface LinkState {
  certPem: string;
  keyPem: string;
  pairToken: string;
  hosts: Record<string, { key: string; name: string }>;
}

export class LinkServer extends EventEmitter {
  private state!: LinkState;
  private server: https.Server | null = null;
  nodes = new Map<string, RemoteNode>();
  port = 47800;

  constructor(private stateFile: string, private masterName: string, private lastSeqFor: (hostId: string) => Record<string, number>) {
    super();
  }

  private async load() {
    try {
      this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return;
    } catch { /* first run */ }
    const selfsigned = (await import('selfsigned')).default as any;
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'ue-fleet-master' }], { days: 3650, keySize: 2048, algorithm: 'sha256' });
    this.state = { certPem: pems.cert, keyPem: pems.private, pairToken: crypto.randomBytes(18).toString('base64url'), hosts: {} };
    this.save();
  }

  private save() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state));
  }

  async start() {
    await this.load();
    const server = https.createServer({ cert: this.state.certPem, key: this.state.keyPem });
    const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 * 1024 });
    wss.on('connection', (ws) => this.onConnection(ws));
    // ws re-emits the server's errors; port conflicts are handled by tryListen below.
    wss.on('error', () => {});
    this.server = server;
    // Hosts were paired with this port, so a restart gets a moment for the old app to let go of it.
    const started = Date.now();
    await new Promise<void>((resolve) => {
      const tryListen = (port: number, left: number) => {
        server.once('error', (e: any) => {
          if (e.code !== 'EADDRINUSE') { console.error('Link server failed to start:', e); resolve(); }
          else if (Date.now() - started < PORT_WAIT_MS && port === this.port) setTimeout(() => tryListen(port, left), 300);
          else if (left > 0) tryListen(port + 1, left - 1);
          else { console.error('Link server failed to start:', e); resolve(); }
        });
        server.listen(port, '0.0.0.0', () => { this.port = port; resolve(); });
      };
      tryListen(this.port, 10);
    });
  }

  // The master's own host links like any other, without a pairing code.
  localHostConfig(masterName: string) {
    this.state.hosts[LOCAL_HOST_ID] ??= { key: crypto.randomBytes(24).toString('base64url'), name: masterName };
    this.save();
    return {
      hostId: LOCAL_HOST_ID,
      key: this.state.hosts[LOCAL_HOST_ID].key,
      masterName,
      pair: { a: ['127.0.0.1'], p: this.port, t: this.state.pairToken, f: fingerprintOf(this.state.certPem) },
    };
  }

  pairing() {
    const addresses = lanAddresses();
    const code = encodePairCode({ a: addresses, p: this.port, t: this.state.pairToken, f: fingerprintOf(this.state.certPem) });
    return { code, port: this.port, addresses };
  }

  // A pairing code stops working once replaced; machines already paired keep their own key.
  rotatePairing() {
    this.state.pairToken = crypto.randomBytes(18).toString('base64url');
    this.save();
  }

  forget(hostId: string) {
    delete this.state.hosts[hostId];
    this.save();
    const n = this.nodes.get(hostId);
    n?.ws?.close();
    this.nodes.delete(hostId);
  }

  private onConnection(ws: WebSocket) {
    const timer = setTimeout(() => ws.close(), 10_000);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      let frame: LinkFrame;
      try { frame = JSON.parse(raw.toString()); } catch { ws.close(); return; }
      const deny = (reason: string) => { ws.send(JSON.stringify({ f: 'denied', reason } satisfies LinkFrame)); ws.close(); };
      let newKey: string | undefined;
      if (frame.f === 'pair') {
        if (!safeEqual(frame.code, this.state.pairToken)) return deny('That pairing code is not valid any more. Get a new one from the master.');
        newKey = crypto.randomBytes(24).toString('base64url');
        this.state.hosts[frame.hostId] = { key: newKey, name: frame.info.name };
        this.save();
      } else if (frame.f === 'hello') {
        const known = this.state.hosts[frame.hostId];
        if (!known || !safeEqual(frame.key, known.key)) return deny('This machine is no longer paired. Pair it again with a new code.');
      } else {
        return deny('Unexpected first message.');
      }
      let node = this.nodes.get(frame.hostId);
      if (!node) {
        node = new RemoteNode(frame.hostId, frame.info);
        this.nodes.set(frame.hostId, node);
        this.emit('node', node);
      } else {
        node.info = frame.info;
      }
      const lastSeq = this.lastSeqFor(frame.hostId);
      node.attach(ws);
      ws.send(JSON.stringify({ f: 'welcome', key: newKey, masterName: this.masterName, lastSeq } satisfies LinkFrame));
    });
  }

  stop() { return new Promise<void>((resolve) => { for (const n of this.nodes.values()) n.ws?.terminate(); if (this.server) this.server.close(() => resolve()); else resolve(); setTimeout(resolve, 1000); }); }
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
