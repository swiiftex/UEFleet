// The small app for remote machines: no UI, no Electron. Pair it once with a code from the
// master and it keeps itself connected, running agents and Unreal instances here on request.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import WebSocket from 'ws';
import { dataRoot, engineFromRoot, engineProblem, engineRootOf } from '../node/machine';
import { NodeService } from '../node/nodeService';
import { decodePairCode, type PairCode } from '../shared/pair';
import type { LinkFrame, NodeEvent } from '../shared/protocol';

const VERSION = '1.0.0';
const DATA = process.env.FLEET_HOST_DATA ?? dataRoot('uefleet-host');
const CONFIG = path.join(DATA, 'config.json');

interface Config { hostId: string; key?: string; pair?: PairCode; masterName?: string; engines?: string[] }

function loadConfig(): Config {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return { hostId: crypto.randomUUID() }; }
}
function saveConfig(c: Config) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2));
}

const stamp = () => new Date().toLocaleTimeString();
const log = (...a: unknown[]) => console.log(`[${stamp()}]`, ...a);
const NO_MCP = "It has no ModelContextProtocol plugin, so agents can't drive this editor.";

function argValue(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  console.log(`UE Fleet Host ${VERSION}`);
  const cfg = loadConfig();
  if (process.argv.includes('--forget')) {
    delete cfg.key; delete cfg.pair; delete cfg.masterName;
    saveConfig(cfg);
    console.log('Unpaired from the master.');
    return;
  }
  const engineArg = argValue('--engine');
  if (engineArg) {
    const root = engineRootOf(engineArg);
    const problem = engineProblem(root);
    if (problem) {
      console.log(`Can't use ${root}: ${problem}.`);
      process.exitCode = 1;
      return;
    }
    cfg.engines = [...(cfg.engines ?? []).filter((r) => r.toLowerCase() !== root.toLowerCase()), root];
    saveConfig(cfg);
    const e = engineFromRoot(root, root)!;
    console.log(`Added Unreal ${e.version} at ${root}.`);
    if (!e.hasMcp) console.log(NO_MCP);
    console.log('Close any running host and start it again to use it.');
    return;
  }
  const removeArg = argValue('--remove-engine');
  if (removeArg) {
    const root = engineRootOf(removeArg);
    cfg.engines = (cfg.engines ?? []).filter((r) => r.toLowerCase() !== root.toLowerCase());
    saveConfig(cfg);
    console.log(`Removed ${root}. Close any running host and start it again.`);
    return;
  }
  const codeArg = argValue('--pair');
  if (codeArg) { cfg.pair = decodePairCode(codeArg); delete cfg.key; }
  if (!cfg.pair) {
    console.log('\nOn the master, open Machines and copy the pairing code.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    while (!cfg.pair) {
      const code = await rl.question('Pairing code: ');
      try { cfg.pair = decodePairCode(code); } catch (e: any) { console.log(e.message); }
    }
    rl.close();
    delete cfg.key;
  }
  saveConfig(cfg);

  const service = new NodeService({ id: cfg.hostId, role: 'remote', version: VERSION, dataDir: DATA, extraEngines: cfg.engines });
  const info = service.info;
  console.log(`\nThis machine: ${info.name}, ${info.threads} threads, ${info.ramGb} GB RAM, ${info.vramGb} GB VRAM`);
  console.log(`Unreal: ${info.engines.length ? '' : 'none found'}`);
  for (const e of info.engines) console.log(`  ${e.version}  ${e.root}${e.hasMcp ? '' : `\n    ${NO_MCP}`}`);
  for (const u of info.unusableEngines ?? []) console.log(`  Not usable: ${u.root}: ${u.reason}.`);
  console.log('  Editor missing? Run: fleet-host.exe --engine "<engine folder>"');
  console.log(`Claude: ${info.claudePath ?? 'NOT FOUND. Install Claude Code and sign in, or agents cannot run here.'}`);
  console.log(`Up to ${info.maxInstances} editors at once.\n`);
  connect(cfg, service);

  const quit = async () => { log('Shutting down.'); await service.shutdown(); process.exit(0); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}

function connect(cfg: Config, service: NodeService) {
  let backoff = 1000;
  let addrIndex = 0;
  const schedule = () => { setTimeout(open, backoff); backoff = Math.min(backoff * 1.7, 15_000); };

  function open() {
    const pair = cfg.pair!;
    const addr = pair.a[addrIndex % Math.max(1, pair.a.length)] ?? '127.0.0.1';
    addrIndex++;
    const url = `wss://${addr}:${pair.p}`;
    // The certificate is self-signed, so trust comes from the fingerprint in the pairing code.
    const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 6000, maxPayload: 8 * 1024 * 1024 } as WebSocket.ClientOptions);
    let verified = false;
    let forward: ((ev: NodeEvent) => void) | null = null;
    let heartbeat: NodeJS.Timeout | null = null;

    ws.on('upgrade', (res) => {
      const cert = (res.socket as any).getPeerCertificate?.();
      const fp = cert?.raw ? crypto.createHash('sha256').update(cert.raw).digest('hex') : '';
      if (fp !== pair.f) {
        log(`Refusing ${addr}: its certificate doesn't match the pairing code.`);
        ws.terminate();
        return;
      }
      verified = true;
    });
    ws.on('open', () => {
      if (!verified) { ws.terminate(); return; }
      const frame: LinkFrame = cfg.key
        ? { f: 'hello', hostId: cfg.hostId, key: cfg.key, info: service.info }
        : { f: 'pair', code: pair.t, hostId: cfg.hostId, info: service.info };
      ws.send(JSON.stringify(frame));
    });
    ws.on('message', (raw) => {
      let f: LinkFrame;
      try { f = JSON.parse(raw.toString()); } catch { return; }
      if (f.f === 'welcome') {
        if (f.key) { cfg.key = f.key; }
        cfg.masterName = f.masterName;
        saveConfig(cfg);
        backoff = 1000;
        log(`Connected to ${f.masterName} at ${addr}.`);
        forward = (ev) => { if (ws.readyState === 1) ws.send(JSON.stringify({ f: 'ev', ev } satisfies LinkFrame)); };
        service.on('event', forward);
        service.replay(f.lastSeq ?? {});
        heartbeat = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ f: 'ping' } satisfies LinkFrame)); }, 15_000);
      } else if (f.f === 'denied') {
        log(f.reason);
        delete cfg.key;
        delete cfg.pair;
        saveConfig(cfg);
        log('Run this app again with a new pairing code.');
        void holdOpen().then(() => process.exit(1));
      } else if (f.f === 'req') {
        const { id, method, params } = f;
        service.rpc(method, params).then(
          (result) => ws.send(JSON.stringify({ f: 'res', id, ok: true, result } satisfies LinkFrame)),
          (e) => ws.send(JSON.stringify({ f: 'res', id, ok: false, error: String(e?.message ?? e) } satisfies LinkFrame)),
        );
      }
    });
    ws.on('close', () => {
      if (forward) { service.off('event', forward); log('Lost the connection to the master. Retrying.'); }
      if (heartbeat) clearInterval(heartbeat);
      schedule();
    });
    ws.on('error', () => { /* close follows */ });
  }
  open();
}

// Double-clicked, the console window would vanish before anyone could read why.
async function holdOpen() {
  if (!process.stdin.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('\nPress Enter to close.');
  rl.close();
}

main().catch(async (e) => {
  console.error(e?.message ?? e);
  await holdOpen();
  process.exit(1);
});
