// The real Claude Code CLI and real Unreal editors, with only the model swapped for a local
// scripted API. Proves everything except the model's judgement, for free and with no login.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Behave like a normal launch, then point the CLI at the scripted API before anything loads.
for (const k of Object.keys(process.env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_') || k.startsWith('ANTHROPIC_')) delete process.env[k];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cli-'));
process.env.CLAUDE_CONFIG_DIR = path.join(dataDir, 'claude-config');
process.env.ANTHROPIC_API_KEY = 'scripted';

const { Hub } = await import('../src/hub/hub');
const { encodePairCode, decodePairCode } = await import('../src/shared/pair');
type Item = any;

const ROOT = process.env.FLEET_ROOT!;
const PROJECT = path.join(ROOT, 'probe', 'FleetProbe', 'FleetProbe.uproject');
const shots = path.join(ROOT, 'test', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const TOOLSET = 'EditorToolset.EditorAppToolset';

type Step = { text?: string; tool?: { name: string; input: any } };
const fin = (summary: string, verified: string[], needs: any[] = []): Step => ({ tool: { name: 'mcp__fleet__finish_task', input: { summary, verified, needs_human_testing: needs } } });
const ue = (tool_name: string, args: any = {}): Step => ({ tool: { name: 'mcp__fleet__ue_call', input: { toolset_name: TOOLSET, tool_name, arguments: args } } });
const pie = (warm: number) => ue('StartPIE', { options: { bSimulate: false, playMode: 'PlayMode_InViewPort', warmupSeconds: warm } });

const SCRIPTS: Record<string, Step[]> = {
  'pie-a': [
    { text: 'Starting Play In Editor.', ...pie(20) }, ue('IsPIERunning'), ue('StopPIE'),
    { tool: { name: 'Write', input: { file_path: 'Config/DefaultGame.ini', content: '; edited by agent A\n' } } },
    fin('Changed the config.', ['PIE ran in my own editor']),
    { text: 'Done.' },
  ],
  'pie-b': [
    pie(20), ue('IsPIERunning'),
    { tool: { name: 'mcp__fleet__ue_list_toolsets', input: {} } },
    ue('CaptureViewport', { captureTransform: { location: { x: -400, y: 0, z: 250 }, rotation: { pitch: -25, yaw: 0, roll: 0 }, scale: { x: 1, y: 1, z: 1 } }, annotations: { gridSpacing: 0, gridExtent: 0, gridHeight: 0, maxLabelDistance: 0, classFilter: { refPath: '/Script/Engine.Actor' }, maxLabels: 0 }, bShowUI: false }),
    ue('StopPIE'),
    { tool: { name: 'mcp__fleet__ue_log', input: { lines: 5, grep: 'PIE' } } },
    { tool: { name: 'mcp__fleet__ue_status', input: {} } },
    fin('Checked the viewport.', ['Captured an offscreen viewport image']),
    { text: 'Done.' },
  ],
  perm: [{ tool: { name: 'Bash', input: { command: `node -e "console.log('fleet-permission-check')"` } } }, fin('Ran it.', ['Saw the output']), { text: 'Done.' }],
  deny: [{ tool: { name: 'Bash', input: { command: `node -e "console.log('should-not-run')"` } } }, { text: 'Understood, you said no. What should I do instead?' }],
  question: [
    { tool: { name: 'AskUserQuestion', input: { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Crimson', description: 'Red' }, { label: 'Teal', description: 'Blue-green' }] }] } } },
    fin('$LAST_RESULT', ['Asked the user']),
    { text: 'Done.' },
  ],
  testing: [fin('Tuned the jump.', ['Read the code'], [{ what: 'Try the jump', why: 'Feel is a human call' }]), { text: 'Done.' }],
  reply: [{ text: 'Two possible causes. Which do you want fixed?' }],
  followup: [fin('Followed up: $HAS_HISTORY', ['Remembered the conversation']), { text: 'Done.' }],
  remote: [
    ue('IsPIERunning'),
    { tool: { name: 'Write', input: { file_path: 'Source/Remote/FromHost.cpp', content: '// from the host\n' } } },
    fin('Changed a file on the host.', ['Checked the editor there']),
    { text: 'Done.' },
  ],
  crash: [ue('IsPIERunning'), { tool: { name: 'mcp__fleet__ue_status', input: {} } }, fin('Recovered after a crash.', ['Editor came back']), { text: 'Done.' }],
};

// ---- The scripted API ----

const seen: { marker: string; messages: any[]; tools: string[] }[] = [];
const systemSeen = new Map<string, unknown>();
function lastResultText(messages: any[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content;
    if (!Array.isArray(c)) continue;
    const r = c.find((b: any) => b.type === 'tool_result');
    if (r) return typeof r.content === 'string' ? r.content : (r.content ?? []).map((x: any) => x.text ?? '').join(' ');
  }
  return '';
}

const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (!req.url?.includes('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url?.includes('count_tokens') ? '{"input_tokens":100}' : '{}');
      return;
    }
    const json = JSON.parse(body);
    const messages: any[] = json.messages ?? [];
    const hasTools = (json.tools ?? []).length > 0;
    // Find the latest scripted instruction and count what happened after it.
    let marker = '';
    let from = 0;
    messages.forEach((m, i) => {
      const hit = JSON.stringify(m.content).match(/\[script:([a-z-]+)\]/);
      if (m.role === 'user' && hit) { marker = hit[1]; from = i; }
    });
    let step = 0;
    for (const m of messages.slice(from + 1)) if (m.role === 'assistant') step++;
    if (hasTools && marker) {
      seen.push({ marker, messages, tools: json.tools.map((t: any) => t.name) });
      systemSeen.set(marker, json.system);
    }
    const script = hasTools ? SCRIPTS[marker] : undefined;
    let s: Step = script?.[step] ?? { text: 'ok' };
    if (s.tool?.input?.summary?.includes('$')) {
      const history = JSON.stringify(messages);
      s = { tool: { ...s.tool, input: { ...s.tool.input, summary: s.tool.input.summary.replace('$LAST_RESULT', lastResultText(messages)).replace('$HAS_HISTORY', String(history.includes('[script:question]'))) } } };
    }
    const id = `msg_${crypto.randomBytes(6).toString('hex')}`;
    const sse = (type: string, data: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse('message_start', { message: { id, type: 'message', role: 'assistant', model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 } } });
    let idx = 0;
    if (s.text) {
      sse('content_block_start', { index: idx, content_block: { type: 'text', text: '' } });
      for (const w of s.text.split(/(?<= )/)) sse('content_block_delta', { index: idx, delta: { type: 'text_delta', text: w } });
      sse('content_block_stop', { index: idx });
      idx++;
    }
    if (s.tool) {
      sse('content_block_start', { index: idx, content_block: { type: 'tool_use', id: `toolu_${crypto.randomBytes(6).toString('hex')}`, name: s.tool.name, input: {} } });
      sse('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(s.tool.input) } });
      sse('content_block_stop', { index: idx });
    }
    sse('message_delta', { delta: { stop_reason: s.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } });
    sse('message_stop', {});
    res.end();
  });
});
await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(api.address() as any).port}`;

// ---- The test ----

const hub = new Hub({ dataDir, version: 'test', demo: false, hostAppPath: null });
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const card = (id: string): any => hub.snapshot().cards.find((c: any) => c.id === id);
const sha = (f: string) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 10);
const task = (script: string, extra: any = {}) => ({ prompt: `Run the script [script:${script}]`, projectFile: null, nodeId: 'master', model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'acceptEdits', instanceMode: 'offscreen', ...extra });
const tools = (id: string): Item[] => hub.transcript(id).filter((t: Item) => t.kind === 'tool');

const results: string[] = [];
const check = (name: string, ok: boolean, info?: unknown) => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  log(ok ? 'ok  ' : 'FAIL', name, ok || info === undefined ? '' : JSON.stringify(info).slice(0, 500));
};
async function waitFor(id: string, fn: (c: any) => boolean, what: string, ms = 8 * 60_000) {
  const end = Date.now() + ms;
  let last = '';
  while (Date.now() < end) {
    const c = card(id);
    if (fn(c)) return c;
    const now = `${c.status}${c.slot ? ` / ${c.slot.state}` : ''}${c.detail ? ` / ${c.detail}` : ''}`;
    if (now !== last) { log(`  ${String(c.index).padStart(2, '0')} ${now}`); last = now; }
    await sleep(100);
  }
  for (const t of hub.transcript(id) as Item[]) log('    ', t.kind, t.name ?? '', String(t.text ?? t.result ?? '').slice(0, 300).replace(/\s+/g, ' '));
  throw new Error(`Timed out waiting for ${what}`);
}
const settled = (c: any) => c.status === 'finished' || !!c.attention;

const watch = { both: false, states: new Set<string>() };
const watcher = setInterval(() => {
  const slots = hub.machines()[0].slots;
  for (const s of slots) watch.states.add(`${s.id}:${s.state}`);
  if (slots.filter((s: any) => s.state === 'pie').length >= 2) watch.both = true;
}, 100);

try {
  await hub.start();
  const info = hub.machines()[0].info;
  log('Using', info.claudePath);
  const assetSrc = path.join(path.dirname(PROJECT), 'Content/Probe/ST_Test.uasset');
  const assetHash = sha(assetSrc);
  const iniSrc = path.join(path.dirname(PROJECT), 'Config/DefaultGame.ini');
  fs.rmSync(iniSrc, { force: true });

  // The real project's memory has to follow the agent into its copy.
  const memKey = path.resolve(path.dirname(PROJECT)).replace(/[^A-Za-z0-9]/g, '-');
  const memDir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', memKey, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- [Probe note](probe.md) — fleet-memory-marker-7731\n');
  fs.writeFileSync(path.join(memDir, 'probe.md'), 'fleet-memory-marker-7731\n');

  log('Two real CLI agents drive two real editors at once');
  const a = await hub.createAgent(task('pie-a', { projectFile: PROJECT }));
  const b = await hub.createAgent(task('pie-b', { projectFile: PROJECT }));
  const [ca, cb] = await Promise.all([waitFor(a, settled, 'agent A'), waitFor(b, settled, 'agent B')]);
  check('agent A finished through finish_task', ca.status === 'finished' && !!ca.final, ca.attention);
  check('agent B finished through finish_task', cb.status === 'finished' && !!cb.final, cb.attention);
  check('both editors were in PIE at the same moment', watch.both, [...watch.states]);
  check('each agent got its own copy and its own port', ca.slot.dir !== cb.slot.dir && ca.slot.port !== cb.slot.port, [ca.slot, cb.slot]);
  const isPie = tools(a).find((t) => JSON.stringify(t.input).includes('IsPIERunning'));
  check('the CLI reached the editor and got a real answer', !!isPie?.result?.includes('true'), isPie);
  for (let i = 0; i < 100 && hub.local.slots.editors.inUse > 0; i++) await sleep(100);
  check('finishing stops the editor and frees its place', hub.local.slots.editors.inUse === 0, hub.local.slots.editors.inUse);
  check('verified tasks raised no popup', ca.attention === null && cb.attention === null);
  check('nothing was added to the test list', hub.testList().length === 0, hub.testList());
  check('tokens and context are tracked', ca.tokens > 1000 && ca.usage.context > 0, [ca.tokens, ca.usage]);
  check('time in each activity is tracked', ca.buckets.testing > 0 && ca.buckets.coding >= 0, ca.buckets);

  const capture = tools(b).find((t) => JSON.stringify(t.input).includes('CaptureViewport'));
  check('the viewport capture reached the UI as an image', !!capture?.images?.length, capture?.result?.slice(0, 300));
  if (capture?.images?.[0]) {
    const png = Buffer.from(capture.images[0].split(',')[1], 'base64');
    fs.writeFileSync(path.join(shots, 'real-offscreen-capture.jpg'), png);
    check('it is a real image with content', png.length > 2000 && ((png[0] === 0xff && png[1] === 0xd8) || png[1] === 0x50), png.length);
    const sent = seen.filter((s) => s.marker === 'pie-b').at(-1)!;
    const blob = JSON.stringify(sent.messages);
    check('the model receives it as an image block, not base64 text', blob.includes('"type":"image"') && !/"data\\":\\"[A-Za-z0-9+/]{2000}/.test(blob));
  }
  const tl = seen.find((s) => s.marker === 'pie-a')!.tools;
  check('agents get the fleet tools', tl.includes('mcp__fleet__ue_call') && tl.includes('mcp__fleet__finish_task'), tl.slice(0, 40));
  check('agents cannot see any other Unreal MCP server', !tl.some((t) => t.startsWith('mcp__') && !t.startsWith('mcp__fleet__')), tl.filter((t) => t.startsWith('mcp__')));
  const sys = JSON.stringify(systemSeen.get('pie-a') ?? '');
  check('the instance instructions reach the agent', sys.includes('Your Unreal instance'), sys.slice(0, 200));
  check('project notes are told who wins over a shared-editor habit', sys.includes('reaches the user') && sys.includes('fixed port'));
  check('the real project memory reaches an agent in a copy', JSON.stringify(seen.find((s) => s.marker === 'pie-a')!.messages).includes('fleet-memory-marker-7731') || sys.includes('fleet-memory-marker-7731'));

  log('Changes stay in the copy until applied');
  check('the agent did not touch the real project', !fs.existsSync(iniSrc));
  check('the source asset is byte-identical', sha(assetSrc) === assetHash);
  const changes = await hub.changes(a);
  check('the edit shows up as a change', changes.some((c: any) => c.path.replaceAll('\\', '/') === 'Config/DefaultGame.ini'), changes);
  const applied = await hub.apply(a);
  check('apply succeeds', applied.conflicts.length === 0 && applied.applied.length >= 1, applied);
  check('the real project now has the edit', fs.existsSync(iniSrc) && fs.readFileSync(iniSrc, 'utf8').includes('edited by agent A'));
  fs.rmSync(iniSrc, { force: true });

  log('Editor crash recovery');
  const rc = await hub.createAgent(task('crash', { projectFile: PROJECT, permissionMode: 'default' }));
  await waitFor(rc, settled, 'the crash agent');
  const slot = hub.local.slots.get(rc)!;
  // Right after finishing, the editor is on its way down. Asking for it must give a fresh one.
  await slot.ensureEditor();
  check('asking during shutdown gives a live editor', slot.isRunning && slot.state === 'ready', slot.state);
  const pid = slot.pid!;

  log('What the instance is launched with');
  const editorLog = await slot.tail(5000);
  const cmdline = editorLog.split('\n').find((l) => l.includes('commandline=')) ?? '';
  check('audio is left on', !/-nosound/i.test(cmdline) && !/audio.*disabled/i.test(editorLog.split('\n').slice(0, 400).join('\n')), cmdline.slice(0, 400));
  check('it has a working audio device', /LogAudioMixer.*(Using|Display: Audio Device|Initializing audio mixer)/i.test(editorLog) || /AudioMixerPlatform/i.test(editorLog), editorLog.split('\n').filter((l) => /audio/i.test(l)).slice(0, 6));
  check('background throttling is forced off', /bThrottleCPUWhenNotForeground=False/.test(cmdline), cmdline.slice(-300));
  const windowHandle = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).MainWindowHandle`], { encoding: 'utf8' }).trim();
  check('an offscreen editor has no window to steal focus', windowHandle === '0', windowHandle);

  process.kill(pid);
  await sleep(1500);
  check('a killed editor is seen as crashed', slot.state === 'crashed', slot.state);
  check('and gives its place back', hub.local.slots.editors.inUse === 0, hub.local.slots.editors.inUse);
  await slot.ensureEditor();
  check('the next use boots a new editor', slot.isRunning && slot.pid !== pid && slot.state === 'ready', slot.state);
  await slot.stopEditor();

  log('Permission prompts');
  const p = await hub.createAgent(task('perm', { permissionMode: 'default' }));
  const atP = await waitFor(p, (c) => c.attention?.kind === 'permission', 'the prompt', 90_000);
  check('the prompt carries the command', JSON.stringify(hub.transcript(p).find((t: Item) => t.kind === 'permission')).includes('fleet-permission-check'));
  await hub.decide(p, atP.attention.ref, 'allow');
  const doneP = await waitFor(p, (c) => c.status === 'finished', 'after allow', 90_000);
  check('the approved command ran', !!tools(p).find((t) => t.name === 'Bash')?.result?.includes('fleet-permission-check'));
  check('and it finished quietly', doneP.attention === null, doneP.attention);

  const d = await hub.createAgent(task('deny', { permissionMode: 'default' }));
  const atD = await waitFor(d, (c) => c.attention?.kind === 'permission', 'the prompt', 90_000);
  await hub.decide(d, atD.attention.ref, 'deny');
  const doneD = await waitFor(d, (c) => c.attention?.kind === 'reply', 'after deny', 90_000);
  const bash = tools(d).find((t) => t.name === 'Bash');
  check('a denied command does not run', !bash?.result?.includes('should-not-run') || bash?.state === 'error', bash);
  check('and the agent says what it wants next', doneD.lastText.includes('What should I do'), doneD.lastText);

  log('Questions');
  const q = await hub.createAgent(task('question'));
  const atQ = await waitFor(q, (c) => c.attention?.kind === 'question', 'the question', 90_000);
  const qItem = hub.transcript(q).find((t: Item) => t.kind === 'question') as Item;
  check('the options reach the UI', qItem.questions[0].options.length === 2);
  await hub.answer(q, atQ.attention.ref, { 'Which color?': 'Teal' });
  const doneQ = await waitFor(q, (c) => c.status === 'finished', 'after the answer', 90_000);
  check('the CLI gave the agent the real answer', /Teal/.test(doneQ.final?.summary ?? ''), doneQ.final);

  log('Final messages');
  const h = await hub.createAgent(task('testing'));
  const doneH = await waitFor(h, (c) => c.status === 'finished', 'the testing agent', 90_000);
  check('needs-testing shows a final message and popup', doneH.attention?.kind === 'testing' && hub.transcript(h).some((t: Item) => t.kind === 'final'), doneH.attention);
  check('and lands on the test list', hub.testList().some((t: any) => t.agentId === h));

  const r = await hub.createAgent(task('reply'));
  const doneR = await waitFor(r, (c) => c.attention?.kind === 'reply', 'the reply', 90_000);
  check('stopping to ask is "waiting on you", not finished', doneR.status === 'attention' && !doneR.final);

  log('Follow-ups');
  await hub.send(q, 'Now do this [script:followup]');
  const again = await waitFor(q, (c) => c.final?.summary?.startsWith('Followed up'), 'the follow-up', 90_000);
  check('a follow-up continues the same conversation', again.final.summary.includes('true'), again.final);
  await hub.stopAgent(q);
  await hub.send(q, 'Again after a stop [script:followup]');
  const resumed = await waitFor(q, (c) => c.status === 'finished' && !!c.final, 'the resume', 90_000);
  check('a stopped agent resumes its session from disk', resumed.final.summary.includes('true'), resumed.final);

  log('A real host process: project sent over, real CLI and real editor there, changes back');
  // Same PC, so the master's own editors have to be down for the ports to be free.
  for (const c of hub.snapshot().cards) if (hub.local.slots.get(c.id)) await hub.local.slots.get(c.id)!.stopEditor();
  const pairing = hub.snapshot().pairing!;
  const pairCode = encodePairCode({ ...decodePairCode(pairing.code), a: ['127.0.0.1'] });
  const hostLogBox = { text: '' };
  const hostProc = spawn(process.execPath, [path.join(ROOT, 'dist', 'host', 'fleet-host.cjs'), '--pair', pairCode], { env: { ...process.env, FLEET_HOST_DATA: path.join(dataDir, 'host') }, stdio: ['ignore', 'pipe', 'pipe'] });
  hostProc.stdout!.on('data', (d) => { hostLogBox.text += d; });
  hostProc.stderr!.on('data', (d) => { hostLogBox.text += d; });
  try {
    let remote: any;
    for (let i = 0; i < 200 && !remote; i++) { remote = hub.machines().find((m: any) => m.info.role === 'remote' && m.online); await sleep(100); }
    check('the host linked', !!remote, hostLogBox.text);
    const rem = await hub.createAgent(task('remote', { projectFile: PROJECT, nodeId: remote.info.id }));
    const doneRem = await waitFor(rem, settled, 'the remote agent', 5 * 60_000);
    check('the remote agent finished', doneRem.status === 'finished' && !!doneRem.final, doneRem.attention);
    const isPieRem = tools(rem).find((t) => JSON.stringify(t.input).includes('IsPIERunning'));
    check('it drove an editor on the host', !!isPieRem?.result?.includes('false'), isPieRem);
    check('its copy lives on the host', doneRem.slot.dir.includes(path.join(dataDir, 'host')), doneRem.slot.dir);
    check('with the project the master sent', fs.existsSync(path.join(dataDir, 'host', 'projects', 'FleetProbe', 'FleetProbe.uproject')));

    const remChanges = await hub.changes(rem);
    check('the master can see its changes', remChanges.some((c: any) => c.path.replaceAll('\\', '/') === 'Source/Remote/FromHost.cpp'), remChanges);
    const appliedRem = await hub.apply(rem);
    const landed = path.join(path.dirname(PROJECT), 'Source/Remote/FromHost.cpp');
    check('apply brings them back to the master', appliedRem.conflicts.length === 0 && fs.existsSync(landed) && fs.readFileSync(landed, 'utf8').includes('from the host'), appliedRem);
    fs.rmSync(path.join(path.dirname(PROJECT), 'Source'), { recursive: true, force: true });
  } finally {
    hostProc.kill();
  }

  log('Broadcast');
  const bid = hub.broadcast('Listen up [script:reply]', [r, h]);
  await sleep(100);
  const replied = await (async () => {
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      const br = hub.snapshot().broadcasts.find((x: any) => x.id === bid)!;
      if (br.replies[r] && br.replies[h]) return br;
      await sleep(100);
    }
    return null;
  })();
  check('every target replies into the broadcast', !!replied, hub.snapshot().broadcasts);
  check('replying to a broadcast raises no popup', card(r).attention === null, card(r).attention);
} catch (e: any) {
  results.push(`FAIL ${e.message}`);
  log('FAIL', e.stack ?? e);
} finally {
  clearInterval(watcher);
  await hub.shutdown();
  api.close();
  const failed = results.filter((x) => x.startsWith('FAIL'));
  console.log(`\n${results.join('\n')}\n\n${results.length - failed.length}/${results.length} passed`);
  assert.ok(results.length);
  setTimeout(() => process.exit(failed.length ? 1 : 0), 500);
}
