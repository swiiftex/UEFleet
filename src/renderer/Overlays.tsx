import { useEffect, useMemo, useRef, useState } from 'react';
import { EFFORTS, INSTANCE_MODES, MASTER_CHAT_ID, MODELS, PERMISSION_MODES, type AgentCard, type ImageAttachment, type InstanceMode, type NewTask } from '../shared/protocol';
import { isLive } from './Cards';
import { attentionQueue, dismissPopup, fmtAgo, getState, goToNextTest, pad2, select, setState, useStore } from './store';

const KIND_LABEL: Record<string, string> = {
  permission: 'Needs permission', question: 'Has a question', reply: 'Waiting on you', crash: 'Unreal crashed', testing: 'Ready to test', error: 'Hit an error', blocked: 'Blocked',
};

export function AttentionPopup() {
  const queue = useStore((s) => attentionQueue(s).map((c) => c.id).join(','));
  const cards = useStore((s) => s.snapshot.cards);
  const allDone = useStore((s) => s.allDone);
  const head = queue ? cards.find((c) => c.id === queue.split(',')[0]) : undefined;
  const count = queue ? queue.split(',').length : 0;
  if (!head?.attention) {
    if (!allDone) return null;
    return (
      <div className="popup popup-done" role="status" data-popup="all-done">
        <div className="popup-body">
          <div className="popup-kind">All tasks finished</div>
          <div className="popup-text">{allDone.count} thing{allDone.count === 1 ? '' : 's'} left to test by hand.</div>
        </div>
        <div className="popup-keys"><span><kbd className="tab-key">Tab</kbd> Go there</span><span><kbd>Esc</kbd> Dismiss</span></div>
      </div>
    );
  }
  return (
    <div className={`popup popup-${head.attention.kind}`} role="alert" data-popup={head.id} key={`${head.id}-${head.attention.at}`}>
      <div className="popup-body">
        <div className="popup-kind">{KIND_LABEL[head.attention.kind] ?? 'Needs you'} · <span className="popup-card">{pad2(head.index)} {head.title}</span></div>
        <div className="popup-text">{head.attention.text}</div>
      </div>
      <div className="popup-keys">
        <span><kbd className="tab-key">Tab</kbd> Go there</span>
        <span><kbd>Esc</kbd> Later</span>
        {count > 1 && <span className="popup-more">+{count - 1} more</span>}
      </div>
    </div>
  );
}

export function handlePopupKey(e: KeyboardEvent): boolean {
  const s = getState();
  const queue = attentionQueue(s);
  if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    if (queue[0]) {
      e.preventDefault();
      void select(queue[0].id);
      return true;
    }
    if (s.allDone) {
      e.preventDefault();
      setState({ allDone: null });
      goToNextTest();
      return true;
    }
  }
  if (e.key === 'Escape') {
    if (queue[0]) { e.preventDefault(); dismissPopup(queue[0]); return true; }
    if (s.allDone) { e.preventDefault(); setState({ allDone: null }); return true; }
  }
  return false;
}

export function BroadcastOverlay() {
  const open = useStore((s) => s.broadcastOpen);
  const cards = useStore((s) => s.snapshot.cards);
  const broadcasts = useStore((s) => s.snapshot.broadcasts);
  const now = useStore((s) => s.now);
  const [text, setText] = useState('');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [includeDone, setIncludeDone] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) ref.current?.focus(); }, [open]);
  useEffect(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight; }, [broadcasts, open]);

  const present = cards.filter((c) => !c.archived && !c.isMaster && !c.isWorkspace);
  // Finished agents aren't messaged unless asked for: it would restart them and spend tokens.
  const targets = present.filter((c) => (c.status === 'finished' || c.status === 'stopped' ? includeDone.has(c.id) : !excluded.has(c.id)));
  if (!open) return null;

  const toggle = (c: AgentCard) => {
    if (c.status === 'finished' || c.status === 'stopped') {
      const n = new Set(includeDone);
      if (n.has(c.id)) n.delete(c.id); else n.add(c.id);
      setIncludeDone(n);
    } else {
      const n = new Set(excluded);
      if (n.has(c.id)) n.delete(c.id); else n.add(c.id);
      setExcluded(n);
    }
  };
  const send = () => {
    const t = text.trim();
    if (!t || !targets.length) return;
    void window.fleet.call('broadcast', t, targets.map((c) => c.id));
    setText('');
  };
  const titleOf = (id: string) => { const c = cards.find((x) => x.id === id); return c ? `${pad2(c.index)} ${c.title}` : id; };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setState({ broadcastOpen: false }); }}>
      <div className="broadcast" role="dialog" aria-label="Message all agents" data-broadcast>
        <div className="broadcast-head">
          <span className="broadcast-title">All agents</span>
          <span className="broadcast-count">{targets.length} of {present.length} will get this</span>
          <span className="broadcast-keys"><kbd>Esc</kbd> Close</span>
        </div>
        <div className="chips">
          {present.map((c) => {
            const on = targets.includes(c);
            return <button key={c.id} className={`chip${on ? ' on' : ''}`} onClick={() => toggle(c)} aria-pressed={on} title={c.title}>{pad2(c.index)} {c.title}</button>;
          })}
        </div>
        <div className="broadcast-thread" ref={threadRef}>
          {broadcasts.slice(-6).map((b) => (
            <div key={b.id} className="bc">
              <div className="bc-you"><span>You, {fmtAgo(b.at, now)}</span>{b.text}</div>
              {b.targets.map((id) => {
                const r = b.replies[id];
                const card = cards.find((c) => c.id === id);
                return (
                  <button key={id} className="bc-reply" onClick={() => { setState({ broadcastOpen: false }); void select(id); }}>
                    <span className="bc-who">{titleOf(id)}</span>
                    <span className={`bc-text${r ? '' : ' pending'}`}>{r ? r.text.replace(/\s+/g, ' ').slice(0, 220) : card && isLive(card) ? 'Working…' : 'No reply yet'}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="broadcast-input">
          <textarea
            ref={ref}
            value={text}
            rows={2}
            placeholder={targets.length ? `Message ${targets.length} agent${targets.length === 1 ? '' : 's'}. Enter sends, Shift+Enter adds a line.` : 'No agents selected.'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <button className="btn primary" disabled={!text.trim() || !targets.length} onClick={send}>Send to all</button>
        </div>
      </div>
    </div>
  );
}

const DEMO_SCRIPTS = ['clean', 'testing', 'permission', 'question', 'reply', 'long'];
const STOP_WORDS = new Set(['this', 'that', 'with', 'from', 'have', 'when', 'then', 'them', 'they', 'what', 'should', 'would', 'could', 'make', 'still', 'also', 'just', 'into', 'there', 'about', 'please', 'does', 'doesnt', 'dont', 'your']);
const wordsOf = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_]{4,}/g)?.filter((w) => !STOP_WORDS.has(w)) ?? []);

// A follow-up usually belongs with the agent that already has the context, so offer those first.
export function relatedCards(prompt: string, cards: AgentCard[]): AgentCard[] {
  const words = wordsOf(prompt);
  if (words.size === 0) return [];
  const score = (c: AgentCard) => {
    const title = wordsOf(c.title);
    const rest = wordsOf(`${c.lastPrompt} ${c.lastText}`);
    let n = 0;
    for (const w of words) n += title.has(w) ? 2 : rest.has(w) ? 1 : 0;
    return n;
  };
  return cards.filter((c) => !c.archived && !c.isMaster).map((c) => [c, score(c)] as const).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c);
}

export function NewTaskModal() {
  const open = useStore((s) => s.modal === 'new');
  const snapshot = useStore((s) => s.snapshot);
  const d = snapshot.defaults;
  const master = snapshot.machines.find((m) => m.info.id === 'master');
  const [prompt, setPrompt] = useState('');
  const [projectFile, setProjectFile] = useState<string | null>(d.projectFile);
  const [nodeId, setNodeId] = useState('auto');
  const [model, setModel] = useState(d.model);
  const [effort, setEffort] = useState(d.effort);
  const [permissionMode, setPermissionMode] = useState(d.permissionMode);
  const [instanceMode, setInstanceMode] = useState<InstanceMode>(d.instanceMode);
  const [another, setAnother] = useState(false);
  const [demo, setDemo] = useState('testing');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setProjectFile(getState().snapshot.defaults.projectFile ?? getState().snapshot.machines.find((m) => m.info.id === 'master')?.info.projects[0]?.file ?? null);
    setPermissionMode(getState().snapshot.defaults.permissionMode);
    ref.current?.focus();
  }, [open]);
  const projects = useMemo(() => master?.info.projects ?? [], [master]);
  const related = useMemo(() => relatedCards(prompt, snapshot.cards), [prompt, snapshot.cards]);
  if (!open) return null;

  const launch = () => {
    const text = prompt.trim();
    if (!text) return;
    const task: NewTask = { prompt: text, images: images.length ? images : undefined, projectFile: snapshot.demo ? null : projectFile, nodeId, model, effort, permissionMode, instanceMode, demo: snapshot.demo ? demo : undefined };
    // Watching the master chat first means following along to the agent it starts.
    if (!another) void select(MASTER_CHAT_ID);
    void window.fleet.call<string>('request', task);
    setPrompt('');
    setImages([]);
    if (another) ref.current?.focus();
    else setState({ modal: null });
  };
  const sendTo = (card: AgentCard) => {
    const text = prompt.trim();
    if (!text) return;
    void window.fleet.call('send', card.id, text, images.length ? images : undefined);
    setPrompt('');
    setImages([]);
    setState({ modal: null });
    void select(card.id);
  };
  const addImage = (f: File) => {
    if (!f.type.startsWith('image/')) return;
    const r = new FileReader();
    r.onload = () => setImages((cur) => [...cur, { mediaType: f.type, data: String(r.result).split(',')[1] }]);
    r.readAsDataURL(f);
  };
  const browse = async () => {
    const f = await window.fleet.pickProject();
    if (!f) return;
    await window.fleet.call('addProject', f);
    setProjectFile(f);
  };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setState({ modal: null }); }}>
      <div className="modal" role="dialog" aria-label="New task" data-new-task>
        <div className="modal-head"><h2>New task</h2><span className="modal-hint"><kbd>Esc</kbd> Close</span></div>
        <textarea
          ref={ref}
          className="new-prompt"
          rows={5}
          value={prompt}
          placeholder="What needs doing? The master chat fetches any ticket it mentions and starts an agent on the best PC. Paste screenshots here too."
          onChange={(e) => setPrompt(e.target.value)}
          onPaste={(e) => { for (const it of e.clipboardData.items) { const f = it.getAsFile(); if (f) addImage(f); } }}
          onKeyDown={(e) => {
            if (e.altKey && /^[1-3]$/.test(e.key) && related[Number(e.key) - 1]) {
              e.preventDefault();
              sendTo(related[Number(e.key) - 1]);
            } else if (e.key === 'Enter' && e.ctrlKey) {
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: a, selectionEnd: b } = el;
              setPrompt(`${prompt.slice(0, a)}\n${prompt.slice(b)}`);
              requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + 1; });
            } else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); launch(); }
          }}
        />
        {images.length > 0 && (
          <div className="composer-images">
            {images.map((img, i) => <button key={i} onClick={() => setImages(images.filter((_, j) => j !== i))} title="Remove"><img src={`data:${img.mediaType};base64,${img.data}`} alt="Attachment" /></button>)}
          </div>
        )}
        {related.length > 0 && (
          <div className="route" data-route>
            <span className="route-label">Or send to the agent that has the context:</span>
            {related.map((c, i) => (
              <button key={c.id} className="route-card" onClick={() => sendTo(c)} data-route-card={c.id}>
                <kbd>Alt {i + 1}</kbd> {pad2(c.index)} {c.title} <small>{c.status === 'finished' ? 'finished' : isLive(c) ? 'busy, it will see this next' : 'idle'}</small>
              </button>
            ))}
          </div>
        )}
        <div className="form-grid">
          <label>Project
            <div className="row">
              <select value={projectFile ?? ''} onChange={(e) => setProjectFile(e.target.value || null)}>
                <option value="">No project</option>
                {projects.map((p) => <option key={p.file} value={p.file}>{p.name} ({p.engineVersion ?? 'unknown engine'})</option>)}
              </select>
              <button className="btn" onClick={() => void browse()}>Browse…</button>
            </div>
          </label>
          <label>Machine
            <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
              <option value="auto">Automatic: another PC if one is free</option>
              {snapshot.machines.filter((m) => m.online).map((m) => <option key={m.info.id} value={m.info.id}>{m.info.name}</option>)}
            </select>
          </label>
          <label>Model
            <select value={model} onChange={(e) => setModel(e.target.value)}>{MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
          </label>
          <label>Effort
            <select value={effort} onChange={(e) => setEffort(e.target.value)}>{EFFORTS.map((x) => <option key={x}>{x}</option>)}</select>
          </label>
          <label>Permissions
            <select data-permission-mode value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>{PERMISSION_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
          </label>
          <label>Editor
            <select value={instanceMode} onChange={(e) => setInstanceMode(e.target.value as InstanceMode)} title={INSTANCE_MODES.find((m) => m.id === instanceMode)?.hint}>{INSTANCE_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}: {m.hint}</option>)}</select>
          </label>
          {snapshot.demo && <label>Demo script<select value={demo} onChange={(e) => setDemo(e.target.value)} data-demo-script>{DEMO_SCRIPTS.map((x) => <option key={x}>{x}</option>)}</select></label>}
        </div>
        <div className="modal-foot">
          <label className="check"><input type="checkbox" checked={another} onChange={(e) => setAnother(e.target.checked)} /> Keep open to add another</label>
          <button className="btn primary" disabled={!prompt.trim()} onClick={launch}>Start <kbd>Enter</kbd></button>
        </div>
      </div>
    </div>
  );
}

function ApiCredits() {
  const credits = useStore((s) => s.snapshot.apiCredits);
  const [key, setKey] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (value: string | null) => {
    const refused = await window.fleet.setApiKey(value);
    setProblem(refused);
    if (!refused) setKey('');
  };
  return (
    <section data-api-credits>
      <h3>API credits</h3>
      <label className="credits-toggle">
        <input type="checkbox" data-api-credits-on checked={!!credits?.enabled} disabled={!credits?.hasKey} onChange={(e) => void window.fleet.call('setApiCreditsEnabled', e.target.checked)} />
        Use API credits if available
      </label>
      <p className="pair-note">Agents use your subscription first. If one hits a usage limit, it carries on billed to this key until the limit resets, then goes back. That spends real money from the Console organisation that owns the key. Make a key at console.anthropic.com.</p>
      <div className="pair-code">
        <input type="password" className="credits-key" data-api-key autoComplete="off" spellCheck={false} placeholder={credits?.hasKey ? 'A key is saved. Paste another to replace it.' : 'Paste an API key'} value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn" data-api-key-save disabled={!key.trim()} onClick={() => void save(key.trim())}>Save key</button>
        {credits?.hasKey && <button className="btn" data-api-key-remove onClick={() => void save(null)}>Remove key</button>}
      </div>
      {(problem ?? credits?.problem) && <p className="final-warn" data-api-credits-problem>{problem ?? credits?.problem}</p>}
    </section>
  );
}

export function MachinesModal() {
  const open = useStore((s) => s.modal === 'machines');
  const machines = useStore((s) => s.snapshot.machines);
  const preferred = useStore((s) => s.snapshot.preferredMachine);
  const pairing = useStore((s) => s.snapshot.pairing);
  const hostAppPath = useStore((s) => s.snapshot.hostAppPath);
  const [copied, setCopied] = useState(false);
  if (!open) return null;
  const rotate = async () => {
    const p = await window.fleet.call('rotatePairing');
    setState({ snapshot: { ...getState().snapshot, pairing: p } });
  };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setState({ modal: null }); }}>
      <div className="modal wide" role="dialog" aria-label="Machines" data-machines>
        <div className="modal-head"><h2>Machines</h2><span className="modal-hint"><kbd>Esc</kbd> Close</span></div>
        <section className="pair">
          <h3>Link another machine</h3>
          <ol>
            <li>Copy <code>fleet-host.exe</code> to it. {hostAppPath && <button className="link-btn" onClick={() => void window.fleet.reveal(hostAppPath)}>Show the file</button>}</li>
            <li>That machine also needs Claude Code signed in, and the same Unreal version as your project.</li>
            <li>Run it and paste this code:</li>
          </ol>
          {pairing ? (
            <>
              <div className="pair-code"><code data-pair-code>{pairing.code}</code>
                <button className="btn" onClick={() => { void window.fleet.copy(pairing.code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy'}</button>
                <button className="btn" onClick={() => void rotate()}>New code</button>
              </div>
              <p className="pair-note">Tries {pairing.addresses.join(', ') || 'no network address found'} on port {pairing.port}. Windows may ask to allow this app through the firewall the first time. Anyone with this code can run commands on machines they link, so treat it like a password.</p>
            </>
          ) : <p className="final-warn">The link server isn't running.</p>}
        </section>
        <ApiCredits />
        <section data-preferred>
          <h3>Where work goes</h3>
          <label className="preferred-machine">Preferred machine
            <select data-preferred-machine value={preferred ?? ''} onChange={(e) => void window.fleet.call('setPreferredMachine', e.target.value || null)}>
              <option value="">Automatic, by how busy each one is</option>
              {machines.map((m) => <option key={m.info.id} value={m.info.id}>{m.info.name}{m.online ? '' : ' (offline)'}</option>)}
            </select>
          </label>
          <p className="pair-note">The master chat sends new tasks here unless you name another machine, or this one can't take it, in which case the card says why.</p>
        </section>
        <section>
          <h3>Linked</h3>
          <ul className="machine-list">
            {machines.map((m) => (
              <li key={m.info.id}>
                <div className="machine-name"><span className={m.online ? 'mach-on' : 'mach-off'}>◆</span> {m.info.name} <small>{m.info.role === 'master' ? 'this PC' : m.online ? 'connected' : 'offline'}</small></div>
                <div className="machine-spec">{m.info.threads} threads · {m.info.ramGb} GB RAM · {m.info.vramGb} GB VRAM · UE {m.info.engines.map((e) => e.version).join(', ') || 'none'}{!m.info.claudePath && <b className="final-warn"> · Claude Code not found</b>}</div>
                {m.info.unusableEngines?.map((u) => <div key={u.root} className="machine-spec">Not usable: {u.root}: {u.reason}</div>)}
                {m.update?.stage === 'waiting' && <div className="machine-spec">A new host version is ready, and installs once {m.update.busy} running agent{m.update.busy === 1 ? ' finishes' : 's finish'}. <button className="link-btn" onClick={() => void window.fleet.call('restartHost', m.info.id)} data-restart-host>Restart now</button>, and they'll carry on afterwards.</div>}
                {m.update?.stage === 'failed' && <div className="machine-spec final-warn">Couldn't update its host: {m.update.detail}</div>}
                <div className="machine-ctl">
                  <label>Editors at once
                    <input type="number" min={1} max={32} value={m.info.maxInstances} onChange={(e) => void window.fleet.call('setMaxInstances', m.info.id, Number(e.target.value))} />
                  </label>
                  {m.info.role !== 'master' && <button className="link-btn" onClick={() => void window.fleet.call('forgetMachine', m.info.id)}>Unlink</button>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

