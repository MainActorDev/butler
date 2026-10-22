/** The agent loop — reason→act→observe with hard budgets (plan Stage 1).
 *  ReAct discipline: tool handler throws become the tool RESULT (observation),
 *  never a crash; invalid tool calls get ONE structured repair prompt; budgets
 *  (hops, tokens, wall clock) abort cleanly with partial transcript persisted
 *  via the persistence hook. */
import type { Provider, ProviderMessage, ProviderTool } from './provider/index.ts';
import { ProviderError } from './provider/index.ts';
import type { TextBlockActivity } from './provider/activity.ts';
import { createBlockTracker } from './provider/activity.ts';

/** Loop failure codes. Budget/abort/invalid are loop-owned outcomes;
 *  PROVIDER_* codes classify provider failures (chat-reliability F3: the loop
 *  must never relabel a permanent provider rejection as exhausted runway).
 *  The `string & {}` member passes provider-owned codes through unchanged
 *  (e.g. PROVIDER_BAD_REQUEST, PROVIDER_UNAVAILABLE, MCP_PENDING). */
export type LoopErrorCode =
  | 'BUDGET_EXCEEDED'
  | 'ABORTED'
  | 'TOOL_CALL_INVALID'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_FAILED'
  | (string & {});

/** What actually terminated the loop. Consumers key continuation eligibility
 *  (budget stash vs honest failure) off the cause, not the message string. */
export type LoopErrorCause =
  | 'budget-hop'
  | 'budget-wall'
  | 'budget-token'
  | 'caller-abort'
  | 'provider'
  | 'tool-invalid';

export class LoopError extends Error {
  constructor(message: string, readonly code: LoopErrorCode, readonly partial: ProviderMessage[], readonly cause?: LoopErrorCause, readonly status?: number) {
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
  type: 'turn.start' | 'provider.response' | 'turn.end' | 'turn.error' | 'turn.delta' | 'turn.tool';
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
  /** prior turns for multi-turn memory (user + textful assistant messages) */
  history?: ProviderMessage[];
  /** event stream for transports (WS emission in Stage 4) */
  onEvent?: (e: TurnEvent) => void;
  /** live token stream — called per provider delta (streaming UI) */
  onDelta?: (delta: string) => void;
  /** R2-F4: provider-scoped session key (claude-cli --resume isolation) */
  sessionKey?: string;
  /** structured tool events (claude-cli harness + registry loop).
   *  invocationId: the provider-NATIVE call id when one exists (runtime
   *  registry tools carry it from the assistant tool_calls); durability keys
   *  per INVOCATION, never per tool name. */
  onTool?: (e: { phase: 'call' | 'result'; name: string; invocationId?: string; arg?: string; result?: string; isError?: boolean }) => void;
  /** R3 decision 4: opt INTO the hard token cap (fan-out children); default advisory */
  hardTokenCap?: boolean;
  /** chat-reliability F2 (text block lifecycle): per-block activity for the
   *  durable chunk rail — start/delta/end per assistant message (hop), so a
   *  replayed log can separate consecutive hops' narration instead of gluing
   *  it. Purely additive: absent → behavior identical to before. */
  onActivity?: (a: TextBlockActivity) => void;
  signal?: AbortSignal;
}

function toolDefs(tools: LoopTool[]): ProviderTool[] {
  return tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export async function runLoop(systemPrompt: string, userMessage: string, deps: LoopDeps): Promise<LoopResult> {
  const budget = { ...DEFAULT_BUDGET, ...deps.budget };
  const started = Date.now();
  // prior conversation (memory): injected between system and the fresh user
  // message so multi-turn sessions keep context. Callers cap it.
  const messages: ProviderMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(deps.history ?? []),
    { role: 'user', content: userMessage },
  ];
  const tokens = { in: 0, out: 0 };
  let repairs = 0;
  // chat-reliability F2: the block tracker runs only when a consumer asked
  // for block activity; block ids are hop-scoped and stable per run.
  const tracker = deps.onActivity ? createBlockTracker(deps.onActivity, (h) => `blk_h${h}`) : undefined;

  for (let hop = 1; hop <= budget.maxHops; hop++) {
    if (deps.signal?.aborted) throw new LoopError('aborted by caller', 'ABORTED', messages, 'caller-abort');
    const remainingMs = budget.wallMs - (Date.now() - started);
    if (remainingMs <= 0) throw new LoopError(`wall budget exhausted after ${Date.now() - started}ms`, 'BUDGET_EXCEEDED', messages, 'budget-wall');

    deps.onEvent?.({ type: 'turn.start', hop });
    // the LOOP owns the wall: even a provider that ignores remainingMs gets
    // aborted at the deadline (mock-hang proof, review F5). F3: the deadline
    // stays a SEPARATE signal so the catch can attribute the failure from
    // observed signal state instead of the exception name; composition with
    // the caller signal happens only here, at the provider seam.
    const wallDeadline = AbortSignal.timeout(remainingMs);
    const wallSignal = AbortSignal.any(deps.signal ? [wallDeadline, deps.signal] : [wallDeadline]);
    // chat-reliability identity contract: harness tool events without a
    // provider-native id get one ALLOCATED at first observation — never key
    // durability by tool name (repeated same-name invocations must stay
    // distinct). Pairing call→result is FIFO per name WITHIN this provider
    // call only (a deterministic window); an unpaired result stays uncorrelated.
    const harnessPending = new Map<string, string[]>();
    let harnessSeq = 0;
    let res;
    // F2: the LOOP accumulates the streamed text itself (sum of deltas) — the
    // completed message's content may differ from the stream (claude-cli
    // snapshot vs partial stream), so text.end must not trust content.
    let streamedText = '';
    try {
      // streaming: the EVENT always flows (WS UIs); the direct callback stays
      // opt-in for hosts that want it without the event bus
      res = await deps.provider.complete(messages, toolDefs(deps.tools), { remainingMs, signal: wallSignal, ...(deps.sessionKey !== undefined ? { sessionKey: deps.sessionKey } : {}), onDelta: (d: string) => { streamedText += d; tracker?.onDelta(hop, d); deps.onDelta?.(d); deps.onEvent?.({ type: 'turn.delta', hop, detail: { delta: d } }); }, onTool: (e: { phase: 'call' | 'result'; name: string; invocationId?: string; arg?: string; result?: string; isError?: boolean }) => {
          let out = e;
          if (e.invocationId === undefined) {
            const pending = harnessPending.get(e.name) ?? [];
            if (e.phase === 'call') {
              const id = `alloc_${hop}_${harnessSeq++}`;
              pending.push(id);
              harnessPending.set(e.name, pending);
              out = { ...e, invocationId: id };
            } else {
              const id = pending.shift();
              harnessPending.set(e.name, pending);
              if (id !== undefined) out = { ...e, invocationId: id };
            }
          }
          deps.onTool?.(out);
          deps.onEvent?.({ type: 'turn.tool', hop, detail: out });
        } });
    } catch (err) {
      // F3 classification, by precedence: an observed caller abort wins
      // (explicit Stop beats everything, even a concurrent wall expiry), then
      // the loop-owned wall, then the provider's own typed failure, then
      // unattributed timeouts, then unknown. A permanent provider rejection
      // (auth, bad request) is NEVER relabeled as exhausted runway.
      if (deps.signal?.aborted) throw new LoopError('aborted by caller', 'ABORTED', messages, 'caller-abort');
      if (wallDeadline.aborted) throw new LoopError(`wall budget exhausted after ${Date.now() - started}ms`, 'BUDGET_EXCEEDED', messages, 'budget-wall');
      if (err instanceof ProviderError) throw new LoopError(`${err.code}: ${err.message}`, err.code, messages, 'provider', err.status);
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new LoopError(`PROVIDER_TIMEOUT: ${err.message}`, 'PROVIDER_TIMEOUT', messages, 'provider');
      }
      throw new LoopError(`provider failed: ${err instanceof Error ? err.message : String(err)}`, 'PROVIDER_FAILED', messages, 'provider');
    }

    // butler#8 (defensive twin): a provider that RESOLVES after the caller
    // aborted (claude-cli exits 0 with an empty result on interrupt) is still
    // an abort, not an empty answer — classify before touching the result.
    // F3: the guard fires only when the caller signal is actually observed
    // aborted; ordinary success passes untouched.
    if (deps.signal?.aborted) throw new LoopError('aborted by caller', 'ABORTED', messages, 'caller-abort');

    // F2: close the hop's text block BEFORE the message lands. text.end prefers
    // the STREAMED accumulation when any deltas flowed (byte-exact to what the
    // UI saw); content is the fallback for snapshot-only hops (which usually
    // have no block at all — then the tracker emits nothing).
    if (tracker) tracker.onMessageComplete(hop, streamedText !== '' ? streamedText : (res.message.content ?? ''));

    if (res.usage) { tokens.in += res.usage.promptTokens; tokens.out += res.usage.completionTokens; }
    messages.push(res.message);
    deps.onMessage?.(res.message, { hop, tokensIn: res.usage?.promptTokens ?? 0, tokensOut: res.usage?.completionTokens ?? 0 });
    deps.onEvent?.({ type: 'provider.response', hop, detail: { finishReason: res.finishReason, tokens: res.usage } });

    // R3 decision 4: cost meter is ADVISORY for chat turns — it streams (usage
    // event) and never aborts. The old hard throw produced the 'turn failed:
    // token budget exceeded (202315 > 200000)' interruption class; context
    // pressure is absorbed by compaction at the orchestrator layer, not by dying.
    // Fan-out children (deliberate per-child caps) opt back into the hard stop
    // via hardTokenCap=true; the runaway guard remains the universal backstop.
    if (tokens.in + tokens.out > budget.maxTokens) {
      if (deps.hardTokenCap) {
        throw new LoopError(`token budget exceeded (${tokens.in + tokens.out} > ${budget.maxTokens})`, 'BUDGET_EXCEEDED', messages, 'budget-token');
      }
      deps.onEvent?.({ type: 'turn.delta', hop, detail: { advisory: `cost ${tokens.in + tokens.out} > ${budget.maxTokens} (advisory)` } });
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
        deps.onEvent?.({ type: 'turn.tool', hop, detail: { phase: 'result', name: call.function.name, result: 'unknown tool — no result', isError: true } });
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
        throw new LoopError(`tool ${call.function.name} sent invalid JSON twice`, 'TOOL_CALL_INVALID', messages, 'tool-invalid');
      }
      deps.onEvent?.({ type: 'turn.tool', hop, detail: { phase: 'call', name: call.function.name } });
      // chat-reliability F1 (tool durability): ordinary registry tools must
      // ride the SAME durable seam as streamed harness tools — the loop emits
      // per-invocation call/result callbacks so the transport's durable path
      // records them (previously runtime tools produced ZERO durable events).
      deps.onTool?.({ phase: 'call', name: call.function.name, invocationId: call.id, arg: call.function.arguments });
      let obs: string;
      let toolFailed = false;
      try {
        obs = await tool.execute(args, { signal: deps.signal ?? undefined });
      } catch (err) {
        // handler throws become observations (ReAct) — the loop continues
        obs = `error: ${err instanceof Error ? err.message : String(err)}`;
        toolFailed = true;
      }
      deps.onTool?.({ phase: 'result', name: call.function.name, invocationId: call.id, result: obs, isError: toolFailed });
      const msg: ProviderMessage = { role: 'tool', content: obs, tool_call_id: call.id };
      messages.push(msg);
      deps.onMessage?.(msg, { hop, tokensIn: 0, tokensOut: 0 });
      deps.onEvent?.({ type: 'turn.tool', hop, detail: { phase: 'result', name: call.function.name, result: `${obs.length} bytes` } });
    }
  }
  throw new LoopError(`hop budget exhausted (${budget.maxHops})`, 'BUDGET_EXCEEDED', messages, 'budget-hop');
}
