// Drives one Claude Code session through the Agent SDK and normalises everything it does
// into AgentEvents, so the hub never has to know about SDK message shapes.
import { query, type McpServerConfig, type PermissionResult, type PermissionUpdate, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ActivityBucket, AgentEvent, AgentSpawn, AgentStatus, ImageAttachment, Question } from '../shared/protocol';
import { agentEnv } from './machine';

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(m: SDKUserMessage) { this.items.push(m); this.wake?.(); }
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
}

type Pending = { resolve: (r: PermissionResult) => void; input: Record<string, unknown>; suggestions?: PermissionUpdate[] };

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
  running = false;

  constructor(private cfg: RunnerConfig) {
    this.sessionId = cfg.spawn.resumeSessionId;
  }

  private id(prefix: string) { return `${prefix}-${Date.now().toString(36)}-${++this.seqId}`; }
  private emit(ev: AgentEvent) { this.cfg.emit(ev); }

  start(initial?: { text: string; images?: ImageAttachment[]; broadcastId?: string }) {
    if (initial?.text) this.send(initial.text, initial.images, initial.broadcastId);
    void this.loop();
  }

  send(text: string, images?: ImageAttachment[], broadcastId?: string) {
    const content: any[] = [];
    const shown: string[] = [];
    for (const img of images ?? []) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      shown.push(`data:${img.mediaType};base64,${img.data}`);
    }
    content.push({ type: 'text', text });
    this.emit({ k: 'item', item: { kind: 'user', id: this.id('u'), at: Date.now(), text, images: shown.length ? shown : undefined, broadcastId } });
    this.emit({ k: 'attention-clear' });
    this.emit({ k: 'activity', status: 'working', bucket: 'thinking' });
    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } as SDKUserMessage);
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
          // Agents must only ever reach their own editor, never one from the user's config.
          strictMcpConfig: true,
          allowedTools,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: appendPrompt },
          settingSources: ['user', 'project', 'local'],
          settings: this.cfg.memoryDir ? { autoMemoryDirectory: this.cfg.memoryDir } : undefined,
          pathToClaudeCodeExecutable: claudePath ?? undefined,
          env: agentEnv(),
          canUseTool: (name, input, opts) => this.onPermission(name, input, opts as any),
          stderr: (d) => { if (/error|fatal/i.test(d)) console.error(`[agent ${spawn.id}]`, d.trim()); },
        },
      });
      for await (const m of this.q) this.onMessage(m as any);
      this.emit({ k: 'ended', reason: 'closed' });
    } catch (e: any) {
      if (!this.stopped) {
        const msg = String(e?.message ?? e);
        this.emit({ k: 'item', item: { kind: 'system', id: this.id('s'), at: Date.now(), text: msg, tone: 'error' } });
        this.emit({ k: 'attention', kind: 'error', text: msg.slice(0, 140) });
        this.emit({ k: 'activity', status: 'error', bucket: null });
      }
    } finally {
      this.q = null;
      this.running = false;
      this.input = new InputQueue();
    }
  }

  private onMessage(m: any) {
    switch (m.type) {
      case 'system': return this.onSystem(m);
      case 'stream_event': return this.onStream(m);
      case 'assistant': return this.onAssistant(m);
      case 'user': return this.onUserEcho(m);
      case 'tool_progress': return;
      case 'result': return this.onResult(m);
    }
  }

  private onSystem(m: any) {
    if (m.subtype === 'init') {
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
        if (!sub) {
          const c = classifyTool(block.name, block.input);
          this.emit({ k: 'activity', status: c.status, bucket: c.bucket, detail: block.name });
        }
      }
    }
    if (m.error) this.emit({ k: 'item', item: { kind: 'system', id: this.id('s'), at: Date.now(), text: `Assistant error: ${m.error}`, tone: 'error' } });
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
    this.emit({ k: 'turn-end', interrupted, isError: !interrupted && (!!m.is_error || m.subtype !== 'success'), text: typeof m.result === 'string' ? m.result : (m.errors ?? []).join('\n') });
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
