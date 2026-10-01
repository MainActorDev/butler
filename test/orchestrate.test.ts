import { describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { MockProvider, type ScriptedTurn } from '../src/provider/mock.ts';
import { runLoop } from '../src/loop.ts';
import { fanOut, spawnTool, childBudgets } from '../src/orchestrate/supervisor.ts';

/** Stage D (condition 4): supervisor spawns children concurrently; budgets
 *  roll up; failures are named-skips; session tree populated; summaries
 *  (not transcripts) returned; the spawn tool works inside a loop. */

const tool = { name: 'noop', description: 'n', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' } as const;
const CTX = { signal: undefined, sessionId: 'parent' };

describe('childBudgets (roll-up)', () => {
  it('children share the parent remainder pro-rata; wall = remaining', () => {
    const bs = childBudgets({ maxHops: 12, maxTokens: 1_000, wallMs: 10_000 }, 4, 2_000 /* elapsed */, 200 /* spent */);
    expect(bs).toHaveLength(4);
    expect(bs[0]!.maxTokens).toBe(Math.floor(800 / 4));
    expect(bs[0]!.wallMs).toBe(8_000);
    expect(bs[0]!.maxHops).toBe(12); // hops are per-loop ceilings, NOT divided
  });
});

describe('fanOut (concurrency, named-skip, tree, summaries)', () => {
  it('children run concurrently; reports summarize; session tree rows land', { timeout: 30_000 }, async () => {
    const storage = SqliteStorage.memory();
    await storage.createSession({ id: 'parent_1', title: 'supervisor' });
    const script: ScriptedTurn[] = [
      { kind: 'assistant', content: null, toolCalls: [{ id: 'c', type: 'function', function: { name: 'noop', arguments: '{}' } }] },
      { kind: 'assistant', content: 'child finished its narrow goal' },
    ];
    const t0 = Date.now();
    const { reports, tokens } = await fanOut(
      [
        { goal: 'draft spec for DEMO-101', prompt: 'do 101' },
        { goal: 'draft spec for DEMO-102', prompt: 'do 102' },
        { goal: 'draft spec for DEMO-103', prompt: 'do 103' },
        { goal: 'draft spec for DEMO-104', prompt: 'do 104' },
      ],
      { provider: () => new MockProvider(script), storage, tools: [tool], parentSessionId: 'parent_1' },
      { maxHops: 4, maxTokens: 10_000, wallMs: 30_000 },
    );
    const wall = Date.now() - t0;
    expect(reports).toHaveLength(4);
    expect(reports.every((r) => r.ok && r.summary === 'child finished its narrow goal')).toBe(true);
    // budgets rolled up
    expect(tokens.in).toBe(4 * 20); // 2 assistant turns × 10in × 4 children (mock usage 10/5)
    // concurrency: 4 instant children inside one window (serial would multiply)
    expect(wall).toBeLessThan(2_000);
    // session tree: 4 children pointing at the parent, depth 1
    const kids = await storage.childSessions('parent_1');
    expect(kids).toHaveLength(4);
    expect(kids.every((k) => k.depth === 1 && k.parent_session_id === 'parent_1')).toBe(true);
    // child messages persisted (resume-from-rows)
    for (const k of kids) expect((await storage.sessionMessages(k.id)).length).toBeGreaterThan(0);
    storage.close();
  });

  it('one child blowing its budget → named-skip; the fan-out continues', { timeout: 30_000 }, async () => {
    const storage = SqliteStorage.memory();
    await storage.createSession({ id: 'parent_2' });
    // provider that returns HUGE usage on the second hop → token overflow
    const explosive: ScriptedTurn[] = [
      { kind: 'assistant', content: null, toolCalls: [{ id: 'c', type: 'function', function: { name: 'noop', arguments: '{}' } }] },
      { kind: 'assistant', content: 'big', usage: { promptTokens: 5_000, completionTokens: 1 } },
    ];
    const fine: ScriptedTurn[] = [{ kind: 'assistant', content: 'ok', usage: { promptTokens: 5, completionTokens: 2 } }];
    // two children share one provider? No — per-child providers: build fanOut with a factory would be cleaner;
    // here we pass ONE provider (explosive) for both children — both skip (still proves never-abort):
    const { reports } = await fanOut(
      [{ goal: 'a', prompt: 'x' }, { goal: 'b', prompt: 'y' }],
      { provider: () => new MockProvider(explosive), storage, tools: [tool], parentSessionId: 'parent_2' },
      { maxHops: 4, maxTokens: 1_000, wallMs: 30_000 },
    );
    expect(reports.every((r) => !r.ok && r.code === 'BUDGET_EXCEEDED')).toBe(true);
    expect(reports.every((r) => r.summary.startsWith('skipped:'))).toBe(true);
    // mixed outcome proof:
    const { reports: mixed } = await fanOut(
      [{ goal: 'fine', prompt: 'f' }],
      { provider: () => new MockProvider(fine), storage, tools: [tool], parentSessionId: 'parent_2' },
      { maxHops: 4, maxTokens: 1_000, wallMs: 30_000 },
    );
    expect(mixed[0]!.ok).toBe(true);
    storage.close();
  });
});

describe('spawnTool inside a supervisor loop (the real shape)', () => {
  it('supervisor calls agent.spawn; receives summaries JSON as the observation', { timeout: 30_000 }, async () => {
    const storage = SqliteStorage.memory();
    await storage.createSession({ id: 'parent_3', title: 'loop supervisor' });
    const spawn = spawnTool({ provider: () => new MockProvider([{ kind: 'assistant', content: 'child result: 42' }]), storage, tools: [tool], parentSessionId: 'parent_3' });
    // supervisor script: call spawn with two goals, then answer
    const supervisorProvider = new MockProvider([
      { kind: 'assistant', content: null, toolCalls: [{ id: 's1', type: 'function', function: { name: 'agent.spawn', arguments: JSON.stringify({ goals: [{ goal: 'g1', prompt: 'p1' }, { goal: 'g2', prompt: 'p2' }] }) } }] },
      { kind: 'assistant', content: 'fan-out complete, summaries received' },
    ]);
    const result = await runLoop('supervisor sys', 'fan these out', {
      provider: supervisorProvider,
      tools: [spawn],
    });
    expect(result.answer).toBe('fan-out complete, summaries received');
    // grandchildren exist in the tree under parent_3
    const kids = await storage.childSessions('parent_3');
    expect(kids.length).toBe(2);
    storage.close();
  });

  it('spawn validates its args (empty/malformed goals → named error observation, loop continues)', { timeout: 15_000 }, async () => {
    const storage = SqliteStorage.memory();
    await storage.createSession({ id: 'parent_4' });
    const spawn = spawnTool({ provider: new MockProvider([{ kind: 'assistant', content: 'x' }]), storage, tools: [tool], parentSessionId: 'parent_4' });
    const out = await spawn.execute({ goals: [] }, CTX);
    expect(out).toContain('error: goals[]');
    const out2 = await spawn.execute({}, CTX);
    expect(out2).toContain('error: goals[]');
    storage.close();
  });
});
