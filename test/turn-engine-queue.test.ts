import { describe, expect, it } from 'vitest';
import { decide, fold, initialState, type OrchestratorState, type TurnCommand, type TurnEvent } from '../src/orchestrate/turn-engine.ts';

/** Pure engine contract for detached send: identity-bearing queue items,
 *  per-item removal rows, claim-all admission (display/items), steer
 *  delivery with a model-memory user row, notices, and legacy folding. */

const SID = 's1';
let seq = 0;
const apply = (st: OrchestratorState, cmd: TurnCommand): { st: OrchestratorState; events: TurnEvent[] } => {
  const events = decide(st, cmd).map((e) => ({ ...e, seq: ++seq }));
  let next = st;
  for (const e of events) next = fold(next, e);
  return { st: next, events };
};
const queue = (st: OrchestratorState, queueId: string, content: string, disposition: 'steering' | 'followup' = 'followup', extra: Record<string, unknown> = {}) =>
  apply(st, { kind: 'message.queue', sessionId: SID, content, disposition, queueId, principalId: 'u1', ...extra } as TurnCommand);
const running = (): OrchestratorState =>
  apply(initialState(SID), { kind: 'turn.request', sessionId: SID, turnId: 't1', prompt: 'go', refIds: [], at: 0 }).st;

describe('turn engine — queue identity', () => {
  it('message.queue with an id records the identity and an id-bearing snapshot', () => {
    const { st, events } = queue(running(), 'q_a', 'first', 'followup', { body: { model: 'm' }, requestId: 'r1' });
    expect(events.map((e) => e.kind)).toEqual(['message.queued', 'queue.updated']);
    expect(events[0]!.detail).toMatchObject({ queueId: 'q_a', requestId: 'r1', principalId: 'u1', body: { model: 'm' } });
    expect(events[1]!.detail).toEqual({ steering: [], followUp: ['first'], ids: { steering: [], followUp: ['q_a'] } });
    expect(st.entries.map((e) => e.queueId)).toEqual(['q_a']);
    expect(st.queue.followUp).toEqual(['first']);
  });

  it('a still-pending duplicate request id from the same principal decides nothing', () => {
    const one = queue(running(), 'q_a', 'first', 'followup', { requestId: 'r1' });
    expect(queue(one.st, 'q_b', 'first', 'followup', { requestId: 'r1' }).events).toEqual([]);
    // another principal's request id never collides
    expect(queue(one.st, 'q_c', 'first', 'followup', { requestId: 'r1', principalId: 'u2' }).events).toHaveLength(2);
  });

  it('queue.remove writes one queue.removed + snapshot; unknown ids are a no-op', () => {
    const a = queue(running(), 'q_a', 'first');
    const b = queue(a.st, 'q_b', 'second');
    const r = apply(b.st, { kind: 'queue.remove', sessionId: SID, queueId: 'q_a', reason: 'deleted' });
    expect(r.events.map((e) => e.kind)).toEqual(['queue.removed', 'queue.updated']);
    expect(r.events[0]!.detail).toEqual({ queueId: 'q_a', reason: 'deleted' });
    expect(r.st.entries.map((e) => e.queueId)).toEqual(['q_b']);
    expect(apply(r.st, { kind: 'queue.remove', sessionId: SID, queueId: 'q_a', reason: 'deleted' }).events).toEqual([]);
  });
});

describe('turn engine — claim-all admission (display vs prompt)', () => {
  it('claims the items in the same decision and records the display text with items', () => {
    let st = running();
    st = queue(st, 'q_a', 'alpha').st;
    st = queue(st, 'q_b', 'beta').st;
    st = apply(st, { kind: 'turn.complete', sessionId: SID, turnId: 't1', answer: 'ok' }).st;
    const r = apply(st, {
      kind: 'turn.request', sessionId: SID, turnId: 't2', prompt: '[2 queued messages]\n\nalpha\n\nbeta', refIds: [], at: 0,
      display: 'alpha\n\nbeta', items: [{ queueId: 'q_a', content: 'alpha' }, { queueId: 'q_b', content: 'beta' }], claim: ['q_a', 'q_b'],
    });
    expect(r.events.map((e) => e.kind)).toEqual(['queue.removed', 'queue.removed', 'queue.updated', 'turn.requested', 'user_message.recorded', 'turn.started']);
    expect(r.events.filter((e) => e.kind === 'queue.removed').map((e) => e.detail)).toEqual([{ queueId: 'q_a', reason: 'claimed' }, { queueId: 'q_b', reason: 'claimed' }]);
    const user = r.events.find((e) => e.kind === 'user_message.recorded')!;
    expect(user.detail).toEqual({ role: 'user', content: 'alpha\n\nbeta', items: [{ queueId: 'q_a', content: 'alpha' }, { queueId: 'q_b', content: 'beta' }] });
    expect(r.events.find((e) => e.kind === 'turn.requested')!.detail).toMatchObject({ prompt: '[2 queued messages]\n\nalpha\n\nbeta' });
    expect(r.st.entries).toEqual([]);
    expect(r.st.activeTurnId).toBe('t2');
  });

  it('a claim that matches no pending item decides nothing (lost race)', () => {
    const r = apply(initialState(SID), { kind: 'turn.request', sessionId: SID, turnId: 't9', prompt: 'x', refIds: [], at: 0, claim: ['q_gone'] });
    expect(r.events).toEqual([]);
  });
});

describe('turn engine — steer delivery', () => {
  it('removes the steers, records the delivery AND one via:steer user row per item', () => {
    let st = running();
    st = queue(st, 's_1', 'also check X', 'steering').st;
    st = queue(st, 'q_f', 'later', 'followup').st;
    const r = apply(st, { kind: 'steer.deliver', sessionId: SID, turnId: 't1', queueIds: ['s_1'] });
    expect(r.events.map((e) => e.kind)).toEqual(['queue.removed', 'queue.updated', 'steer.delivered', 'user_message.recorded']);
    expect(r.events[0]!.detail).toEqual({ queueId: 's_1', reason: 'delivered' });
    expect(r.events[2]!.detail).toEqual({ items: [{ queueId: 's_1', content: 'also check X' }] });
    expect(r.events[3]!.detail).toEqual({ role: 'user', content: 'also check X', via: 'steer' });
    expect(r.st.entries.map((e) => e.queueId)).toEqual(['q_f']); // the follow-up stays queued
  });

  it('never delivers to a turn that is not running, nor follow-up items', () => {
    let st = running();
    st = queue(st, 'q_f', 'later', 'followup').st;
    expect(apply(st, { kind: 'steer.deliver', sessionId: SID, turnId: 't1', queueIds: ['q_f'] }).events).toEqual([]);
    st = queue(st, 's_1', 'steer', 'steering').st;
    const done = apply(st, { kind: 'turn.complete', sessionId: SID, turnId: 't1', answer: 'ok' }).st;
    expect(apply(done, { kind: 'steer.deliver', sessionId: SID, turnId: 't1', queueIds: ['s_1'] }).events).toEqual([]);
  });
});

describe('turn engine — notices and legacy rows', () => {
  it('session.notice is a plain row against the given turn', () => {
    const r = apply(running(), { kind: 'session.notice', sessionId: SID, turnId: 't1', level: 'error', text: 'boom' });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ kind: 'session.notice', turn_id: 't1', detail: { level: 'error', text: 'boom' } });
  });

  it('legacy queue rows (no id) fold into legacy entries that keep their identity across snapshots', () => {
    let st = running();
    st = apply(st, { kind: 'message.queue', sessionId: SID, content: 'old', disposition: 'followup' }).st;
    expect(st.entries).toHaveLength(1);
    expect(st.entries[0]).toMatchObject({ content: 'old', legacy: true });
    expect(st.entries[0]!.queueId.startsWith('q_legacy_')).toBe(true);
    // a mixed snapshot: legacy strings keep identity, id-bearing entries survive
    st = queue(st, 'q_new', 'new').st;
    expect(st.entries.map((e) => e.content)).toEqual(['old', 'new']);
    expect(st.entries[0]!.legacy).toBe(true);
  });
});
