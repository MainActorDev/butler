/** chat-reliability F2 (text block lifecycle): a streamed turn's durable
 *  chunk rail must carry BLOCK identity — one block per assistant message
 *  (hop) — so replayed narration separates cleanly instead of gluing
 *  ("…check.develop…"). Byte-exactness: chunk splits inside a block
 *  concatenate with zero whitespace injection; the legacy scalar `delta`
 *  field stays on EVERY chunk. */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import type { Provider, ProviderMessage, ProviderResponse, ProviderTool } from '../src/provider/types.ts';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { EventSink } from '../src/orchestrate/event-sink.ts';
import { ToolRegistry } from '../src/tools.ts';
import { registerConversationApi } from '../src/transport/conversation.ts';

type Opts = Parameters<Provider['complete']>[2];
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function boot(provider: Provider): Promise<{ app: FastifyInstance; url: string; sink: EventSink; storage: SqliteStorage }> {
  const dir = mkdtempSync(join(tmpdir(), 'butler-blkdur-'));
  dirs.push(dir);
  const storage = new SqliteStorage(join(dir, 'agent.db'));
  const sink = new EventSink(storage['db'] as InstanceType<typeof Database>, { passive: true, enqueueRunTurn: false });
  const registry = new ToolRegistry().register({
    name: 'probe', description: 'p', permission: 'read', parameters: { type: 'object', properties: { q: { type: 'string' } } },
    execute: async (args) => `observed:${String(args['q'])}`,
  });
  const app = Fastify();
  await registerConversationApi(app, {
    storage, provider, registry, policy: { name: 'draft', allows: 'draft' },
    systemPrompt: 'sys', emit: () => undefined, sink,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, sink, storage };
}

/** streams `deltas` live via opts.onDelta, then completes with content
 *  (which may deliberately DIFFER from the stream — snapshot vs stream). */
class StreamingProvider implements Provider {
  readonly model = 'streaming';
  calls = 0;
  constructor(private readonly turns: Array<{ deltas?: string[]; content?: string; toolCalls?: ProviderMessage['tool_calls'] }>) {}
  async complete(_m: ProviderMessage[], _t: ProviderTool[], opts: Opts): Promise<ProviderResponse> {
    const turn = this.turns[Math.min(this.calls, this.turns.length - 1)]!;
    this.calls += 1;
    for (const d of turn.deltas ?? []) opts.onDelta?.(d);
    return {
      message: { role: 'assistant', content: turn.content ?? null, ...(turn.toolCalls ? { tool_calls: turn.toolCalls } : {}) },
      finishReason: turn.toolCalls ? 'tool_calls' : 'stop',
      usage: { promptTokens: 5, completionTokens: 2 },
    };
  }
}

type ChunkDetail = { delta: string; block?: { id: string; phase: 'start' | 'delta' | 'end'; native?: string; text?: string } };

async function runTurn(rig: { url: string }, content: string): Promise<string> {
  const created = await (await fetch(`${rig.url}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { session: { id: string } };
  const res = await fetch(`${rig.url}/api/agent/sessions/${created.session.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { turn: { ok: boolean } }).turn.ok).toBe(true);
  return created.session.id;
}

function chunkEvents(sink: EventSink, sessionId: string): Array<{ detail: ChunkDetail }> {
  return sink.events(sessionId).filter((e) => e.kind === 'chunk') as unknown as Array<{ detail: ChunkDetail }>;
}

describe('text block lifecycle durability (F2)', () => {
  it('a two-hop streamed turn: distinct block ids, byte-exact concatenation, scalar delta on every chunk', async () => {
    // hop 2's completed content DIFFERS from its stream — proves text.end
    // below prefers the streamed accumulation
    const provider = new StreamingProvider([
      { deltas: ['Let me ', 'check.'], content: 'Let me check.', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{"q":"x"}' } }] },
      { deltas: ['de', 'velop'], content: 'develop-final' },
    ]);
    const rig = await boot(provider);
    try {
      const sid = await runTurn(rig, 'run probe');
      const chunks = chunkEvents(rig.sink, sid);
      expect(chunks.length).toBeGreaterThan(0);
      // legacy contract: the scalar delta field is present on EVERY chunk
      for (const c of chunks) expect(typeof c.detail.delta).toBe('string');
      const deltaChunks = chunks.filter((c) => c.detail.block?.phase === 'delta');
      expect(deltaChunks).toHaveLength(4); // 2 deltas per hop
      for (const c of deltaChunks) expect(c.detail.delta.length).toBeGreaterThan(0); // real text rides the delta chunks
      // one block per hop → distinct ids
      const ids = [...new Set(deltaChunks.map((c) => c.detail.block!.id))];
      expect(ids).toHaveLength(2);
      // byte-exact per block: chunk splits concatenate with no injection
      const byBlock = new Map<string, string>();
      for (const c of deltaChunks) byBlock.set(c.detail.block!.id, (byBlock.get(c.detail.block!.id) ?? '') + c.detail.delta);
      expect([...byBlock.values()].sort()).toEqual(['Let me check.', 'develop'].sort());
      // de +velop = develop (the canonical split proof)
      // start boundaries: one per block, EMPTY scalar delta (no text duplication)
      const starts = chunks.filter((c) => c.detail.block?.phase === 'start');
      expect(starts).toHaveLength(2);
      for (const s of starts) expect(s.detail.delta).toBe('');
    } finally {
      await rig.app.close();
      rig.storage.close();
    }
  });

  it('text.end carries the full STREAMED text — not the completed snapshot', async () => {
    const provider = new StreamingProvider([
      { deltas: ['Let me ', 'check.'], content: 'Let me check.', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{"q":"x"}' } }] },
      { deltas: ['de', 'velop'], content: 'develop-final' }, // snapshot ≠ stream
    ]);
    const rig = await boot(provider);
    try {
      const sid = await runTurn(rig, 'run probe');
      const ends = chunkEvents(rig.sink, sid).filter((c) => c.detail.block?.phase === 'end');
      expect(ends).toHaveLength(2); // one end per block
      const endTexts = ends.map((c) => c.detail.block!.text);
      expect(endTexts).toContain('develop'); // streamed accumulation wins
      expect(endTexts).toContain('Let me check.');
      expect(endTexts).not.toContain('develop-final'); // content was NOT trusted
      // end chunks keep the scalar field (empty — the text rode delta chunks)
      for (const e of ends) expect(e.detail.delta).toBe('');
    } finally {
      await rig.app.close();
      rig.storage.close();
    }
  });

  it('turn.delta bus events carry the live blockId; absent without a block', async () => {
    const events: Array<{ type: string; hop: number; detail?: { delta?: string; blockId?: string } }> = [];
    const dir = mkdtempSync(join(tmpdir(), 'butler-blkdur-'));
    dirs.push(dir);
    const storage = new SqliteStorage(join(dir, 'agent.db'));
    const sink = new EventSink(storage['db'] as InstanceType<typeof Database>, { passive: true, enqueueRunTurn: false });
    const registry = new ToolRegistry().register({
      name: 'probe', description: 'p', permission: 'read', parameters: { type: 'object', properties: { q: { type: 'string' } } },
      execute: async (args) => `observed:${String(args['q'])}`,
    });
    const provider = new StreamingProvider([
      { deltas: ['a', 'b'], toolCalls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{"q":"x"}' } }] },
      { deltas: ['c'], content: 'abc' },
    ]);
    const app = Fastify();
    await registerConversationApi(app, {
      storage, provider, registry, policy: { name: 'draft', allows: 'draft' },
      systemPrompt: 'sys',
      emit: (e) => { events.push(e as unknown as { type: string; hop: number; detail?: { delta?: string; blockId?: string } }); },
      sink,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const created = await (await fetch(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { session: { id: string } };
      const res = await fetch(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/agent/sessions/${created.session.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'stream two hops' }) });
      expect(res.status).toBe(200);
      const deltas = events.filter((e) => e.type === 'turn.delta');
      expect(deltas.map((e) => e.detail?.delta)).toEqual(['a', 'b', 'c']);
      expect(deltas[0]!.detail?.blockId).toBe('blk_h1'); // hops are 1-indexed
      expect(deltas[1]!.detail?.blockId).toBe('blk_h1');
      expect(deltas[2]!.detail?.blockId).toBe('blk_h2'); // tool hop → NEW block id
    } finally {
      await app.close();
      storage.close();
    }
  });

  it('a non-streamed hop: text written beside tool calls lands as ONE block before the call; the final answer stays block-less', async () => {
    const provider = new StreamingProvider([
      { content: 'Looking at the probe first.', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{"q":"x"}' } }] }, // no deltas
      { content: 'done' }, // no deltas: rides the turn answer only
    ]);
    const rig = await boot(provider);
    try {
      const sid = await runTurn(rig, 'run probe');
      const chunks = chunkEvents(rig.sink, sid);
      expect(chunks.map((c) => c.detail.block?.phase)).toEqual(['start', 'delta', 'end']);
      expect(chunks.map((c) => c.detail.delta).join('')).toBe('Looking at the probe first.'); // scalar rail carries it once
      expect(chunks[2]!.detail.block!.text).toBe('Looking at the probe first.');
      expect(new Set(chunks.map((c) => c.detail.block!.id)).size).toBe(1);
      // order: the narration precedes the tool call it introduces
      const kinds = rig.sink.events(sid).map((e) => e.kind).filter((k) => k === 'chunk' || k === 'tool_call');
      expect(kinds).toEqual(['chunk', 'chunk', 'chunk', 'tool_call']);
    } finally {
      await rig.app.close();
      rig.storage.close();
    }
  });

  it('a streamed hop with tool calls is not duplicated by the snapshot', async () => {
    const provider = new StreamingProvider([
      { deltas: ['Let me ', 'check.'], content: 'Let me check.', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{"q":"x"}' } }] },
      { content: 'done' },
    ]);
    const rig = await boot(provider);
    try {
      const sid = await runTurn(rig, 'run probe');
      expect(chunkEvents(rig.sink, sid).map((c) => c.detail.delta).join('')).toBe('Let me check.');
    } finally {
      await rig.app.close();
      rig.storage.close();
    }
  });

  it('a hop with no deltas emits no block', async () => {
    const provider = new StreamingProvider([
      { toolCalls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{"q":"silent"}' } }] }, // no deltas
      { content: 'done' }, // no deltas
    ]);
    const rig = await boot(provider);
    try {
      const sid = await runTurn(rig, 'run probe quietly');
      const chunks = chunkEvents(rig.sink, sid);
      expect(chunks.filter((c) => c.detail.block !== undefined)).toHaveLength(0); // no phantom blocks
      expect(chunks).toHaveLength(0); // nothing streamed at all
    } finally {
      await rig.app.close();
      rig.storage.close();
    }
  });
});
