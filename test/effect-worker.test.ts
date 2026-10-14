/** R3-S2: EffectWorker drain tests — a scripted multi-hop turn against a fake
 *  provider. Proves: events land DURING the turn; stable toolCallIds; both
 *  meters stream; compaction fires at threshold; cost NEVER aborts; runaway
 *  guard does; provider failure → turn.failed. No sleeps (drain-based). */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { EventSink } from '../src/orchestrate/event-sink.ts';
import { EffectWorker } from '../src/orchestrate/effect-worker.ts';
import type { Provider, ProviderMessage, ProviderTool } from '../src/provider/types.ts';

const sess = 'sess_s2';

function makeSink() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE butler_messages(
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
    tool_calls_json TEXT, tool_results_json TEXT, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
  return new EventSink(db);
}

/** Fake provider: N tool hops then a final answer, with usage per hop. */
function fakeProvider(hops: Array<{ tool: string; promptTokens: number }>, final: { promptTokens: number }) {
  let call = 0;
  const provider: Provider = {
    async complete(_messages: ProviderMessage[], _tools: ProviderTool[], opts: { remainingMs: number; onDelta?: (d: string) => void; onTool?: (e: { phase: 'call' | 'result'; name: string; arg?: string; result?: string; isError?: boolean }) => void }) {
      call += 1;
      const hop = hops[call - 1];
      opts?.onDelta?.(`delta-${call} `);
      if (hop) {
        opts?.onTool?.({ phase: 'call', name: hop.tool, arg: '{}' });
        opts?.onTool?.({ phase: 'result', name: hop.tool, result: 'ok', isError: false });
        return {
          message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${call}`, type: 'function', function: { name: hop.tool, arguments: '{}' } }] },
          finishReason: 'tool_calls',
          usage: { promptTokens: hop.promptTokens, completionTokens: 10 },
        };
      }
      return {
        message: { role: 'assistant', content: 'FINAL ANSWER' },
        finishReason: 'stop',
        usage: { promptTokens: final.promptTokens, completionTokens: 20 },
      };
    },
    model: 'fake-test-model',
  };
  return provider;
}

async function runTurn(provider: Provider, opts?: { contextWindow?: number; runawayCost?: number; onCompaction?: (s: string, ids: string[]) => Promise<void> }) {
  const sink = makeSink();
  sink.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'do it', refIds: [], at: 0 }, 'k1');
  const worker = new EffectWorker({
    sink,
    provider,
    systemPrompt: 'sys',
    tools: [],
    contextWindow: opts?.contextWindow ?? 1_000_000,
    ...(opts?.runawayCost !== undefined ? { runawayCost: opts.runawayCost } : {}),
    ...(opts?.onCompaction !== undefined ? { onCompaction: opts.onCompaction } : {}),
  });
  await worker.drain();
  return sink;
}

describe('EffectWorker drain', () => {
  it('8-hop tool turn: events during turn, stable tool ids, both meters, completes', async () => {
    const sink = await runTurn(fakeProvider(
      Array.from({ length: 8 }, (_, i) => ({ tool: `tool_${i}`, promptTokens: 500 })),
      { promptTokens: 600 },
    ));
    const ev = sink.events(sess);
    expect(ev.filter((e) => e.kind === 'chunk').length).toBe(9); // 8 hops + final
    const calls = ev.filter((e) => e.kind === 'tool_call');
    expect(calls).toHaveLength(8);
    // stable ids, no order-correlation guesses: tc_t1_1..8
    expect(calls.map((c) => c.kind === 'tool_call' && c.detail.toolCallId)).toEqual(
      Array.from({ length: 8 }, (_, i) => `tc_t1_${i + 1}`),
    );
    const usages = ev.filter((e) => e.kind === 'usage');
    expect(usages.length).toBeGreaterThanOrEqual(9);
    const last = usages.at(-1);
    expect(last?.kind === 'usage' && last.detail.cost).toBe(8 * 510 + 620);
    expect(ev.at(-1)?.kind).toBe('turn.completed');
  });

  it('cost NEVER aborts: cost far over budget, turn still completes (decision 4)', async () => {
    // 8 hops × (25_000 + 10) each ≈ 200k+ — the old loop would have thrown here.
    const sink = await runTurn(fakeProvider(
      Array.from({ length: 8 }, () => ({ tool: 't', promptTokens: 25_000 })),
      { promptTokens: 3_000 },
    ));
    const ev = sink.events(sess);
    expect(ev.at(-1)?.kind).toBe('turn.completed');
    const lastUsage = ev.filter((e) => e.kind === 'usage').at(-1);
    expect(lastUsage?.kind === 'usage' && lastUsage.detail.cost).toBe(8 * 25_010 + 3_020);
  });

  it('context ≥ 80% triggers ONE compaction event, turn continues', async () => {
    const compacted: string[] = [];
    const sink = await runTurn(
      fakeProvider([{ tool: 't', promptTokens: 850 }, { tool: 't2', promptTokens: 900 }, { tool: 't3', promptTokens: 400 }], { promptTokens: 300 }),
      { contextWindow: 1_000, onCompaction: async (s) => { compacted.push(s); } },
    );
    const ev = sink.events(sess);
    const comps = ev.filter((e) => e.kind === 'compaction');
    expect(comps).toHaveLength(1); // once, not per hop after threshold
    expect(compacted).toHaveLength(1);
    expect(ev.at(-1)?.kind).toBe('turn.completed');
  });

  it('runaway cost guard is the ONLY hard stop: throws → turn.failed', async () => {
    const sink = await runTurn(fakeProvider([{ tool: 't', promptTokens: 900_000 }], { promptTokens: 1 }), { runawayCost: 500_000 });
    const ev = sink.events(sess);
    expect(ev.at(-1)?.kind).toBe('turn.failed');
    const fail = ev.at(-1);
    expect(fail?.kind === 'turn.failed' && fail.detail.error).toContain('runaway');
  });

  it('provider failure mid-turn → turn.failed with honest error', async () => {
    const provider: Provider = {
      async complete() { throw new Error('connection reset'); },
      model: 'fake-test-model',
    };
    const sink = await runTurn(provider);
    const ev = sink.events(sess);
    expect(ev.at(-1)?.kind).toBe('turn.failed');
    const fail = ev.at(-1);
    expect(fail?.kind === 'turn.failed' && fail.detail.error).toContain('connection reset');
  });

  it('drain is idempotent: second pass finds nothing (all retired)', async () => {
    const sink = makeSink();
    sink.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'p', refIds: [], at: 0 }, 'k1');
    const worker = new EffectWorker({ sink, provider: fakeProvider([], { promptTokens: 10 }), systemPrompt: 's', tools: [], contextWindow: 1000 });
    expect(await worker.drain()).toBe(1);
    expect(await worker.drain()).toBe(0);
  });
});

describe('v0.5.6 — terminal-turn effects retire without re-running (the 63-row backlog)', () => {
  it('drain retires effects for ALREADY-TERMINAL turns and never calls the provider', async () => {
    const sink = makeSink();
    // a turn that completed long ago (as if the transport ran it inline)
    sink.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't_done', prompt: 'old', refIds: [], at: 0 }, 'r1');
    sink.handle(sess, { kind: 'turn.chunk', sessionId: sess, turnId: 't_done', delta: 'x' }, 'r2');
    sink.handle(sess, { kind: 'turn.complete', sessionId: sess, turnId: 't_done', answer: 'done long ago' }, 'r3');
    // a genuinely fresh pending turn that SHOULD run
    sink.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't_live', prompt: 'run me', refIds: [], at: 1 }, 'r4');
    let providerCalls = 0;
    const counting: Provider = {
      async complete() { providerCalls += 1; return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } }; },
      model: 'counting',
    };
    const worker = new EffectWorker({ sink, provider: counting, tools: [], systemPrompt: 'sys', contextWindow: 1_000_000 });
    const ran = await worker.drain();
    // t_done retired without a provider call; t_live ran once
    expect(providerCalls).toBe(1);
    expect(ran).toBeGreaterThanOrEqual(1);
    const remaining = sink.pendingEffects().filter((e) => JSON.parse(e.effect_json).turnId === 't_done');
    expect(remaining.length).toBe(0); // stale row retired
  });
});

describe('v0.5.6 — inline hosts & stale backlog (the 63-row outbox)', () => {
  it('sink with enqueueRunTurn:false never writes outbox rows (inline hosts)', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE butler_messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, tool_calls_json TEXT, tool_results_json TEXT, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
    const sk = new EventSink(db, { enqueueRunTurn: false });
    sk.handle('s-inline', { kind: 'turn.request', sessionId: 's-inline', turnId: 't1', prompt: 'x', refIds: [], at: 0 }, 'k1');
    const n = (db.prepare('SELECT COUNT(*) AS n FROM butler_outbox').get() as { n: number }).n;
    expect(n).toBe(0); // no rows enqueued for inline hosts
    // default sink still enqueues (worker hosts unchanged)
    const sk2 = new EventSink(db);
    sk2.handle('s-worker', { kind: 'turn.request', sessionId: 's-worker', turnId: 't2', prompt: 'x', refIds: [], at: 0 }, 'k2');
    const n2 = (db.prepare('SELECT COUNT(*) AS n FROM butler_outbox WHERE session_id=?').get('s-worker') as { n: number }).n;
    expect(n2).toBe(1);
  });
});

