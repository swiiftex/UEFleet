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
const { forgetCopiesFromRecents } = await import('../src/node/machine');
type Item = any;

const ROOT = process.env.FLEET_ROOT!;
// Editors now work in the project itself, so they get a throwaway one. The second has a name no
// editor here has opened, so a host on this PC won't find it and has to be sent it.
const probeCopy = (name: string) => {
  const dir = path.join(dataDir, name);
  fs.cpSync(path.join(ROOT, 'probe', 'FleetProbe'), dir, { recursive: true });
  fs.renameSync(path.join(dir, 'FleetProbe.uproject'), path.join(dir, `${name}.uproject`));
  return path.join(dir, `${name}.uproject`);
};
const PROJECT = probeCopy('FleetProbe');
const SENT_PROJECT = probeCopy('FleetSent');
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
  testing: [fin('Tuned the jump.', ['Read the code'], [{ what: 'Try the jump', how: 'Press Play and jump', expect: 'It lands softly', why: 'Feel is a human call' }]), { text: 'Done.' }],
  'master-route': [{ tool: { name: 'mcp__fleet__start_task', input: { prompt: 'From the master [script:testing]', title: 'Routed by the master' } } }, { text: 'Started it.' }],
  'master-answer': [{ tool: { name: 'mcp__fleet__answer_agent', input: { request_id: '$REQUEST_ID', answer: 'the ticket says blue' } } }, { text: 'Answered.' }],
  asks: [{ tool: { name: 'mcp__fleet__ask_master', input: { question: 'What does NIGH-1 say? [script:master-answer]' } } }, fin('$LAST_RESULT', ['Asked the master']), { text: 'Done.' }],
  'master-switch': [{ tool: { name: 'mcp__fleet__set_agent_options', input: { agents: ['$AGENT'], model: 'claude-opus-5-5', effort: 'xhigh', permission_mode: 'acceptEdits' } } }, { text: 'Switched.' }],
  'after-switch': [{ tool: { name: 'Write', input: { file_path: 'switched.txt', content: 'written with no prompt\n' } } }, fin('Wrote it.', ['Checked the file']), { text: 'Done.' }],
  'master-remember': [{ tool: { name: 'mcp__fleet__remember', input: { text: 'Always say fleet-memory-note-4417' } } }, { text: 'Noted.' }],
  'master-recall': [{ text: 'Still here.' }],
  'master-mode': [{ tool: { name: 'mcp__fleet__set_own_permissions', input: { mode: 'auto' } } }, { text: 'Switched myself.' }],
  'limit-hit': [fin('Carried on.', ['Checked it']), { text: 'Done.' }],
  'limit-billing': [{ text: 'Never reached.' }],
  'master-workspace': [{ tool: { name: 'mcp__fleet__open_workspace_chat', input: { prompt: 'Merge main into dev [script:workspace]' } } }, { text: 'Opened.' }],
  workspace: [{ tool: { name: 'mcp__fleet__hold_workspace', input: {} } }, { tool: { name: 'mcp__fleet__release_workspace', input: { summary: 'merged main into dev' } } }, { text: 'Merged it.' }],
  'master-clear': [{ tool: { name: 'mcp__fleet__stop_agents', input: { agents: ['$AGENT'] } } }, { tool: { name: 'mcp__fleet__archive_agents', input: { agents: ['$AGENT'] } } }, { text: 'Cleared.' }],
  reply: [{ text: 'Two possible causes. Which do you want fixed?' }],
  followup: [fin('Followed up: $HAS_HISTORY', ['Remembered the conversation']), { text: 'Done.' }],
  remote: [
    ue('IsPIERunning'),
    { tool: { name: 'Write', input: { file_path: 'Source/Remote/FromHost.cpp', content: '// from the host\n' } } },
    fin('Changed a file on the host.', ['Checked the editor there']),
    { text: 'Done.' },
  ],
  crash: [{ tool: { name: 'mcp__fleet__report_progress', input: { percent: 40 } } }, ue('IsPIERunning'), { tool: { name: 'mcp__fleet__ue_status', input: {} } }, fin('Recovered after a crash.', ['Editor came back']), { text: 'Done.' }],
};

// ---- The scripted API ----

const seen: { marker: string; messages: any[]; tools: string[]; model: string; effort?: string; apiKey?: string }[] = [];
let switchedAgent = 0;
const systemSeen = new Map<string, unknown>();
const sysFor = (marker: string) => JSON.stringify(systemSeen.get(marker) ?? '');
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
    // Find the latest scripted instruction and count what happened after it. Only in what was said,
    // and the last one said, because tool results and agents' titles quote other agents' prompts.
    let marker = '';
    let from = 0;
    messages.forEach((m, i) => {
      const said = typeof m.content === 'string' ? m.content : m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      const hit = [...said.matchAll(/\[script:([a-z-]+)\]/g)].at(-1);
      if (m.role === 'user' && hit) { marker = hit[1]; from = i; }
    });
    let step = 0;
    for (const m of messages.slice(from + 1)) if (m.role === 'assistant') step++;
    if (hasTools && marker) {
      seen.push({ marker, messages, tools: json.tools.map((t: any) => t.name), model: json.model, effort: json.output_config?.effort, apiKey: req.headers['x-api-key'] as string | undefined });
      systemSeen.set(marker, json.system);
    }
    // The subscription's limit is reached, and what happens next depends on what's signed in.
    const apiKey = req.headers['x-api-key'];
    if (hasTools && marker.startsWith('limit-') && !apiKey) {
      res.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600), 'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-overage-status': 'rejected', 'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: "This request would exceed your account's rate limit." } }));
      return;
    }
    if (hasTools && marker === 'limit-billing' && apiKey) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }));
      return;
    }
    const script = hasTools ? SCRIPTS[marker] : undefined;
    let s: Step = script?.[step] ?? { text: 'ok' };
    if (s.tool?.input?.summary?.includes('$')) {
      const history = JSON.stringify(messages);
      s = { tool: { ...s.tool, input: { ...s.tool.input, summary: s.tool.input.summary.replace('$LAST_RESULT', lastResultText(messages)).replace('$HAS_HISTORY', String(history.includes('[script:question]'))) } } };
    }
    if (s.tool?.input?.agents?.[0] === '$AGENT') s = { tool: { ...s.tool, input: { ...s.tool.input, agents: [switchedAgent] } } };
    if (s.tool?.input?.request_id === '$REQUEST_ID') {
      const asked = [...JSON.stringify(messages).matchAll(/request_id: ([^\\\s"]+)/g)].at(-1)?.[1];
      s = { tool: { ...s.tool, input: { ...s.tool.input, request_id: asked } } };
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
  check('both worked in the project folder, each with its own port and own folder', ca.slot.dir === path.dirname(PROJECT) && cb.slot.dir === ca.slot.dir && ca.slot.shared && ca.slot.port !== cb.slot.port && ca.slot.own !== cb.slot.own, [ca.slot, cb.slot]);
  // An editor starts the build tool to check platforms, and the build tool keeps these two for anyone.
  const inProject = (f: string) => { try { return fs.readdirSync(path.join(path.dirname(PROJECT), f)); } catch { return []; } };
  check('and left nothing of theirs in it', !fs.existsSync(path.join(path.dirname(PROJECT), '.fleet')) && inProject('Saved').every((f) => f === 'UnrealBuildTool') && inProject('Intermediate').every((f) => f === 'Build'), [inProject('Saved'), inProject('Intermediate')]);
  check('their editors wrote to their own folders', fs.existsSync(path.join(ca.slot.own, 'Saved')) && fs.existsSync(path.join(cb.slot.own, 'Saved')));
  const isPie = tools(a).find((t) => JSON.stringify(t.input).includes('IsPIERunning'));
  check('the CLI reached the editor and got a real answer', !!isPie?.result?.includes('true'), isPie);
  for (let i = 0; i < 100 && hub.local!.slots.editors.inUse > 0; i++) await sleep(100);
  check('finishing stops the editor and frees its place', hub.local!.slots.editors.inUse === 0, hub.local!.slots.editors.inUse);
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
  check('agents get the fleet tools', tl.includes('mcp__fleet__ue_call') && tl.includes('mcp__fleet__finish_task') && tl.includes('mcp__fleet__report_progress') && tl.includes('mcp__fleet__check_packages') && tl.includes('mcp__fleet__report_blocked'), tl.slice(0, 40));
  check('and are told to report progress', sysFor('pie-a').includes('Call report_progress'));
  check('agents cannot see any other Unreal MCP server', !tl.some((t) => t.startsWith('mcp__') && !t.startsWith('mcp__fleet__')), tl.filter((t) => t.startsWith('mcp__')));
  const sys = JSON.stringify(systemSeen.get('pie-a') ?? '');
  check('the instance instructions reach the agent', sys.includes('Your Unreal instance'), sys.slice(0, 200));
  check('project notes are told who wins over a shared-editor habit', sys.includes('reaches the user') && sys.includes('fixed port'));
  check('the real project memory reaches the agent', JSON.stringify(seen.find((s) => s.marker === 'pie-a')!.messages).includes('fleet-memory-marker-7731') || sys.includes('fleet-memory-marker-7731'));
  check('it is told it shares the folder', sys.includes('Never run anything that reverts') && sys.includes(JSON.stringify(path.dirname(PROJECT)).slice(1, -1)), sys.slice(0, 600));

  log('Changes land in the project straight away');
  check('the edit is already in the project', fs.existsSync(iniSrc) && fs.readFileSync(iniSrc, 'utf8').includes('edited by agent A'));
  check('the source asset is byte-identical', sha(assetSrc) === assetHash);
  const changes = await hub.changes(a);
  check('the edit shows up as a change', changes.some((c: any) => c.path.replaceAll('\\', '/') === 'Config/DefaultGame.ini'), changes);
  const applied = await hub.apply(a);
  check('and there is nothing to apply', applied.applied.length === 0 && applied.conflicts.length === 0, applied);
  check('B can see A in the folder', tools(b).some((t) => t.name === 'mcp__fleet__ue_status' && t.result?.includes('otherAgentsHere')), tools(b).find((t) => t.name === 'mcp__fleet__ue_status'));
  check('only the agent that changed a file has it on its list', !(await hub.changes(b)).some((c: any) => c.path.replaceAll('\\', '/') === 'Config/DefaultGame.ini'));
  await waitFor(a, (c) => c.stage === 'complete', 'A to complete', 60_000);
  check('having checked its own work, A went through to complete by itself', card(a).merge?.files >= 1 && !card(a).attention, card(a).merge);
  fs.rmSync(iniSrc, { force: true });

  log('Editor crash recovery');
  const rc = await hub.createAgent(task('crash', { projectFile: PROJECT, permissionMode: 'default' }));
  const doneRc = await waitFor(rc, settled, 'the crash agent');
  check('an agent reports progress through the real CLI, with no prompt, even in the strictest mode', doneRc.progress === 40 && doneRc.status === 'finished', [doneRc.progress, doneRc.status, doneRc.attention]);
  const slot = hub.local!.slots.get(rc)!;
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
  // A large process takes a while to go when the machine is busy.
  for (let i = 0; i < 300 && slot.state !== 'crashed'; i++) await sleep(100);
  check('a killed editor is seen as crashed', slot.state === 'crashed', slot.state);
  check('and gives its place back', hub.local!.slots.editors.inUse === 0, hub.local!.slots.editors.inUse);
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

  log('The master chat');
  const beforeRoute = hub.snapshot().cards.length;
  await hub.request(task('master-route'));
  const end = Date.now() + 90_000;
  while (hub.snapshot().cards.length === beforeRoute && Date.now() < end) await sleep(100);
  const routed = hub.snapshot().cards.at(-1) as any;
  check('a request reaches the master through the real CLI, and it starts the agent', routed?.title === 'Routed by the master', routed);
  const doneRouted = await waitFor(routed.id, (c) => c.status === 'finished', 'the routed agent', 90_000);
  check('that agent got the brief and paused for testing', doneRouted.stage === 'testing' && doneRouted.attention?.kind === 'testing', doneRouted);
  check('with instructions for the checklist', hub.testList().some((t: any) => t.agentId === routed.id && t.test.how === 'Press Play and jump' && t.test.expect === 'It lands softly'));
  check('and the master chat says what it did', hub.transcript('master-chat').some((t: Item) => t.kind === 'assistant' && t.text.includes('Started it')));
  await hub.approve(routed.id);
  check('Approve takes it through to complete', card(routed.id).stage === 'complete', card(routed.id).stage);

  const asker = await hub.createAgent(task('asks'));
  const doneAsk = await waitFor(asker, (c) => c.status === 'finished', 'the agent that asked', 90_000);
  check('an agent gets an answer from the master through the real tools', /the ticket says blue/.test(doneAsk.final?.summary ?? ''), doneAsk.final);
  check('and the master saw who was asking', hub.transcript('master-chat').some((t: Item) => t.kind === 'user' && t.text.startsWith('[Question from agent') && t.text.includes('NIGH-1')));

  // The strictest mode would stop at the Write, so getting past it shows permissions really changed.
  const sw = await hub.createAgent(task('reply', { model: 'claude-sonnet-5-5', effort: 'low', permissionMode: 'default' }));
  await waitFor(sw, (c) => c.attention?.kind === 'reply', 'the agent to switch', 90_000);
  switchedAgent = card(sw).index;
  await hub.send('master-chat', 'Put it on xhigh [script:master-switch]');
  await waitFor(sw, (c) => c.effort === 'xhigh', 'the master to switch it', 90_000);
  await hub.send(sw, 'Carry on [script:after-switch]');
  const doneSw = await waitFor(sw, (c) => c.status === 'finished' || c.attention?.kind === 'permission', 'it to carry on', 90_000);
  const switched = seen.filter((s) => s.marker === 'after-switch').at(-1)!;
  check('the master changes a running agent, and its next call uses the new model', switched?.model === 'claude-opus-5-5', switched?.model);
  check('and the new effort', switched?.effort === 'xhigh', switched?.effort);
  check('and the new permissions, with no prompt', doneSw.status === 'finished' && !hub.transcript(sw).some((t: Item) => t.kind === 'permission'), doneSw.attention);
  check('the master tool said so', tools('master-chat').some((t) => t.name === 'mcp__fleet__set_agent_options' && t.result?.includes('changed')), tools('master-chat').at(-1));
  await hub.send('master-chat', 'Clear it away [script:master-clear]');
  for (let i = 0; i < 900 && !(hub as any).agents.get(sw).card.archived; i++) await sleep(100);
  check('the master stops and archives an agent through the real tools', (hub as any).agents.get(sw).card.archived === true && !(hub as any).local.agents.has(sw), tools('master-chat').slice(-2));

  await hub.send('master-chat', 'Switch to auto [script:master-mode]');
  for (let i = 0; i < 900 && !hub.transcript('master-chat').some((t: Item) => t.kind === 'assistant' && t.text.includes('Switched myself')); i++) await sleep(100);
  check('asked to, the master changes its own permissions mid-session, and carries on', card('master-chat').permissionMode === 'auto' && hub.transcript('master-chat').some((t: Item) => t.kind === 'assistant' && t.text.includes('Switched myself')), tools('master-chat').at(-1));

  const masterSaid = (text: string) => hub.transcript('master-chat').some((t: Item) => t.kind === 'assistant' && t.text.includes(text));
  await hub.send('master-chat', 'From now on, say the note [script:master-remember]');
  for (let i = 0; i < 900 && !masterSaid('Noted.'); i++) await sleep(100);
  check('told to remember something, the master saves it through the real tools', masterSaid('Noted.') && (hub.snapshot().masterMemory ?? []).includes('Always say fleet-memory-note-4417'), hub.snapshot().masterMemory);
  // Let it finish, because a message that arrives before it's idle stays with the old prompt for that turn.
  for (let i = 0; i < 100 && card('master-chat').status !== 'idle'; i++) await sleep(100);
  await sleep(1000);
  await hub.send('master-chat', 'Are you there? [script:master-recall]');
  for (let i = 0; i < 900 && !masterSaid('Still here.'); i++) await sleep(100);
  check('its next turn has the note in its instructions', masterSaid('Still here.') && sysFor('master-recall').includes('fleet-memory-note-4417'), sysFor('master-recall').slice(-300));
  check('and carries on the same conversation', JSON.stringify(seen.filter((s) => s.marker === 'master-recall').at(-1)?.messages).includes('From now on, say the note'));
  hub.removeMasterMemory(0);

  log('The workspace chat');
  (hub as any).local.addProject(PROJECT);
  (hub as any).defaults.projectFile = PROJECT;
  await hub.send('master-chat', 'Open a workspace chat [script:master-workspace]');
  let wsCard: any;
  for (let i = 0; i < 900 && !wsCard; i++) { wsCard = hub.snapshot().cards.find((c: any) => c.isWorkspace && !c.archived); await sleep(100); }
  if (!wsCard) log('The master chat at this point:', card('master-chat').status, JSON.stringify(card('master-chat').attention), JSON.stringify(hub.transcript('master-chat').slice(-8).map((t: Item) => [t.kind, String(t.text ?? t.name ?? '').slice(0, 200), t.tone, t.result ? String(t.result).slice(0, 200) : undefined])));
  check('the master opens a workspace chat through the real tools', !!wsCard && wsCard.project === path.basename(PROJECT, '.uproject'), tools('master-chat').at(-1));
  const doneWs = await waitFor(wsCard.id, (c) => c.attention?.kind === 'reply' || c.status === 'idle', 'the workspace chat', 120_000);
  const heldTool = tools(wsCard.id).find((t) => t.name === 'mcp__fleet__hold_workspace');
  check('it holds the workspace, and hears who else is there', heldTool?.state === 'done' && heldTool.result.includes('personEditorOpen') && heldTool.result.includes('"agents"'), heldTool);
  check('and lets it go again', tools(wsCard.id).find((t) => t.name === 'mcp__fleet__release_workspace')?.result?.includes('carrying on') && !doneWs.holdingWorkspace, tools(wsCard.id).at(-1));
  const wsSys = sysFor('workspace');
  const wsTools = seen.find((s) => s.marker === 'workspace')!.tools;
  check('it is told it may change the workspace, and the rule against that is gone', wsSys.includes('You are the workspace chat') && !wsSys.includes('Never run anything that reverts'), wsSys.slice(0, 300));
  check('it has the tools for that, and no finish_task', wsTools.includes('mcp__fleet__hold_workspace') && !wsTools.includes('mcp__fleet__finish_task'), wsTools.filter((t) => t.startsWith('mcp__')));
  check("normal agents don't", !tl.includes('mcp__fleet__hold_workspace') && sysFor('pie-a').includes('Never run anything that reverts'));
  await hub.archive(wsCard.id);

  log('API credits');
  // A made-up subscription token, so the CLI behaves as it does for a subscriber at a limit.
  delete process.env.ANTHROPIC_API_KEY;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-fleet-test-subscription';
  hub.setApiKey('sk-ant-fleet-test');
  hub.setApiCreditsEnabled(true);
  const lim = await hub.createAgent(task('limit-hit'));
  const doneLim = await waitFor(lim, (c) => c.status === 'finished' || c.attention, 'the agent at the limit', 150_000);
  const limCalls = seen.filter((s) => s.marker === 'limit-hit');
  check('an agent at the limit carries on with API credits, with no prompt', doneLim.status === 'finished' && doneLim.onApiCredits === true, [doneLim.status, doneLim.onApiCredits, doneLim.attention]);
  check('having tried the subscription first', limCalls.length >= 2 && !limCalls[0].apiKey, limCalls.map((c) => c.apiKey));
  check('and billed to the key after that', limCalls.at(-1)?.apiKey === 'sk-ant-fleet-test', limCalls.at(-1)?.apiKey);
  check('in the same conversation', JSON.stringify(limCalls.at(-1)?.messages).includes('Run the script [script:limit-hit]') && JSON.stringify(limCalls.at(-1)?.messages).includes('carry on from where you stopped'));
  check('and the chat says so', hub.transcript(lim).some((t: Item) => t.kind === 'system' && t.text.includes('carrying on with API credits until')), hub.transcript(lim).filter((t: Item) => t.kind === 'system'));
  const bill = await hub.createAgent(task('limit-billing'));
  const doneBill = await waitFor(bill, (c) => c.attention?.kind === 'error', 'the agent with no credits', 150_000);
  check('out of credits, it stops and says why, rather than looping', /credit balance/i.test(doneBill.attention?.text ?? '') && !doneBill.onApiCredits, doneBill.attention);
  check('and the setting shows it', /credit balance/i.test(hub.snapshot().apiCredits?.problem ?? ''), hub.snapshot().apiCredits);
  hub.setApiKey(null);
  await hub.stopAgent(lim);
  await hub.stopAgent(bill);
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = 'scripted';

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
  for (const c of hub.snapshot().cards) if (hub.local!.slots.get(c.id)) await hub.local!.slots.get(c.id)!.stopEditor();
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
    const rem = await hub.createAgent(task('remote', { projectFile: SENT_PROJECT, nodeId: remote.info.id }));
    const doneRem = await waitFor(rem, settled, 'the remote agent', 5 * 60_000);
    check('the remote agent finished', doneRem.status === 'finished' && !!doneRem.final, doneRem.attention);
    const isPieRem = tools(rem).find((t) => JSON.stringify(t.input).includes('IsPIERunning'));
    check('it drove an editor on the host', !!isPieRem?.result?.includes('false'), isPieRem);
    check('a project it was sent gets a copy, on the host', !doneRem.slot.shared && doneRem.slot.dir.includes(path.join(dataDir, 'host')), doneRem.slot);
    check('from the project the master sent', fs.existsSync(path.join(dataDir, 'host', 'projects', 'FleetSent', 'FleetSent.uproject')));

    const remChanges = await hub.changes(rem);
    check('the master can see its changes', remChanges.some((c: any) => c.path.replaceAll('\\', '/') === 'Source/Remote/FromHost.cpp'), remChanges);
    const appliedRem = await hub.apply(rem);
    const landed = path.join(path.dirname(SENT_PROJECT), 'Source/Remote/FromHost.cpp');
    check('apply brings them back to the master', appliedRem.conflicts.length === 0 && fs.existsSync(landed) && fs.readFileSync(landed, 'utf8').includes('from the host'), appliedRem);

    const askerRem = await hub.createAgent(task('asks', { nodeId: remote.info.id }));
    const doneAskRem = await waitFor(askerRem, (c) => c.status === 'finished', 'the remote agent that asked', 90_000);
    check("an agent on another machine can ask the master for what only it can reach", /the ticket says blue/.test(doneAskRem.final?.summary ?? ''), doneAskRem.final);
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
  // Marked as a copy so this throwaway project drops off Unreal's recent list.
  fs.mkdirSync(path.join(path.dirname(PROJECT), '.fleet'), { recursive: true });
  for (const e of hub.machines()[0].info.engines) forgetCopiesFromRecents(e.version);
  const failed = results.filter((x) => x.startsWith('FAIL'));
  console.log(`\n${results.join('\n')}\n\n${results.length - failed.length}/${results.length} passed`);
  assert.ok(results.length);
  setTimeout(() => process.exit(failed.length ? 1 : 0), 500);
}
