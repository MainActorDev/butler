import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { MockProvider } from '../src/provider/mock.ts';
import { ToolRegistry } from '../src/tools.ts';
import { registerConversationApi } from '../src/transport/conversation.ts';

/** Abort mid-flight (review F1, the strong case): a HANGING turn gets aborted
 *  via the route; outcome is clean, partial transcript persisted. */

describe('abort mid-flight', () => {
  it('POST abort kills a hanging turn; turn outcome carries the abort; rows intact',  async () => {
    const storage = new SqliteStorage(':memory:');
    const registry = new ToolRegistry().register({
      name: 'noop', description: 'n', permission: 'read', parameters: { type: 'object', properties: {} },
      execute: async () => 'done',
    });
    const app = Fastify();
    const hang = new MockProvider([{ kind: 'hang', ms: 30_000 }]);
    await registerConversationApi(app, {
      storage, provider: hang, registry, policy: { name: 'draft', allows: 'draft' },
      systemPrompt: 'sys',
      budget: { wallMs: 60_000 },
      emit: () => undefined,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

    const created = await (await fetch(`${baseUrl}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { session: { id: string } };
    const sid = created.session.id;

    // fire the message (hangs), then abort after a beat
    const turnPromise = fetch(`${baseUrl}/api/agent/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hang please' }),
    }).then((r) => r.json() as Promise<{ turn: { ok: boolean; code?: string } }>);
    await new Promise((r) => setTimeout(r, 300));
    const abortRes = await fetch(`${baseUrl}/api/agent/sessions/${sid}/abort`, { method: 'POST' });
    expect(abortRes.status).toBe(200);
    const { turn } = await turnPromise;
    expect(turn.ok).toBe(false);
    expect(turn.code).toBe('ABORTED');
    // partial transcript persisted: the user message at minimum
    const msgs = await storage.sessionMessages(sid);
    expect(msgs.some((m) => m.role === 'user' && m.content === 'hang please')).toBe(true);
    await app.close();
    storage.close();
  });
});
