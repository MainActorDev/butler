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
