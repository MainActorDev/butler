import { describe, expect, it } from 'vitest';
import { MockProvider, type ScriptedTurn } from '../src/provider/mock.ts';
import { ProviderError } from '../src/provider/types.ts';
import { runLoop, LoopError, type LoopTool, type TurnEvent } from '../src/loop.ts';

const toolCall = (id: string, name: string, args: unknown): ScriptedTurn => ({
  kind: 'assistant',
  content: null,
  toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

const echoTool: LoopTool = {
  name: 'echo',
  description: 'echoes text',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: async (args) => `echo: ${String(args['text'])}`,
};

const failTool: LoopTool = {
  name: 'boom',
  description: 'always throws',
  parameters: { type: 'object', properties: {} },
  execute: async () => { throw new Error('kaboom'); },
};

describe('loop — happy paths (condition 2)', () => {
  it('completes a tool-calling conversation within budgets; accounting rows per turn', async () => {
    const persisted: Array<{ role: string; in: number; out: number }> = [];
    const events: TurnEvent[] = [];
    const provider = new MockProvider([
      toolCall('c1', 'echo', { text: 'hi' }),
      { kind: 'assistant', content: 'done: echo ran', usage: { promptTokens: 20, completionTokens: 7 } },
    ]);
    const result = await runLoop('sys', 'say hi via echo', {
      provider,
      tools: [echoTool],
      onMessage: (m, meta) => persisted.push({ role: m.role, in: meta.tokensIn, out: meta.tokensOut }),
      onEvent: (e) => events.push(e),
    });
    expect(result.answer).toBe('done: echo ran');
    expect(result.hops).toBe(2);
    expect(result.tokens).toEqual({ in: 30, out: 12 });
    // persistence hook saw every message incl. the tool observation
    expect(persisted.map((p) => p.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(persisted[1]).toEqual({ role: 'tool', in: 0, out: 0 });
    // event stream covers the lifecycle
    expect(events.map((e) => e.type)).toContain('turn.tool');
    expect(events.at(-1)?.type).toBe('turn.end');
    // the tool observation is in the transcript for the next provider call
    expect(result.messages.some((m) => m.role === 'tool' && m.content === 'echo: hi')).toBe(true);
  });

  it('multiple tool calls in one turn all execute', async () => {
    const provider = new MockProvider([
      { kind: 'assistant', content: null, toolCalls: [
        { id: 'a', type: 'function', function: { name: 'echo', arguments: '{"text":"one"}' } },
        { id: 'b', type: 'function', function: { name: 'echo', arguments: '{"text":"two"}' } },
      ] },
      { kind: 'assistant', content: 'both done' },
    ]);
    const r = await runLoop('sys', 'go', { provider, tools: [echoTool] });
    expect(r.answer).toBe('both done');
    expect(r.messages.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual(['echo: one', 'echo: two'] as (string | null)[]);
  });

  it('tool handler throws become observations — loop continues (ReAct)', async () => {
    const provider = new MockProvider([
      toolCall('c1', 'boom', {}),
      { kind: 'assistant', content: 'tool failed gracefully' },
    ]);
    const r = await runLoop('sys', 'go', { provider, tools: [failTool] });
    expect(r.answer).toBe('tool failed gracefully');
    expect(r.messages.some((m) => m.role === 'tool' && m.content === 'error: kaboom')).toBe(true);
  });

  it('unknown tool → named observation listing available tools', async () => {
    const provider = new MockProvider([
      toolCall('c1', 'nope', {}),
      { kind: 'assistant', content: 'ok' },
    ]);
    const r = await runLoop('sys', 'go', { provider, tools: [echoTool] });
    expect(r.messages.some((m) => m.role === 'tool' && (m.content ?? '').includes('unknown tool "nope"') && (m.content ?? '').includes('echo'))).toBe(true);
  });

  it('invalid JSON arguments → ONE repair prompt, second offense → TOOL_CALL_INVALID', async () => {
    const bad: ScriptedTurn = { kind: 'assistant', content: null, toolCalls: [{ id: 'x', type: 'function', function: { name: 'echo', arguments: '{not json' } }] };
    const provider = new MockProvider([bad, { kind: 'assistant', content: 'recovered after repair' }]);
    const r = await runLoop('sys', 'go', { provider, tools: [echoTool] });
    expect(r.answer).toBe('recovered after repair');
    expect(r.messages.some((m) => m.role === 'tool' && (m.content ?? '').includes('not valid JSON'))).toBe(true);

    const provider2 = new MockProvider([bad, bad, bad]);
    await expect(runLoop('sys', 'go', { provider: provider2, tools: [echoTool] })).rejects.toMatchObject({ code: 'TOOL_CALL_INVALID' });
  });
});

describe('loop — budgets (condition 2)', () => {
  it('hop budget exhaustion → BUDGET_EXCEEDED with partial transcript', async () => {
    const loop: ScriptedTurn = { kind: 'assistant', content: null, toolCalls: [{ id: 'c', type: 'function', function: { name: 'echo', arguments: '{"text":"again"}' } }] };
    const provider = new MockProvider([loop, loop, loop, loop]);
    await expect(runLoop('sys', 'go', { provider, tools: [echoTool], budget: { maxHops: 3 } }))
      .rejects.toMatchObject({ code: 'BUDGET_EXCEEDED', partial: expect.any(Array) });
  });

  it('token budget exhaustion → BUDGET_EXCEEDED', async () => {
    const provider = new MockProvider([
      { kind: 'assistant', content: 'big', usage: { promptTokens: 90, completionTokens: 20 } },
    ]);
    await expect(runLoop('sys', 'go', { provider, tools: [], budget: { maxTokens: 100 } }))
      .rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });

  it('wall budget exhaustion → BUDGET_EXCEEDED', async () => {
    // hop 1 succeeds after burning ~60ms; hop 2 finds the wall gone
    const slow: ScriptedTurn = { kind: 'assistant', content: null, toolCalls: [{ id: 'c', type: 'function', function: { name: 'echo', arguments: '{"text":"x"}' } }] };
    const provider = new MockProvider([slow, { kind: 'assistant', content: 'never' }]);
    await expect(runLoop('sys', 'go', {
      provider,
      tools: [{ ...echoTool, execute: async () => { await new Promise((r) => setTimeout(r, 60)); return 'slow'; } }],
      budget: { wallMs: 30 },
    })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });

  it('abort mid-loop → ABORTED, clean stop', async () => {
    const ac = new AbortController();
    const provider = new MockProvider([
      toolCall('c1', 'echo', { text: 'x' }),
      { kind: 'assistant', content: 'final' },
    ]);
    const err = await runLoop('sys', 'go', {
      provider,
      tools: [{
        ...echoTool,
        execute: async (args, ctx) => { ac.abort(); expect(ctx.signal?.aborted).toBe(true); return 'done'; },
      }],
      signal: ac.signal,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoopError);
    expect((err as LoopError).code).toBe('ABORTED');
  });

  it('never-responding provider → PROVIDER_TIMEOUT inside wall budget; session resumable (review F5)', async () => {
    const provider = new MockProvider([{ kind: 'hang', ms: 10_000 }]);
    const t0 = Date.now();
    const err = await runLoop('sys', 'go', {
      provider,
      tools: [],
      budget: { wallMs: 1_500 },
    }).catch((e: unknown) => e);
    const elapsed = Date.now() - t0;
    expect(err).toBeInstanceOf(LoopError);
    expect((err as LoopError).code).toBe('BUDGET_EXCEEDED');
    expect((err as LoopError).message).toContain('PROVIDER_TIMEOUT');
    // the wall budget held: aborted well inside it (not 10s)
    expect(elapsed).toBeLessThan(3_000);
    // partial transcript persisted = resumable shape
    expect((err as LoopError).partial.length).toBeGreaterThanOrEqual(2);
  });

  it('provider hard error (non-retryable) surfaces its code', async () => {
    const provider = new MockProvider([{ kind: 'error', error: new ProviderError('bad key', 'PROVIDER_BAD_REQUEST', 401, false) }]);
    const err = await runLoop('sys', 'go', { provider, tools: [] }).catch((e: unknown) => e);
    expect((err as LoopError).message).toContain('PROVIDER_BAD_REQUEST');
  });
});
