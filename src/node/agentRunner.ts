// Drives one Claude Code session through the Agent SDK and normalises everything it does
// into AgentEvents, so the hub never has to know about SDK message shapes.
import { query, type McpServerConfig, type PermissionResult, type PermissionUpdate, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ActivityBucket, AgentEvent, AgentOptions, AgentSpawn, AgentStatus, ImageAttachment, Question } from '../shared/protocol';
import { agentEnv } from './machine';

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(m: SDKUserMessage) { this.items.push(m); this.wake?.(); }
  takeUnread() { return this.items.splice(0); }
  close() { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => { this.wake = r; });
      this.wake = null;
    }
  }
}

export interface RunnerConfig {
  spawn: AgentSpawn;
  cwd: string;
  claudePath: string | null;
  mcpServers: Record<string, McpServerConfig>;
  allowedTools: string[];
  appendPrompt: string;
  memoryDir?: string | null;
  emit: (ev: AgentEvent) => void;
  // The master chat keeps the user's own MCP servers. Agents must only ever reach their own editor.
  userMcp?: boolean;
  additionalDirectories?: string[];
  disallowedTools?: string[];
  onFileEdited?: (file: string) => void;
  // By default a conversation keeps the prompt it first had, even resumed with a new one. This session
  // outlives new versions and its notes change, so it needs what's current.
  freshPrompt?: boolean;
}

type Pending = { resolve: (r: PermissionResult) => void; input: Record<string, unknown>; suggestions?: PermissionUpdate[] };

const USAGE_LIMIT = /^You('ve| have) (hit|reached) your/;
const CREDITS_REFUSED = /credit balance|invalid x-api-key/i;
const CODING_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const BUILD_CMD = /\b(Build\.bat|UnrealBuildTool|RunUAT|msbuild|cl\.exe)\b/i;

export function classifyTool(name: string, input: any): { status: AgentStatus; bucket: ActivityBucket } {
  if (name === 'mcp__fleet__ue_build') return { status: 'building', bucket: 'building' };
  if (name === 'Bash' && BUILD_CMD.test(String(input?.command ?? ''))) return { status: 'building', bucket: 'building' };
  if (name.startsWith('mcp__fleet__ue_')) return { status: 'testing', bucket: 'testing' };
  if (CODING_TOOLS.test(name)) return { status: 'coding', bucket: 'coding' };
  return { status: 'tools', bucket: 'tools' };
}

function resultToParts(content: unknown): { text: string; images: string[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: content == null ? '' : JSON.stringify(content), images: [] };
  const texts: string[] = [];
  const images: string[] = [];
  for (const c of content as any[]) {
    if (c?.type === 'text') texts.push(c.text);
    else if (c?.type === 'image' && c.source?.data) images.push(`data:${c.source.media_type};base64,${c.source.data}`);
    else if (c?.type) texts.push(`[${c.type}]`);
  }
  return { text: texts.join('\n'), images };
}

const MAX_RESULT = 24_000;

export class AgentRunner {
  private q: Query | null = null;
  private input = new InputQueue();
  private pending = new Map<string, Pending>();
  private seqId = 0;
  private sessionId: string | undefined;
  private tools = new Map<string, { at: number; name: string; input: unknown; sub: boolean }>();
  private streamBlocks = new Map<string, { id: string; type: string }[]>();
  private currentMsg = '';
  private lastOutput = 0;
  private stopped = false;
  private interrupted = false;
  private apiKey: string | undefined;
  private usageLimit: { resetsAt?: number } | null = null;
  private creditsProblem: string | null = null;
  private restarting: { carryOn?: string; arrived: SDKUserMessage[] } | null = null;
  private sessionIdle = false;
  private promptChanged = false;
  running = false;

  constructor(private cfg: RunnerConfig) {
    this.sessionId = cfg.spawn.resumeSessionId;
    this.apiKey = cfg.spawn.apiKey;
  }

  private id(prefix: string) { return `${prefix}-${Date.now().toString(36)}-${++this.seqId}`; }
  private emit(ev: AgentEvent) { this.cfg.emit(ev); }

  start(initial?: { text: string; images?: ImageAttachment[]; broadcastId?: string }) {
    if (initial?.text) this.send(initial.text, initial.images, initial.broadcastId);
    void this.loop();
  }

  send(text: string, images?: ImageAttachment[], broadcastId?: string, from?: string) {
    const content: any[] = [];
    const shown: string[] = [];
    for (const img of images ?? []) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      shown.push(`data:${img.mediaType};base64,${img.data}`);
    }
    content.push({ type: 'text', text });
    this.emit({ k: 'item', item: { kind: 'user', id: this.id('u'), at: Date.now(), text, images: shown.length ? shown : undefined, broadcastId, from } });
    this.emit({ k: 'attention-clear' });
    this.emit({ k: 'activity', status: 'working', bucket: 'thinking' });
    const message = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } as SDKUserMessage;
    // A session on its way out would take it and never answer. With nothing in flight, this is also
    // the safe moment to pick up a new prompt, and this message goes to the session that has it.
    if (this.restarting) this.restarting.arrived.push(message);
    else if (this.promptChanged && this.q && this.sessionIdle) {
      this.promptChanged = false;
      this.restarting = { arrived: [message] };
      this.q.close();
    } else {
      this.sessionIdle = false;
      this.input.push(message);
    }
    if (!this.running && !this.stopped && this.q === null && this.started) void this.loop();
  }

  private started = false;

  private async loop() {
    if (this.running) return;
    this.running = true;
    this.started = true;
    const { spawn, cwd, claudePath, mcpServers, allowedTools, appendPrompt } = this.cfg;
    try {
      this.q = query({
        prompt: this.input,
        options: {
          cwd,
          model: spawn.model,
          effort: spawn.effort as any,
          permissionMode: spawn.permissionMode as any,
          allowDangerouslySkipPermissions: spawn.permissionMode === 'bypassPermissions',
          includePartialMessages: true,
          resume: this.sessionId,
          mcpServers,
          strictMcpConfig: !this.cfg.userMcp,
          allowedTools,
          additionalDirectories: this.cfg.additionalDirectories,
          disallowedTools: this.cfg.disallowedTools,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: appendPrompt, ...(this.cfg.freshPrompt && { snapshot: false }) },
          settingSources: ['user', 'project', 'local'],
          settings: this.cfg.memoryDir ? { autoMemoryDirectory: this.cfg.memoryDir } : undefined,
          pathToClaudeCodeExecutable: claudePath ?? undefined,
          env: { ...agentEnv(), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1', ...(this.apiKey && { ANTHROPIC_API_KEY: this.apiKey }) },
          canUseTool: (name, input, opts) => this.onPermission(name, input, opts as any),
          stderr: (d) => { if (/error|fatal/i.test(d)) console.error(`[agent ${spawn.id}]`, d.trim()); },
        },
      });
      for await (const m of this.q) this.onMessage(m as any);
      if (!this.restarting) this.emit({ k: 'ended', reason: 'closed' });
    } catch (e: any) {
      if (!this.stopped && !this.restarting) {
        const msg = String(e?.message ?? e);
        this.emit({ k: 'item', item: { kind: 'system', id: this.id('s'), at: Date.now(), text: msg, tone: 'error' } });
        this.emit({ k: 'attention', kind: 'error', text: msg.slice(0, 140) });
        this.emit({ k: 'activity', status: 'error', bucket: null });
      }
    } finally {
      this.q = null;
      this.running = false;
      this.sessionIdle = false;
      const unread = this.input.takeUnread();
      this.input = new InputQueue();
      const restart = this.restarting;
      this.restarting = null;
      // What arrived while it was restarting still gets answered.
      const waiting = restart ? [...unread, ...restart.arrived] : [];
      for (const m of waiting) this.input.push(m);
      if (restart?.carryOn) this.send(restart.carryOn, undefined, undefined, 'UE Fleet');
      else if (waiting.length && !this.stopped) void this.loop();
    }
  }

  private onMessage(m: any) {
    switch (m.type) {
      case 'rate_limit_event': return this.onRateLimit(m.rate_limit_info);
      case 'system': return this.onSystem(m);
      case 'stream_event': return this.onStream(m);
      case 'assistant': return this.onAssistant(m);
      case 'user': return this.onUserEcho(m);
      case 'tool_progress': return;
      case 'result': return this.onResult(m);
    }
  }

  // With extra usage turned on for the account the CLI carries on by itself, so that isn't a limit here.
  private onRateLimit(info: any) {
    if (info?.status !== 'rejected' || info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning') return;
    this.usageLimit = { resetsAt: info.resetsAt ? info.resetsAt * 1000 : undefined };
  }

  private onSystem(m: any) {
    if (m.subtype === 'session_state_changed') {
      this.sessionIdle = m.state === 'idle';
    } else if (m.subtype === 'init') {
      this.sessionId = m.session_id;
      this.emit({ k: 'session', sessionId: m.session_id, model: m.model });
    } else if (m.subtype === 'compact_boundary') {
      this.emit({ k: 'item', item: { kind: 'system', id: this.id('s'), at: Date.now(), text: 'Context compacted.' } });
    } else if (m.subtype === 'api_retry') {
      this.emit({ k: 'item', item: { kind: 'system', id: this.id('s'), at: Date.now(), text: `API retry ${m.attempt ?? ''}: ${m.error ?? ''}`.trim(), tone: 'warn' } });
    }
  }

  private onStream(m: any) {
    const ev = m.event;
    const sub = !!m.parent_tool_use_id;
    if (ev.type === 'message_start') {
      this.currentMsg = ev.message.id;
      const u = ev.message.usage ?? {};
      const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      this.lastOutput = 0;
      this.emit({ k: 'tokens', n: input });
      if (!sub) this.emit({ k: 'usage', usage: { context: input } });
      return;
    }
    if (ev.type === 'message_delta') {
      const out = ev.usage?.output_tokens ?? 0;
      if (out > this.lastOutput) { this.emit({ k: 'tokens', n: out - this.lastOutput }); this.lastOutput = out; }
      return;
    }
    if (sub) return;
    if (ev.type === 'content_block_start') {
      const t = ev.content_block.type;
      if (t === 'text' || t === 'thinking') {
        const id = `${this.currentMsg}:${ev.index}`;
        const list = this.streamBlocks.get(this.currentMsg) ?? [];
        list.push({ id, type: t });
        this.streamBlocks.set(this.currentMsg, list);
        this.emit({ k: 'item', item: t === 'text'
          ? { kind: 'assistant', id, at: Date.now(), text: '', streaming: true }
          : { kind: 'thinking', id, at: Date.now(), text: '', streaming: true } });
        this.emit({ k: 'activity', status: 'working', bucket: 'thinking' });
      }
    } else if (ev.type === 'content_block_delta') {
      const id = `${this.currentMsg}:${ev.index}`;
      if (ev.delta.type === 'text_delta') this.emit({ k: 'delta', id, text: ev.delta.text });
      else if (ev.delta.type === 'thinking_delta') this.emit({ k: 'delta', id, text: ev.delta.thinking });
    }
  }

  private onAssistant(m: any) {
    const sub = !!m.parent_tool_use_id;
    const msgId = m.message.id;
    for (const block of m.message.content ?? []) {
      if (block.type === 'text' || block.type === 'thinking') {
        if (sub) continue;
        const list = this.streamBlocks.get(msgId) ?? [];
        const idx = list.findIndex((b) => b.type === block.type);
        const id = idx >= 0 ? list.splice(idx, 1)[0].id : this.id('a');
        const text = block.type === 'text' ? block.text : block.thinking;
        this.emit({ k: 'item', item: block.type === 'text'
          ? { kind: 'assistant', id, at: Date.now(), text }
          : { kind: 'thinking', id, at: Date.now(), text } });
      } else if (block.type === 'tool_use') {
        this.tools.set(block.id, { at: Date.now(), name: block.name, input: block.input, sub });
        this.emit({ k: 'item', item: { kind: 'tool', id: block.id, at: Date.now(), name: block.name, input: block.input, state: 'running', sub } });
        const edited = CODING_TOOLS.test(block.name) ? block.input?.file_path ?? block.input?.notebook_path : undefined;
        if (typeof edited === 'string') this.cfg.onFileEdited?.(edited);
        if (!sub) {
          const c = classifyTool(block.name, block.input);
          this.emit({ k: 'activity', status: c.status, bucket: c.bucket, detail: block.name });
        }
      }
    }
    if (m.error) this.emit({ k: 'item', item: { kind: 'system', id: this.id('s'), at: Date.now(), text: `Assistant error: ${m.error}`, tone: 'error' } });
    if (this.apiKey && (m.error === 'billing_error' || m.error === 'authentication_failed')) this.creditsProblem = m.error;
  }

  private onUserEcho(m: any) {
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const t = this.tools.get(block.tool_use_id);
      const { text, images } = resultToParts(block.content);
      this.emit({ k: 'item', item: {
        kind: 'tool',
        id: block.tool_use_id,
        at: t?.at ?? Date.now(),
        name: t?.name ?? 'tool',
        input: t?.input,
        sub: t?.sub,
        state: block.is_error ? 'error' : 'done',
        result: text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n… (${text.length - MAX_RESULT} more characters)` : text,
        images: images.length ? images : undefined,
        ms: t ? Date.now() - t.at : undefined,
      } });
      this.tools.delete(block.tool_use_id);
    }
    if (!m.parent_tool_use_id) this.emit({ k: 'activity', status: 'working', bucket: 'thinking' });
  }

  private onResult(m: any) {
    const u = m.usage ?? {};
    this.emit({ k: 'usage', usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      costUsd: m.total_cost_usd ?? 0,
    } });
    const interrupted = this.interrupted;
    this.interrupted = false;
    const isError = !interrupted && (!!m.is_error || m.subtype !== 'success');
    const text = typeof m.result === 'string' ? m.result : (m.errors ?? []).join('\n');
    if (isError && this.apiKey && (this.creditsProblem || CREDITS_REFUSED.test(text))) this.emit({ k: 'credits-failed', why: text || this.creditsProblem! });
    else if (isError && !this.apiKey && (this.usageLimit || USAGE_LIMIT.test(text))) this.emit({ k: 'usage-limit', resetsAt: this.usageLimit?.resetsAt });
    this.usageLimit = null;
    this.creditsProblem = null;
    this.emit({ k: 'turn-end', interrupted, isError, text });
  }

  // A running session keeps the prompt it started with, so a new one means carrying on in a fresh
  // process. That waits for the next message, when the session is known to have nothing in flight.
  setAppendPrompt(text: string) {
    this.cfg.appendPrompt = text;
    this.promptChanged = !!this.q;
  }

  private onPermission(toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; decisionReason?: string }): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const id = this.id(toolName === 'AskUserQuestion' ? 'q' : 'p');
      this.pending.set(id, { resolve, input, suggestions: opts.suggestions });
      opts.signal?.addEventListener('abort', () => {
        if (this.pending.delete(id)) resolve({ behavior: 'deny', message: 'Cancelled.', interrupt: true });
      });
      if (toolName === 'AskUserQuestion') {
        const questions = (input.questions ?? []) as Question[];
        this.emit({ k: 'item', item: { kind: 'question', id, at: Date.now(), questions } });
        this.emit({ k: 'attention', kind: 'question', text: questions[0]?.question ?? 'Has a question for you', ref: id });
      } else {
        this.emit({ k: 'item', item: { kind: 'permission', id, at: Date.now(), tool: toolName, input, canAlways: !!opts.suggestions?.length, reason: opts.decisionReason } });
        this.emit({ k: 'attention', kind: 'permission', text: `Wants to use ${toolName}`, ref: id });
      }
      this.emit({ k: 'activity', status: 'attention', bucket: 'waiting' });
    });
  }

  decide(itemId: string, decision: 'allow' | 'always' | 'deny') {
    const p = this.pending.get(itemId);
    if (!p) return;
    this.pending.delete(itemId);
    if (decision === 'deny') p.resolve({ behavior: 'deny', message: 'The user denied this.' });
    else p.resolve({ behavior: 'allow', updatedInput: p.input, updatedPermissions: decision === 'always' ? p.suggestions : undefined });
    this.emit({ k: 'attention-clear', ref: itemId });
    this.emit({ k: 'activity', status: 'working', bucket: 'thinking' });
  }

  answer(itemId: string, answers: Record<string, string>) {
    const p = this.pending.get(itemId);
    if (!p) return;
    this.pending.delete(itemId);
    p.resolve({ behavior: 'allow', updatedInput: { ...p.input, answers } });
    this.emit({ k: 'attention-clear', ref: itemId });
    this.emit({ k: 'activity', status: 'working', bucket: 'thinking' });
  }

  // The same conversation carries on billed to this key, or back on the subscription without one. A
  // running session can't change what it's signed in with, so this restarts it from where it is.
  useCredits(apiKey: string | null, carryOn?: string) {
    this.apiKey = apiKey ?? undefined;
    if (this.q) {
      this.restarting = { carryOn, arrived: [] };
      this.q.close();
    } else if (carryOn) this.send(carryOn, undefined, undefined, 'UE Fleet');
  }

  // The session uses these from its next model call. With none running, the next one starts on them.
  async setOptions(o: AgentOptions) {
    Object.assign(this.cfg.spawn, o);
    if (!this.q) return;
    if (o.permissionMode) await this.q.setPermissionMode(o.permissionMode as any);
    if (o.model) await this.q.setModel(o.model);
    if (o.effort) await this.q.applyFlagSettings({ effortLevel: o.effort as any });
  }

  async interrupt() {
    this.interrupted = true;
    for (const [id, p] of this.pending) { p.resolve({ behavior: 'deny', message: 'Interrupted by the user.', interrupt: true }); this.pending.delete(id); }
    await this.q?.interrupt().catch(() => {});
    this.emit({ k: 'attention-clear' });
  }

  stop() {
    this.stopped = true;
    for (const [id, p] of this.pending) { p.resolve({ behavior: 'deny', message: 'Stopped.', interrupt: true }); this.pending.delete(id); }
    this.input.close();
    this.q?.close();
  }

  revive() { this.stopped = false; }
  systemNote(text: string, tone?: 'info' | 'warn' | 'error') {
    this.emit({ k: 'item', item: { kind: 'system', id: this.id('s'), at: Date.now(), text, tone } });
  }
}
