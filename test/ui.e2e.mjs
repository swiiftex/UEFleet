// Drives the real Electron app with real key presses, using scripted agents.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'test', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ui-'));
const require = createRequire(import.meta.url);

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  cwd: root,
  env: { ...process.env, FLEET_DEMO: '1', FLEET_DATA: dataDir },
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
    const sel = await selectedId();
    const kind = await page.evaluate(() => (document.querySelector('[data-permission]') ? 'permission' : document.querySelector('[data-question]') ? 'question' : null));
    assert.ok(kind, `selected chat ${sel} should be showing a prompt`);
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

await step('a finished task with things to test gets a popup, a final message, and a test list', async () => {
  ids.testing = await spawn('testing', 'Greenhouse sprinkler should only run at dawn');
  const p = await until(async () => { const x = await popupId(); return x === ids.testing ? x : null; }, 'the testing popup', 20000);
  await page.screenshot({ path: path.join(shots, '05-all-cards.png') });
  await page.keyboard.press('Tab');
  await until(async () => (await selectedId()) === p, 'the jump');
  await page.waitForSelector('.final-card');
  await page.screenshot({ path: path.join(shots, '06-final-message.png') });
  const text = await page.evaluate(() => document.querySelector('.final-card').innerText);
  assert.ok(text.includes('Walk past the sprinkler'));
  assert.ok((await page.evaluate(() => document.querySelector('[data-tests-btn]').innerText)).includes('2'));
});

await step('ticking a test off updates the count', async () => {
  await page.click('.final-tests input');
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
  const count = await page.evaluate(() => window.fleet.call('snapshot').then((s) => s.cards.length));
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
  await until(() => page.evaluate((n) => window.fleet.call('snapshot').then((s) => s.cards.length === n), Object.keys(ids).length + 2), 'a new card');
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

await step('when everything is done, a popup offers the test list and Tab opens it', async () => {
  await page.evaluate(async (id) => { await window.fleet.call('stopAgent', id); }, longId);
  // Anything still waiting on the user keeps the fleet "busy", so settle those first.
  for (const c of await page.evaluate(() => window.fleet.call('snapshot').then((s) => s.cards))) {
    if (c.attention) await page.evaluate((id) => window.fleet.call('dismissAttention', id), c.id);
  }
  await until(() => page.evaluate(() => document.querySelector('[data-popup="all-done"]') != null), 'the all-done popup', 10000);
  await page.screenshot({ path: path.join(shots, '07-all-done.png') });
  await page.keyboard.press('Tab');
  await page.waitForSelector('[data-tests]');
  await page.screenshot({ path: path.join(shots, '08-test-list.png') });
  await page.keyboard.press('Escape');
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

await step('no renderer errors', async () => {
  assert.deepEqual(errors, []);
});

await app.close();
const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
