/** R3-S6: concurrency + performance sanity for the sink.
 *  - Two concurrent command streams on ONE session serialize (no interleaved
 *    seq, no lost events) — the per-session single-writer contract.
 *  - Event append cost stays sane (< 5ms per event average, the plan's bar). */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { EventSink } from '../src/orchestrate/event-sink.ts';

const sess = 'sess_s6';

function mkSink() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE butler_messages(
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
    tool_calls_json TEXT, tool_results_json TEXT, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
  return new EventSink(db);
}

describe('S6: concurrency', () => {
  it('two interleaved command streams on one session: seq strictly monotonic, no gaps, no dupes', () => {
    const sk = mkSink();
    sk.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'a', refIds: [], at: 0 }, 'k-req');
    // 100 alternating chunk/usage commands
    for (let i = 0; i < 100; i++) {
      if (i % 2 === 0) sk.handle(sess, { kind: 'turn.chunk', sessionId: sess, turnId: 't1', delta: `d${i}` }, `k-c${i}`);
      else sk.handle(sess, { kind: 'turn.usage', sessionId: sess, turnId: 't1', meters: { cost: i, contextUsed: i, contextWindow: 1000 } }, `k-u${i}`);
    }
    const seqs = sk.events(sess).map((e) => e.seq);
    expect(seqs).toHaveLength(103);          // 3 (request triple) + 100 interleaved
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);            // monotonic
    expect(new Set(seqs).size).toBe(103);                             // no dupes
    expect(seqs.at(-1)).toBe(103);                                    // contiguous from 1
    // idempotent replay of an old key changes nothing
    sk.handle(sess, { kind: 'turn.chunk', sessionId: sess, turnId: 't1', delta: 'd0' }, 'k-c0');
    expect(sk.events(sess)).toHaveLength(103);
  });

  it('two sessions, two logs: zero cross-talk', () => {
    const sk = mkSink();
    for (const s of [sess, 'sess_other']) {
      sk.handle(s, { kind: 'turn.request', sessionId: s, turnId: `t_${s}`, prompt: 'p', refIds: [], at: 0 }, `k-${s}`);
    }
    expect(sk.events(sess).every((e) => e.session_id === sess)).toBe(true);
    expect(sk.events('sess_other').every((e) => e.session_id === 'sess_other')).toBe(true);
    expect(sk.replay(sess).turns[0]?.id).toBe(`t_${sess}`);
  });
});

describe('S6: performance sanity', () => {
  it('event append averages < 5ms (the plan bar) over 500 commands', () => {
    const sk = mkSink();
    sk.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'p', refIds: [], at: 0 }, 'k0');
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) {
      sk.handle(sess, { kind: 'turn.chunk', sessionId: sess, turnId: 't1', delta: 'x'.repeat(40) }, `pk${i}`);
    }
    const per = (performance.now() - t0) / 500;
    expect(sk.events(sess)).toHaveLength(503); // 3 + 500
    expect(per).toBeLessThan(5);
  });
});
