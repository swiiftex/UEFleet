import { memo, useMemo } from 'react';
import { BUCKETS, FLOW_STAGES, modelLabel, type ActivityBucket, type AgentCard, type AgentStatus, type MachineView, type SlotInfo } from '../shared/protocol';
import { fmtAgo, fmtDuration, fmtShort, fmtTokens, pad2, select, setState, useStore } from './store';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  queued: 'QUEUED', provisioning: 'PREPARING', working: 'WORKING', tools: 'TOOLS', coding: 'CODING', building: 'BUILDING', testing: 'TESTING',
  'waiting-instance': 'WAITING', attention: 'NEEDS YOU', blocked: 'BLOCKED', idle: 'IDLE', finished: 'FINISHED', error: 'ERROR', stopped: 'STOPPED',
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

// Stopped and failed say so, since those aren't places in the flow. Anything else is where it's up to,
// plus whether it's waiting on you.
export function stageLabel(c: AgentCard) {
  if (c.status === 'stopped' || c.status === 'error' || c.status === 'blocked') return STATUS_LABEL[c.status];
  const stage = FLOW_STAGES.find((s) => s.id === c.stage)?.label.toUpperCase() ?? STATUS_LABEL[c.status];
  return c.attention ? `${stage} · NEEDS YOU` : stage;
}

export function FlowSteps({ c, labelled }: { c: AgentCard; labelled?: boolean }) {
  const at = FLOW_STAGES.findIndex((s) => s.id === (c.stage ?? 'preparing'));
  const paused = !!c.attention || c.status === 'stopped' || c.status === 'error' || c.status === 'blocked';
  return (
    <ol className={`flow-steps${labelled ? ' labelled' : ''}`} aria-label={`Stage: ${FLOW_STAGES[at]?.label}`}>
      {FLOW_STAGES.map((s, i) => <li key={s.id} title={s.label} className={i < at ? 'done' : i === at ? (c.stage === 'complete' ? 'done' : paused ? 'now paused' : 'now') : ''}>{labelled && <span>{s.label}</span>}</li>)}
    </ol>
  );
}

export function MasterBar() {
  const c = useStore((s) => s.snapshot.cards.find((x) => x.isMaster));
  const selected = useStore((s) => s.selectedId === c?.id);
  if (!c) return null;
  return (
    <button className={`master-bar s-${c.status}${selected ? ' selected' : ''}`} onClick={() => void select(c.id)} data-card={c.id} data-master-bar>
      <StatusGlyph c={c} />
      <span className="master-name">Master chat</span>
      <kbd>Ctrl 0</kbd>
      <span className="master-msg">{c.attention?.text ?? (c.lastText || 'New tasks come here first, and agents ask it for anything only this PC can reach.')}</span>
      {c.tokens > 0 && <span className="master-tokens">{fmtTokens(c.tokens)}</span>}
    </button>
  );
}

function TaskProgress({ c }: { c: AgentCard }) {
  const percent = c.final ? 100 : c.progress;
  return (
    <div className="card-progress" role="progressbar" aria-label="Task progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div className="progress-track"><span className="progress-fill" style={{ width: `${percent ?? 0}%` }} /></div>
      <span className="progress-text">{percent == null ? '–' : `${percent}%`}</span>
    </div>
  );
}

function StatusGlyph({ c }: { c: AgentCard }) {
  if (c.status === 'finished') return <span className="glyph glyph-done">✓</span>;
  if (c.status === 'attention') return <span className="glyph glyph-attn">!</span>;
  if (c.status === 'blocked') return <span className="glyph glyph-blocked">■</span>;
  if (c.status === 'error') return <span className="glyph glyph-err">×</span>;
  if (isLive(c)) return <span className="glyph-ring" />;
  return <span className="glyph glyph-idle">·</span>;
}

export const Card = memo(function Card({ c, selected, now, machine }: { c: AgentCard; selected: boolean; now: number; machine?: MachineView }) {
  const slot = c.slot;
  const showTps = c.tps > 0.5;
  return (
    <button className={`card s-${c.status}${selected ? ' selected' : ''}${c.isWorkspace ? ' workspace' : ''}`} onClick={() => void select(c.id)} data-card={c.id}>
      <div className="card-head">
        <StatusGlyph c={c} />
        <span className="card-num">{pad2(c.index)}</span>
        <span className="card-title">{c.title}</span>
        <span className="card-status" data-stage={c.stage}>{stageLabel(c)}</span>
      </div>
      {!c.isWorkspace && <FlowSteps c={c} />}
      {!c.isWorkspace && <TaskProgress c={c} />}
      <div className="card-msg">
        <span className="card-msg-text">{c.attention?.text && c.status === 'attention' ? c.attention.text : (c.detail && c.status === 'provisioning' ? c.detail : c.lastText || 'Starting…')}</span>
        <span className="card-msg-age">{fmtAgo(c.lastTextAt || c.createdAt, now)}</span>
      </div>
      <div className="card-meta">
        <span className="dot-model" />
        <span className="card-model">{modelLabel(c.model)} <em>@{c.effort}</em></span>
        <span className="card-tag">{machine?.info.name ?? 'offline'}</span>
        {c.holdingWorkspace && <span className="card-tag tag-workspace" data-holding>agents paused</span>}
        {c.pausedForWorkspace && <span className="card-tag tag-workspace">paused</span>}
        {c.onApiCredits && <span className="card-tag tag-credits" data-on-credits>API credits</span>}
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

  const tasks = cards.filter((c) => !c.archived && !c.isMaster);
  const pinned = tasks.filter((c) => c.isWorkspace);
  const visible = tasks.filter((c) => !c.isWorkspace).filter((c) => !filter || `${c.title} ${c.project} ${c.stage} ${c.status} ${c.lastPrompt}`.toLowerCase().includes(filter.toLowerCase()));
  if (!tasks.length) {
    return (
      <div className="empty">
        <h2>No tasks running</h2>
        <p>Say what needs doing and the master chat picks the best PC. Each task gets its own Unreal editor, and they all work from the project's own files.</p>
        <button className="btn primary" onClick={() => setState({ modal: 'new' })}>New task <kbd>Ctrl N</kbd></button>
      </div>
    );
  }
  return (
    <div className="grid-scroll">
      {pinned.length > 0 && (
        <section data-pinned>
          <h3 className="group-head workspace-head"><span>◆</span> Workspace chat <span>can merge, switch and update your workspace</span></h3>
          <div className="card-grid">
            {pinned.map((c) => <Card key={c.id} c={c} selected={c.id === selectedId} now={now} machine={machines.find((m) => m.info.id === c.nodeId)} />)}
          </div>
        </section>
      )}
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
