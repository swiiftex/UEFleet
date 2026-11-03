import { useSyncExternalStore } from 'react';
import { DEFAULT_PERMISSION_MODE, MASTER_CHAT_ID, type AgentCard, type FleetSnapshot, type HubEvent, type TranscriptItem } from '../shared/protocol';

declare global {
  interface Window {
    fleet: {
      call: <T = any>(method: string, ...args: unknown[]) => Promise<T>;
      onEvent: (fn: (e: HubEvent) => void) => void;
      onSelect: (fn: (id: string) => void) => void;
      pickProject: () => Promise<string | null>;
      copy: (t: string) => Promise<void>;
      reveal: (p: string) => Promise<void>;
      applyUpdate: () => Promise<void>;
      setApiKey: (key: string | null) => Promise<string | null>;
    };
  }
}

export type Modal = 'new' | 'machines' | null;

export interface UiState {
  ready: boolean;
  snapshot: FleetSnapshot;
  selectedId: string | null;
  transcripts: Record<string, TranscriptItem[]>;
  dismissed: Record<string, number>;
  modal: Modal;
  broadcastOpen: boolean;
  allDone: { count: number; at: number } | null;
  filter: string;
  focusTick: number;
  now: number;
  messagesOnly: boolean;
}

const empty: FleetSnapshot = { cards: [], machines: [], broadcasts: [], pairing: null, testList: [], defaults: { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: DEFAULT_PERMISSION_MODE, instanceMode: 'offscreen', projectFile: null }, hostAppPath: null, demo: false };

function savedMessagesOnly() {
  try { return localStorage.getItem('messagesOnly') === '1'; } catch { return false; }
}

let state: UiState = { ready: false, snapshot: empty, selectedId: null, transcripts: {}, dismissed: {}, modal: null, broadcastOpen: false, allDone: null, filter: '', focusTick: 0, now: Date.now(), messagesOnly: savedMessagesOnly() };
const listeners = new Set<() => void>();

export function setState(patch: Partial<UiState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const getState = () => state;
export function useStore<T>(pick: (s: UiState) => T): T {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => pick(state));
}

function mergeCards(cards: AgentCard[]) {
  const byId = new Map(state.snapshot.cards.map((c) => [c.id, c]));
  for (const c of cards) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => a.index - b.index);
}

function applyTranscript(e: Extract<HubEvent, { e: 'transcript' }>) {
  const current = state.transcripts[e.agentId];
  if (!current) return;
  const next = [...current];
  for (const item of e.items) {
    const i = next.findIndex((x) => x.id === item.id);
    if (i >= 0) next[i] = item;
    else next.push(item);
  }
  for (const d of e.deltas) {
    const i = next.findIndex((x) => x.id === d.id);
    const it = next[i];
    if (it && (it.kind === 'assistant' || it.kind === 'thinking')) next[i] = { ...it, text: it.text + d.text };
  }
  setState({ transcripts: { ...state.transcripts, [e.agentId]: next } });
}

export function handleEvent(e: HubEvent) {
  const s = state.snapshot;
  switch (e.e) {
    case 'snapshot': setState({ snapshot: e.snapshot }); break;
    case 'cards': setState({ snapshot: { ...s, cards: mergeCards(e.cards) } }); break;
    case 'machines': setState({ snapshot: { ...s, machines: e.machines } }); break;
    case 'broadcasts': setState({ snapshot: { ...s, broadcasts: [...e.broadcasts] } }); break;
    case 'tests': setState({ snapshot: { ...s, testList: e.testList } }); break;
    case 'transcript': applyTranscript(e); break;
    case 'all-done': if (e.count > 0) setState({ allDone: { count: e.count, at: Date.now() } }); break;
    case 'api-credits': setState({ snapshot: { ...s, apiCredits: e.view } }); break;
    case 'master-memory': setState({ snapshot: { ...s, masterMemory: e.memory } }); break;
    case 'preferred-machine': setState({ snapshot: { ...s, preferredMachine: e.id } }); break;
    case 'plan-usage': setState({ snapshot: { ...s, planUsage: e.meters } }); break;
    // Someone watching the master chat follows the request to the agent it started.
    case 'task-started': if (state.selectedId === MASTER_CHAT_ID) void select(e.id); break;
    case 'app-update':
      setState({ snapshot: { ...s, appUpdate: e.update } });
      // New screens load straight away unless that would lose something being typed.
      if (e.update && !e.update.needsRestart && !somethingTyped()) void window.fleet.applyUpdate();
      break;
  }
}

function somethingTyped() {
  return state.modal !== null || state.broadcastOpen || [...document.querySelectorAll('textarea')].some((t) => t.value.trim());
}

export async function init() {
  window.fleet.onEvent(handleEvent);
  window.fleet.onSelect((id) => void select(id));
  const snapshot = await window.fleet.call<FleetSnapshot>('snapshot');
  // After a reload or a new version, stay on the same chat.
  const live = snapshot.cards.filter((c) => !c.archived);
  const saved = savedSelection();
  const first = live.find((c) => c.id === saved) ?? live.find((c) => !c.isMaster) ?? live[0];
  setState({ snapshot, ready: true, selectedId: first?.id ?? null });
  if (first) await select(first.id);
  setInterval(() => setState({ now: Date.now() }), 1000);
}

function savedSelection() {
  try { return localStorage.getItem('selectedCard'); } catch { return null; }
}

export async function select(id: string) {
  try { localStorage.setItem('selectedCard', id); } catch { /* not important */ }
  setState({ selectedId: id, focusTick: state.focusTick + 1 });
  const items = await window.fleet.call<TranscriptItem[]>('transcript', id).catch(() => []);
  setState({ transcripts: { ...state.transcripts, [id]: items } });
  const card = state.snapshot.cards.find((c) => c.id === id);
  // Looking at it is what "attention" was asking for, unless a prompt still needs an answer. Either
  // way it has been seen, so it doesn't pop up again on the way to something else.
  if (card?.attention && !card.attention.ref) {
    dismissPopup(card);
    void window.fleet.call('dismissAttention', id);
  }
}

// Oldest first, so nothing waiting gets buried by newer events.
export function attentionQueue(s: UiState): AgentCard[] {
  return s.snapshot.cards
    .filter((c) => c.attention && !c.archived && c.id !== s.selectedId && s.dismissed[c.id] !== c.attention.at)
    .sort((a, b) => a.attention!.at - b.attention!.at);
}

export function dismissPopup(card: AgentCard) {
  setState({ dismissed: { ...state.dismissed, [card.id]: card.attention!.at } });
}

// The tests button and the all-done popup both land on the next checklist that isn't finished.
export function goToNextTest() {
  const next = state.snapshot.testList.find((t) => !t.done);
  if (next) void select(next.agentId);
}

export function setMessagesOnly(on: boolean) {
  try { localStorage.setItem('messagesOnly', on ? '1' : '0'); } catch { /* not important */ }
  setState({ messagesOnly: on, focusTick: state.focusTick + 1 });
}

// What stays when the chat shows only messages. A prompt still waiting stays because the agent is
// stuck until it's answered, and an error stays because an agent that stopped would otherwise leave
// nothing to say why.
export function isMessage(item: TranscriptItem) {
  switch (item.kind) {
    case 'user': case 'assistant': case 'final': return true;
    case 'permission': return !item.decided;
    case 'question': return !item.answers;
    case 'system': return !!item.message || item.tone === 'error';
    default: return false;
  }
}

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
export function fmtDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
export function fmtShort(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${(m / 60).toFixed(1)}h`;
}
export function fmtAgo(at: number, now: number) {
  if (!at) return '';
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}
export const pad2 = (n: number) => String(n).padStart(2, '0');
