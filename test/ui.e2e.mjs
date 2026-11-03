// Drives the real Electron app with real key presses, using scripted agents.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'test', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ui-'));
const require = createRequire(import.meta.url);

// Stands in for Anthropic when a key is saved, so a test key never leaves this PC.
const fakeApi = http.createServer((req, res) => {
  res.writeHead(req.headers['x-api-key'] === 'bad-key' ? 401 : 200, { 'content-type': 'application/json' });
  res.end('{"data":[]}');
});
await new Promise((r) => fakeApi.listen(0, '127.0.0.1', r));

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  cwd: root,
  env: { ...process.env, FLEET_DEMO: '1', FLEET_DATA: dataDir, FLEET_TEST_UNSEEN: '1', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fakeApi.address().port}` },
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.waitForSelector('.topbar');

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(`ok   ${name}`); console.log(`ok   ${name}`); }
  catch (e) {
    results.push(`FAIL ${name}`);
    console.log(`FAIL ${name}\n  ${e.message}`);
    await page.screenshot({ path: path.join(shots, `fail-${results.length}.png`) });
  }
}

const spawn = (demo, prompt) => page.evaluate(([d, p]) => window.fleet.call('createAgent', { prompt: p, projectFile: null, nodeId: 'master', model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'default', instanceMode: 'offscreen', demo: d }), [demo, prompt]);
const selectedId = () => page.evaluate(() => document.querySelector('.card.selected')?.dataset.card ?? null);
const popupId = () => page.evaluate(() => document.querySelector('.popup')?.dataset.popup ?? null);
const until = async (fn, what, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await page.waitForTimeout(40);
  }
  throw new Error(`Timed out waiting for ${what}`);
};

await step('first run shows the empty state', async () => {
  await page.waitForSelector('.empty');
  await page.screenshot({ path: path.join(shots, '01-empty.png') });
});

await step('New Task always opens on auto, even after a different pick', async () => {
  const mode = () => page.$eval('[data-permission-mode]', (e) => e.value);
  await page.keyboard.press('Control+n');
  await page.waitForSelector('[data-new-task]');
  if (await mode() !== 'auto') throw new Error(`Opened on ${await mode()}`);
  await page.selectOption('[data-permission-mode]', 'default');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-new-task]', { state: 'detached' });
  await page.keyboard.press('Control+n');
  await page.waitForSelector('[data-new-task]');
  await until(async () => (await mode()) === 'auto', 'it to reopen on auto');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-new-task]', { state: 'detached' });
});

let longId;
await step('Ctrl+N opens New Task, and Enter launches it and selects its card', async () => {
  await page.keyboard.press('Control+n');
  await page.waitForSelector('[data-new-task]');
  await page.screenshot({ path: path.join(shots, '02-new-task.png') });
  await page.selectOption('[data-demo-script]', 'long');
  await page.keyboard.type('Refactor the watering schedule so every call site goes through WaterPlants');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-new-task]', { state: 'detached' });
  longId = await until(selectedId, 'a selected card');
  await until(() => page.evaluate(() => document.querySelector('.transcript')?.innerText.includes('Refactor the watering')), 'the prompt in the transcript');
});

await step('selecting a card shows its live output on the right', async () => {
  await until(() => page.evaluate(() => /Read|Edit|Grep/.test(document.querySelector('.transcript')?.innerText ?? '')), 'tool rows');
  await until(() => page.evaluate(() => document.querySelector('.card.selected .card-msg-text')?.innerText.length > 5), 'the latest message on the card');
});

const ids = {};
await step('agents that need the user raise a popup while another chat is open', async () => {
  ids.permission = await spawn('permission', 'Clean up the intermediate folder before rebuilding');
  ids.question = await spawn('question', 'Greenhouse sprinkler timing');
  await until(popupId, 'a popup');
  await page.screenshot({ path: path.join(shots, '03-popup.png') });
});

await step('Tab jumps straight to the waiting chat, even while typing in the composer', async () => {
  await page.click('[data-composer]');
  await page.keyboard.type('half written');
  const target = await until(popupId, 'a popup');
  await page.keyboard.press('Tab');
  await until(async () => (await selectedId()) === target, 'the selection to move');
  const draft = await page.evaluate((id) => document.querySelector('[data-composer]').value, target);
  assert.equal(draft, '', 'the draft for the other chat stays with that chat');
});

await step('number keys answer the prompt, and Tab walks through the rest', async () => {
  // Whichever came first, deal with both.
  for (let i = 0; i < 2; i++) {
    const kind = await until(() => page.evaluate(() => (document.querySelector('[data-permission]') ? 'permission' : document.querySelector('[data-question]') ? 'question' : null)), 'the selected chat to show its prompt');
    await page.keyboard.press('1');
    await page.waitForSelector(kind === 'permission' ? '[data-permission]' : '[data-question]', { state: 'detached' });
    if (i === 0) {
      const next = await until(popupId, 'the second popup');
      await page.keyboard.press('Tab');
      await until(async () => (await selectedId()) === next, 'the selection to move to the second prompt');
    }
  }
});

await step('Esc puts a popup away without jumping', async () => {
  await page.click(`[data-card="${longId}"]`);
  ids.reply = await spawn('reply', 'Why does the weather station lose its signal early?');
  const pop = await until(async () => { const p = await popupId(); return p === ids.reply ? p : null; }, 'the reply popup', 20000);
  await page.keyboard.press('Escape');
  await until(async () => (await popupId()) !== pop, 'the popup to go');
  assert.equal(await selectedId(), longId);
});

await step('Tab does nothing special with no popup open', async () => {
  assert.equal(await popupId(), null);
  await page.click('[data-composer]');
  const before = await selectedId();
  await page.keyboard.press('Tab');
  assert.equal(await selectedId(), before);
});

await step('Shift+Enter opens the all-agents chat from anywhere, without adding a line to the composer', async () => {
  await page.click('[data-composer]');
  await page.keyboard.type('draft');
  await page.keyboard.press('Shift+Enter');
  await page.waitForSelector('[data-broadcast]');
  const composer = await page.evaluate(() => document.querySelector('[data-composer]').value);
  assert.ok(composer.endsWith('draft') && !composer.includes('\n'), `composer was ${JSON.stringify(composer)}`);
  const focused = await page.evaluate(() => document.activeElement?.closest('[data-broadcast]') != null);
  assert.ok(focused, 'the broadcast box takes focus');
});

await step('Shift+Enter inside it adds a line, Enter sends to everyone, and replies come back', async () => {
  await page.keyboard.type('Commit what you have');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('then keep going');
  const value = await page.evaluate(() => document.querySelector('[data-broadcast] textarea').value);
  assert.equal(value, 'Commit what you have\nthen keep going');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.bc');
  await until(() => page.evaluate(() => [...document.querySelectorAll('.bc-text')].some((e) => e.innerText.startsWith('Got it'))), 'a reply in the thread', 20000);
  await page.screenshot({ path: path.join(shots, '04-broadcast.png') });
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-broadcast]', { state: 'detached' });
  const t = await page.evaluate((id) => window.fleet.call('transcript', id), longId);
  assert.ok(t.some((x) => x.kind === 'user' && x.broadcastId), 'the long agent got the broadcast');
  const replies = t.filter((x) => x.kind === 'assistant' && x.text.includes('Commit what you have'));
  assert.ok(replies.length >= 1);
  for (const r of replies) assert.ok(!r.text.includes('Got it: Got it'), `streamed text doubled: ${r.text}`);
  const shown = await page.evaluate(() => document.querySelector('.transcript').innerText);
  assert.ok(!shown.includes('Got it: Got it'), 'the live view must not double streamed text');
  assert.equal(await popupId(), null, 'replying to a broadcast is not a popup');
});

await step('a finished task with nothing to test stays quiet', async () => {
  const seen = new Set();
  ids.clean = await spawn('clean', 'Fix the paper lantern null pointer crash');
  await until(async () => {
    const p = await popupId();
    if (p) seen.add(p);
    return page.evaluate((id) => document.querySelector(`[data-card="${id}"]`)?.classList.contains('s-finished'), ids.clean);
  }, 'the clean task to finish', 20000);
  assert.ok(!seen.has(ids.clean), 'no popup for a self-verified task');
});

await step('a finished task with things to test gets a popup, a final message, and a checklist with instructions', async () => {
  ids.testing = await spawn('testing', 'Greenhouse sprinkler should only run at dawn');
  const p = await until(async () => { const x = await popupId(); return x === ids.testing ? x : null; }, 'the testing popup', 20000);
  assert.match(await page.evaluate(() => document.querySelector('.popup').innerText), /Ready to test/);
  await page.screenshot({ path: path.join(shots, '05-all-cards.png') });
  await page.keyboard.press('Tab');
  await until(async () => (await selectedId()) === p, 'the jump');
  await page.waitForSelector('[data-checklist]');
  await page.screenshot({ path: path.join(shots, '06-checklist.png') });
  const text = await page.evaluate(() => document.querySelector('[data-checklist]').innerText);
  assert.ok(text.includes('Walk past the sprinkler'));
  assert.ok(text.includes('Open Greenhouse_2 and press Play'), 'how to test it');
  assert.ok(text.includes('You should see'), 'what to look for');
  assert.ok(text.includes('Approve (tested)') && text.includes('Issue found'));
  assert.match(await page.evaluate(() => document.querySelector('[data-flow-text]').innerText), /Your turn to test/);
  assert.ok((await page.evaluate(() => document.querySelector('[data-tests-btn]').innerText)).includes('2'));
  assert.match(await page.evaluate((id) => document.querySelector(`[data-card="${id}"] .card-status`).innerText, p), /TESTING · NEEDS YOU/);
});

await step('ticking a test off updates the count', async () => {
  await page.click('.checks input');
  await until(() => page.evaluate(() => document.querySelector('[data-tests-btn]').innerText.includes('1')), 'the count to drop');
});

await step('a new request that matches a card offers to send it there, and Alt+1 does', async () => {
  await page.keyboard.press('Control+n');
  await page.waitForSelector('[data-new-task]');
  await page.keyboard.type('The greenhouse sprinkler timing still looks wrong near the pond');
  await page.waitForSelector('[data-route]');
  const offered = await page.evaluate(() => document.querySelector('[data-route-card]').dataset.routeCard);
  assert.ok([ids.question, ids.testing].includes(offered), 'it offers one of the greenhouse sprinkler cards');
  await page.screenshot({ path: path.join(shots, '10-routing.png') });
  await page.keyboard.press('Alt+1');
  await page.waitForSelector('[data-new-task]', { state: 'detached' });
  await until(async () => (await selectedId()) === offered, 'the jump to that card');
  await until(async () => {
    const t = await page.evaluate((id) => window.fleet.call('transcript', id), offered);
    return t.some((x) => x.kind === 'user' && x.text.includes('near the pond'));
  }, 'the message to arrive');
  const count = await page.evaluate(() => window.fleet.call('snapshot').then((s) => s.cards.filter((c) => !c.isMaster).length));
  assert.equal(count, Object.keys(ids).length + 1, 'no new card was made');
  // It answers and goes back to waiting on the user, which would keep the fleet "busy" below.
  await until(() => page.evaluate((id) => window.fleet.call('snapshot').then((s) => !!s.cards.find((c) => c.id === id).attention), offered), 'its reply');
  await page.evaluate((id) => window.fleet.call('dismissAttention', id), offered);
});

await step('Enter still makes a new task when the suggestion is not wanted', async () => {
  await page.keyboard.press('Control+n');
  await page.waitForSelector('[data-new-task]');
  await page.selectOption('[data-demo-script]', 'clean');
  await page.keyboard.type('The greenhouse sprinkler needs a brand new nozzle');
  await page.waitForSelector('[data-route]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-new-task]', { state: 'detached' });
  await until(() => page.evaluate((n) => window.fleet.call('snapshot').then((s) => s.cards.filter((c) => !c.isMaster).length === n), Object.keys(ids).length + 2), 'a new card');
  await until(() => page.evaluate(() => window.fleet.call('snapshot').then((s) => s.cards.at(-1).status === 'finished')), 'it to finish', 20000);
});

await step('Esc in the composer interrupts a running agent without a popup', async () => {
  await page.click(`[data-card="${longId}"]`);
  await page.click('[data-composer]');
  await page.keyboard.press('Escape');
  await until(() => page.evaluate((id) => document.querySelector(`[data-card="${id}"]`).classList.contains('s-idle'), longId), 'it to go idle');
  const c = await page.evaluate((id) => window.fleet.call('snapshot').then((s) => s.cards.find((x) => x.id === id)), longId);
  assert.equal(c.attention, null);
});

await step('when everything is done, a popup points at what is left to test and Tab goes there', async () => {
  await page.evaluate(async (id) => { await window.fleet.call('stopAgent', id); }, longId);
  // Anything still waiting on the user keeps the fleet "busy", so settle those first.
  for (const c of await page.evaluate(() => window.fleet.call('snapshot').then((s) => s.cards))) {
    if (c.attention) await page.evaluate((id) => window.fleet.call('dismissAttention', id), c.id);
  }
  await until(() => page.evaluate(() => document.querySelector('[data-popup="all-done"]') != null), 'the all-done popup', 10000);
  await page.screenshot({ path: path.join(shots, '07-all-done.png') });
  await page.keyboard.press('Tab');
  await until(async () => (await selectedId()) === ids.testing, 'the jump to the checklist');
  await page.waitForSelector('[data-checklist]');
});

await step('the machines window shows a pairing code', async () => {
  await page.click('text=machines');
  await page.waitForSelector('[data-machines]');
  const code = await page.evaluate(() => document.querySelector('[data-pair-code]').innerText);
  const decoded = JSON.parse(Buffer.from(code, 'base64url').toString());
  assert.ok(decoded.p && decoded.t && decoded.f.length === 64);
  await page.screenshot({ path: path.join(shots, '09-machines.png') });
  await page.keyboard.press('Escape');
});

await step('filter narrows the cards', async () => {
  await page.fill('[data-filter]', 'lantern');
  await until(() => page.evaluate(() => document.querySelectorAll('.card').length === 1), 'one card');
  await page.fill('[data-filter]', '');
});

await step('Ctrl+2 jumps to the second card', async () => {
  await page.click('[data-composer]');
  await page.keyboard.press('Control+2');
  await until(async () => (await selectedId()) === ids.permission, 'selection');
});

const progress = (id) => page.evaluate((i) => {
  const card = document.querySelector(`[data-card="${i}"]`);
  return { text: card.querySelector('.progress-text').innerText, width: card.querySelector('.progress-fill').style.width, value: card.querySelector('[role="progressbar"]').getAttribute('aria-valuenow') };
}, id);

await step('each card shows how far through its task the agent is', async () => {
  assert.deepEqual(await progress(ids.clean), { text: '100%', width: '100%', value: '100' }, 'finished is full');
  const stopped = await progress(longId);
  assert.match(stopped.text, /^\d+%$/);
  assert.ok(Number.parseInt(stopped.text, 10) >= 50 && Number.parseInt(stopped.text, 10) < 100, `a stopped task keeps what it reported: ${stopped.text}`);
  assert.equal(stopped.width, stopped.text, 'the bar matches the number');

  const fresh = await page.evaluate(() => window.fleet.call('createAgent', { prompt: 'Sweep the greenhouse paths', projectFile: null, nodeId: 'master', model: 'claude-opus-5-5', effort: 'low', permissionMode: 'default', instanceMode: 'offscreen', demo: 'clean' }));
  await until(() => page.evaluate((i) => !!document.querySelector(`[data-card="${i}"]`), fresh), 'the new card');
  assert.equal((await progress(fresh)).text, '–', 'nothing reported yet');
  await until(async () => (await progress(fresh)).text !== '–', 'its first report');
  await page.screenshot({ path: path.join(shots, '13-progress.png') });
  await until(async () => (await progress(fresh)).text === '100%', 'it to finish', 20000);

  await page.evaluate((i) => window.fleet.call('send', i, 'One more thing'), fresh);
  await until(async () => (await progress(fresh)).text === '–', 'a follow-up to start the bar again');
  await until(() => page.evaluate((i) => window.fleet.call('snapshot').then((s) => !!s.cards.find((c) => c.id === i).attention), fresh), 'its reply');
  await page.evaluate((i) => window.fleet.call('dismissAttention', i), fresh);
});

const flowOf = () => page.evaluate(() => document.querySelector('[data-flow]')?.dataset.flow ?? null);
const flowText = () => page.evaluate(() => document.querySelector('[data-flow-text]')?.innerText ?? '');
const dismissIfWaiting = (id) => page.evaluate((i) => window.fleet.call('dismissAttention', i), id);

await step('the master chat has its own bar, Ctrl+0 opens it, and it has no stages or files', async () => {
  await page.click('[data-composer]');
  await page.keyboard.press('Control+0');
  await until(() => page.evaluate(() => document.querySelector('[data-master-bar]').classList.contains('selected')), 'the master chat to open');
  await until(() => page.evaluate(() => document.querySelector('[data-composer]').placeholder.includes('master chat')), 'its message box');
  assert.equal(await flowOf(), null);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.tabs button').length), 1);
  const text = await page.evaluate(() => document.querySelector('.transcript').innerText);
  assert.ok(text.includes('Refactor the watering schedule'), 'it has seen the requests');
  assert.ok(text.includes('Started agent'), 'and says what it did with them');
  await page.screenshot({ path: path.join(shots, '14-master-chat.png') });
});

await step('Issue found sends it straight back to the agent with what you wrote', async () => {
  const id = await spawn('testing', 'Greenhouse gate should close at night');
  await page.click(`[data-card="${id}"]`);
  await page.waitForSelector('[data-checklist]', { timeout: 20000 });
  await page.click('[data-issue]');
  await page.waitForSelector('[data-issue-text]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-issue-send]').disabled), true, 'it wants to know what is wrong');
  await page.keyboard.type('It closes during the day too');
  await page.screenshot({ path: path.join(shots, '15-issue-found.png') });
  await page.click('[data-issue-send]');
  await page.waitForSelector('[data-checklist]', { state: 'detached' });
  assert.equal(await flowOf(), 'building');
  assert.match(await flowText(), /making the change/);
  await until(() => page.evaluate(() => document.querySelector('.transcript').innerText.includes('It closes during the day too')), 'the issue in the chat');
  await until(() => page.evaluate((i) => window.fleet.call('snapshot').then((s) => !!s.cards.find((c) => c.id === i).attention), id), 'its reply');
  await dismissIfWaiting(id);
});

await step('Approve takes a tested task through to complete, and says where things ended up', async () => {
  const id = await spawn('testing', 'Greenhouse door should stay shut');
  await page.click(`[data-card="${id}"]`);
  await page.waitForSelector('[data-checklist]', { timeout: 20000 });
  assert.equal(await flowOf(), 'testing');
  await page.click('[data-approve]');
  await page.waitForSelector('[data-checklist]', { state: 'detached' });
  await until(async () => (await flowOf()) === 'complete', 'complete');
  assert.match(await flowText(), /Done/);
  assert.match(await page.evaluate((i) => document.querySelector(`[data-card="${i}"] .card-status`).innerText, id), /^COMPLETE/);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.flow-steps.labelled li.done').length), 7);
  await page.screenshot({ path: path.join(shots, '16-complete.png') });
});

await step('Open editor explains itself when it can not run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ui-project-'));
  const file = path.join(dir, 'NoEngine.uproject');
  fs.writeFileSync(file, '{"EngineAssociation":"0.1"}');
  const id = await page.evaluate((f) => window.fleet.call('createAgent', { prompt: 'A task with a project', projectFile: f, nodeId: 'master', model: 'claude-opus-5-5', effort: 'low', permissionMode: 'default', instanceMode: 'offscreen', demo: 'testing' }), file);
  await page.click(`[data-card="${id}"]`);
  await page.waitForSelector('[data-open-editor]', { timeout: 20000 });
  await page.click('[data-open-editor]');
  await page.waitForSelector('[data-test-run="failed"]', { timeout: 15000 });
  assert.match(await page.evaluate(() => document.querySelector('[data-test-run]').innerText), /No Unreal Engine/);
  assert.equal(await flowOf(), 'testing', 'it stays in testing');
  await page.click('[data-approve]');
  await until(async () => (await flowOf()) === 'complete', 'complete');
  await page.click('.tabs button:nth-child(2)');
  await page.waitForSelector('.changes');
  await page.click('.tabs button:nth-child(1)');
});

const transcriptText = () => page.evaluate(() => document.querySelector('.transcript').innerText);

await step('Messages only leaves just the messages in the chat, and hands the keyboard back', async () => {
  await page.click(`[data-card="${ids.clean}"]`);
  await page.waitForSelector('.transcript .tool');
  await page.click('[data-messages-only]');
  await page.waitForSelector('.transcript .tool', { state: 'detached' });
  const text = await transcriptText();
  assert.equal(await page.evaluate(() => document.querySelector('[data-flow-text]').isConnected), true, 'where things stand still shows');
  assert.ok(text.includes('Fix the paper lantern null pointer crash'), 'what the user asked');
  assert.ok(text.includes('Looking at how this is set up'), 'what the agent said');
  assert.ok(text.includes('Fixed the crash when a paper lantern lands'), 'its closing message');
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-composer')), true);
  await page.screenshot({ path: path.join(shots, '12-messages-only.png') });
});

await step('it applies to every chat, but a prompt still waiting stays until it is answered', async () => {
  const waiting = await spawn('permission', 'Clear out the old sprinkler logs');
  await page.click(`[data-card="${waiting}"]`);
  await page.waitForSelector('[data-permission]', { timeout: 15000 });
  assert.equal(await page.evaluate(() => document.querySelector('.transcript .tool')), null);
  await page.keyboard.press('1');
  await page.waitForSelector('[data-permission]', { state: 'detached' });
  assert.ok(!(await transcriptText()).includes('Bash: allowed'), 'the answered prompt goes too');
  await page.evaluate((id) => window.fleet.call('stopAgent', id), waiting);
});

await step('the tabs that are not the chat have no such toggle', async () => {
  await page.click('.tabs button:nth-child(3)');
  assert.equal(await page.evaluate(() => document.querySelector('[data-messages-only]')), null);
  await page.click('.tabs button:nth-child(1)');
});

await step('it is remembered, and turning it off brings everything back', async () => {
  await page.reload();
  await page.waitForSelector('.topbar');
  await page.waitForSelector('[data-messages-only]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-messages-only]').checked), true);
  await page.click(`[data-card="${ids.clean}"]`);
  await until(transcriptText, 'the chat to load');
  assert.equal(await page.evaluate(() => document.querySelector('.transcript .tool')), null);
  await page.click('[data-messages-only]');
  await page.waitForSelector('.transcript .tool');
});

await step('the master opens a workspace chat, outlined in pink and pinned above every other card', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ui-workspace-'));
  const file = path.join(dir, 'Greenhouse.uproject');
  fs.writeFileSync(file, '{"EngineAssociation":"5.8"}');
  await page.evaluate((f) => window.fleet.call('addProject', f), file);
  await page.keyboard.press('Control+0');
  await page.evaluate(() => window.fleet.call('send', 'master-chat', 'Open a workspace chat and merge main into dev'));
  await page.waitForSelector('[data-pinned] .card.workspace', { timeout: 15000 });
  const first = await page.evaluate(() => document.querySelector('.grid-scroll').firstElementChild.matches('[data-pinned]'));
  assert.equal(first, true, 'it is the first thing in the list');
  const outline = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('.card.workspace')); return `${s.borderColor} ${s.boxShadow}`; });
  assert.match(outline, /rgb\(244, 114, 182\)/, 'pink, because blue means selected');
  assert.equal(await page.evaluate(() => document.querySelector('.card.workspace .flow-steps')), null, 'a chat, so no stages');
  await page.waitForSelector('[data-workspace-banner]', { timeout: 10000 });
  assert.match(await page.evaluate(() => document.querySelector('[data-workspace-banner]').innerText), /merge, switch and update/);
  assert.equal(await page.evaluate(() => document.querySelector('[data-flow]')), null);
  await page.screenshot({ path: path.join(shots, '17-workspace-chat.png') });
});

await step("the master chat's permissions can be changed from the top of its chat, without bypass on offer", async () => {
  await page.keyboard.press('Control+0');
  await page.waitForSelector('[data-master-mode]');
  const master = async () => (await page.evaluate(() => window.fleet.call('snapshot'))).cards.find((c) => c.isMaster).permissionMode;
  assert.equal(await page.$eval('[data-master-mode]', (e) => e.value), 'default');
  assert.deepEqual(await page.$$eval('[data-master-mode] option', (o) => o.map((x) => x.value)), ['default', 'auto', 'acceptEdits']);
  await page.selectOption('[data-master-mode]', 'auto');
  await until(async () => (await master()) === 'auto', 'it to change');
  await until(() => page.$eval('[data-master-mode]', (e) => e.value === 'auto'), 'the screen to show it');
  await page.screenshot({ path: path.join(shots, '19-master-mode.png') });
});

await step('Use API credits needs a working key, and the key never comes back to the screen', async () => {
  await page.click('.topbar button:has-text("machines")');
  await page.waitForSelector('[data-api-credits]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-api-credits-on]').disabled), true, 'nothing to use yet');
  await page.fill('[data-api-key]', 'bad-key');
  await page.click('[data-api-key-save]');
  await page.waitForSelector('[data-api-credits-problem]');
  assert.match(await page.evaluate(() => document.querySelector('[data-api-credits-problem]').innerText), /refused/);
  assert.equal(await page.evaluate(() => document.querySelector('[data-api-credits-on]').disabled), true);
  await page.fill('[data-api-key]', 'sk-ant-good-test-key');
  await page.click('[data-api-key-save]');
  await until(() => page.evaluate(() => !document.querySelector('[data-api-credits-on]').disabled), 'the option to be available');
  await until(() => page.evaluate(() => document.querySelector('[data-api-key]').value === ''), 'the box to be emptied');
  await page.click('[data-api-credits-on]');
  await until(async () => (await page.evaluate(() => window.fleet.call('snapshot'))).apiCredits.enabled, 'it to turn on');
  const snap = await page.evaluate(() => window.fleet.call('snapshot'));
  assert.ok(!JSON.stringify(snap).includes('sk-ant-good-test-key'), 'not in anything the screens get');
  assert.ok(!fs.readFileSync(path.join(dataDir, 'api-key.bin')).includes('sk-ant-good-test-key'), 'encrypted on disk');
  await page.screenshot({ path: path.join(shots, '18-api-credits.png') });
  await page.click('[data-api-key-remove]');
  await until(() => page.evaluate(() => document.querySelector('[data-api-credits-on]').disabled), 'it to turn off with no key');
  assert.equal(fs.existsSync(path.join(dataDir, 'api-key.bin')), false);
  await page.keyboard.press('Escape');
});

await step('no renderer errors', async () => {
  assert.deepEqual(errors, []);
});

await app.close();
fakeApi.close();
const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
