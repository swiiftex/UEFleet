import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMessage } from '../src/renderer/store';
import type { TranscriptItem } from '../src/shared/protocol';

const base = { id: 'x', at: 0 };
const report = { summary: 's', verified: [], needsTesting: [], at: 0 };
const question = { question: 'q', options: [] };

test('Messages only keeps what was said', () => {
  const kept: TranscriptItem[] = [
    { ...base, kind: 'user', text: 'do it' },
    { ...base, kind: 'assistant', text: 'done' },
    { ...base, kind: 'final', report },
    { ...base, kind: 'system', text: 'Finished: it works', message: true },
  ];
  for (const item of kept) assert.ok(isMessage(item), item.kind);
});

test('Messages only hides the working and the notes about it', () => {
  const hidden: TranscriptItem[] = [
    { ...base, kind: 'thinking', text: 'hmm' },
    { ...base, kind: 'tool', name: 'Read', input: {}, state: 'done' },
    { ...base, kind: 'system', text: 'Context compacted.' },
    { ...base, kind: 'system', text: 'API retry', tone: 'warn' },
  ];
  for (const item of hidden) assert.ok(!isMessage(item), item.kind);
});

test('a prompt stays only while the agent is waiting on it', () => {
  assert.ok(isMessage({ ...base, kind: 'permission', tool: 'Bash', input: {}, canAlways: false }));
  assert.ok(!isMessage({ ...base, kind: 'permission', tool: 'Bash', input: {}, canAlways: false, decided: 'allow' }));
  assert.ok(isMessage({ ...base, kind: 'question', questions: [question] }));
  assert.ok(!isMessage({ ...base, kind: 'question', questions: [question], answers: { q: 'a' } }));
});

test('an error stays, so a stopped agent still says why', () => {
  assert.ok(isMessage({ ...base, kind: 'system', text: "Claude Code isn't signed in", tone: 'error' }));
});
