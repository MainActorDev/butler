import { describe, it, expect } from 'vitest';
import { SqliteWorkflowStorage, runWorkflow, advanceWorkflow } from '../src/index.ts';
import { MockProvider, ToolRegistry, SqliteStorage } from '../src/index.ts';
import Database from 'better-sqlite3';
import type { WorkflowSpec } from '../src/workflow/spec.ts';

const storage = new SqliteWorkflowStorage(new Database(':memory:'));
const registry = new ToolRegistry();
const convo = SqliteStorage.memory();

function spec(gated: boolean): WorkflowSpec {
  return {
    id: 'gate-test',
    input: (x: unknown) => (typeof x === 'object' && x !== null && 'ask' in x ? { ok: true as const, value: x } : { ok: false as const, error: 'ask required' }),
    stages: [
      {
        id: 'one', profileId: 'p1', gated,
        input: (x: unknown) => ({ ok: true as const, value: x }),
        handoff: (o: unknown) => ({ plan: JSON.stringify(o) }),
      },
      {
        id: 'two', profileId: 'p2',
        input: (x: unknown) => (typeof x === 'object' && x !== null && 'plan' in x ? { ok: true as const, value: x } : { ok: false as const, error: 'plan missing' }),
      },
    ],
  } as WorkflowSpec;
}

let call = 0;
function deps() {
  return {
    storage: convo,
    workflow: storage,
    registry,
    profiles: {
      p1: { id: 'p1', name: 'P1', systemPrompt: 's', tools: '*', policy: 'read', provider: { kind: 'mock' as const, baseUrl: 'x', apiKey: 'k', model: 'm', mockScript: [{ kind: 'assistant' as const, content: '{"plan":"x"}' }] } },
      p2: { id: 'p2', name: 'P2', systemPrompt: 's', tools: '*', policy: 'read', provider: { kind: 'mock' as const, baseUrl: 'x', apiKey: 'k', model: 'm', mockScript: [{ kind: 'assistant' as const, content: 'FINAL' }] } },
    },
    provider: (profileId: string) => new MockProvider([{ kind: 'assistant', content: profileId === 'p1' ? '{"plan":"x"}' : 'FINAL' }]),
  } as never;
}
void call;

describe('manual handoff gates', () => {
  it('ungated spec runs to done automatically', async () => {
    const out = await runWorkflow(spec(false), deps(), { input: { ask: 'go' } });
    expect(out.status).toBe('done');
  });

  it('gated stage parks the run awaiting_gate; advance releases and completes', async () => {
    const out = await runWorkflow(spec(true), deps(), { input: { ask: 'go' } });
    expect(out.status).toBe('awaiting_gate');
    const run = await storage.getWorkflowRun(out.runId);
    expect(run?.status).toBe('awaiting_gate');
    await advanceWorkflow(deps(), out.runId);
    const resumed = await runWorkflow(spec(true), deps(), { runId: out.runId });
    expect(resumed.status).toBe('done');
    expect(resumed.finalOutput).toBe('FINAL');
  });

  it('advance on a non-gated run is refused', async () => {
    const out = await runWorkflow(spec(false), deps(), { input: { ask: 'go' } });
    await expect(advanceWorkflow(deps(), out.runId)).rejects.toThrow('not awaiting a gate');
  });
});
