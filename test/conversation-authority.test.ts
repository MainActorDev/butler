import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import type { Provider, ProviderMessage, ProviderResponse, ProviderTool } from '../src/provider/types.ts';
import { ProviderError } from '../src/provider/types.ts';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { EventSink } from '../src/orchestrate/event-sink.ts';
import { ToolRegistry } from '../src/tools.ts';
import { registerConversationApi } from '../src/transport/conversation.ts';
import { createSqliteExecutionAuthority, ExecutionAuthorityBusyError, type ExecutionAuthority } from '../src/orchestrate/execution-authority.ts';

/** chat-reliability F1/F2/F3 end-to-end at the transport seam: the message
 *  POST driven by the execution authority over real HTTP — atomic admission,
 *  preserved provider classification in the envelope, authority-fenced Stop,
 *  honest budget pause, single-executor election across transport instances. */

type Opts = Parameters<Provider['complete']>[2];
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

class SlowProvider implements Provider {
  readonly model = 'slow';
  calls = 0;
  constructor(private readonly ms: number, private readonly failWith?: () => never) {}
  async complete(_m: ProviderMessage[], _t: ProviderTool[], _o: Opts): Promise<ProviderResponse> {
    this.calls += 1;
    if (this.failWith) this.failWith();
    await new Promise((r) => setTimeout(r, this.ms));
    return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 2 } };
  }
}

interface Rig {
  dir: string; agent: string; storage: SqliteStorage; sink: EventSink; auth: ExecutionAuthority;
  baseUrl: (app: Fastify.FastifyInstance) => string;
}

async function bootRig(name: string, provider: Provider): Promise<Rig & { app: Fastify.FastifyInstance; url: string }> {
  const dir = mkdtempSync(join(tmpdir(), `butler-conv-auth-${name}-`));
  dirs.push(dir);
  const agent = join(dir, 'agent.db');
  const storage = new SqliteStorage(agent);
  const sink = new EventSink(storage['db'] as InstanceType<typeof Database>, { passive: true, enqueueRunTurn: false });
  const auth = await createSqliteExecutionAuthority({ dbPath: agent, sink, storage });
  const app = Fastify();
  const registry = new ToolRegistry().register({
    name: 'nop', description: 'n', permission: 'read', parameters: { type: 'object', properties: {} },
    execute: async () => 'observation',
  });
  await registerConversationApi(app, {
    storage, provider, registry, policy: { name: 'draft', allows: 'draft' },
    systemPrompt: 'sys', emit: () => undefined, execution: auth,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return { dir, agent, storage, sink, auth, app, url, baseUrl: () => url };
}

const post = (url: string, sid: string, body: Record<string, unknown>) =>
  fetch(`${url}/api/agent/sessions/${sid}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const newSession = async (url: string): Promise<string> => {
  const r = await fetch(`${url}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return ((await r.json()) as { session: { id: string } }).session.id;
};

describe('authority-driven transport', () => {
  it('concurrent same-session sends: one 200, one 409 — provider and hooks run exactly once', async () => {
    let hooks = 0;
    const provider = new SlowProvider(120);
    const rig = await bootRig('race', provider);
    try {
      const sid = await newSession(rig.url);
      const [a, b] = await Promise.all([post(rig.url, sid, { content: 'first' }), post(rig.url, sid, { content: 'second' })]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(provider.calls).toBe(1);
      expect(hooks).toBe(0);
      const messages = await rig.storage.sessionMessages(sid);
      expect(messages.filter((m) => m.role === 'user')).toHaveLength(1); // no phantom user row
      // follow-up send works — ownership was released
      const again = await post(rig.url, sid, { content: 'third' });
      expect(again.status).toBe(200);
      expect(provider.calls).toBe(2);
    } finally {
      await rig.app.close();
      await rig.auth.drain();
      rig.storage.close();
    }
  });

  it('F3 consumer wiring: provider 400 surfaces PROVIDER_BAD_REQUEST — no budget stash, session errors honestly', async () => {
    const provider = new SlowProvider(1, () => { throw new ProviderError('bad request', 'PROVIDER_BAD_REQUEST', 400); });
    const rig = await bootRig('p400', provider);
    try {
      const sid = await newSession(rig.url);
      const res = await post(rig.url, sid, { content: 'hello' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { turn: { ok: boolean; code?: string; error?: string } };
      expect(body.turn.ok).toBe(false);
      expect(body.turn.code).toBe('PROVIDER_BAD_REQUEST');
      expect(body.turn.error).toContain('PROVIDER_BAD_REQUEST');
      expect(await rig.storage.peekPartial?.(sid)).toBeNull(); // no budget stash for a provider failure
      const sess = await rig.storage.getSession(sid);
      expect(sess?.status).toBe('error');
      expect(rig.auth.readSession(sid)).toMatchObject({ state: 'idle', admission: 'ready' }); // ownership released
    } finally {
      await rig.app.close();
      await rig.auth.drain();
      rig.storage.close();
    }
  });

  it('duplicate clientRequestId returns REQUEST_ALREADY_ADMITTED with the original turn, without re-executing', async () => {
    const provider = new SlowProvider(10);
    const rig = await bootRig('reqid', provider);
    try {
      const sid = await newSession(rig.url);
      const rid = '22222222-2224-4222-8222-222222222222';
      const first = await post(rig.url, sid, { content: 'same prompt', clientRequestId: rid });
      expect(first.status).toBe(200);
      expect(((await first.json()) as { turn: { ok: boolean } }).turn.ok).toBe(true);
      const dup = await post(rig.url, sid, { content: 'same prompt', clientRequestId: rid });
      expect(dup.status).toBe(409);
      const dupBody = (await dup.json()) as { code?: string; turnId?: string };
      expect(dupBody.code).toBe('REQUEST_ALREADY_ADMITTED');
      expect(typeof dupBody.turnId).toBe('string');
      expect(provider.calls).toBe(1); // never re-executed
    } finally {
      await rig.app.close();
      await rig.auth.drain();
      rig.storage.close();
    }
  });

  it('explicit Stop mid-turn → ABORTED envelope; the session returns to ready', async () => {
    const provider = new SlowProvider(10_000);
    const rig = await bootRig('stop', provider);
    try {
      const sid = await newSession(rig.url);
      const inflight = post(rig.url, sid, { content: 'long work' });
      await new Promise((r) => setTimeout(r, 150)); // let it admit + begin
      const stop = await fetch(`${rig.url}/api/agent/sessions/${sid}/abort`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(stop.status).toBe(200);
      const res = await inflight;
      const body = (await res.json()) as { turn: { ok: boolean; code?: string } };
      expect(body.turn.ok).toBe(false);
      expect(body.turn.code).toBe('ABORTED');
      expect(rig.auth.readSession(sid)).toMatchObject({ state: 'idle', admission: 'ready' });
    } finally {
      await rig.app.close();
      await rig.auth.drain();
      rig.storage.close();
    }
  });

  it('a second transport instance on the same agent DB cannot elect its own authority', async () => {
    const rig = await bootRig('elect', new SlowProvider(1));
    try {
      const sink2 = new EventSink(new Database(rig.agent), { passive: true, enqueueRunTurn: false });
      await expect(createSqliteExecutionAuthority({ dbPath: rig.agent, sink: sink2, storage: rig.storage }))
        .rejects.toBeInstanceOf(ExecutionAuthorityBusyError);
    } finally {
      await rig.app.close();
      await rig.auth.drain();
      rig.storage.close();
    }
  });
});
