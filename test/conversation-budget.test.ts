import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Provider, ProviderMessage, ProviderTool } from '../src/provider/types.ts';
import { MockProvider, type ScriptedTurn } from '../src/provider/mock.ts';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { ToolRegistry } from '../src/tools.ts';
import { registerConversationApi } from '../src/transport/conversation.ts';

/** no-hassle long-running turns (2026-10-21 plan, Stage A): budget
 *  exhaustion is a PAUSE — friendly fail, session stays usable, partial
 *  transcript stashed — and the NEXT message seeds it back (invisible
 *  resume) instead of redoing the same hops. ABORTED keeps poisoning. */

const noopCall = (i: number): ProviderMessage['tool_calls'] => [
  { id: `c${i}`, type: 'function', function: { name: 'noop', arguments: '{}' } },
];

function toolTurn(i: number): ScriptedTurn {
  return { kind: 'assistant', content: null, toolCalls: noopCall(i) };
}

/** provider wrapper that CAPTURES the message list of every call — proves
 *  (or disproves) that a stashed partial was seeded into the next turn. */
class CapturingProvider implements Provider {
  readonly model = 'mock-model';
  readonly seen: ProviderMessage[][] = [];
  calls = 0;
  constructor(private readonly inner: MockProvider) {}
  async complete(messages: ProviderMessage[], tools: ProviderTool[], opts: { remainingMs: number; signal?: AbortSignal }) {
    this.calls += 1;
    this.seen.push(messages.map((m) => ({ ...m })));
    return this.inner.complete(messages, tools, opts);
  }
}

async function boot(provider: Provider, budget: { maxHops?: number; wallMs?: number }, storage: SqliteStorage) {
  const app = Fastify();
  const registry = new ToolRegistry().register({
    name: 'noop', description: 'n', permission: 'read', parameters: { type: 'object', properties: {} },
    execute: async () => `observation ${Date.now()}`,
  });
  await registerConversationApi(app, {
    storage, provider, registry, policy: { name: 'draft', allows: 'draft' },
    systemPrompt: 'sys', budget, emit: () => undefined,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, baseUrl: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` };
}

const post = (b: string, sid: string, content: string) =>
  fetch(`${b}/api/agent/sessions/${sid}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) })
    .then((r) => r.json() as Promise<{ turn: { ok: boolean; code?: string; error?: string; answer?: string } }>);

describe('partial stash storage', () => {
  it('stash → take roundtrip is one-shot and replaceable', async () => {
    const s = new SqliteStorage(':memory:');
    await s.stashPartial('sess_x', 't_1', '[{"role":"tool"}]');
    await s.stashPartial('sess_x', 't_2', '[{"role":"tool","content":"newer"}]'); // REPLACE wins
    const got = await s.takePartial('sess_x');
    expect(got).toEqual({ turnId: 't_2', json: '[{"role":"tool","content":"newer"}]' });
    expect(await s.takePartial('sess_x')).toBeNull(); // consumed
    s.close();
  });
});

describe('budget exhaustion pauses, resume continues', () => {
  it('exhaust → friendly fail, session active, stash seeded into the NEXT turn (not redone)', async () => {
    const storage = new SqliteStorage(':memory:');
    // app A: a model that tool-calls forever → dies at maxHops 3
    const exhaust = await boot(new MockProvider([toolTurn(0)]), { maxHops: 3, wallMs: 60_000 }, storage);
    const created = await (await fetch(`${exhaust.baseUrl}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { session: { id: string } };
    const sid = created.session.id;

    const failed = await post(exhaust.baseUrl, sid, 'do a deep multi-step thing');
    expect(failed.turn.ok).toBe(false);
    expect(failed.turn.code).toBe('BUDGET_EXCEEDED');
    expect(failed.turn.error).toContain('continue from where it stopped');

    // session stays usable — no dead-end error state
    const sess = await (await fetch(`${exhaust.baseUrl}/api/agent/sessions/${sid}`)).json() as { session: { status: string } };
    expect(sess.session.status).toBe('active');

    // app B (same storage): the follow-up turn completes and RECEIVES the
    // stashed transcript — history rows alone never carry role:'tool'
    const capturer = new CapturingProvider(new MockProvider([{ kind: 'assistant', content: 'resumed and finished' }]));
    const resume = await boot(capturer, { maxHops: 5, wallMs: 60_000 }, storage);
    const done = await post(resume.baseUrl, sid, 'continue');
    expect(done.turn.ok).toBe(true);
    expect(done.turn.answer).toBe('resumed and finished');

    const firstCall = capturer.seen[0]!;
    const seededTool = firstCall.find((m) => m.role === 'tool');
    expect(seededTool).toBeDefined(); // the 3 exhausted hops' results rode along
    expect(firstCall.some((m) => m.role === 'user' && m.content === 'continue')).toBe(true);

    // one-shot: the stash was consumed by the resume turn
    expect(await storage.takePartial(sid)).toBeNull();

    await exhaust.app.close(); await resume.app.close(); storage.close();
  });

  it('a fresh session gets NO seed (stash is per-session)', async () => {
    const storage = new SqliteStorage(':memory:');
    const exhaust = await boot(new MockProvider([toolTurn(0)]), { maxHops: 2, wallMs: 60_000 }, storage);
    const a = await (await fetch(`${exhaust.baseUrl}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { session: { id: string } };
    await post(exhaust.baseUrl, a.session.id, 'exhaust it'); // stashes for session A

    const capturer = new CapturingProvider(new MockProvider([{ kind: 'assistant', content: 'fresh answer' }]));
    const fresh = await boot(capturer, { maxHops: 4, wallMs: 60_000 }, storage);
    const b = await (await fetch(`${fresh.baseUrl}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { session: { id: string } };
    const done = await post(fresh.baseUrl, b.session.id, 'unrelated ask');
    expect(done.turn.answer).toBe('fresh answer');
    expect(capturer.seen[0]!.some((m) => m.role === 'tool')).toBe(false); // no leakage
    await exhaust.app.close(); await fresh.app.close(); storage.close();
  });
});

describe('non-budget failures keep today\'s behavior', () => {
  it('an ABORTED turn still poisons the session to error (regression guard)', async () => {
    const storage = new SqliteStorage(':memory:');
    const hang = await boot(new MockProvider([{ kind: 'hang', ms: 30_000 }]), { maxHops: 5, wallMs: 60_000 }, storage);
    const created = await (await fetch(`${hang.baseUrl}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { session: { id: string } };
    const sid = created.session.id;
    const turnPromise = fetch(`${hang.baseUrl}/api/agent/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hang please' }),
    }).then((r) => r.json() as Promise<{ turn: { ok: boolean; code?: string } }>);
    await new Promise((r) => setTimeout(r, 300));
    await fetch(`${hang.baseUrl}/api/agent/sessions/${sid}/abort`, { method: 'POST' });
    const out = await turnPromise;
    expect(out.turn.ok).toBe(false);
    expect(out.turn.code).toBe('ABORTED');
    const sess = await (await fetch(`${hang.baseUrl}/api/agent/sessions/${sid}`)).json() as { session: { status: string } };
    expect(sess.session.status).toBe('error'); // only the budget path softens
    await hang.app.close(); storage.close();
  });
});
