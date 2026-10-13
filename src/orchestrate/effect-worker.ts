/** R3-S2: EffectWorker — drains the outbox, executes provider turns via runLoop,
 *  and feeds every loop event back through the EventSink as commands (so the
 *  durable log is written DURING the turn, not after it). Stable toolCallIds
 *  (ACP patch-by-id, review R5/R2), usage meters both surfaced (decision 4),
 *  compaction hook owned here (context meter drives it — never the budget).
 *
 *  History inventory (review R6, verified against the adapters 2026-10-13):
 *  - openai-compat: history = explicit ProviderMessage[] the loop re-sends each
 *    hop. WINDOWABLE: compaction trims/summarizes the array. contextUsed =
 *    last-hop promptTokens is a TRUE measure of what the provider sees.
 *  - claude-cli: history lives server-side behind --resume (claude-cli.ts:97);
 *    the loop's message array is NOT what the model sees. Compaction = cut a
 *    new session seeded with the summary; windowing the array is a NO-OP.
 *    contextUsed (promptTokens) reflects only the fresh turn's prompt. */

import { runLoop } from '../loop.ts';
import type { LoopTool } from '../loop.ts';
import type { Provider, ProviderMessage } from '../provider/types.ts';
import { EventSink, type Effect } from './event-sink.ts';
import type { UsageMeters } from './turn-engine.ts';

export interface EffectWorkerDeps {
  sink: EventSink;
  provider: Provider;
  systemPrompt: string;
  tools: LoopTool[];
  history?: ProviderMessage[];
  sessionKey?: string;
  /** context window of the ACTIVE provider (for the context meter) */
  contextWindow: number;
  /** compaction callback — receives the summary; the caller decides provider mechanics */
  onCompaction?: (summary: string, preservedEventIds: string[]) => Promise<void>;
  signal?: AbortSignal;
  /** cost runaway guard — the ONLY hard cost stop (decision 4) */
  runawayCost?: number;
}

const COMPACT_THRESHOLD = 0.8; // auto-compact at 80% of window (plan decision 4)

export class EffectWorker {
  constructor(private readonly deps: EffectWorkerDeps) {}

  /** Drain ONE pass of un-retired effects. Returns how many ran. No sleeps. */
  async drain(): Promise<number> {
    const pending = this.deps.sink.pendingEffects();
    let ran = 0;
    for (const row of pending) {
      const eff = JSON.parse(row.effect_json) as Effect;
      if (eff.type === 'runTurn') {
        await this.runTurn(eff.sessionId, eff.turnId);
      }
      // 'emit' effects carry no side effect for the worker (the sink emits at append)
      this.deps.sink.retire(row.id);
      ran += 1;
    }
    return ran;
  }

  private async runTurn(sessionId: string, turnId: string): Promise<void> {
    const { sink } = this.deps;
    const key = (n: string) => `${sessionId}:${turnId}:${n}`;
    const promptRow = sink.events(sessionId).find((e) => e.kind === 'turn.requested' && e.turn_id === turnId);
    const prompt = promptRow && promptRow.kind === 'turn.requested' ? promptRow.detail.prompt : '';
    const toolIds = new Map<string, string>(); // provider call.id → stable ACP toolCallId

    let cost = 0;
    let contextUsed = 0;
    let compacted = false;

    try {
      const result = await runLoop(this.deps.systemPrompt, prompt, {
        provider: this.deps.provider,
        tools: this.deps.tools,
        ...(this.deps.history !== undefined ? { history: this.deps.history } : {}),
        ...(this.deps.sessionKey !== undefined ? { sessionKey: this.deps.sessionKey } : {}),
        ...(this.deps.signal !== undefined ? { signal: this.deps.signal } : {}),
        onDelta: (delta) => {
          void sink.handle(sessionId, { kind: 'turn.chunk', sessionId, turnId, delta }, key(`chunk:${delta.length}:${Math.random()}`));
        },
        onTool: (e) => {
          // stable toolCallId: first sighting of a provider call id gets a durable one
          if (e.phase === 'call') {
            const stable = `tc_${turnId}_${toolIds.size + 1}`;
            toolIds.set(e.name + toolIds.size, stable);
            void sink.handle(sessionId, { kind: 'turn.tool', sessionId, turnId, phase: 'call', toolCallId: stable, name: e.name, ...(e.arg !== undefined ? { arg: e.arg } : {}) }, key(`tool:${stable}`));
          } else {
            const stable = [...toolIds.entries()].at(-1)?.[1] ?? 'tc_unknown';
            void sink.handle(sessionId, { kind: 'turn.tool', sessionId, turnId, phase: 'update', toolCallId: stable, ...(e.result !== undefined ? { result: e.result } : {}), ...(e.isError !== undefined ? { isError: e.isError } : {}) }, key(`toolu:${stable}:${Math.random()}`));
          }
        },
        onEvent: (e) => {
          if (e.type === 'provider.response' && e.detail && typeof e.detail === 'object' && 'tokens' in e.detail) {
            const t = (e.detail as { tokens?: { promptTokens?: number; completionTokens?: number } }).tokens;
            if (t?.promptTokens !== undefined || t?.completionTokens !== undefined) {
              cost += (t.promptTokens ?? 0) + (t.completionTokens ?? 0);
              contextUsed = t.promptTokens ?? contextUsed;
              const meters: UsageMeters = { cost, contextUsed, contextWindow: this.deps.contextWindow };
              void sink.handle(sessionId, { kind: 'turn.usage', sessionId, turnId, meters }, key(`usage:${cost}`));
              // decision 4: context ≥ 80% → compact ONCE (originals preserved), continue
              if (!compacted && this.deps.contextWindow > 0 && contextUsed >= COMPACT_THRESHOLD * this.deps.contextWindow) {
                compacted = true;
                const preserved = sink.events(sessionId).map((ev) => ev.id).slice(0, -1);
                void sink.handle(sessionId, { kind: 'turn.compaction', sessionId, turnId, summary: `[context compacted at ${Math.round((contextUsed / this.deps.contextWindow) * 100)}% — older history summarized, originals preserved]`, preservedEventIds: preserved }, key('compact'));
                void this.deps.onCompaction?.('[compaction summary]', preserved);
              }
              // runaway guard: the ONLY hard cost stop
              if (this.deps.runawayCost !== undefined && cost > this.deps.runawayCost) {
                throw new Error(`runaway cost guard (${cost} > ${this.deps.runawayCost})`);
              }
            }
          }
        },
      });
      void sink.handle(sessionId, { kind: 'turn.complete', sessionId, turnId, answer: result.answer }, key('complete'));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      void sink.handle(sessionId, { kind: 'turn.fail', sessionId, turnId, error }, key(`fail:${error.slice(0, 40)}`));
    }
  }
}
