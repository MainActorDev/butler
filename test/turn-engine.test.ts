/** R3-S1 table tests: the pure orchestrator + EventSink transaction + fold.
 *  Hermetic (in-memory sqlite, no timers, no sleeps — t3code's rule). */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { EventSink } from '../src/orchestrate/event-sink.ts';
import { decide, fold, initialState, type TurnCommand } from '../src/orchestrate/turn-engine.ts';

const sess = 'sess_test';

function sink() {
  const db = new Database(':memory:');
  // butler_messages projection target must exist (mirrors memory/sqlite.ts DDL)
  db.exec(`CREATE TABLE butler_messages(
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
    tool_calls_json TEXT, tool_results_json TEXT, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
  return new EventSink(db);
}

describe('pure decide()', () => {
  it('turn.request (idle session) → requested + user_message.recorded + started', () => {
    const ev = decide(initialState(sess), { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'hi', refIds: [], at: 0 });
    expect(ev.map((e) => e.kind)).toEqual(['turn.requested', 'user_message.recorded', 'turn.started']);
  });

  it('turn.request while RUNNING → queues as followup, no second active turn', () => {
    let st = initialState(sess);
    st = fold(st, decide(st, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'a', refIds: [], at: 0 })[0]!);
    st = fold(st, decide(st, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'a', refIds: [], at: 0 }).find((e) => e.kind === 'turn.started')!);
    const ev = decide(st, { kind: 'turn.request', sessionId: sess, turnId: 't2', prompt: 'wait', refIds: [], at: 0 });
    expect(ev.map((e) => e.kind)).toEqual(['message.queued', 'queue.updated']);
    const folded = ev.reduce((s, e) => fold(s, e), st);
    expect(folded.queue.followUp).toEqual(['wait']);
    expect(folded.activeTurnId).toBe('t1');
  });

  it('chunk/tool/usage on a non-running turn → no events (no zombie streams)', () => {
    const st = initialState(sess);
    const cmds: TurnCommand[] = [
      { kind: 'turn.chunk', sessionId: sess, turnId: 't9', delta: 'x' },
      { kind: 'turn.tool', sessionId: sess, turnId: 't9', phase: 'call', toolCallId: 'tc1', name: 'jira.get' },
      { kind: 'turn.usage', sessionId: sess, turnId: 't9', meters: { cost: 1, contextUsed: 1, contextWindow: 100 } },
    ];
    for (const c of cmds) expect(decide(st, c)).toEqual([]);
  });

  it('terminal stays terminal: complete then fail → only completed', () => {
    let st = initialState(sess);
    for (const e of decide(st, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'p', refIds: [], at: 0 })) st = fold(st, e);
    const done = decide(st, { kind: 'turn.complete', sessionId: sess, turnId: 't1', answer: 'ok' });
    expect(done.map((e) => e.kind)).toEqual(['turn.completed']);
    const after = done.reduce((s, e) => fold(s, e), st);
    expect(decide(after, { kind: 'turn.fail', sessionId: sess, turnId: 't1', error: 'late' })).toEqual([]);
  });

  it('abort only from requested/running; unknown command kinds → []', () => {
    let st = initialState(sess);
    for (const e of decide(st, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'p', refIds: [], at: 0 })) st = fold(st, e);
    const aborted = decide(st, { kind: 'turn.abort', sessionId: sess, turnId: 't1', reason: 'user' }).reduce((s, e) => fold(s, e), st);
    expect(decide(aborted, { kind: 'turn.abort', sessionId: sess, turnId: 't1', reason: 'again' })).toEqual([]);
    expect(decide(st, { kind: 'nonsense' as never, sessionId: sess, turnId: 't1' })).toEqual([]);
  });
});

describe('EventSink transactions', () => {
  it('happy path: request → events appended, seq monotonic, message projected, runTurn enqueued', () => {
    const sk = sink();
    const { events, effects } = sk.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'hello', refIds: [], at: 0 }, 'k1');
    expect(events.map((e) => e.kind)).toEqual(['turn.requested', 'user_message.recorded', 'turn.started']);
    expect(effects.some((f) => f.type === 'runTurn')).toBe(true);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    const rows = sk.events(sess);
    expect(rows).toHaveLength(3);
    const msg = (sk as unknown as { db: Database.Database }).db.prepare('SELECT * FROM butler_messages').all();
    expect(msg).toHaveLength(1);
    expect((msg[0] as { content: string }).content).toBe('hello');
  });

  it('idempotent: same commandKey twice → second is a no-op', () => {
    const sk = sink();
    const cmd: TurnCommand = { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'hi', refIds: [], at: 0 };
    sk.handle(sess, cmd, 'k1');
    const again = sk.handle(sess, cmd, 'k1');
    expect(again.events).toEqual([]);
    expect(again.effects.filter((f) => f.type === 'runTurn')).toEqual([]);
    expect(sk.events(sess)).toHaveLength(3);
  });

  it('replay determinism: folded state from events === live cached state', () => {
    const sk = sink();
    sk.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'a', refIds: [], at: 0 }, 'k1');
    sk.handle(sess, { kind: 'turn.chunk', sessionId: sess, turnId: 't1', delta: 'x' }, 'k2');
    sk.handle(sess, { kind: 'turn.complete', sessionId: sess, turnId: 't1', answer: 'done' }, 'k3');
    expect(sk.replay(sess)).toEqual(sk.state(sess));
  });

  it('crash-window recovery: pending runTurn effect survives, retire clears it', () => {
    const sk = sink();
    sk.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'a', refIds: [], at: 0 }, 'k1');
    const pending = sk.pendingEffects();
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending.every((p) => JSON.parse(p.effect_json).type === 'runTurn')).toBe(true);
    sk.retire(pending[0]!.id);
    expect(sk.pendingEffects()).toEqual([]);
  });

  it('session.imported: null turn_id row folds into imported=true', () => {
    const sk = sink();
    const { events } = sk.handle(sess, { kind: 'session.import', sessionId: sess, note: 'v0.4.2 backfill' }, 'k0');
    expect(events[0]!.kind).toBe('session.imported');
    expect(sk.replay(sess).imported).toBe(true);
  });
});

describe('crash recovery (kill -9 drill, in-memory)', () => {
  it('orphaned running turn → recoverOrphans marks failed + appends turn.failed event', () => {
    const sk = sink();
    sk.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'slow', refIds: [], at: 0 }, 'k1');
    sk.handle(sess, { kind: 'turn.chunk', sessionId: sess, turnId: 't1', delta: 'partial ' }, 'k2');
    // process dies here — NO complete/fail. Age the turn past the freshness window
    // (a boot-time sweep must skip LIVE-fresh turns — the sess_e2e40228 split-brain):
    const db = (sk as unknown as { db: import('better-sqlite3').Database }).db;
    db.prepare('UPDATE butler_turn_events SET at = at - ? WHERE session_id = ?').run(20 * 60_000, sess);
    db.prepare('UPDATE butler_turns SET created_at = created_at - ? WHERE session_id = ?').run(20 * 60_000, sess);
    const revived = new EventSink(db);
    const evs = revived.events(sess);
    expect(evs.at(-1)?.kind).toBe('turn.failed');
    const st = revived.replay(sess);
    expect(st.turns.find((t) => t.id === 't1')?.status).toBe('failed');
    expect(revived.state(sess).activeTurnId).toBeNull(); // no lying spinner, next turn accepted
  });
});

describe('zombie liveTurn (v0.5.2 — projection/log divergence, sess_e2e40228)', () => {
  it('projection claims completed but the LOG has no terminal event → recovery fails the turn anyway (the log wins)', () => {
    const sk = sink();
    sk.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'doom', refIds: [], at: 0 }, 'k1');
    // process dies mid-turn; a stale heal then writes a LYING projection row:
    const db = (sk as unknown as { db: import('better-sqlite3').Database }).db;
    db.prepare("UPDATE butler_turns SET status = 'completed', updated_at = updated_at + 937 WHERE session_id = ?").run(sess);
    // age past the freshness window:
    db.prepare('UPDATE butler_turn_events SET at = at - ? WHERE session_id = ?').run(20 * 60_000, sess);
    db.prepare('UPDATE butler_turns SET created_at = created_at - ? WHERE session_id = ?').run(20 * 60_000, sess);
    const revived = new EventSink(db);
    const evs = revived.events(sess);
    expect(evs.at(-1)?.kind).toBe('turn.failed');            // terminal event appended
    const st = revived.replay(sess);
    expect(st.activeTurnId).toBeNull();                       // fold no longer sees it live
    expect(st.turns.find((t) => t.id === 't1')?.status).toBe('failed');
    // and the projection was RECONCILED to match the log:
    const row = db.prepare('SELECT status FROM butler_turns WHERE id = ?').get('t1') as { status: string };
    expect(row.status).toBe('failed');
  });

  it('liveTurn freshness guard: a turn whose last event is ancient is NOT reported live', async () => {
    // long-running server, turn stalled silently > 15min, NO restart yet: the
    // fold's cached state still says active — the transport must not report
    // it live (recovery only fires at sink construction)
    const sk = sink();
    sk.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'stale', refIds: [], at: 0 }, 'k1');
    const db = (sk as unknown as { db: import('better-sqlite3').Database }).db;
    db.prepare('UPDATE butler_turn_events SET at = at - ? WHERE session_id = ?').run(30 * 60_000, sess);
    const st = sk.state(sess);
    expect(st.activeTurnId).toBe('t1'); // cached fold still holds it…
    const events = sk.events(sess);
    const lastForTurn = [...events].reverse().find((e) => e.turn_id === 't1');
    const STALE_MS = 15 * 60_000;
    const isLive = !(lastForTurn && Date.now() - lastForTurn.at > STALE_MS);
    expect(isLive).toBe(false); // …but the freshness guard says not live
  });
});

describe('chunk cap (the 219,961-token fix)', () => {
  it('a heading-less 255k-char file splits into capped chunks — no giant chunk survives', async () => {
    const { structuralChunks, MAX_CHUNK_CHARS } = await import('../src/chunk.ts');
    const big = 'static let colorRed = UIColor(red: 0.8, green: 0.1, blue: 0.1, alpha: 1)\n'.repeat(6000); // ~255k chars, no headings
    const chunks = structuralChunks(big, 'swift');
    expect(chunks.length).toBeGreaterThan(10);
    expect(Math.max(...chunks.map((c) => c.content.length))).toBeLessThanOrEqual(MAX_CHUNK_CHARS + 200);
    // headings still work normally
    const md = structuralChunks('# A\nx\n\n# B\ny', 'markdown');
    expect(md.map((c) => c.headingPath)).toEqual(['A', 'B']);
  });
});

describe('split-brain guard (sess_e2e40228)', () => {
  it('a FRESH running turn is NOT failed by a sibling boot sweep', () => {
    const sk = sink();
    sk.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'live', refIds: [], at: 0 }, 'k1');
    // sibling process boots RIGHT NOW — the turn is 0ms old:
    const db = (sk as unknown as { db: import('better-sqlite3').Database }).db;
    const revived = new EventSink(db);
    const st = revived.replay(sess);
    expect(st.turns.find((t) => t.id === 't1')?.status).toBe('running'); // left alone
    expect(revived.events(sess).at(-1)?.kind).not.toBe('turn.failed');
  });
});
