// The master chat: one long-running Claude session on the user's main PC. Every new request goes
// through it, and it's the agents' way to anything only this PC is logged into. It routes and
// fetches, and the work itself is done by the agents it starts.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AgentRunner } from '../node/agentRunner';
import { MASTER_CHAT_ID, type AgentEvent, type AgentSpawn, type ImageAttachment } from '../shared/protocol';

export const MASTER_MODEL = 'claude-sonnet-5-5';
export const MASTER_EFFORT = 'medium';

export interface MasterActions {
  machines(): unknown;
  agents(): unknown;
  startTask(a: { prompt: string; title?: string; project?: string; machine?: string }): Promise<string>;
  messageAgent(a: { agent: number; text: string }): Promise<string>;
  answerAgent(a: { request_id: string; answer: string }): Promise<string>;
  assignChangelist(a: { agent: number; name: string; description: string }): Promise<string>;
}

export function masterPrompt(machineName: string) {
  return `
# You are the master chat of UE Fleet
You run on ${machineName}, the user's main PC, and you coordinate agents that do the real work on this and other PCs. Your own job is to route and to fetch. Don't do the task yourself, and don't edit files.

## New requests
Everything the user types as a new task comes to you first.
1. Call list_agents. If the request belongs with an agent already on that work, use message_agent.
2. Otherwise call start_task. Leave machine out so placement picks the best PC by its load, unless the user named one. Use the project the request names, or the one in the options line.
3. If the request points at a ticket or document, fetch it now, because the agent's machine may not be logged in. Put what you find in the prompt along with the user's own words, so the agent starts with everything it needs. If you can't reach it, say so in the prompt and start anyway.
4. Reply with one line saying what you did. Don't ask for confirmation unless the request is truly unclear.

## Questions from agents
A message headed [Question from agent ...] comes from an agent that's stopped until you answer. Fetch what it needs and call answer_agent with its request_id. If only the user can answer, use AskUserQuestion first. If you can't find out, say so through answer_agent so it can carry on.

## Changelists
A message headed [Ready for a changelist] means tested work has been merged into the user's workspace. Call assign_changelist with a short name someone would recognise in Plastic, starting with the ticket number if there is one, such as "NIGH-2863 Fix quickbar reset", and a one-sentence description. Don't check anything in.

## How you reach the user
Your plain replies don't alert them. When you need them, use AskUserQuestion. Keep replies short. Never use a tool that reaches an Unreal editor, because that would be the user's own.`;
}

export const MASTER_TOOLS = ['list_machines', 'list_agents', 'start_task', 'message_agent', 'answer_agent', 'assign_changelist'].map((n) => `mcp__fleet__${n}`);

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError });

function masterServer(a: MasterActions) {
  const always: typeof tool = (name, description, schema, handler) => tool(name, description, schema, handler, { alwaysLoad: true });
  const guarded = <A,>(fn: (x: A) => Promise<string>) => async (x: A) => {
    try { return text(await fn(x)); } catch (e: any) { return text(String(e?.message ?? e), true); }
  };
  return createSdkMcpServer({
    name: 'fleet',
    version: '1.0.0',
    tools: [
      always('list_machines', 'Every machine: whether it is online, CPU, free RAM, running agents and the projects it has.', {}, guarded(async () => JSON.stringify(a.machines(), null, 2))),
      always('list_agents', 'Every agent: number, title, stage, machine, project, progress and what it last said.', {}, guarded(async () => JSON.stringify(a.agents(), null, 2))),
      always('start_task', 'Start a new agent on a task.', {
        prompt: z.string().describe("The agent's full brief: the user's own words plus anything you fetched for it."),
        title: z.string().optional().describe('A few words for its card, with the ticket number if there is one.'),
        project: z.string().optional().describe('Project name. Leave out to use the one in the options line.'),
        machine: z.string().optional().describe('Only if the user named a machine. Otherwise placement picks by load.'),
      }, guarded((x) => a.startTask(x))),
      always('message_agent', 'Send something to an agent that is already running, by its number.', { agent: z.number().int(), text: z.string() }, guarded((x) => a.messageAgent(x))),
      always('answer_agent', 'Answer a question from an agent, using the request_id from its message.', { request_id: z.string(), answer: z.string() }, guarded((x) => a.answerAgent(x))),
      always('assign_changelist', "Put an agent's merged files into a Plastic changelist. This doesn't check anything in.", {
        agent: z.number().int(),
        name: z.string().describe('Short and recognisable, starting with the ticket number if there is one.'),
        description: z.string(),
      }, guarded((x) => a.assignChangelist(x))),
    ],
  });
}

// Keeps a session going for the hub, speaking the same method names as a machine.
export interface MasterBackend {
  send(text: string, images?: ImageAttachment[], from?: string): void;
  decide(itemId: string, d: 'allow' | 'always' | 'deny'): void;
  answer(itemId: string, answers: Record<string, string>): void;
  interrupt(): Promise<void> | void;
  stop(): void;
}

export class RealMaster implements MasterBackend {
  private runner: AgentRunner;
  private started = false;
  constructor(cfg: { spawn: AgentSpawn; cwd: string; claudePath: string | null; machineName: string; actions: MasterActions; otherDirs: string[]; emit: (ev: AgentEvent) => void }) {
    fs.mkdirSync(cfg.cwd, { recursive: true });
    this.runner = new AgentRunner({
      spawn: cfg.spawn,
      cwd: cfg.cwd,
      claudePath: cfg.claudePath,
      mcpServers: { fleet: masterServer(cfg.actions) },
      allowedTools: MASTER_TOOLS,
      appendPrompt: masterPrompt(cfg.machineName),
      emit: cfg.emit,
      // It keeps the user's own connections, which are the point of it. It can't edit files, and it
      // can't reach an editor through whatever the project's own config points at.
      userMcp: true,
      additionalDirectories: cfg.otherDirs,
      disallowedTools: ['Edit', 'Write', 'NotebookEdit', ...unrealServers(cfg.cwd).map((s) => `mcp__${s}`)],
    });
  }
  send(text: string, images?: ImageAttachment[], from?: string) {
    if (!this.started) { this.started = true; this.runner.start(); }
    this.runner.send(text, images, undefined, from);
  }
  decide(itemId: string, d: 'allow' | 'always' | 'deny') { this.runner.decide(itemId, d); }
  answer(itemId: string, answers: Record<string, string>) { this.runner.answer(itemId, answers); }
  interrupt() { return this.runner.interrupt(); }
  stop() { this.runner.stop(); }
}

function unrealServers(cwd: string): string[] {
  try {
    const servers = JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8')).mcpServers ?? {};
    return Object.keys(servers).filter((n) => /unreal/i.test(n));
  } catch { return []; }
}

// The scripted stand-in, so the whole flow runs without tokens.
export class DemoMaster implements MasterBackend {
  private seq = 0;
  constructor(private actions: MasterActions, private emit: (ev: AgentEvent) => void) {}
  private say(text: string) {
    this.emit({ k: 'item', item: { kind: 'assistant', id: `m-${Date.now().toString(36)}-${++this.seq}`, at: Date.now(), text } });
    this.emit({ k: 'turn-end' });
  }
  send(text: string, _images?: ImageAttachment[], from?: string) {
    this.emit({ k: 'item', item: { kind: 'user', id: `mu-${Date.now().toString(36)}-${++this.seq}`, at: Date.now(), text, from } });
    void this.handle(text).catch((e) => this.say(String(e?.message ?? e)));
  }
  private async handle(text: string) {
    const question = text.match(/^\[Question from agent[^\n]*\]\nrequest_id: (\S+)/);
    if (question) { this.say(await this.actions.answerAgent({ request_id: question[1], answer: 'Scripted answer: the sprinkler should run at dawn.' })); return; }
    const ready = text.match(/^\[Ready for a changelist\] Agent (\d+) "([^"]*)"/);
    if (ready) { this.say(await this.actions.assignChangelist({ agent: Number(ready[1]), name: ready[2], description: 'Scripted changelist.' })); return; }
    this.say(await this.actions.startTask({ prompt: text.split('\n\n(Options:')[0] }));
  }
  decide() {}
  answer() {}
  interrupt() {}
  stop() {}
}

export { MASTER_CHAT_ID };
