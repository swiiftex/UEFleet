import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { describeLock, MASTER_PERMISSION_MODES, modelLabel, type AgentCard, type BlockedState, type ChangedFile, type FinalReport, type ImageAttachment, type Question, type TranscriptItem } from '../shared/protocol';
import { FlowSteps, isLive, stageLabel } from './Cards';
import { fmtDuration, getState, isMessage, pad2, setMessagesOnly, useStore } from './store';

marked.setOptions({ gfm: true, breaks: false });

const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

function toolLabel(name: string, input: any): { name: string; summary: string } {
  if (name.startsWith('mcp__fleet__')) {
    const n = name.slice('mcp__fleet__'.length);
    if (n === 'ue_call') return { name: 'UE', summary: `${input?.tool_name ?? ''}${input?.arguments && Object.keys(input.arguments).length ? ' …' : ''}` };
    return { name: 'UE', summary: n.replace(/^ue_/, '').replaceAll('_', ' ') };
  }
  const summary = input?.file_path ?? input?.command ?? input?.pattern ?? input?.url ?? input?.description ?? input?.query ?? '';
  return { name: name.replace(/^mcp__[^_]+__/, ''), summary: String(summary) };
}

function ToolRow({ item }: { item: Extract<TranscriptItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const { name, summary } = toolLabel(item.name, item.input);
  return (
    <div className={`tool t-${item.state}${item.sub ? ' sub' : ''}`}>
      <button className="tool-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-dot" />
        <span className="tool-name">{name}</span>
        <span className="tool-summary">{summary}</span>
        {item.ms != null && <span className="tool-ms">{fmtDuration(item.ms)}</span>}
      </button>
      {open && (
        <div className="tool-body">
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
          {item.result && <pre className="tool-result">{item.result}</pre>}
        </div>
      )}
      {item.images?.map((src, i) => <img key={i} className="tool-image" src={src} alt="Screenshot from the tool" />)}
    </div>
  );
}

function PermissionCard({ agentId, item }: { agentId: string; item: Extract<TranscriptItem, { kind: 'permission' }> }) {
  const decide = (d: 'allow' | 'always' | 'deny') => void window.fleet.call('decide', agentId, item.id, d);
  const { summary } = toolLabel(item.tool, item.input);
  if (item.decided) return <div className="sys">{item.tool}: {item.decided === 'deny' ? 'denied' : item.decided === 'always' ? 'allowed from now on' : 'allowed'}</div>;
  return (
    <div className="prompt-card" data-permission={item.id}>
      <div className="prompt-title">Allow {item.tool}?</div>
      {summary && <pre className="prompt-input">{summary}</pre>}
      {item.reason && <div className="prompt-reason">{item.reason}</div>}
      <div className="prompt-actions">
        <button className="btn primary" onClick={() => decide('allow')}><kbd>1</kbd> Allow</button>
        {item.canAlways && <button className="btn" onClick={() => decide('always')}><kbd>2</kbd> Always allow</button>}
        <button className="btn" onClick={() => decide('deny')}><kbd>3</kbd> Deny</button>
      </div>
    </div>
  );
}

function QuestionCard({ agentId, item }: { agentId: string; item: Extract<TranscriptItem, { kind: 'question' }> }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  if (item.answers) return <div className="sys">Answered: {Object.values(item.answers).join(' · ')}</div>;
  const submit = (override?: Record<string, string[]>) => {
    const answers: Record<string, string> = {};
    for (const q of item.questions) {
      const chosen = [...(override?.[q.question] ?? picked[q.question] ?? [])];
      if (other[q.question]?.trim()) chosen.push(other[q.question].trim());
      answers[q.question] = chosen.join(', ');
    }
    void window.fleet.call('answer', agentId, item.id, answers);
  };
  const toggle = (q: Question, label: string) => {
    const cur = picked[q.question] ?? [];
    const next = q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
    const all = { ...picked, [q.question]: next };
    setPicked(all);
    if (!q.multiSelect && item.questions.length === 1) submit(all);
  };
  return (
    <div className="prompt-card" data-question={item.id}>
      {item.questions.map((q) => (
        <div className="q-block" key={q.question}>
          <div className="prompt-title">{q.question}</div>
          <div className="q-options">
            {q.options.map((o, i) => (
              <button key={o.label} className={`q-option${picked[q.question]?.includes(o.label) ? ' on' : ''}`} onClick={() => toggle(q, o.label)}>
                <kbd>{i + 1}</kbd><span><b>{o.label}</b>{o.description && <small>{o.description}</small>}</span>
              </button>
            ))}
          </div>
          <input className="q-other" placeholder="Other…" value={other[q.question] ?? ''} onChange={(e) => setOther({ ...other, [q.question]: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
        </div>
      ))}
      {(item.questions.length > 1 || item.questions.some((q) => q.multiSelect)) && <div className="prompt-actions"><button className="btn primary" onClick={() => submit()}>Submit</button></div>}
    </div>
  );
}

function FinalCard({ report }: { report: FinalReport }) {
  return (
    <div className="final-card">
      <div className="final-head">Finished</div>
      <p className="final-summary">{report.summary}</p>
      {report.verified.length > 0 && (
        <details className="final-verified"><summary>What the agent already checked ({report.verified.length})</summary><ul>{report.verified.map((v) => <li key={v}>{v}</li>)}</ul></details>
      )}
      {!report.verified.length && <p className="final-warn">The agent reported no checks of its own, so treat this as untested.</p>}
    </div>
  );
}

const Item = memo(function Item({ item, card }: { item: TranscriptItem; card: AgentCard }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className={`msg-user${item.broadcastId ? ' broadcast' : ''}${item.from ? ' from-other' : ''}`}>
          {item.broadcastId && <span className="msg-tag">to all</span>}
          {item.from && <span className="msg-tag">from {item.from}</span>}
          {item.images?.map((src, i) => <img key={i} src={src} alt="Attachment" />)}
          <div className="msg-user-text">{item.text}</div>
        </div>
      );
    case 'assistant':
      return item.text ? <div className="msg-assistant"><Markdown text={item.text} /></div> : null;
    case 'thinking':
      return item.text ? <details className="thinking"><summary>Thinking</summary><div>{item.text}</div></details> : null;
    case 'tool': return <ToolRow item={item} />;
    case 'permission': return <PermissionCard agentId={card.id} item={item} />;
    case 'question': return <QuestionCard agentId={card.id} item={item} />;
    case 'system': return <div className={`sys tone-${item.tone ?? 'info'}`}>{item.text}</div>;
    case 'final': return <FinalCard report={item.report} />;
  }
});

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

// One plain sentence: what's happening with this task and where its files are right now.
function flowText(c: AgentCard, machine: string) {
  const inPlace = !!c.slot?.shared && c.nodeId === 'master';
  const where = !c.slot ? null : inPlace ? 'your workspace' : c.slot.shared ? `the project folder on ${machine}` : `its private copy on ${machine}`;
  const merged = c.merge?.files ?? 0;
  if (c.status === 'stopped') return `Stopped.${where ? ` Its files are in ${where}.` : ''} Message it to carry on.`;
  if (c.blocked) return `Blocked: ${c.attention?.text ?? 'a package it needs is locked.'}`;
  if (c.attention && !c.final) return `Paused: ${c.attention.text}`;
  switch (c.stage) {
    case 'preparing': return 'Getting ready. Nothing has changed yet.';
    case 'building': return `The agent is making the change.${where ? ` Its files are in ${where}.` : ''}`;
    case 'testing':
      if (!c.final) return 'The agent is testing its own change.';
      if (!c.project) return 'Your turn to test.';
      if (inPlace) return 'Your turn to test. Its files are already in your workspace.';
      return merged ? `Your turn to test. ${plural(merged, 'file')} from ${machine} are in your workspace.` : `Your turn to test. Its files are still in ${where ?? machine}. Open editor brings them into your workspace first.`;
    case 'awaiting-merge':
      if (c.merge?.conflicts?.length) return `Paused: ${plural(c.merge.conflicts.length, 'file')} couldn't be merged with your workspace. Choose which to keep.`;
      if (c.merge?.error) return `Paused: couldn't merge. ${c.merge.error}`;
      return `Approved. Bringing its files from ${where ?? machine} into your workspace.`;
    case 'merged': return `${plural(merged, 'file')} are in your workspace.`;
    case 'checking-in': return `${plural(merged, 'file')} are in your workspace. The master chat is putting them in a Plastic changelist.`;
    case 'complete':
      if (c.changelist) return `Done. ${plural(merged, 'file')} are in the Plastic changelist "${c.changelist}". Check it in from Plastic when you're ready.`;
      return c.project && merged ? `Done. ${plural(merged, 'file')} are in your workspace, ready to check in.` : 'Done.';
    default: return '';
  }
}

const TEST_RUN_TEXT: Record<NonNullable<AgentCard['testRun']>['stage'], string> = {
  pulling: 'Bringing its files into your workspace…',
  building: "Compiling… If the engine is out of date this rebuilds the editor too, which takes longer.",
  opening: "Opening the editor, after compiling if it's out of date…",
  open: "The editor is opening in its own window. It's a real editor with your settings, so you can change things in it.",
  'already-open': "You already have an editor open on this project. Close it and press Open editor again to load these changes, because it keeps the code it started with.",
  failed: "That didn't work:",
};

function Checklist({ card }: { card: AgentCard }) {
  const tests = useStore((s) => s.snapshot.testList).filter((t) => t.agentId === card.id);
  const [issue, setIssue] = useState<string | null>(null);
  useEffect(() => { setIssue(null); }, [card.id]);
  const run = card.testRun;
  const busy = !!run && ['pulling', 'building', 'opening'].includes(run.stage);
  const left = tests.filter((t) => !t.done).length;
  return (
    <div className="checklist" data-checklist>
      {tests.length ? (
        <ol className="checks">
          {tests.map((t) => (
            <li key={t.key} className={t.done ? 'done' : ''}>
              <label>
                <input type="checkbox" checked={t.done} onChange={(e) => void window.fleet.call('setTestDone', t.key, e.target.checked)} />
                <div>
                  <b>{t.test.what}</b>
                  {t.test.how && <p>{t.test.how}</p>}
                  {t.test.expect && <p className="expect">You should see: {t.test.expect}</p>}
                </div>
              </label>
            </li>
          ))}
        </ol>
      ) : <p className="final-warn">The agent didn't list anything to test and didn't check its own work, so look it over yourself.</p>}
      {run && <div className={`test-run${run.stage === 'failed' ? ' failed' : ''}`} data-test-run={run.stage}>{TEST_RUN_TEXT[run.stage]}{run.detail && <pre>{run.detail}</pre>}</div>}
      {issue === null ? (
        <div className="prompt-actions">
          {card.project && <button className="btn" disabled={busy} onClick={() => void window.fleet.call('testChanges', card.id)} data-open-editor>{busy ? 'Working…' : 'Open editor'}</button>}
          <button className="btn primary" onClick={() => void window.fleet.call('approve', card.id)} data-approve>Approve (tested){left && tests.length ? ` · ${left} not ticked` : ''}</button>
          <button className="btn" onClick={() => setIssue('')} data-issue>Issue found</button>
        </div>
      ) : (
        <div className="issue-box">
          <textarea autoFocus rows={3} value={issue} placeholder="What's not right? This goes straight back to the agent." onChange={(e) => setIssue(e.target.value)} data-issue-text />
          <div className="prompt-actions">
            <button className="btn primary" disabled={!issue.trim()} onClick={() => { void window.fleet.call('reportIssue', card.id, issue.trim()); setIssue(null); }} data-issue-send>Send back to the agent</button>
            <button className="btn" onClick={() => setIssue(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function BlockedPanel({ card, blocked }: { card: AgentCard; blocked: BlockedState }) {
  return (
    <div className="blocked-panel" data-blocked>
      <ul className="change-list">{blocked.locks.map((l) => <li key={`${l.path}:${l.by}`}><span className="chg-path">{l.path}</span><small data-lock-holder>{describeLock(l)}</small></li>)}</ul>
      {blocked.why && <p className="blocked-why">{blocked.why}</p>}
      {blocked.plan && <p className="blocked-plan" data-blocked-plan>{blocked.plan}</p>}
      <div className="prompt-actions">
        <button className="btn primary" onClick={() => void window.fleet.call('checkBlocked', card.id)} data-check-blocked>Check again</button>
        {blocked.canPause && <button className="btn" onClick={() => void window.fleet.call('mergeBlockedNow', card.id)} data-merge-now>Pause them and merge now</button>}
        <button className="btn" onClick={() => void window.fleet.call('carryOnPastBlock', card.id)} data-carry-on>Carry on anyway</button>
      </div>
    </div>
  );
}

// Always at the top of a task, so there's one place that says what's going on and what you need to do.
function FlowPanel({ card }: { card: AgentCard }) {
  const machine = useStore((s) => s.snapshot.machines.find((m) => m.info.id === card.nodeId)?.info.name ?? 'that machine');
  const conflicts = card.merge?.conflicts ?? [];
  return (
    <section className="flow" data-flow={card.stage}>
      <FlowSteps c={card} labelled />
      <p className="flow-text" data-flow-text>{flowText(card, machine)}</p>
      {card.blocked && <BlockedPanel card={card} blocked={card.blocked} />}
      {conflicts.length > 0 && (
        <div className="conflicts" data-conflicts>
          <ul className="change-list">{conflicts.map((c) => <li key={c.path}><span className="chg-path">{c.path}</span><small>{c.reason}</small></li>)}</ul>
          <div className="prompt-actions">
            <button className="btn primary" onClick={() => void window.fleet.call('resolveConflicts', card.id, 'agent')} data-use-agents>Use the agent's changes</button>
            <button className="btn" onClick={() => void window.fleet.call('resolveConflicts', card.id, 'mine')} data-keep-mine>Keep mine</button>
            <button className="btn" onClick={() => void window.fleet.call('resolveConflicts', card.id, 'retry')} data-retry-merge>Try merging again</button>
          </div>
        </div>
      )}
      {card.stage === 'awaiting-merge' && card.merge?.error && <div className="prompt-actions"><button className="btn primary" onClick={() => void window.fleet.call('approve', card.id)}>Try again</button></div>}
      {card.stage === 'testing' && card.final && !conflicts.length && <Checklist card={card} />}
    </section>
  );
}

function Transcript({ card }: { card: AgentCard }) {
  const items = useStore((s) => s.transcripts[card.id]);
  const messagesOnly = useStore((s) => s.messagesOnly);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = ref.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };
  useLayoutEffect(() => { stick.current = true; }, [card.id]);
  useLayoutEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [items, messagesOnly]);
  const shown = messagesOnly ? (items ?? []).filter(isMessage) : items ?? [];
  return (
    <div className="transcript" ref={ref} onScroll={onScroll}>
      {shown.map((it) => <Item key={it.id} item={it} card={card} />)}
    </div>
  );
}

function Composer({ card }: { card: AgentCard }) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const focusTick = useStore((s) => s.focusTick);
  const drafts = useRef<Record<string, string>>({});

  useEffect(() => { setText(drafts.current[card.id] ?? ''); setImages([]); }, [card.id]);
  useEffect(() => { drafts.current[card.id] = text; }, [text, card.id]);
  useEffect(() => { ref.current?.focus(); }, [focusTick]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const send = () => {
    const t = text.trim();
    if (!t && !images.length) return;
    void window.fleet.call('send', card.id, t || 'See the attached image.', images.length ? images : undefined);
    setText('');
    setImages([]);
  };
  const addFile = (f: File) => {
    if (!f.type.startsWith('image/')) return;
    const r = new FileReader();
    r.onload = () => setImages((cur) => [...cur, { mediaType: f.type, data: String(r.result).split(',')[1] }]);
    r.readAsDataURL(f);
  };
  return (
    <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); [...e.dataTransfer.files].forEach(addFile); }}>
      {images.length > 0 && (
        <div className="composer-images">
          {images.map((img, i) => (
            <button key={i} onClick={() => setImages(images.filter((_, j) => j !== i))} title="Remove"><img src={`data:${img.mediaType};base64,${img.data}`} alt="Attachment" /></button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        className="composer-input"
        value={text}
        rows={1}
        data-composer
        placeholder={`Message ${card.isMaster ? 'the master chat' : pad2(card.index)}. Enter sends, Ctrl+Enter adds a line.`}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => { for (const it of e.clipboardData.items) { const f = it.getAsFile(); if (f) addFile(f); } }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = el;
            setText(`${text.slice(0, a)}\n${text.slice(b)}`);
            requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + 1; });
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          } else if (e.key === 'Escape' && isLive(card)) {
            e.preventDefault();
            void window.fleet.call('interrupt', card.id);
          }
        }}
      />
      <button className="btn primary composer-send" onClick={send} disabled={!text.trim() && !images.length}>Send</button>
    </div>
  );
}

// Only for looking. Merging happens through the flow, so there's one way for files to move.
function FilesTab({ card }: { card: AgentCard }) {
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    setFiles(null);
    setError(null);
    window.fleet.call<ChangedFile[]>('changes', card.id, all).then(setFiles, (e) => setError(String(e?.message ?? e)));
  }, [card.id, all]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { setAll(false); }, [card.id]);
  if (!card.project) return <div className="tab-empty">This task has no project attached.</div>;
  return (
    <div className="changes">
      <p className="changes-note">{all ? 'Everything that changed in this folder since the task started, by any agent or by you.' : 'The files this agent changed.'}</p>
      {error && <div className="sys tone-error">{error}</div>}
      {files === null ? <div className="tab-empty">{all ? 'Scanning the whole project…' : 'Looking…'}</div> : files.length === 0 ? <div className="tab-empty">No changes.</div> : (
        <ul className="change-list" data-files>
          {files.map((f) => (
            <li key={f.path}>
              <span className={`chg chg-${f.kind}`}>{f.kind[0].toUpperCase()}</span>
              <span className="chg-path">{f.path}</span>
              {f.binary && <span className="chg-bin">binary</span>}
              {f.usuallySkipped && <span className="chg-bin">left out of merges</span>}
              {all && f.mine && <span className="chg-bin">this agent</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="prompt-actions">
        <button className="btn" onClick={refresh}>Rescan</button>
        {card.slot?.shared && <button className="btn" onClick={() => setAll(!all)}>{all ? 'Just this agent' : 'Everything in the folder'}</button>}
      </div>
    </div>
  );
}

function LogTab({ card }: { card: AgentCard }) {
  const [log, setLog] = useState('');
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let live = true;
    const load = () => window.fleet.call<string>('log', card.id, 400).then((t) => { if (live) setLog(t); }, () => {});
    void load();
    const t = setInterval(load, 2000);
    return () => { live = false; clearInterval(t); };
  }, [card.id]);
  useLayoutEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [log]);
  return <pre className="log" ref={ref}>{log || 'No editor log yet. The editor starts when the agent first needs it.'}</pre>;
}

// What the master chat follows in every session, all in view, because it shapes everything it does.
function MasterMemory() {
  const memory = useStore((s) => s.snapshot.masterMemory ?? []);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const add = () => {
    if (!text.trim()) return;
    void window.fleet.call('addMasterMemory', text);
    setText('');
  };
  return (
    <div className="master-memory" data-master-memory>
      <button className="link-btn" onClick={() => setOpen(!open)} data-memory-toggle aria-expanded={open}>{open ? 'Hide memory' : `Memory (${memory.length})`}</button>
      {open && (
        <>
          <p className="memory-note">It follows these in every session. Tell it "from now on..." to add one, or add one here.</p>
          {memory.length > 0 && (
            <ol className="memory-list">
              {memory.map((m, i) => <li key={m}><span>{m}</span><button className="link-btn" onClick={() => void window.fleet.call('removeMasterMemory', i)} data-memory-remove={i}>Remove</button></li>)}
            </ol>
          )}
          <div className="memory-add">
            <input data-memory-input value={text} placeholder="Always..." onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); add(); } }} />
            <button className="btn" disabled={!text.trim()} onClick={add} data-memory-add>Add</button>
          </div>
        </>
      )}
    </div>
  );
}

const PERMISSION_TEXT: Record<string, string> = { auto: 'auto', acceptEdits: 'accepts edits', default: 'asks', bypassPermissions: 'bypass' };

// Archiving frees a private copy, which would wipe anything not merged yet. Work in a shared folder
// stays where it is.
async function archive(card: AgentCard) {
  const merged = ['merged', 'checking-in', 'complete'].includes(card.stage ?? '');
  const files = card.slot?.shared || merged ? [] : await window.fleet.call<ChangedFile[]>('changes', card.id).catch(() => [] as ChangedFile[]);
  if (files.length && !window.confirm(`${files.length} changed file${files.length === 1 ? ' hasn\'t' : 's haven\'t'} been merged into your project and will be lost. Archive anyway?`)) return;
  await window.fleet.call('archive', card.id);
}

export function DetailPanel() {
  const selectedId = useStore((s) => s.selectedId);
  const card = useStore((s) => s.snapshot.cards.find((c) => c.id === s.selectedId && !c.archived));
  const [tab, setTab] = useState<'chat' | 'files' | 'log'>('chat');
  const messagesOnly = useStore((s) => s.messagesOnly);
  useEffect(() => { setTab('chat'); }, [selectedId]);
  if (!card) return <aside className="detail detail-empty"><p>Select a card to see its output.</p></aside>;
  const live = isLive(card);
  return (
    <aside className={`detail s-${card.status}`}>
      <header className="detail-head">
        <div className="detail-title">{!card.isMaster && <span className="card-num">{pad2(card.index)}</span>} {card.title}{!card.isMaster && <span className="card-status">{stageLabel(card)}</span>}</div>
        <div className="detail-sub">
          <span>{modelLabel(card.model)} @{card.effort}</span>
          {card.isMaster ? (
            <select className="mode-select" data-master-mode aria-label="Master chat permissions" value={card.permissionMode} onChange={(e) => void window.fleet.call('setMasterPermissions', e.target.value)}>
              {MASTER_PERMISSION_MODES.map((m) => <option key={m} value={m}>{PERMISSION_TEXT[m]}</option>)}
            </select>
          ) : <span data-permissions>{PERMISSION_TEXT[card.permissionMode] ?? card.permissionMode}</span>}
          <span>{getState().snapshot.machines.find((m) => m.info.id === card.nodeId)?.info.name}</span>
          {card.project && <span>{card.project}</span>}
          {card.slot && <span title={card.slot.dir}>UE :{card.slot.port} {card.slot.state}</span>}
          <span className="detail-actions">
            {live && <button className="link-btn" onClick={() => void window.fleet.call('interrupt', card.id)}>Interrupt <kbd>Esc</kbd></button>}
            {card.slot && !['cold', 'syncing', 'empty', 'crashed'].includes(card.slot.state) && <button className="link-btn" onClick={() => void window.fleet.call('stopInstance', card.id)}>Stop editor</button>}
            {live && !card.isMaster && <button className="link-btn" onClick={() => void window.fleet.call('stopAgent', card.id)}>Stop</button>}
            {!live && !card.isMaster && <button className="link-btn" onClick={() => void archive(card)}>Archive</button>}
          </span>
        </div>
        <div className="tabs-row">
          <nav className="tabs" role="tablist">
            {(card.isMaster ? ['chat'] as const : ['chat', 'files', 'log'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'chat' ? 'Chat' : t === 'files' ? 'Files' : 'Editor log'}</button>)}
          </nav>
          {tab === 'chat' && (
            <label className="chat-filter" title="Hides tool calls, thinking and status notes. A prompt waiting on you and an error that stopped the agent still show.">
              <input type="checkbox" checked={messagesOnly} onChange={(e) => setMessagesOnly(e.target.checked)} data-messages-only />
              Messages only
            </label>
          )}
        </div>
      </header>
      {card.isMaster && <MasterMemory />}
      {card.isWorkspace && (
        <div className="workspace-banner" data-workspace-banner>
          {card.holdingWorkspace ? 'Other agents on this project are paused while this chat changes the workspace.' : "This chat can merge, switch and update your real workspace. It asks before touching anyone's pending changes, and it doesn't check in unless you say to."}
          {card.holdingWorkspace && <button className="btn" data-release onClick={() => void window.fleet.call('releaseWorkspace', card.id)}>Let agents carry on</button>}
        </div>
      )}
      {!card.isMaster && !card.isWorkspace && <FlowPanel card={card} />}
      {tab === 'chat' && <Transcript card={card} />}
      {tab === 'files' && <FilesTab card={card} />}
      {tab === 'log' && <LogTab card={card} />}
      <Composer card={card} />
    </aside>
  );
}
