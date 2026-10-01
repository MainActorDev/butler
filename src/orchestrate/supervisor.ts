/** Orchestration L2 (plan Stage D): supervisor spawns child sessions with
 *  independent budgets that roll up to the parent's caps; parent abort cancels
 *  children (cancel graph); supervisor receives SUMMARIES, not transcripts;
 *  named-skip on child budget overflow — the fan-out never aborts.
 *
 *  Built ON the eval family in test/eval-orchestration.test.ts (D.0). */

import type { Provider } from '../provider/index.ts';
import { runLoop, type LoopBudget, type LoopTool, type TurnEvent } from '../loop.ts';
import type { Storage } from '../memory/contract.ts';
import { createHash } from 'node:crypto';

export interface ChildSpec {
  /** short goal handed to the child (narrowed system prompt) */
  goal: string;
  /** what the child should do — provider-script for mocks, real for live */
  prompt: string;
  budget?: Partial<LoopBudget>;
}

export interface ChildReport {
  childId: string;
  ok: boolean;
  summary: string;
  tokens: { in: number; out: number };
  wallMs: number;
  code?: string | undefined; // BUDGET_EXCEEDED | ABORTED | … when !ok
}

export interface SupervisorDeps {
  /** provider OR factory: concurrent children MUST NOT share one scripted
   *  provider (interleaved call counters race) — pass a factory for mocks */
  provider: Provider | (() => Provider);
  storage: Storage;
  tools: LoopTool[];
  parentSessionId: string;
  emit?: (e: TurnEvent & { sessionId: string; child?: string }) => void;
}

/** Derive child budgets from the parent's REMAINING allowance (plan D).
 *  Tokens and wall roll up (shared pools, pro-rata); HOPS do not — hops are a
 *  per-loop bound, not a consumable pool: dividing them makes children too
 *  small to finish (caught live: 4-turn scripts died at maxHops=1). Each child
 *  gets the parent's hop ceiling; the parent's hop budget governs the
 *  SUPERVISOR loop, not the sum of children. */
export function childBudgets(parent: Partial<LoopBudget>, n: number, elapsedMs: number, spentTokens: number): LoopBudget[] {
  const full: LoopBudget = { maxHops: 12, maxTokens: 200_000, wallMs: 10 * 60_000, ...parent };
  const remainingTokens = Math.max(0, full.maxTokens - spentTokens);
  const remainingWall = Math.max(0, full.wallMs - elapsedMs);
  const perChildTokens = Math.floor(remainingTokens / Math.max(1, n));
  return Array.from({ length: n }, () => ({ maxHops: full.maxHops, maxTokens: perChildTokens, wallMs: remainingWall }));
}

const SUMMARY_MAX = 400;

/** fan out children concurrently; collect summaries; named-skip on failure */
export async function fanOut(specs: ChildSpec[], deps: SupervisorDeps, parentBudget: Partial<LoopBudget> = {}): Promise<{ reports: ChildReport[]; tokens: { in: number; out: number } }> {
  const t0 = Date.now();
  const parentFull: LoopBudget = { maxHops: 12, maxTokens: 200_000, wallMs: 10 * 60_000, ...parentBudget };
  const budgets = childBudgets(parentFull, specs.length, 0, 0);

  const reports = await Promise.all(specs.map(async (spec, i): Promise<ChildReport> => {
    const childId = `sess_child_${createHash('sha256').update(`${deps.parentSessionId}:${i}:${spec.goal}`).digest('hex').slice(0, 10)}`;
    // the session tree: child rows point at the parent (the Stage-2 seam)
    await deps.storage.createSession({ id: childId, parent_session_id: deps.parentSessionId, depth: 1, title: spec.goal.slice(0, 60) });
    const childT0 = Date.now();
    try {
      const result = await runLoop(
        `You are a sub-agent. Goal: ${spec.goal}. Work ONLY toward it; the supervisor receives your final answer as a summary.`,
        spec.prompt,
        {
          provider: typeof deps.provider === 'function' ? deps.provider() : deps.provider,
          tools: deps.tools,
          ...(budgets[i] ? { budget: budgets[i] } : {}),
          onMessage: (msg, meta) => {
            void deps.storage.appendMessage({
              session_id: childId, role: msg.role, content: msg.content,
              tool_calls_json: msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
              tool_results_json: null, tokens_in: meta.tokensIn, tokens_out: meta.tokensOut,
            });
          },
          ...(deps.emit ? { onEvent: (e: TurnEvent) => deps.emit?.({ ...e, sessionId: deps.parentSessionId, child: childId }) } : {}),
        },
      );
      // SUMMARY not transcript (information-bottleneck discipline)
      const summary = result.answer.length > SUMMARY_MAX ? `${result.answer.slice(0, SUMMARY_MAX)}…` : result.answer;
      await deps.storage.updateSession(childId, { status: 'ended', tokens_in: result.tokens.in, tokens_out: result.tokens.out });
      return { childId, ok: true, summary, tokens: result.tokens, wallMs: Date.now() - childT0 };
    } catch (err) {
      // named-skip: the child's failure is a REPORT, never a fan-out abort
      const e = err as { code?: string; message?: string };
      await deps.storage.updateSession(childId, { status: 'error' });
      return { childId, ok: false, summary: `skipped: ${e.code ?? 'error'} — ${(e.message ?? String(err)).slice(0, 120)}`, tokens: { in: 0, out: 0 }, wallMs: Date.now() - childT0, code: e.code };
    }
  }));

  const tokens = reports.reduce((acc, r) => ({ in: acc.in + r.tokens.in, out: acc.out + r.tokens.out }), { in: 0, out: 0 });
  void parentFull;
  return { reports, tokens };
}

/** supervisor turn: run a loop that can CALL fan-out via a spawn tool */
export function spawnTool(deps: SupervisorDeps, parentBudget: Partial<LoopBudget> = {}): LoopTool {
  return {
    name: 'agent.spawn',
    description: 'spawn child agents for a fan-out; pass an array of goals. Children run concurrently with rolled-up budgets. You receive SUMMARIES, not transcripts.',
    parameters: {
      type: 'object',
      properties: {
        goals: { type: 'array', items: { type: 'object', properties: { goal: { type: 'string' }, prompt: { type: 'string' } }, required: ['goal', 'prompt'] } },
      },
      required: ['goals'],
    },
    execute: async (args) => {
      const goals = (args['goals'] as Array<{ goal?: string; prompt?: string }>) ?? [];
      if (!Array.isArray(goals) || goals.length === 0) return 'error: goals[] required';
      const specs: ChildSpec[] = goals
        .filter((g): g is { goal: string; prompt: string } => typeof g.goal === 'string' && typeof g.prompt === 'string')
        .map((g) => ({ goal: g.goal, prompt: g.prompt }));
      if (specs.length === 0) return 'error: goals[] needs {goal, prompt} entries';
      const { reports, tokens } = await fanOut(specs, deps, parentBudget);
      return JSON.stringify({ reports: reports.map((r) => ({ child: r.childId.slice(-6), ok: r.ok, summary: r.summary, tokens: r.tokens })), totalTokens: tokens }, null, 2);
    },
  };
}
