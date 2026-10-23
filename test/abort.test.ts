import { describe, expect, it } from 'vitest';
import net from 'node:net';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { EventSink } from '../src/orchestrate/event-sink.ts';
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

  it('durable log (sink, no authority): a Stop records turn.aborted, never turn.failed', async () => {
    const storage = new SqliteStorage(':memory:');
    const sink = new EventSink(storage['db'] as InstanceType<typeof Database>, { passive: true, enqueueRunTurn: false });
    const app = Fastify();
    await registerConversationApi(app, {
      storage, provider: new MockProvider([{ kind: 'hang', ms: 30_000 }]), registry: new ToolRegistry(), policy: { name: 'draft', allows: 'draft' },
      systemPrompt: 'sys', budget: { wallMs: 60_000 }, emit: () => undefined, sink,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    try {
      const sid = ((await (await fetch(`${baseUrl}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as { session: { id: string } }).session.id;
      const turnPromise = fetch(`${baseUrl}/api/agent/sessions/${sid}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hang please' }) })
        .then((r) => r.json() as Promise<{ turn: { ok: boolean; code?: string } }>);
      await new Promise((r) => setTimeout(r, 300));
      await fetch(`${baseUrl}/api/agent/sessions/${sid}/abort`, { method: 'POST' });
      expect((await turnPromise).turn.code).toBe('ABORTED');
      const terminals = sink.events(sid).filter((e) => e.kind === 'turn.completed' || e.kind === 'turn.failed' || e.kind === 'turn.aborted');
      expect(terminals.map((e) => [e.kind, e.detail])).toEqual([['turn.aborted', { reason: 'aborted by caller' }]]);
      expect((await storage.getSession(sid))?.status).toBe('error'); // accounting unchanged: ABORTED still poisons
    } finally {
      await app.close();
      storage.close();
    }
  });
});


// ── #7: client disconnect mid-flight aborts the turn (opt-in) ──
describe('abort on client disconnect (#7)', () => {
  it('socket destroyed mid-turn → turn aborts (opt-in flag on)', async () => {
    const storage = new SqliteStorage(':memory:');
    const registry = new ToolRegistry().register({
      name: 'noop', description: 'n', permission: 'read', parameters: { type: 'object', properties: {} },
      execute: async () => 'done',
    });
    const app = Fastify();
    await registerConversationApi(app, {
      storage, provider: new MockProvider([{ kind: 'hang', ms: 20_000 }]), registry,
      policy: { name: 'draft', allows: 'draft' }, systemPrompt: 'sys',
      budget: { wallMs: 60_000 }, emit: () => undefined,
      abortOnDisconnect: true,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;

    const created = await (await fetch(`http://127.0.0.1:${port}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { session: { id: string } };
    const sid = created.session.id;

    // open a raw socket, send the message, then DESTROY the connection mid-turn
    const sock = net.connect({ port, host: '127.0.0.1' });
    await new Promise<void>((r) => sock.once('connect', () => r()));
    sock.write(`POST /api/agent/sessions/${sid}/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${JSON.stringify({ content: 'hang' }).length}\r\nConnection: close\r\n\r\n${JSON.stringify({ content: 'hang' })}`);
    await new Promise((r) => setTimeout(r, 300)); // turn is now hanging in-flight
    sock.destroy();

    // the abort lands in the transport's catch → session status flips to error
    let status: string | undefined;
    for (let i = 0; i < 40 && status !== 'error'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = (await storage.getSession(sid))?.status;
    }
    expect(status).toBe('error');
    await app.close();
  });

  it('flag OFF (default) → disconnect does NOT abort; the turn outlives the socket', async () => {
    const storage = new SqliteStorage(':memory:');
    const registry = new ToolRegistry().register({
      name: 'noop', description: 'n', permission: 'read', parameters: { type: 'object', properties: {} },
      execute: async () => 'done',
    });
    const app = Fastify();
    await registerConversationApi(app, {
      storage, provider: new MockProvider([{ kind: 'hang', ms: 3_000 }]), registry,
      policy: { name: 'draft', allows: 'draft' }, systemPrompt: 'sys',
      budget: { wallMs: 60_000 }, emit: () => undefined,
      // no abortOnDisconnect — default off
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const created = await (await fetch(`http://127.0.0.1:${port}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { session: { id: string } };
    const sid = created.session.id;
    const sock = net.connect({ port, host: '127.0.0.1' });
    await new Promise<void>((r) => sock.once('connect', () => r()));
    sock.write(`POST /api/agent/sessions/${sid}/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${JSON.stringify({ content: 'hang' }).length}\r\nConnection: close\r\n\r\n${JSON.stringify({ content: 'hang' })}`);
    await new Promise((r) => setTimeout(r, 300));
    sock.destroy();
    // within the hang window the session has NOT been failed by the disconnect
    await new Promise((r) => setTimeout(r, 700));
    const st = (await storage.getSession(sid))?.status;
    expect(st).not.toBe('error');
    // cleanup: abort via the route so the suite doesn't wait the full hang
    await fetch(`http://127.0.0.1:${port}/api/agent/sessions/${sid}/abort`, { method: 'POST' });
    await app.close();
  });
});
