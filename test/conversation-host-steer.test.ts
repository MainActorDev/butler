import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { MockProvider } from '../src/provider/mock.ts';
import { ToolRegistry } from '../src/tools.ts';
import { registerConversationApi } from '../src/transport/conversation.ts';

/** Host-owned steering (no execution authority): `ConversationDeps.takeSteering`
 *  is asked at each tool boundary; what it returns joins the running turn as a
 *  user message, is stored, and reaches the model's next call. */

const tc = (id: string) => ({ kind: 'assistant' as const, content: '', toolCalls: [{ id, type: 'function' as const, function: { name: 'noop', arguments: '{}' } }] });

async function rig(take?: (sid: string) => Array<{ queueId: string; content: string }>, opts: { execution?: unknown } = {}) {
  const storage = new SqliteStorage(':memory:');
  const registry = new ToolRegistry().register({
    name: 'noop', description: 'n', permission: 'read', parameters: { type: 'object', properties: {} },
    execute: async () => 'done',
  });
  const seen: string[][] = [];
  const provider = new MockProvider([tc('a'), tc('b'), { kind: 'assistant', content: 'selesai' }]);
  const complete = provider.complete.bind(provider);
  provider.complete = async (messages, tools, o) => {
    seen.push(messages.filter((m) => m.role === 'user').map((m) => String(m.content)));
    return complete(messages, tools, o);
  };
  const app = Fastify();
  await registerConversationApi(app, {
    storage, provider, registry, policy: { name: 'draft', allows: 'draft' }, systemPrompt: 'sys', emit: () => undefined,
    ...(take ? { takeSteering: take } : {}),
    ...(opts.execution ? { execution: opts.execution as never } : {}),
  });
  const sid = (await app.inject({ method: 'POST', url: '/api/agent/sessions', payload: {} })).json().session.id as string;
  return { app, storage, sid, seen };
}

describe('host-owned steering (no execution authority)', () => {
  it('a steer handed over at the first tool boundary is stored and reaches the next model call, once', async () => {
    const asked: string[] = [];
    const list = ['juga cek gober'];
    const h = await rig((sid) => {
      asked.push(sid);
      return list.splice(0).map((content, i) => ({ queueId: `s${i}`, content }));
    });
    const r = await h.app.inject({ method: 'POST', url: `/api/agent/sessions/${h.sid}/messages`, payload: { content: 'mulai' } });
    expect(r.json().turn).toMatchObject({ ok: true, answer: 'selesai' });
    // two tool boundaries, both asked with this session's id
    expect(asked).toEqual([h.sid, h.sid]);
    expect(h.seen).toEqual([['mulai'], ['mulai', 'juga cek gober'], ['mulai', 'juga cek gober']]);
    const users = (await h.storage.sessionMessages(h.sid)).filter((m) => m.role === 'user').map((m) => m.content);
    expect(users).toEqual(['mulai', 'juga cek gober']);
    await h.app.close();
  });

  it('without takeSteering nothing changes', async () => {
    const h = await rig();
    const r = await h.app.inject({ method: 'POST', url: `/api/agent/sessions/${h.sid}/messages`, payload: { content: 'mulai' } });
    expect(r.json().turn.ok).toBe(true);
    expect(h.seen).toEqual([['mulai'], ['mulai'], ['mulai']]);
    await h.app.close();
  });

  it('a throwing takeSteering never breaks the turn', async () => {
    const h = await rig(() => {
      throw new Error('host list gone');
    });
    const r = await h.app.inject({ method: 'POST', url: `/api/agent/sessions/${h.sid}/messages`, payload: { content: 'mulai' } });
    expect(r.json().turn).toMatchObject({ ok: true, answer: 'selesai' });
    await h.app.close();
  });
});
