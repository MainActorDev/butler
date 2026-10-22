import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Provider, ProviderMessage, ProviderResponse, ProviderTool } from '../src/provider/types.ts';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { ToolRegistry } from '../src/tools.ts';
import { registerConversationApi } from '../src/transport/conversation.ts';

/** chat-reliability F1: admission check-and-acquire must be atomic across the
 *  async preparation window (durable writes, history reads, stash). Two
 *  same-session sends racing through that window: exactly ONE accepted turn,
 *  ONE 409, no double provider execution, no phantom user message. A failed
 *  preparation must release the reservation (no stranded session). */

type Opts = Parameters<Provider['complete']>[2];

class SlowProvider implements Provider {
  readonly model = 'slow';
  calls = 0;
  constructor(private readonly ms: number) {}
  async complete(_m: ProviderMessage[], _t: ProviderTool[], _o: Opts): Promise<ProviderResponse> {
    this.calls += 1;
    await new Promise((r) => setTimeout(r, this.ms));
    return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 2 } };
  }
}

/** fails sessionMessages ONCE (simulates a preparation-window storage error),
 *  then delegates normally. */
class FlakyPrepStorage extends SqliteStorage {
  private failed = false;
  constructor() { super(':memory:'); }
  override async sessionMessages(id: string) {
    if (!this.failed) { this.failed = true; throw new Error('transient history read failure'); }
    return super.sessionMessages(id);
  }
}

async function boot(provider: Provider, storage: SqliteStorage) {
  const app = Fastify();
  const registry = new ToolRegistry().register({
    name: 'noop', description: 'n', permission: 'read', parameters: { type: 'object', properties: {} },
    execute: async () => 'observation',
  });
  await registerConversationApi(app, {
    storage, provider, registry, policy: { name: 'draft', allows: 'draft' },
    systemPrompt: 'sys', emit: () => undefined,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, baseUrl: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` };
}

const post = (b: string, sid: string, content: string) =>
  fetch(`${b}/api/agent/sessions/${sid}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });

describe('F1 — atomic same-session admission across the async prep window', () => {
  it('two concurrent sends: one 200, one 409, provider runs exactly once', async () => {
    const storage = new SqliteStorage(':memory:');
    const provider = new SlowProvider(120);
    const { app, baseUrl } = await boot(provider, storage);
    try {
      const created = await (await fetch(`${baseUrl}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { session: { id: string } };
      const sid = created.session.id;

      const [a, b] = await Promise.all([post(baseUrl, sid, 'first'), post(baseUrl, sid, 'second')]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);

      // the loser executed nothing and left no phantom user row
      expect(provider.calls).toBe(1);
      const messages = await storage.sessionMessages(sid);
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      const loser = a.status === 409 ? a : b;
      expect(await loser.json()).toEqual({ error: 'turn already in flight on this session' });
    } finally {
      await app.close();
      storage.close();
    }
  });

  it('the 409 does not poison the session: a follow-up send after completion succeeds', async () => {
    const storage = new SqliteStorage(':memory:');
    const provider = new SlowProvider(40);
    const { app, baseUrl } = await boot(provider, storage);
    try {
      const created = await (await fetch(`${baseUrl}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { session: { id: string } };
      const sid = created.session.id;

      const [a, b] = await Promise.all([post(baseUrl, sid, 'first'), post(baseUrl, sid, 'second')]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const followUp = await post(baseUrl, sid, 'third');
      expect(followUp.status).toBe(200);
      expect(provider.calls).toBe(2);
    } finally {
      await app.close();
      storage.close();
    }
  });

  it('a preparation failure releases the reservation instead of stranding the session', async () => {
    const storage = new FlakyPrepStorage();
    const provider = new SlowProvider(10);
    const { app, baseUrl } = await boot(provider, storage);
    try {
      const created = await (await fetch(`${baseUrl}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { session: { id: string } };
      const sid = created.session.id;

      const first = await post(baseUrl, sid, 'first');
      expect(first.status).toBe(500);
      expect(((await first.json()) as { error: string }).error).toContain('turn preparation failed');

      // reservation was released — the next send must be admitted, not 409
      const second = await post(baseUrl, sid, 'retry');
      expect(second.status).toBe(200);
      expect(provider.calls).toBe(1);
    } finally {
      await app.close();
      storage.close();
    }
  });
});
