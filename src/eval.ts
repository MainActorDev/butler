/** Eval harness (plan Stage 5, D6): fixture-driven metrics that run in CI and
 *  CAN FAIL. Three families:
 *    authoring — ticket fixture → drafted spec passes the validator (ground
 *                truth judges, never model self-report)
 *    retrieval  — query set → expected doc in top-k (BM25 over fixtures)
 *    budget     — loops respect caps (hops/tokens/wall) under a misbehaving
 *                provider
 *  CI runs these against the MOCK provider by default; live-provider evals
 *  run when BUTLER_* env is present (reported honestly, skipped otherwise). */

import type { Provider, ScriptedTurn } from './provider/index.ts';
import { MockProvider } from './provider/mock.ts';
import { runLoop } from './loop.ts';
import type { LoopTool } from './loop.ts';

export interface EvalCase<Q, E> {
  name: string;
  /** the input */
  given: Q;
  /** the expectation the metric asserts */
  expect: E;
}

export interface EvalResult {
  suite: string;
  cases: Array<{ name: string; pass: boolean; metric: string; detail: string }>;
  passRate: number;
  passed: boolean;
}

function report(suite: string, cases: Array<{ name: string; pass: boolean; metric: string; detail: string }>, threshold: number): EvalResult {
  const passedCount = cases.filter((c) => c.pass).length;
  const rate = cases.length === 0 ? 1 : passedCount / cases.length;
  return {
    suite,
    cases,
    passRate: Math.round(rate * 1000) / 1000,
    passed: rate >= threshold,
  };
}

// ── retrieval eval ─────────────────────────────────────────────────────────

export interface RetrievalEvalInput {
  retrieve(query: string, topK: number): Promise<Array<{ ref: string; content: string }>>;
  cases: EvalCase<string, string>[]; // given: query; expect: substring of the right doc
  topK?: number;
  threshold?: number;
}

export async function evalRetrieval(input: RetrievalEvalInput): Promise<EvalResult> {
  const topK = input.topK ?? 3;
  const threshold = input.threshold ?? 1;
  const cases = await Promise.all(input.cases.map(async (c) => {
    const hits = await input.retrieve(c.given, topK);
    const pass = hits.some((h) => h.content.includes(c.expect) || h.ref.startsWith(c.expect));
    return { name: c.name, pass, metric: `top-${topK} contains "${c.expect.slice(0, 40)}"`, detail: pass ? '' : `got: ${hits.map((h) => h.ref).join(', ') || 'nothing'}` };
  }));
  return report('retrieval', cases, threshold);
}

// ── budget eval ────────────────────────────────────────────────────────────

export interface BudgetEvalInput {
  cases: Array<EvalCase<ScriptedTurn[], { code: string; maxWallMs?: number }>>;
  tools: LoopTool[];
  threshold?: number;
}

export async function evalBudget(input: BudgetEvalInput): Promise<EvalResult> {
  const threshold = input.threshold ?? 1;
  const cases = await Promise.all(input.cases.map(async (c) => {
    const provider = new MockProvider(c.given);
    const t0 = Date.now();
    const err = await runLoop('sys', 'go', { provider, tools: input.tools, budget: { maxHops: 6, maxTokens: 1_000, wallMs: 2_000 } })
      .then(() => null)
      .catch((e: unknown) => e as { code?: string });
    const wall = Date.now() - t0;
    if (!err) return { name: c.name, pass: false, metric: 'expected a budget error', detail: 'loop completed without hitting a cap' };
    const codeOk = err.code === c.expect.code;
    const wallOk = c.expect.maxWallMs === undefined || wall <= c.expect.maxWallMs;
    return { name: c.name, pass: codeOk && wallOk, metric: `${c.expect.code} within ${c.expect.maxWallMs ?? '∞'}ms`, detail: `code=${err.code ?? 'none'}, wall=${wall}ms` };
  }));
  return report('budget', cases, threshold);
}

// ── authoring eval ─────────────────────────────────────────────────────────

export interface AuthoringEvalInput {
  cases: Array<{
    name: string;
    /** scripted (mock) or live provider */
    provider: Provider;
    /** tools the loop may use — the validator tool is the ground truth */
    tools: LoopTool[];
    /** validates the FINAL answer or the last draft (returns errors; empty = valid) */
    judge: (result: { answer: string; messages: unknown[] }) => string[];
    budget?: { maxHops?: number; maxTokens?: number; wallMs?: number };
    /** task instruction handed to the agent (default: a generic draft-and-validate ask) */
    prompt?: string;
    systemPrompt?: string;
  }>;
  threshold?: number;
}

export async function evalAuthoring(input: AuthoringEvalInput): Promise<EvalResult> {
  const threshold = input.threshold ?? 1;
  const cases = [];
  for (const c of input.cases) {
    try {
      const result = await runLoop(c.systemPrompt ?? 'You draft specs. Always call spec.draft then spec.validate before answering.', c.prompt ?? 'Draft a spec from the available docs and validate it.', { provider: c.provider, tools: c.tools, ...(c.budget ? { budget: c.budget } : {}) });
      const errors = c.judge({ answer: result.answer, messages: result.messages });
      cases.push({ name: c.name, pass: errors.length === 0, metric: 'validator ground-truth', detail: errors.length ? errors.join('; ').slice(0, 200) : '' });
    } catch (err) {
      cases.push({ name: c.name, pass: false, metric: 'loop completed', detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return report('authoring', cases, threshold);
}
