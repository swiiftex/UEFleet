// Real Claude agents driving real Unreal editors at the same time, through the same hub the app
// uses. Spends a small amount of tokens on the cheapest model, and boots real editors.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from '../src/hub/hub';
import type { AgentCard, NewTask, TranscriptItem } from '../src/shared/protocol';

const ROOT = process.env.FLEET_ROOT!;
const PROJECT = path.join(ROOT, 'probe', 'FleetProbe', 'FleetProbe.uproject');
const shots = path.join(ROOT, 'test', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-real-'));
const hub = new Hub({ dataDir, version: 'test', demo: false, hostAppPath: null });
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const card = (id: string): AgentCard => hub.snapshot().cards.find((c) => c.id === id)!;
const sha = (f: string) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 10);
const base = (extra: Partial<NewTask>): NewTask => ({ prompt: '', projectFile: PROJECT, nodeId: 'master', model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'acceptEdits', instanceMode: 'offscreen', ...extra });

const results: string[] = [];
const check = (name: string, ok: boolean, info?: unknown) => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  log(ok ? 'ok  ' : 'FAIL', name, ok || info === undefined ? '' : JSON.stringify(info).slice(0, 400));
};

async function waitFor(id: string, fn: (c: AgentCard) => boolean, what: string, ms = 12 * 60_000) {
  const end = Date.now() + ms;
  let last = '';
  while (Date.now() < end) {
    const c = card(id);
    if (fn(c)) return c;
    const now = `${c.status}${c.slot ? ` / ${c.slot.state}` : ''}${c.detail ? ` / ${c.detail}` : ''}`;
    if (now !== last) { log(`  ${String(c.index).padStart(2, '0')} ${now}`); last = now; }
    await sleep(500);
  }
  dump(id);
  throw new Error(`Timed out waiting for ${what}`);
}

function dump(id: string) {
  for (const t of hub.transcript(id)) {
    const x = t as any;
    log('    ', t.kind, x.name ?? '', String(x.text ?? x.result ?? '').slice(0, 240).replace(/\s+/g, ' '));
  }
}

const tools = (id: string) => hub.transcript(id).filter((t): t is Extract<TranscriptItem, { kind: 'tool' }> => t.kind === 'tool');

const pieWatch = { both: false, states: new Set<string>() };
const watcher = setInterval(() => {
  const slots = hub.machines()[0].slots;
  const inPie = slots.filter((s) => s.state === 'pie');
  for (const s of slots) pieWatch.states.add(`${s.id}:${s.state}`);
  if (inPie.length >= 2) pieWatch.both = true;
}, 100);

try {
  await hub.start();
  const assetSrc = path.join(path.dirname(PROJECT), 'Content/Probe/ST_Test.uasset');
  const assetHash = sha(assetSrc);

  log('Two agents, one project, both told to hold PIE open so the runs overlap');
  const pieTask = (who: string) => `You are testing your own Unreal editor instance. Do exactly this, using only the mcp__fleet tools:
1. Call ue_call with toolset_name "EditorToolset.EditorAppToolset", tool_name "StartPIE", arguments {"options":{"bSimulate":false,"playMode":"PlayMode_InViewPort","warmupSeconds":45}}. This holds for 45 seconds, which is intended.
2. Call ue_call with the same toolset, tool_name "IsPIERunning", and arguments {}.
3. Call ue_call with the same toolset, tool_name "StopPIE", and arguments {}.
4. ${who}
5. Call finish_task. Put what you confirmed in verified, and leave needs_human_testing empty.`;

  const a = await hub.createAgent(base({ prompt: pieTask('Append the line "; edited by agent A" to Config/DefaultGame.ini in your project copy, creating the file if needed.') }));
  const b = await hub.createAgent(base({ prompt: pieTask('Call ue_call with toolset_name "EditorToolset.EditorAppToolset", tool_name "CaptureViewport", and arguments {"captureTransform":{"location":{"x":-300,"y":0,"z":200},"rotation":{"pitch":-20,"yaw":0,"roll":0},"scale":{"x":1,"y":1,"z":1}},"annotations":{"gridSpacing":0,"gridExtent":0,"gridHeight":0,"maxLabelDistance":0,"classFilter":{"refPath":"/Script/Engine.Actor"},"maxLabels":0},"bShowUI":false}.'), instanceMode: 'offscreen' }));

  const [ca, cb] = await Promise.all([
    waitFor(a, (c) => c.status === 'finished' || c.status === 'error' || c.attention?.kind === 'error', 'agent A'),
    waitFor(b, (c) => c.status === 'finished' || c.status === 'error' || c.attention?.kind === 'error', 'agent B'),
  ]);
  check('agent A finished through finish_task', ca.status === 'finished' && !!ca.final, ca.attention);
  check('agent B finished through finish_task', cb.status === 'finished' && !!cb.final, cb.attention);
  check('both editors were in PIE at the same moment', pieWatch.both, [...pieWatch.states]);
  check('each agent got its own copy and its own port', ca.slot!.dir !== cb.slot!.dir && ca.slot!.port !== cb.slot!.port, [ca.slot, cb.slot]);
  check('agent A used only its own tools for Unreal', tools(a).filter((t) => t.name.startsWith('mcp__fleet__ue_')).length >= 3, tools(a).map((t) => t.name));
  check('a verified task raised no popup', ca.attention === null && cb.attention === null, [ca.attention, cb.attention]);
  check('nothing was added to the test list', hub.testList().length === 0, hub.testList());

  const usage = ca.usage;
  check('tokens and context are tracked', ca.tokens > 0 && usage.context > 0 && usage.costUsd > 0, usage);
  check('activity time is tracked', ca.buckets.testing > 0, ca.buckets);

  const capture = tools(b).find((t) => JSON.stringify(t.input).includes('CaptureViewport'));
  check('the viewport capture came back as an image', !!capture?.images?.length, capture?.result);
  if (capture?.images?.[0]) {
    const png = Buffer.from(capture.images[0].split(',')[1], 'base64');
    fs.writeFileSync(path.join(shots, 'real-offscreen-capture.png'), png);
    check('the image is a real PNG with content', png.length > 2000 && png[1] === 0x50, png.length);
  }

  log('Changes stay in the copy until applied');
  const iniInSource = path.join(path.dirname(PROJECT), 'Config/DefaultGame.ini');
  const sourceBefore = fs.existsSync(iniInSource) ? fs.readFileSync(iniInSource, 'utf8') : '';
  check('the agent did not touch the real project', !sourceBefore.includes('edited by agent A'));
  const changes = await hub.changes(a);
  check('the edit shows up as a change', changes.some((c) => c.path.replaceAll('\\', '/') === 'Config/DefaultGame.ini'), changes);
  check('the source asset is byte-identical', sha(assetSrc) === assetHash);

  log('A permission prompt, end to end');
  const p = await hub.createAgent(base({ projectFile: null, permissionMode: 'default', prompt: 'Run this exact Bash command once: node -e "console.log(\'fleet-permission-check\')" and then call finish_task with what you saw in verified and an empty needs_human_testing. Do nothing else.' }));
  const atPerm = await waitFor(p, (c) => c.attention?.kind === 'permission', 'the permission prompt', 3 * 60_000);
  check('the prompt surfaced as attention with a reference', !!atPerm.attention?.ref);
  await hub.decide(p, atPerm.attention!.ref!, 'allow');
  const doneP = await waitFor(p, (c) => c.status === 'finished', 'the permissioned agent', 3 * 60_000);
  const bash = tools(p).find((t) => t.name === 'Bash');
  check('the approved command ran', !!bash?.result?.includes('fleet-permission-check'), bash);
  check('and it finished quietly', doneP.attention === null, doneP.attention);

  log('A question, end to end');
  const q = await hub.createAgent(base({ projectFile: null, prompt: 'Use the AskUserQuestion tool to ask me which color I want, with the options "Crimson" and "Teal". Then call finish_task with summary set to exactly the color I chose, verified ["asked the user"], and an empty needs_human_testing.' }));
  const atQ = await waitFor(q, (c) => c.attention?.kind === 'question', 'the question', 3 * 60_000);
  const qItem = hub.transcript(q).find((t) => t.kind === 'question') as any;
  await hub.answer(q, atQ.attention!.ref!, { [qItem.questions[0].question]: 'Teal' });
  const doneQ = await waitFor(q, (c) => c.status === 'finished', 'the question agent', 3 * 60_000);
  check('the agent received the answer', /teal/i.test(doneQ.final?.summary ?? ''), doneQ.final);

  log('Honest reporting: something it cannot check goes on the test list');
  const h = await hub.createAgent(base({ projectFile: null, prompt: 'Pretend you tuned how heavy a character jump feels. You can\'t judge game feel yourself. Call finish_task now with a one-line summary, verified ["read the code"], and one needs_human_testing entry about checking how the jump feels.' }));
  const doneH = await waitFor(h, (c) => c.status === 'finished', 'the testing agent', 3 * 60_000);
  check('it shows a final message and a popup', doneH.attention?.kind === 'testing' && hub.transcript(h).some((t) => t.kind === 'final'), doneH.attention);
  check('the test list has it', hub.testList().some((t) => t.agentId === h), hub.testList());

  log('Follow-up after a finish resumes the same session');
  await hub.send(q, 'What color did I choose? Answer in one word, then call finish_task again with that word as the summary, verified ["remembered"], and an empty needs_human_testing.');
  const again = await waitFor(q, (c) => c.status === 'finished' && !!c.final, 'the follow-up', 3 * 60_000);
  check('it remembered', /teal/i.test(again.final?.summary ?? ''), again.final);

  log('Applying changes into the real project');
  const applied = await hub.apply(a);
  check('apply reports the file', applied.conflicts.length === 0 && applied.applied.length + applied.merged.length >= 1, applied);
  check('the real project now has the edit', fs.readFileSync(iniInSource, 'utf8').includes('edited by agent A'));
  fs.rmSync(iniInSource, { force: true });
} catch (e: any) {
  results.push(`FAIL ${e.message}`);
  log('FAIL', e.stack ?? e);
} finally {
  clearInterval(watcher);
  await hub.shutdown();
  const failed = results.filter((r) => r.startsWith('FAIL'));
  console.log(`\n${results.join('\n')}\n\n${results.length - failed.length}/${results.length} passed`);
  assert.ok(results.length);
  setTimeout(() => process.exit(failed.length ? 1 : 0), 500);
}
