import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { modelLabel, type AgentCard, type ApplyResult, type ChangedFile, type FinalReport, type ImageAttachment, type Question, type TranscriptItem } from '../shared/protocol';
import { isLive, STATUS_LABEL } from './Cards';
import { fmtDuration, getState, pad2, useStore } from './store';

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

function FinalCard({ report, card, onChanges }: { report: FinalReport; card: AgentCard; onChanges: () => void }) {
  const tests = useStore((s) => s.snapshot.testList);
  return (
    <div className="final-card">
      <div className="final-head">Finished. {report.needsTesting.length ? 'Needs your testing' : 'Check this one'}</div>
      <p className="final-summary">{report.summary}</p>
      {report.needsTesting.length > 0 && (
        <ul className="final-tests">
          {report.needsTesting.map((t, i) => {
            const key = `${card.id}:${i}`;
            const done = tests.find((x) => x.key === key)?.done ?? false;
            return (
              <li key={key} className={done ? 'done' : ''}>
                <label>
                  <input type="checkbox" checked={done} onChange={(e) => void window.fleet.call('setTestDone', key, e.target.checked)} />
                  <span><b>{t.what}</b>{t.how && <small>How: {t.how}</small>}{t.why && <small>Why you: {t.why}</small>}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {report.verified.length > 0 && (
        <details className="final-verified"><summary>What the agent already checked ({report.verified.length})</summary><ul>{report.verified.map((v) => <li key={v}>{v}</li>)}</ul></details>
      )}
      {!report.verified.length && <p className="final-warn">The agent reported no checks of its own, so treat this as untested.</p>}
      {card.project && <div className="prompt-actions"><button className="btn" onClick={onChanges}>Review changes</button></div>}
    </div>
  );
}

const Item = memo(function Item({ item, card, onChanges }: { item: TranscriptItem; card: AgentCard; onChanges: () => void }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className={`msg-user${item.broadcastId ? ' broadcast' : ''}`}>
          {item.broadcastId && <span className="msg-tag">to all</span>}
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
    case 'final': return <FinalCard report={item.report} card={card} onChanges={onChanges} />;
  }
});

function Transcript({ card, onChanges }: { card: AgentCard; onChanges: () => void }) {
  const items = useStore((s) => s.transcripts[card.id]);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = ref.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };
  useLayoutEffect(() => { stick.current = true; }, [card.id]);
  useLayoutEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [items]);
  return (
    <div className="transcript" ref={ref} onScroll={onScroll}>
      {(items ?? []).map((it) => <Item key={it.id} item={it} card={card} onChanges={onChanges} />)}
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
        placeholder={`Message ${pad2(card.index)}. Enter sends, Ctrl+Enter adds a line.`}
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

function ChangesTab({ card }: { card: AgentCard }) {
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const refresh = useCallback(() => {
    window.fleet.call<ChangedFile[]>('changes', card.id).then((list) => {
      setFiles(list);
      setUnticked(new Set(list.filter((f) => f.usuallySkipped).map((f) => f.path)));
    }, (e) => setError(String(e?.message ?? e)));
  }, [card.id]);
  useEffect(() => { setFiles(null); setResult(null); setError(null); refresh(); }, [card.id, refresh]);
  const chosen = (files ?? []).filter((f) => !unticked.has(f.path));
  const apply = async (force?: string[]) => {
    setBusy(true);
    setError(null);
    try {
      setResult(await window.fleet.call<ApplyResult>('apply', card.id, force ?? chosen.map((f) => f.path), force));
      refresh();
    } catch (e: any) { setError(String(e?.message ?? e)); }
    setBusy(false);
  };
  const toggle = (p: string) => {
    const next = new Set(unticked);
    if (next.has(p)) next.delete(p); else next.add(p);
    setUnticked(next);
  };
  if (!card.project) return <div className="tab-empty">This task has no project attached.</div>;
  // Work in a shared folder on this machine is already in the project, so there's nothing to do but look.
  const inPlace = !!card.slot?.shared && card.nodeId === 'master';
  if (inPlace) return (
    <div className="changes">
      <p className="changes-note">This agent works directly in your project, so there's nothing to apply. These files changed there since the task started, by any agent or by you. Deleted files don't show here, but your version control has them.</p>
      {error && <div className="sys tone-error">{error}</div>}
      {files === null ? <div className="tab-empty">Scanning…</div> : files.length === 0 ? <div className="tab-empty">No changes.</div> : (
        <ul className="change-list">
          {files.map((f) => (
            <li key={f.path}>
              <span className={`chg chg-${f.kind}`}>{f.kind[0].toUpperCase()}</span>
              <span className="chg-path">{f.path}</span>
              {f.binary && <span className="chg-bin">binary</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="prompt-actions"><button className="btn" onClick={refresh}>Rescan</button></div>
    </div>
  );
  return (
    <div className="changes">
      <p className="changes-note">{card.slot?.shared
        ? `These files changed in the project folder on ${getState().snapshot.machines.find((m) => m.info.id === card.nodeId)?.info.name ?? 'that machine'} since the task started, by any agent there. Applying copies them into your project on this machine.`
        : "These edits are only in this agent's private copy. Applying copies them into your real project."}</p>
      {error && <div className="sys tone-error">{error}</div>}
      {files === null ? <div className="tab-empty">Scanning…</div> : files.length === 0 ? <div className="tab-empty">No changes.</div> : (
        <>
          <ul className="change-list">
            {files.map((f) => (
              <li key={f.path}>
                <label className="chg-row">
                  <input type="checkbox" checked={!unticked.has(f.path)} onChange={() => toggle(f.path)} />
                  <span className={`chg chg-${f.kind}`}>{f.kind[0].toUpperCase()}</span>
                  <span className="chg-path">{f.path}</span>
                  {f.binary && <span className="chg-bin">binary</span>}
                  {f.usuallySkipped && <span className="chg-bin">usually skipped</span>}
                </label>
              </li>
            ))}
          </ul>
          <div className="prompt-actions">
            <button className="btn primary" disabled={busy || !chosen.length} onClick={() => void apply()}>{busy ? 'Applying…' : `Apply ${chosen.length} file${chosen.length === 1 ? '' : 's'} to the project`}</button>
            <button className="btn" onClick={refresh}>Rescan</button>
          </div>
        </>
      )}
      {result && (
        <div className="apply-result">
          {result.applied.length + result.merged.length > 0 && <p>Applied {result.applied.length}{result.merged.length ? `, merged ${result.merged.length}` : ''}.</p>}
          {result.conflicts.length > 0 && (
            <>
              <p className="final-warn">{result.conflicts.length} not applied:</p>
              <ul className="change-list">{result.conflicts.map((c) => <li key={c.path}><span className="chg-path">{c.path}</span><small>{c.reason}</small></li>)}</ul>
              <button className="btn" disabled={busy} onClick={() => void apply(result.conflicts.map((c) => c.path))}>Overwrite with the agent's version</button>
            </>
          )}
        </div>
      )}
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

// Archiving frees a private copy, which would wipe anything not applied yet. Work in a shared folder
// stays where it is.
async function archive(card: AgentCard) {
  const files = card.slot?.shared ? [] : await window.fleet.call<ChangedFile[]>('changes', card.id).catch(() => [] as ChangedFile[]);
  if (files.length && !window.confirm(`${files.length} changed file${files.length === 1 ? ' hasn\'t' : 's haven\'t'} been applied to your project and will be lost. Archive anyway?`)) return;
  await window.fleet.call('archive', card.id);
}

export function DetailPanel() {
  const selectedId = useStore((s) => s.selectedId);
  const card = useStore((s) => s.snapshot.cards.find((c) => c.id === s.selectedId && !c.archived));
  const [tab, setTab] = useState<'chat' | 'changes' | 'log'>('chat');
  useEffect(() => { setTab('chat'); }, [selectedId]);
  if (!card) return <aside className="detail detail-empty"><p>Select a card to see its output.</p></aside>;
  const live = isLive(card);
  return (
    <aside className={`detail s-${card.status}`}>
      <header className="detail-head">
        <div className="detail-title"><span className="card-num">{pad2(card.index)}</span> {card.title}<span className="card-status">{STATUS_LABEL[card.status]}</span></div>
        <div className="detail-sub">
          <span>{modelLabel(card.model)} @{card.effort}</span>
          <span>{getState().snapshot.machines.find((m) => m.info.id === card.nodeId)?.info.name}</span>
          {card.project && <span>{card.project}</span>}
          {card.slot && <span title={card.slot.dir}>UE :{card.slot.port} {card.slot.state}</span>}
          <span className="detail-actions">
            {live && <button className="link-btn" onClick={() => void window.fleet.call('interrupt', card.id)}>Interrupt <kbd>Esc</kbd></button>}
            {card.slot && !['cold', 'syncing', 'empty', 'crashed'].includes(card.slot.state) && <button className="link-btn" onClick={() => void window.fleet.call('stopInstance', card.id)}>Stop editor</button>}
            {live && <button className="link-btn" onClick={() => void window.fleet.call('stopAgent', card.id)}>Stop</button>}
            {!live && <button className="link-btn" onClick={() => void archive(card)}>Archive</button>}
          </span>
        </div>
        <nav className="tabs" role="tablist">
          {(['chat', 'changes', 'log'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'chat' ? 'Chat' : t === 'changes' ? 'Changes' : 'Editor log'}</button>)}
        </nav>
      </header>
      {tab === 'chat' && <Transcript card={card} onChanges={() => setTab('changes')} />}
      {tab === 'changes' && <ChangesTab card={card} />}
      {tab === 'log' && <LogTab card={card} />}
      <Composer card={card} />
    </aside>
  );
}
