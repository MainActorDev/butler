/** The agent loop — reason→act→observe with hard budgets (plan Stage 1).
 *  ReAct discipline: tool handler throws become the tool RESULT (observation),
 *  never a crash; invalid tool calls get ONE structured repair prompt; budgets
 *  (hops, tokens, wall clock) abort cleanly with partial transcript persisted
 *  via the persistence hook. */
import type { Provider, ProviderMessage, ProviderTool } from './provider/index.ts';
import { ProviderError } from './provider/index.ts';

export class LoopError extends Error {
  constructor(message: string, readonly code: 'BUDGET_EXCEEDED' | 'ABORTED' | 'TOOL_CALL_INVALID', readonly partial: ProviderMessage[]) {
    super(message);
    this.name = 'LoopError';
  }
}

export interface LoopBudget {
  /** max provider round-trips (tool hops + final) */
  maxHops: number;
  /** max total tokens (in+out) across the run */
  maxTokens: number;
  /** wall-clock ms for the whole run */
  wallMs: number;
}

export const DEFAULT_BUDGET: LoopBudget = { maxHops: 12, maxTokens: 200_000, wallMs: 10 * 60_000 };

/** Minimal tool seam the loop needs (full registry + policy land in Stage 2). */
export interface LoopTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** the handler: may throw — the error becomes the observation */
  execute(args: Record<string, unknown>, ctx: { signal: AbortSignal | undefined }): Promise<string>;
}

export interface TurnEvent {
  type: 'turn.start' | 'provider.response' | 'tool.call' | 'tool.result' | 'turn.end' | 'turn.error';
  hop: number;
  detail?: unknown;
}

export interface LoopResult {
  /** the final assistant message (no tool calls) */
  answer: string;
  messages: ProviderMessage[];
  hops: number;
  tokens: { in: number; out: number };
  wallMs: number;
}

export interface LoopDeps {
  provider: Provider;
  tools: LoopTool[];
  budget?: Partial<LoopBudget>;
  /** persistence hook — called after every message appended (rows land in Stage 2) */
  onMessage?: (msg: ProviderMessage, meta: { hop: number; tokensIn: number; tokensOut: number }) => void;
  /** event stream for transports (WS emission in Stage 4) */
  onEvent?: (e: TurnEvent) => void;
  signal?: AbortSignal;
}

function toolDefs(tools: LoopTool[]): ProviderTool[] {
  return tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export async function runLoop(systemPrompt: string, userMessage: string, deps: LoopDeps): Promise<LoopResult> {
  const budget = { ...DEFAULT_BUDGET, ...deps.budget };
  const started = Date.now();
  const messages: ProviderMessage[] = [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }];
  const tokens = { in: 0, out: 0 };
  let repairs = 0;

  for (let hop = 1; hop <= budget.maxHops; hop++) {
    if (deps.signal?.aborted) throw new LoopError('aborted by caller', 'ABORTED', messages);
    const remainingMs = budget.wallMs - (Date.now() - started);
    if (remainingMs <= 0) throw new LoopError(`wall budget exhausted after ${Date.now() - started}ms`, 'BUDGET_EXCEEDED', messages);

    deps.onEvent?.({ type: 'turn.start', hop });
    // the LOOP owns the wall: even a provider that ignores remainingMs gets
    // aborted at the deadline (mock-hang proof, review F5)
    const wallSignal = AbortSignal.any([AbortSignal.timeout(remainingMs), ...(deps.signal ? [deps.signal] : [])]);
    let res;
    try {
      res = await deps.provider.complete(messages, toolDefs(deps.tools), { remainingMs, signal: wallSignal });
    } catch (err) {
      // caller abort vs wall timeout: AbortSignal.timeout raises TimeoutError;
      // a caller signal abort propagates AbortError (or a custom reason)
      const isWallTimeout = err instanceof Error && err.name === 'TimeoutError';
      if (deps.signal?.aborted && !isWallTimeout) throw new LoopError('aborted by caller', 'ABORTED', messages);
      // provider exhausted its own retries/timeouts — surface with partial transcript
      const pe = err instanceof ProviderError ? err : null;
      const msg = pe ? `${pe.code}: ${pe.message}`
        : err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'PROVIDER_TIMEOUT: wall deadline reached during provider call'
        : `provider failed: ${err instanceof Error ? err.message : String(err)}`;
      throw new LoopError(msg, 'BUDGET_EXCEEDED', messages);
    }

    if (res.usage) { tokens.in += res.usage.promptTokens; tokens.out += res.usage.completionTokens; }
    messages.push(res.message);
    deps.onMessage?.(res.message, { hop, tokensIn: res.usage?.promptTokens ?? 0, tokensOut: res.usage?.completionTokens ?? 0 });
    deps.onEvent?.({ type: 'provider.response', hop, detail: { finishReason: res.finishReason, tokens: res.usage } });

    if (tokens.in + tokens.out > budget.maxTokens) {
      throw new LoopError(`token budget exceeded (${tokens.in + tokens.out} > ${budget.maxTokens})`, 'BUDGET_EXCEEDED', messages);
    }

    const calls = res.message.tool_calls ?? [];
    if (calls.length === 0) {
      // final answer
      const answer = res.message.content ?? '';
      deps.onEvent?.({ type: 'turn.end', hop, detail: { answer: answer.slice(0, 200) } });
      return { answer, messages, hops: hop, tokens, wallMs: Date.now() - started };
    }

    // execute each tool call; results append as tool messages (ReAct observations)
    for (const call of calls) {
      const tool = deps.tools.find((t) => t.name === call.function.name);
      if (!tool) {
        const obs = `error: unknown tool "${call.function.name}" — available: ${deps.tools.map((t) => t.name).join(', ')}`;
        const msg: ProviderMessage = { role: 'tool', content: obs, tool_call_id: call.id };
        messages.push(msg);
        deps.onMessage?.(msg, { hop, tokensIn: 0, tokensOut: 0 });
        deps.onEvent?.({ type: 'tool.result', hop, detail: { id: call.id, unknown: true } });
        continue;
      }
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        if (repairs++ < 1) {
          // ONE structured repair round: tell the model exactly what was wrong
          const msg: ProviderMessage = { role: 'tool', content: `error: arguments for ${call.function.name} are not valid JSON — resend with a valid JSON object`, tool_call_id: call.id };
          messages.push(msg);
          deps.onMessage?.(msg, { hop, tokensIn: 0, tokensOut: 0 });
          continue;
        }
        throw new LoopError(`tool ${call.function.name} sent invalid JSON twice`, 'TOOL_CALL_INVALID', messages);
      }
      deps.onEvent?.({ type: 'tool.call', hop, detail: { id: call.id, name: call.function.name } });
      let obs: string;
      try {
        obs = await tool.execute(args, { signal: deps.signal ?? undefined });
      } catch (err) {
        // handler throws become observations (ReAct) — the loop continues
        obs = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      const msg: ProviderMessage = { role: 'tool', content: obs, tool_call_id: call.id };
      messages.push(msg);
      deps.onMessage?.(msg, { hop, tokensIn: 0, tokensOut: 0 });
      deps.onEvent?.({ type: 'tool.result', hop, detail: { id: call.id, name: call.function.name, bytes: obs.length } });
    }
  }
  throw new LoopError(`hop budget exhausted (${budget.maxHops})`, 'BUDGET_EXCEEDED', messages);
}
