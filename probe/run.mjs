// Proves the core bet on a throwaway project: cloned project + per-instance MCP port =
// parallel editors, each with their own PIE, and hardlinked Content survives saves.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ENGINE = process.argv[2] ?? 'F:/Unreal Engine/UE_5.8';
const ROOT = path.resolve(import.meta.dirname);
const BASE = path.join(ROOT, 'FleetProbe');
const SLOTS = path.join(ROOT, 'slots with spaces');
const EDITOR = `${ENGINE}/Engine/Binaries/Win64/UnrealEditor.exe`;
const CMD = `${ENGINE}/Engine/Binaries/Win64/UnrealEditor-Cmd.exe`;
const ASSET = 'Content/Probe/ST_Test.uasset';
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => `"${s}"`;

function runCmd(project, script) {
  const py = path.join(ROOT, `_tmp_${crypto.randomBytes(3).toString('hex')}.py`);
  fs.writeFileSync(py, script);
  const r = spawnSync(CMD, [q(project), '-run=pythonscript', `-script=${q(py)}`, '-unattended', '-nosplash', '-nullrhi', '-stdout', '-FullStdOutLogOutput'], {
    argv0: q(CMD), windowsVerbatimArguments: true, shell: false, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 15 * 60_000,
  });
  if (r.error) log('  spawn error', String(r.error));
  fs.rmSync(py, { force: true });
  return { code: r.status, tail: (r.stdout ?? '').split('\n').filter((l) => /PROBE|LogPython: Error/.test(l)).slice(-6).join('\n') };
}

function provision(slotDir) {
  fs.rmSync(slotDir, { recursive: true, force: true });
  fs.mkdirSync(slotDir, { recursive: true });
  fs.copyFileSync(path.join(BASE, 'FleetProbe.uproject'), path.join(slotDir, 'FleetProbe.uproject'));
  // Same trap Night Crew has: a project ini that pins a fixed port. The -ini override must beat it.
  fs.mkdirSync(path.join(slotDir, 'Config'), { recursive: true });
  fs.writeFileSync(path.join(slotDir, 'Config/DefaultEditorPerProjectUserSettings.ini'), '[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]\nServerPortNumber=8999\nbAutoStartServer=False\n');
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(BASE, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { fs.mkdirSync(path.join(slotDir, r), { recursive: true }); walk(r); }
      else fs.linkSync(path.join(BASE, r), path.join(slotDir, r));
    }
  };
  fs.mkdirSync(path.join(slotDir, 'Content'), { recursive: true });
  walk('Content');
}

function launch(slotDir, port, modeArgs) {
  const logFile = path.join(slotDir, 'instance.log');
  const S = '[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]';
  const args = [
    q(path.join(slotDir, 'FleetProbe.uproject')),
    `-AbsLog=${q(logFile)}`, '-log', '-nosplash', '-unattended', '-nosound', '-NoLiveCoding', '-EnablePlugins=ModelContextProtocol,AllToolsets', ...modeArgs,
    `-ini:EditorPerProjectUserSettings:${S}:ServerPortNumber=${port},${S}:bAutoStartServer=True`,
  ];
  const p = spawn(EDITOR, args, { argv0: q(EDITOR), windowsVerbatimArguments: true, stdio: 'ignore', windowsHide: true });
  p.on('exit', (c) => log(`  editor :${port} exited code=${c}`));
  return p;
}

class Mcp {
  constructor(port) { this.url = `http://127.0.0.1:${port}/mcp`; this.id = 1; this.session = null; }
  async rpc(method, params) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: this.id++, method, params }), signal: AbortSignal.timeout(180_000) });
    this.session = res.headers.get('mcp-session-id') ?? this.session;
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return JSON.parse(line ? line.slice(5) : text);
  }
  init() { return this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '0' } }); }
  async call(toolset, tool, args = {}) {
    const r = await this.rpc('tools/call', { name: 'call_tool', arguments: { toolset_name: toolset, tool_name: tool, arguments: args } });
    return r.result ?? r.error;
  }
}

async function waitMcp(port, deadlineMs) {
  const m = new Mcp(port);
  while (Date.now() < deadlineMs) {
    try { await m.init(); return m; } catch { await sleep(2000); }
  }
  throw new Error(`MCP on :${port} never came up`);
}

const results = {};
const procs = [];
try {
  log('A. create a real asset in the base project');
  if (!fs.existsSync(path.join(BASE, ASSET))) {
    const r = runCmd(path.join(BASE, 'FleetProbe.uproject'), `
import unreal
tools = unreal.AssetToolsHelpers.get_asset_tools()
a = tools.create_asset('ST_Test', '/Game/Probe', unreal.StringTable, unreal.StringTableFactory())
unreal.EditorAssetLibrary.save_loaded_asset(a, only_if_is_dirty=False)
unreal.log('PROBE created')
`);
    log('  commandlet exit', r.code, r.tail);
  }
  results.baseAsset = fs.existsSync(path.join(BASE, ASSET));
  const baseHash = sha(path.join(BASE, ASSET));
  log('  base asset hash', baseHash);

  log('B. provision two slots with hardlinked Content');
  const a = path.join(SLOTS, 'slot a'), b = path.join(SLOTS, 'slot b');
  provision(a); provision(b);
  results.nlinkAfterProvision = fs.statSync(path.join(BASE, ASSET)).nlink;
  log('  nlink', results.nlinkAfterProvision, '(expect 3)');

  log('C. boot two editors at once (A=offscreen render, B=nullrhi)');
  const bootStart = Date.now();
  procs.push(launch(a, 8311, ['-RenderOffscreen', '-ResX=960', '-ResY=540']));
  procs.push(launch(b, 8312, ['-nullrhi']));
  const deadline = Date.now() + 15 * 60_000;
  const [ma, mb] = await Promise.all([waitMcp(8311, deadline), waitMcp(8312, deadline)]);
  results.bootSeconds = Math.round((Date.now() - bootStart) / 1000);
  log(`  both MCP endpoints up after ${results.bootSeconds}s`);

  log('D. PIE in both at the same time');
  const opts = { options: { bSimulate: false, playMode: 'PlayMode_InViewPort', warmupSeconds: 1 } };
  const [sa, sb] = await Promise.all([ma.call('EditorToolset.EditorAppToolset', 'StartPIE', opts), mb.call('EditorToolset.EditorAppToolset', 'StartPIE', opts)]);
  log('  StartPIE A', JSON.stringify(sa).slice(0, 200));
  log('  StartPIE B', JSON.stringify(sb).slice(0, 200));
  const [ra, rb] = await Promise.all([ma.call('EditorToolset.EditorAppToolset', 'IsPIERunning'), mb.call('EditorToolset.EditorAppToolset', 'IsPIERunning')]);
  results.pieA = JSON.stringify(ra).slice(0, 160); results.pieB = JSON.stringify(rb).slice(0, 160);
  log('  IsPIERunning A', results.pieA);
  log('  IsPIERunning B', results.pieB);

  const cap = await ma.call('EditorToolset.EditorAppToolset', 'CaptureViewport', {});
  const capText = cap?.content?.find?.((c) => c.type === 'text')?.text ?? '';
  const capImg = cap?.content?.find?.((c) => c.type === 'image')?.data ?? capText.match(/"data"\s*:\s*"([A-Za-z0-9+/=]{100,})"/)?.[1];
  if (capImg) { fs.writeFileSync(path.join(ROOT, 'capture-a.png'), Buffer.from(capImg, 'base64')); results.capture = 'saved'; }
  else results.capture = JSON.stringify(cap).slice(0, 240);
  log('  offscreen viewport capture:', results.capture);

  await Promise.all([ma.call('EditorToolset.EditorAppToolset', 'StopPIE'), mb.call('EditorToolset.EditorAppToolset', 'StopPIE')]);

  log('E. stop only the editors this script started');
  for (const p of procs) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(3000);

  log('F. save the asset from slot A through the real UE save path');
  const r = runCmd(path.join(a, 'FleetProbe.uproject'), `
import unreal
st = unreal.EditorAssetLibrary.load_asset('/Game/Probe/ST_Test')
st.modify()
unreal.StringTableLibrary  # keep the import honest
unreal.EditorAssetLibrary.set_metadata_tag(st, 'probe', 'changed-in-slot-a')
unreal.EditorAssetLibrary.save_loaded_asset(st, only_if_is_dirty=False)
unreal.log('PROBE saved')
`);
  log('  commandlet exit', r.code, r.tail);
  results.afterSave = {
    baseUnchanged: sha(path.join(BASE, ASSET)) === baseHash,
    slotBUnchanged: sha(path.join(b, ASSET)) === baseHash,
    slotAChanged: sha(path.join(a, ASSET)) !== baseHash,
    slotANlink: fs.statSync(path.join(a, ASSET)).nlink,
    baseNlink: fs.statSync(path.join(BASE, ASSET)).nlink,
  };
  log('  ', JSON.stringify(results.afterSave));
} catch (e) {
  results.error = String(e?.stack ?? e);
  log('FAILED', results.error);
} finally {
  for (const p of procs) if (p.exitCode === null) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(ROOT, 'results.json'), JSON.stringify(results, null, 2));
  console.log('RESULTS', JSON.stringify(results, null, 2));
}
