import { memo, useMemo } from 'react';
import { BUCKETS, modelLabel, type ActivityBucket, type AgentCard, type AgentStatus, type MachineView, type SlotInfo } from '../shared/protocol';
import { fmtAgo, fmtDuration, fmtShort, fmtTokens, pad2, select, setState, useStore } from './store';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  queued: 'QUEUED', provisioning: 'COPYING', working: 'WORKING', tools: 'TOOLS', coding: 'CODING', building: 'BUILDING', testing: 'TESTING',
  'waiting-instance': 'WAITING', attention: 'NEEDS YOU', idle: 'IDLE', finished: 'FINISHED', error: 'ERROR', stopped: 'STOPPED',
};

export const SLOT_LABEL: Record<SlotInfo['state'], string> = {
  empty: 'empty', syncing: 'copying', cold: 'off', queued: 'queued', booting: 'booting', ready: 'ready', pie: 'PIE', building: 'build', testing: 'tests', crashed: 'crashed',
};

const LIVE: AgentStatus[] = ['queued', 'provisioning', 'working', 'tools', 'coding', 'building', 'testing', 'waiting-instance'];
export const isLive = (c: AgentCard) => LIVE.includes(c.status);

const SPARK_WINDOW = 48;

function Sparkline({ points }: { points: number[] }) {
  const { line, area } = useMemo(() => {
    if (points.length < 2) return { line: '', area: '' };
    const w = 200;
    const h = 30;
    const max = Math.max(...points, 1);
    // A fixed time window, newest on the right, so a new card doesn't stretch two samples across it.
    const step = w / (SPARK_WINDOW - 1);
    const startX = w - (points.length - 1) * step;
    const xy = points.map((p, i) => [startX + i * step, h - 2 - (p / max) * (h - 5)]);
    const l = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    return { line: l, area: `${l} L${w} ${h} L${startX.toFixed(1)} ${h} Z` };
  }, [points]);
  return (
    <svg className="spark" viewBox="0 0 200 30" preserveAspectRatio="none" aria-hidden="true">
      {area && <path d={area} className="spark-area" />}
      {line ? <path d={line} className="spark-line" vectorEffect="non-scaling-stroke" /> : <path d="M0 28 L200 28" className="spark-flat" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

export function BucketBar({ buckets }: { buckets: Record<ActivityBucket, number> }) {
  const total = BUCKETS.reduce((s, b) => s + buckets[b], 0);
  return (
    <div className="bucket-bar" aria-hidden="true">
      {total > 0 ? BUCKETS.map((b) => (buckets[b] > 0 ? <span key={b} className={`seg b-${b}`} style={{ flexGrow: buckets[b] }} /> : null)) : <span className="seg seg-empty" style={{ flexGrow: 1 }} />}
    </div>
  );
}

function StatusGlyph({ c }: { c: AgentCard }) {
  if (c.status === 'finished') return <span className="glyph glyph-done">✓</span>;
  if (c.status === 'attention') return <span className="glyph glyph-attn">!</span>;
  if (c.status === 'error') return <span className="glyph glyph-err">×</span>;
  if (isLive(c)) return <span className="glyph-ring" />;
  return <span className="glyph glyph-idle">·</span>;
}

export const Card = memo(function Card({ c, selected, now, machine }: { c: AgentCard; selected: boolean; now: number; machine?: MachineView }) {
  const slot = c.slot;
  const showTps = c.tps > 0.5;
  return (
    <button className={`card s-${c.status}${selected ? ' selected' : ''}`} onClick={() => void select(c.id)} data-card={c.id}>
      <div className="card-head">
        <StatusGlyph c={c} />
        <span className="card-num">{pad2(c.index)}</span>
        <span className="card-title">{c.title}</span>
        <span className="card-status">{STATUS_LABEL[c.status]}</span>
      </div>
      <div className="card-msg">
        <span className="card-msg-text">{c.attention?.text && c.status === 'attention' ? c.attention.text : (c.detail && c.status === 'provisioning' ? c.detail : c.lastText || 'Starting…')}</span>
        <span className="card-msg-age">{fmtAgo(c.lastTextAt || c.createdAt, now)}</span>
      </div>
      <div className="card-meta">
        <span className="dot-model" />
        <span className="card-model">{modelLabel(c.model)} <em>@{c.effort}</em></span>
        <span className="card-tag">{machine?.info.name ?? 'offline'}</span>
        {slot && <span className={`card-tag slot-${slot.state}`}>{slot.state === 'cold' || slot.state === 'syncing' ? SLOT_LABEL[slot.state] : `UE :${slot.port} ${SLOT_LABEL[slot.state]}`}</span>}
      </div>
      <div className="card-path">{c.project ?? 'no project'}{slot?.progress != null ? ` · copying ${Math.round(slot.progress * 100)}%` : ''}</div>
      <div className="card-spark">
        <Sparkline points={c.spark} />
        <span className="card-tps">{showTps ? `${fmtTokens(c.tps)} tok/s` : isLive(c) ? c.detail ?? 'working' : `idle ${fmtAgo(c.lastTextAt || c.createdAt, now)}`}</span>
      </div>
      <div className="card-prompt"><span className="prompt-mark">›</span><span className="prompt-text">{c.lastPrompt}</span><span className="card-msg-age">{fmtAgo(c.lastPromptAt, now)}</span></div>
      <div className="card-stats">
        <div><label>SESSION</label><b>{fmtDuration(c.sessionMs)}</b></div>
        <div><label>TOKENS</label><b>{fmtTokens(c.tokens)}</b></div>
        <div><label>CONTEXT</label><b>{fmtTokens(c.usage.context)}</b></div>
      </div>
      <BucketBar buckets={c.buckets} />
      <div className="card-legend">
        {BUCKETS.filter((b) => c.buckets[b] >= 1000).map((b) => <span key={b}><i className={`b-${b}`} />{fmtShort(c.buckets[b])}</span>)}
      </div>
    </button>
  );
});

export function CardGrid() {
  const cards = useStore((s) => s.snapshot.cards);
  const machines = useStore((s) => s.snapshot.machines);
  const selectedId = useStore((s) => s.selectedId);
  const filter = useStore((s) => s.filter);
  const now = useStore((s) => s.now);

  const visible = cards.filter((c) => !c.archived && (!filter || `${c.title} ${c.project} ${c.status} ${c.lastPrompt}`.toLowerCase().includes(filter.toLowerCase())));
  if (!visible.length && !cards.filter((c) => !c.archived).length) {
    return (
      <div className="empty">
        <h2>No tasks running</h2>
        <p>Each task gets its own copy of the project and its own Unreal editor, so tasks never wait on each other.</p>
        <button className="btn primary" onClick={() => setState({ modal: 'new' })}>New task <kbd>Ctrl N</kbd></button>
      </div>
    );
  }
  return (
    <div className="grid-scroll">
      {machines.map((m) => {
        const mine = visible.filter((c) => c.nodeId === m.info.id);
        if (!mine.length) return null;
        const live = mine.filter(isLive).length;
        return (
          <section key={m.info.id}>
            <h3 className="group-head"><span className={m.online ? 'mach-on' : 'mach-off'}>◆</span> {m.info.name} <span>{mine.length}</span> <span>{live} live</span></h3>
            <div className="card-grid">
              {mine.map((c) => <Card key={c.id} c={c} selected={c.id === selectedId} now={now} machine={m} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}
