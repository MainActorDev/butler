import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import type { Provider, ProviderMessage, ProviderResponse, ProviderTool } from '../src/provider/types.ts';
import { MockProvider } from '../src/provider/mock.ts';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { EventSink } from '../src/orchestrate/event-sink.ts';
import { ToolRegistry } from '../src/tools.ts';
import { registerConversationApi } from '../src/transport/conversation.ts';

/** chat-reliability F1 (tool durability): a provider-requested REGISTRY tool
 *  must land in the durable event log (tool_call + tool_call_update) —
 *  previously runtime tools emitted no onTool callbacks at all, so replayed
 *  history showed zero tool activity for real work. */

type Opts = Parameters<Provider['complete']>[2];
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function boot(provider: Provider, execute: (args: Record<string, unknown>) => Promise<string> = async (args) => `observed:${String(args['q'])}`): Promise<{ app: FastifyInstance; url: string; sink: EventSink; storage: SqliteStorage }> {
  const dir = mkdtempSync(join(tmpdir(), 'butler-tooldur-'));
  dirs.push(dir);
  const agent = join(dir, 'agent.db');
  const storage = new SqliteStorage(agent);
  const sink = new EventSink(storage['db'] as InstanceType<typeof Database>, { passive: true, enqueueRunTurn: false });
  const registry = new ToolRegistry().register({
    name: 'probe', description: 'p', permission: 'read', parameters: { type: 'object', properties: { q: { type: 'string' } } },
    execute,
  });
  const app = Fastify();
  await registerConversationApi(app, {
    storage, provider, registry, policy: { name: 'draft', allows: 'draft' },
    systemPrompt: 'sys', emit: () => undefined, sink,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, sink, storage };
}

class AnsweringProvider implements Provider {
  readonly model = 'answering';
  calls = 0;
  constructor(private readonly turns: Array<{ toolCalls?: ProviderMessage['tool_calls']; content?: string }>) {}
  async complete(_m: ProviderMessage[], _t: ProviderTool[], _o: Opts): Promise<ProviderResponse> {
    const turn = this.turns[Math.min(this.calls, this.turns.length - 1)]!;
    this.calls += 1;
    return {
      message: { role: 'assistant', content: turn.content ?? null, ...(turn.toolCalls ? { tool_calls: turn.toolCalls } : {}) },
      finishReason: turn.toolCalls ? 'tool_calls' : 'stop',
      usage: { promptTokens: 5, completionTokens: 2 },
    };
  }
}

describe('runtime tool durability', () => {
  it('a provider-requested registry tool lands durable tool_call + tool_call_update events', async () => {
    const provider = new AnsweringProvider([
      { toolCalls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{"q":"tree"}' } }] },
      { content: 'checked the tree' },
    ]);
    const rig = await boot(provider);
    try {
      const created = await (await fetch(`${rig.url}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { session: { id: string } };
      const res = await fetch(`${rig.url}/api/agent/sessions/${created.session.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'run probe' }) });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { turn: { ok: boolean } }).turn.ok).toBe(true);
      const events = rig.sink.events(created.session.id);
      const calls = events.filter((e) => e.kind === 'tool_call');
      const updates = events.filter((e) => e.kind === 'tool_call_update');
      expect(calls.length).toBeGreaterThanOrEqual(1); // PREVIOUSLY 0 — the defect lock
      expect(updates.length).toBeGreaterThanOrEqual(1);
      expect((calls[0]!.detail as { name?: string }).name).toBe('probe');
    } finally {
      await rig.app.close();
      rig.storage.close();
    }
  });

  it('two same-name invocations in one turn stay DISTINCT durable calls (per-invocation identity)', async () => {
    const provider = new AnsweringProvider([
      { toolCalls: [
        { id: 'call_one', type: 'function', function: { name: 'probe', arguments: '{"q":"one"}' } },
        { id: 'call_two', type: 'function', function: { name: 'probe', arguments: '{"q":"two"}' } },
      ] },
      { content: 'ran it twice' },
    ]);
    const rig = await boot(provider);
    try {
      const created = await (await fetch(`${rig.url}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { session: { id: string } };
      const res = await fetch(`${rig.url}/api/agent/sessions/${created.session.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'run probe twice' }) });
      expect(res.status).toBe(200);
      const events = rig.sink.events(created.session.id);
      const calls = events.filter((e) => e.kind === 'tool_call');
      const updates = events.filter((e) => e.kind === 'tool_call_update');
      expect(calls).toHaveLength(2); // PREVIOUSLY 1 — name-derived identity collapsed invocations
      expect(new Set(calls.map((c) => (c.detail as { toolCallId?: string }).toolCallId)).size).toBe(2);
      expect(updates).toHaveLength(2);
      const args = calls.map((c) => (c.detail as { arg?: string }).arg);
      expect(args).toContain('{"q":"one"}');
      expect(args).toContain('{"q":"two"}');
    } finally {
      await rig.app.close();
      rig.storage.close();
    }
  });

  it('a failed tool handler records an isError update, never a silent success', async () => {
    const provider = new AnsweringProvider([
      { toolCalls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{"q":"boom"}' } }] },
      { content: 'handled the failure' },
    ]);
    const rig = await boot(provider, async () => { throw new Error('tool exploded'); });
    try {
      const created = await (await fetch(`${rig.url}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { session: { id: string } };
      const res = await fetch(`${rig.url}/api/agent/sessions/${created.session.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'run probe' }) });
      expect(res.status).toBe(200);
      const events = rig.sink.events(created.session.id);
      const updates = events.filter((e) => e.kind === 'tool_call_update');
      expect(updates.length).toBeGreaterThanOrEqual(1);
      expect((updates[0]!.detail as { isError?: boolean }).isError).toBe(true); // honest failure, recorded
    } finally {
      await rig.app.close();
      rig.storage.close();
    }
  });
});
