import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BUCKETS, MASTER_CHAT_ID, type ActivityBucket, type MachineView } from '../shared/protocol';
import { CardGrid, isLive, MasterBar, SLOT_LABEL } from './Cards';
import { DetailPanel } from './Detail';
import { AttentionPopup, BroadcastOverlay, handlePopupKey, MachinesModal, NewTaskModal } from './Overlays';
import { fmtShort, fmtTokens, getState, goToNextTest, init, pad2, select, setState, useStore } from './store';

const BUCKET_LABEL: Record<ActivityBucket, string> = { thinking: 'working', coding: 'coding', tools: 'tools', building: 'building', testing: 'testing', waiting: 'waiting' };
const BUCKET_COLOR: Record<ActivityBucket, string> = { thinking: 'var(--b-thinking)', coding: 'var(--b-coding)', tools: 'var(--b-tools)', building: 'var(--b-building)', testing: 'var(--b-testing)', waiting: 'var(--b-waiting)' };

function TopBar() {
  const cards = useStore((s) => s.snapshot.cards);
  const filter = useStore((s) => s.filter);
  const openTests = useStore((s) => s.snapshot.testList.filter((t) => !t.done).length);
  const appUpdate = useStore((s) => s.snapshot.appUpdate);
  const present = cards.filter((c) => !c.archived && !c.isMaster);
  const working = present.filter(isLive).length;
  const needsYou = present.filter((c) => c.status === 'attention' || !!c.attention).length;
  const complete = present.filter((c) => c.stage === 'complete').length;
  const tokens = present.reduce((s, c) => s + c.tokens, 0);
  const tps = present.reduce((s, c) => s + c.tps, 0);
  const totals = useMemo(() => {
    const t = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<ActivityBucket, number>;
    for (const c of present) for (const b of BUCKETS) t[b] += c.buckets[b];
    return t;
  }, [present]);
  const sum = BUCKETS.reduce((s, b) => s + totals[b], 0);
  let acc = 0;
  const ring = sum ? BUCKETS.map((b) => {
    const from = (acc / sum) * 100;
    acc += totals[b];
    return `${BUCKET_COLOR[b]} ${from}% ${(acc / sum) * 100}%`;
  }).join(', ') : 'var(--line) 0 100%';
  return (
    <header className="topbar">
      <span className="brand"><span className="brand-mark">◆</span> UE Fleet</span>
      <span className="total-badge">{present.length} TOTAL</span>
      <span className="count c-work">{working} working</span>
      <span className={`count c-attn${needsYou ? ' hot' : ''}`}>{needsYou} need you</span>
      <span className="count c-done">{complete} complete</span>
      {appUpdate && <button className="btn small attn" onClick={() => void window.fleet.applyUpdate()} title="Agents and editors keep running through this." data-app-update>{appUpdate.needsRestart ? 'New version: restart' : 'New version: reload'}</button>}
      <span className="spacer" />
      <div className="filter"><span>/</span><input placeholder="filter" value={filter} onChange={(e) => setState({ filter: e.target.value })} data-filter /></div>
      <span className="metric"><label>tokens used</label><b>{fmtTokens(tokens)}</b></span>
      <span className="metric"><b>{fmtTokens(tps)}/s</b><label>now</label></span>
      <span className="ring" style={{ background: `conic-gradient(${ring})` }} aria-hidden="true" />
      <div className="ring-legend">
        {BUCKETS.map((b) => <span key={b}><i style={{ background: BUCKET_COLOR[b] }} />{BUCKET_LABEL[b]} {fmtShort(totals[b])}</span>)}
      </div>
      <button className="btn primary small" onClick={() => setState({ modal: 'new' })}>new <kbd>Ctrl N</kbd></button>
      <button className="btn small" onClick={() => setState({ broadcastOpen: true })}>all <kbd>Shift ⏎</kbd></button>
      <button className={`btn small${openTests ? ' attn' : ''}`} disabled={!openTests} onClick={goToNextTest} title="Go to the next checklist" data-tests-btn>to test{openTests ? ` ${openTests}` : ''}</button>
      <button className="btn small" onClick={() => setState({ modal: 'machines' })}>machines</button>
    </header>
  );
}

const HOST_UPDATE_TEXT: Record<NonNullable<MachineView['update']>['stage'], string> = {
  sending: 'updating', waiting: 'update waiting on its agents', restarting: 'restarting', failed: 'update failed',
};

function MachineRow({ m }: { m: MachineView }) {
  const cards = useStore((s) => s.snapshot.cards);
  const running = m.slots.filter((s) => ['booting', 'ready', 'pie', 'testing'].includes(s.state));
  const others = m.slots.filter((s) => !running.includes(s));
  const free = Math.max(0, m.info.maxInstances - running.length);
  return (
    <div className={`mach${m.online ? '' : ' off'}`}>
      <span className="mach-name"><span className={m.online ? 'mach-on' : 'mach-off'}>◆</span> {m.info.name}</span>
      <span className="mach-stat">{m.stats ? `CPU ${m.stats.cpu}%` : ''}</span>
      <span className="mach-stat">{m.stats ? `RAM ${m.stats.ramUsedGb}/${m.info.ramGb} GB` : ''}</span>
      <span className="mach-stat">editors {running.length}/{m.info.maxInstances}</span>
      {m.update && <span className="mach-stat mach-update" data-host-update={m.update.stage}>{HOST_UPDATE_TEXT[m.update.stage]}{m.update.stage === 'sending' ? ` ${m.update.percent ?? 0}%` : ''}</span>}
      <div className="slots">
        {[...running, ...others].map((s) => {
          const c = cards.find((x) => x.id === s.agentId);
          return (
            <button key={s.id} className={`slot slot-${s.state}`} title={`${s.dir}${s.detail ? `\n${s.detail}` : ''}`} onClick={() => { if (c) void select(c.id); }}>
              :{s.port} {SLOT_LABEL[s.state]}{c ? ` · ${pad2(c.index)}` : ''}
            </button>
          );
        })}
        {Array.from({ length: Math.min(free, 12) }, (_, i) => <span key={i} className="slot slot-free">free</span>)}
      </div>
    </div>
  );
}

function MachineStrip() {
  const machines = useStore((s) => s.snapshot.machines);
  return (
    <div className="machines-strip">
      {machines.map((m) => <MachineRow key={m.info.id} m={m} />)}
      {machines.length < 2 && <button className="link-btn add-mach" onClick={() => setState({ modal: 'machines' })}>+ link another machine</button>}
    </div>
  );
}

function Splitter({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const dragging = useRef(false);
  useEffect(() => {
    const move = (e: MouseEvent) => { if (dragging.current) onChange(Math.min(Math.max(420, window.innerWidth - e.clientX), window.innerWidth - 360)); };
    const up = () => { dragging.current = false; document.body.classList.remove('resizing'); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [onChange, width]);
  return <div className="splitter" role="separator" aria-orientation="vertical" onMouseDown={() => { dragging.current = true; document.body.classList.add('resizing'); }} />;
}

function readWidth() {
  try { return Number(localStorage.getItem('detailWidth')) || 640; } catch { return 640; }
}

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = getState();
      // Capture phase, so these win no matter which control has focus.
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) {
        if (s.broadcastOpen) return; // Inside the broadcast box it's a plain new line.
        e.preventDefault();
        e.stopPropagation();
        setState({ broadcastOpen: true, modal: null });
        return;
      }
      if (e.key === 'Escape' && s.broadcastOpen) { e.preventDefault(); e.stopPropagation(); setState({ broadcastOpen: false }); return; }
      if (e.key === 'Escape' && s.modal) { e.preventDefault(); e.stopPropagation(); setState({ modal: null }); return; }
      if (!s.broadcastOpen && !s.modal && handlePopupKey(e)) { e.stopPropagation(); return; }
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); setState({ modal: 'new' }); return; }
      if (e.ctrlKey && e.key === '0') { e.preventDefault(); void select(MASTER_CHAT_ID); return; }
      if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
        const visible = s.snapshot.cards.filter((c) => !c.archived && !c.isMaster);
        const c = visible[Number(e.key) - 1];
        if (c) { e.preventDefault(); void select(c.id); }
        return;
      }
      if (!s.broadcastOpen && !s.modal && /^[1-4]$/.test(e.key) && !e.ctrlKey && !e.altKey) answerPrompt(e);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

// With the composer empty, number keys answer whatever the selected agent is asking.
function answerPrompt(e: KeyboardEvent) {
  const s = getState();
  const active = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null;
  if (active && (active.tagName === 'INPUT' || (active.tagName === 'TEXTAREA' && active.value))) return;
  const card = s.snapshot.cards.find((c) => c.id === s.selectedId);
  const ref = card?.attention?.ref;
  if (!card || !ref) return;
  const n = Number(e.key);
  if (card.attention!.kind === 'permission') {
    const decision = n === 1 ? 'allow' : n === 2 ? 'always' : n === 3 ? 'deny' : null;
    if (decision) { e.preventDefault(); void window.fleet.call('decide', card.id, ref, decision); }
  } else if (card.attention!.kind === 'question') {
    const btn = document.querySelectorAll<HTMLButtonElement>(`[data-question="${ref}"] .q-option`)[n - 1];
    if (btn) { e.preventDefault(); btn.click(); }
  }
}

function App() {
  const ready = useStore((s) => s.ready);
  const demo = useStore((s) => s.snapshot.demo);
  const [width, setWidth] = useState(readWidth);
  useGlobalKeys();
  useEffect(() => { try { localStorage.setItem('detailWidth', String(width)); } catch { /* not important */ } }, [width]);
  if (!ready) return <div className="boot">Starting…</div>;
  return (
    <div className="app">
      {demo && <div className="demo-flag">Demo mode. Agents are scripted, and no tokens are used.</div>}
      <TopBar />
      <MachineStrip />
      <div className="workspace" style={{ gridTemplateColumns: `minmax(0, 1fr) 5px ${width}px` }}>
        <main className="left">
          <MasterBar />
          <CardGrid />
          <AttentionPopup />
        </main>
        <Splitter width={width} onChange={setWidth} />
        <DetailPanel />
      </div>
      <BroadcastOverlay />
      <NewTaskModal />
      <MachinesModal />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
void init();
