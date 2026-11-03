// How much of the subscription's usage is left, as the server reports it. This asks the CLI, which
// costs no tokens. The call is marked experimental, so anything unexpected means showing nothing
// rather than showing something wrong.
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import os from 'node:os';
import type { UsageMeter } from '../shared/protocol';
import { agentEnv } from './machine';

const TIMEOUT_MS = 30_000;

export function metersFrom(report: any): UsageMeter[] | null {
  const limits = report?.rate_limits_available === false ? null : report?.rate_limits?.limits;
  if (!Array.isArray(limits) || !limits.length) return null;
  const labelOf = (row: any) => {
    const scoped = row.scope?.model?.display_name ?? row.scope?.surface?.display_name;
    if (scoped) return `${scoped} ${row.group ?? ''}`.trim();
    if (row.kind === 'session') return 'Session';
    if (row.kind === 'weekly_all') return 'Week';
    return String(row.group ?? row.kind);
  };
  return limits.filter((row: any) => typeof row?.percent === 'number').map((row: any): UsageMeter => ({
    label: labelOf(row),
    main: !row.scope,
    percentLeft: Math.max(0, Math.min(100, Math.round(100 - row.percent))),
    resetsAt: row.resets_at ?? undefined,
    severity: String(row.severity ?? 'normal'),
  }));
}

export async function fetchPlanUsage(claudePath: string | null): Promise<UsageMeter[] | null> {
  let finish = () => {};
  const held = new Promise<void>((r) => { finish = r; });
  // A session that never sends a prompt, so nothing is spent.
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> { await held; })();
  const q = query({ prompt, options: { pathToClaudeCodeExecutable: claudePath ?? undefined, cwd: os.tmpdir(), settingSources: [], persistSession: false, env: agentEnv() } });
  try {
    const ask = (q as any).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof ask !== 'function') return null;
    const timeout = new Promise<null>((r) => { setTimeout(() => r(null), TIMEOUT_MS).unref(); });
    return metersFrom(await Promise.race([ask.call(q, { skipBehaviors: true }), timeout]));
  } catch {
    return null;
  } finally {
    finish();
    q.close();
  }
}
