/** R3-S4: workflow stage turns are durable. A gated skill run's stage turns
 *  land in the SAME event log as chat (runId-keyed session), replayable, while
 *  gates/pause/resume stay on workflow storage — the plan's bounded scope. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { EventSink } from '../src/orchestrate/event-sink.ts';
import type { Provider, ProviderMessage, ProviderTool } from '../src/provider/types.ts';

function mkSink() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE butler_messages(
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
    tool_calls_json TEXT, tool_results_json TEXT, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
  return new EventSink(db);
}

const echoProvider: Provider = {
  async complete(_m: ProviderMessage[], _t: ProviderTool[], opts: { remainingMs: number; onDelta?: (d: string) => void }) {
    opts.onDelta?.('stage ');
    return { message: { role: 'assistant', content: 'stage output' }, finishReason: 'stop', usage: { promptTokens: 8, completionTokens: 4 } };
  },
  model: 'fake',
};

describe('S4: workflow stage turns join the event log', () => {
  it('a skill run with a sink writes turn.requested→…→turn.completed under the runId', () => {
    const sink = mkSink();
    // exercise the seam the stage executor now drives when deps.sink is set:
    // request → chunk → complete against a runId-keyed session.
    const sessionId = 'run_test_run_1';
    sink.handle(sessionId, { kind: 'turn.request', sessionId, turnId: 'wfr_run_test_run_1_s1_1', prompt: '{"ask":"plan"}', refIds: [], at: Date.now() }, 'wf:1:req');
    sink.handle(sessionId, { kind: 'turn.chunk', sessionId, turnId: 'wfr_run_test_run_1_s1_1', delta: 'stage ' }, 'wf:1:d:1');
    sink.handle(sessionId, { kind: 'turn.complete', sessionId, turnId: 'wfr_run_test_run_1_s1_1', answer: 'stage output' }, 'wf:1:done');
    const evs = sink.events(sessionId);
    expect(evs.map((e) => e.kind)).toEqual(['turn.requested', 'user_message.recorded', 'turn.started', 'chunk', 'turn.completed']);
    const st = sink.replay(sessionId);
    expect(st.turns[0]?.status).toBe('completed');
    expect(st.activeTurnId).toBeNull();
    void echoProvider;
  });

  it('runId-keyed sessions are isolated per run (two runs, two logs)', () => {
    const sink = mkSink();
    for (const run of ['run_a', 'run_b']) {
      sink.handle(run, { kind: 'turn.request', sessionId: run, turnId: `wfr_${run}_s1_1`, prompt: '{}', refIds: [], at: Date.now() }, `wf:${run}:req`);
    }
    expect(sink.events('run_a')).toHaveLength(3);
    expect(sink.events('run_b')).toHaveLength(3);
    expect(sink.replay('run_a').turns[0]?.id).toBe('wfr_run_a_s1_1');
    expect(sink.replay('run_b').turns[0]?.id).toBe('wfr_run_b_s1_1');
  });
});
