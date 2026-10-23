import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import type { Provider, ProviderMessage, ProviderResponse, ProviderTool } from '../src/provider/types.ts';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { EventSink } from '../src/orchestrate/event-sink.ts';
import { ToolRegistry } from '../src/tools.ts';
import { registerConversationApi, type ConversationDeps } from '../src/transport/conversation.ts';
import { createSqliteExecutionAuthority, type ExecutionAuthority } from '../src/orchestrate/execution-authority.ts';
import type { TurnEvent } from '../src/orchestrate/turn-engine.ts';

/** Detached send (pentools parity, plan 20261022T171041Z B1/B5): instant
 *  202, server-owned queue with steer/queue, claim-all drain into ONE turn,
 *  steer at the tool boundary (and in later turns' memory), queue removal,
 *  the closing gate, boot drain, duplicate-submit guard, finalize retry. */

type Opts = Parameters<Provider['complete']>[2];
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
const answer = (content: string): ProviderResponse => ({ message: { role: 'assistant', content }, finishReason: 'stop', usage: { promptTokens: 3, completionTokens: 1 } });
const toolCall = (id: string): ProviderResponse => ({ message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'nop', arguments: '{}' } }] }, finishReason: 'tool_calls', usage: { promptTokens: 3, completionTokens: 1 } });

/** Scripted provider: `step(i, messages, opts)` answers call i; it records
 *  every call's messages so tests can read the prompt and history. */
class Script implements Provider {
  readonly model = 'script';
  readonly seen: ProviderMessage[][] = [];
  constructor(private readonly step: (i: number, m: ProviderMessage[], o: Opts) => Promise<ProviderResponse>) {}
  async complete(m: ProviderMessage[], _t: ProviderTool[], o: Opts): Promise<ProviderResponse> {
    const i = this.seen.length;
    this.seen.push(m.map((x) => ({ ...x })));
    return this.step(i, m, o);
  }
}

interface Rig { dir: string; storage: SqliteStorage; sink: EventSink; auth: ExecutionAuthority; app: Fastify.FastifyInstance; url: string; close(): Promise<void> }

async function boot(provider: Provider, extra: Partial<ConversationDeps> = {}, dir?: string): Promise<Rig> {
  const d = dir ?? mkdtempSync(join(tmpdir(), 'butler-detach-'));
  if (!dir) dirs.push(d);
  const agent = join(d, 'agent.db');
  const storage = new SqliteStorage(agent);
  const sink = new EventSink(storage.handle() as Database.Database, { passive: true, enqueueRunTurn: false });
  const auth = await createSqliteExecutionAuthority({ dbPath: agent, sink, storage });
  const app = Fastify();
  const registry = new ToolRegistry().register({
    name: 'nop', description: 'n', permission: 'read', parameters: { type: 'object', properties: {} },
    execute: async () => 'observation',
  });
  await registerConversationApi(app, {
    storage, provider, registry, policy: { name: 'draft', allows: 'draft' },
    systemPrompt: 'sys', emit: () => undefined, execution: auth, sink,
    ...extra,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return {
    dir: d, storage, sink, auth, app, url,
    close: async () => { auth.beginShutdown(); await app.close(); await auth.drain(); storage.close(); },
  };
}

const post = (url: string, sid: string, body: Record<string, unknown>) =>
  fetch(`${url}/api/agent/sessions/${sid}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const newSession = async (url: string): Promise<string> => {
  const r = await fetch(`${url}/api/agent/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return ((await r.json()) as { session: { id: string } }).session.id;
};
const kinds = (rig: Rig, sid: string, kind: TurnEvent['kind']) => rig.sink.events(sid).filter((e) => e.kind === kind);
async function until(pred: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const terminalCount = (rig: Rig, sid: string) => rig.sink.events(sid).filter((e) => e.kind === 'turn.completed' || e.kind === 'turn.failed' || e.kind === 'turn.aborted').length;

describe('detached send', () => {
  it('idle: 202 {startedTurnId} at once while the provider is still working', async () => {
    const gate = deferred();
    const rig = await boot(new Script(async () => { await gate.promise; return answer('done'); }));
    try {
      const sid = await newSession(rig.url);
      const t0 = Date.now();
      const res = await post(rig.url, sid, { content: 'hello', detach: true });
      expect(res.status).toBe(202);
      expect(Date.now() - t0).toBeLessThan(1000);
      const body = await res.json() as { startedTurnId: string };
      expect(body.startedTurnId).toMatch(/^t_/);
      expect(kinds(rig, sid, 'turn.completed')).toHaveLength(0);
      gate.resolve();
      await until(() => kinds(rig, sid, 'turn.completed').length === 1);
    } finally { gate.resolve(); await rig.close(); }
  });

  it('without an authority, detach is refused (never silently held)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-detach-noauth-'));
    dirs.push(dir);
    const storage = new SqliteStorage(join(dir, 'agent.db'));
    const app = Fastify();
    await registerConversationApi(app, {
      storage, provider: new Script(async () => answer('x')), registry: new ToolRegistry(), policy: { name: 'draft', allows: 'draft' },
      systemPrompt: 'sys', emit: () => undefined,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    try {
      const sid = await newSession(url);
      const res = await post(url, sid, { content: 'x', detach: true });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('DETACH_UNSUPPORTED');
    } finally { await app.close(); storage.close(); }
  });

  it('busy: 202 {queued} with an id; DELETE removes it once (then 404)', async () => {
    const gate = deferred();
    const rig = await boot(new Script(async (i) => { if (i === 0) await gate.promise; return answer('done'); }));
    try {
      const sid = await newSession(rig.url);
      await post(rig.url, sid, { content: 'first', detach: true });
      const q = await post(rig.url, sid, { content: 'second', detach: true, mode: 'queue' });
      expect(q.status).toBe(202);
      const { queued } = await q.json() as { queued: { queueId: string; disposition: string } };
      expect(queued.queueId).toMatch(/^q_/);
      expect(queued.disposition).toBe('followup');
      expect(kinds(rig, sid, 'message.queued')[0]!.detail).toMatchObject({ queueId: queued.queueId, content: 'second' });
      const del = await fetch(`${rig.url}/api/agent/sessions/${sid}/queue/${queued.queueId}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      expect(kinds(rig, sid, 'queue.removed').map((e) => e.detail)).toEqual([{ queueId: queued.queueId, reason: 'deleted' }]);
      expect((await fetch(`${rig.url}/api/agent/sessions/${sid}/queue/${queued.queueId}`, { method: 'DELETE' })).status).toBe(404);
      gate.resolve();
      await until(() => terminalCount(rig, sid) === 1);
      await new Promise((r) => setTimeout(r, 50));
      expect(kinds(rig, sid, 'turn.started')).toHaveLength(1); // the deleted item never ran
    } finally { gate.resolve(); await rig.close(); }
  });
});

describe('claim-all drain (D-11)', () => {
  it('3 queued + 1 leftover steer run as ONE next turn: 4 claimed removals, steers first, display + items on the user row', async () => {
    const gate = deferred();
    const provider = new Script(async (i) => { if (i === 0) await gate.promise; return answer(`a${i}`); });
    const rig = await boot(provider);
    try {
      const sid = await newSession(rig.url);
      await post(rig.url, sid, { content: 'first', detach: true });
      for (const c of ['q one', 'q two', 'q three']) expect((await post(rig.url, sid, { content: c, detach: true, mode: 'queue' })).status).toBe(202);
      expect((await post(rig.url, sid, { content: 'steer me', detach: true, mode: 'steer' })).status).toBe(202);
      gate.resolve(); // turn 1 has no tool boundary → the steer is left over
      await until(() => terminalCount(rig, sid) === 2);
      expect(kinds(rig, sid, 'turn.started')).toHaveLength(2);
      const removed = kinds(rig, sid, 'queue.removed');
      expect(removed).toHaveLength(4);
      expect(removed.every((e) => (e.detail as { reason: string }).reason === 'claimed')).toBe(true);
      const prompt = provider.seen[1]!.at(-1)!.content!;
      expect(prompt).toBe('[4 queued messages]\n\nsteer me\n\nq one\n\nq two\n\nq three');
      const users = kinds(rig, sid, 'user_message.recorded');
      const claimRow = users.at(-1)!.detail as { content: string; items: Array<{ content: string }> };
      expect(claimRow.content).toBe('steer me\n\nq one\n\nq two\n\nq three');
      expect(claimRow.content).not.toContain('queued messages');
      expect(claimRow.items.map((x) => x.content)).toEqual(['steer me', 'q one', 'q two', 'q three']);
      expect(rig.auth.pendingQueue(sid)).toEqual([]);
    } finally { gate.resolve(); await rig.close(); }
  });

  it('an idle send while items are pending joins them and runs as one claim-all turn', async () => {
    const rig = await boot(new Script(async (i) => answer(`a${i}`)));
    try {
      const sid = await newSession(rig.url);
      // pending item without a running turn (e.g. left by a shutdown)
      rig.auth.enqueue(sid, { content: 'left over', disposition: 'followup', principalId: 'anonymous' });
      const res = await post(rig.url, sid, { content: 'new one', detach: true });
      expect(res.status).toBe(202);
      const body = await res.json() as { startedTurnId: string; queued: { queueId: string } };
      expect(body.startedTurnId).toMatch(/^t_/);
      await until(() => terminalCount(rig, sid) === 1);
      const user = kinds(rig, sid, 'user_message.recorded').at(-1)!.detail as { content: string };
      expect(user.content).toBe('left over\n\nnew one');
    } finally { await rig.close(); }
  });

  it('the claim is atomic: a failed admission keeps every item pending and starts nothing', async () => {
    const rig = await boot(new Script(async () => answer('x')));
    try {
      const sid = await newSession(rig.url);
      rig.auth.enqueue(sid, { content: 'one', disposition: 'followup', principalId: 'anonymous' });
      rig.auth.enqueue(sid, { content: 'two', disposition: 'followup', principalId: 'anonymous' });
      const db = rig.storage.handle() as Database.Database;
      db.exec("CREATE TRIGGER boom BEFORE INSERT ON butler_executions BEGIN SELECT RAISE(ABORT, 'injected crash'); END");
      const res = rig.auth.tryReserve(sid);
      if (res.status !== 'reserved') throw new Error('expected a reservation');
      const adm = rig.auth.admit(res.attempt, { content: 'x', principalId: 'anonymous', claim: rig.auth.pendingQueue(sid).map((e) => e.queueId) });
      expect(adm.status).toBe('rejected');
      expect(rig.auth.pendingQueue(sid).map((e) => e.content)).toEqual(['one', 'two']);
      expect(kinds(rig, sid, 'queue.removed')).toHaveLength(0);
      expect(kinds(rig, sid, 'turn.started')).toHaveLength(0);
      db.exec('DROP TRIGGER boom');
    } finally { await rig.close(); }
  });

  it('a held turn ending also drains what a detached send queued (U3)', async () => {
    const gate = deferred();
    const rig = await boot(new Script(async (i) => { if (i === 0) await gate.promise; return answer(`a${i}`); }));
    try {
      const sid = await newSession(rig.url);
      const held = post(rig.url, sid, { content: 'held turn' });
      await until(() => kinds(rig, sid, 'turn.started').length === 1);
      expect((await post(rig.url, sid, { content: 'queued behind', detach: true, mode: 'queue' })).status).toBe(202);
      gate.resolve();
      expect((await held).status).toBe(200);
      await until(() => terminalCount(rig, sid) === 2);
      expect((kinds(rig, sid, 'user_message.recorded').at(-1)!.detail as { content: string }).content).toBe('queued behind');
    } finally { gate.resolve(); await rig.close(); }
  });
});

describe('steer at the tool boundary', () => {
  it('a steer joins between hops, writes its rows in one commit, and stays in later turns\' memory (T1)', async () => {
    const hop1 = deferred();
    const provider = new Script(async (i) => {
      if (i === 0) { await hop1.promise; return toolCall('call_1'); }
      if (i === 1) return answer('answer one');
      return answer('answer two');
    });
    const rig = await boot(provider);
    const batches: TurnEvent[][] = [];
    rig.sink.onAppend((_s, rows) => { batches.push(rows); });
    try {
      const sid = await newSession(rig.url);
      await post(rig.url, sid, { content: 'turn one', detach: true });
      await until(() => provider.seen.length === 1);
      expect((await post(rig.url, sid, { content: 'also mention pineapple', detach: true, mode: 'steer' })).status).toBe(202);
      hop1.resolve();
      await until(() => terminalCount(rig, sid) === 1);
      // hop 2 saw the steer AFTER the tool result
      const hop2 = provider.seen[1]!;
      const toolAt = hop2.findIndex((m) => m.role === 'tool');
      const steerAt = hop2.findIndex((m) => m.role === 'user' && m.content === 'also mention pineapple');
      expect(toolAt).toBeGreaterThan(-1);
      expect(steerAt).toBeGreaterThan(toolAt);
      // durable rows: removal(delivered) + snapshot + steer.delivered + via:steer
      // user row land in ONE commit — exactly one pushed batch holds them all
      const group = batches.find((rows) => rows.some((e) => e.kind === 'steer.delivered'))!;
      expect(group.map((e) => e.kind)).toEqual(['queue.removed', 'queue.updated', 'steer.delivered', 'user_message.recorded']);
      expect(group[3]!.detail).toEqual({ role: 'user', content: 'also mention pineapple', via: 'steer' });
      // turn 2's history holds the steer between turn 1's prompt and answer
      expect((await post(rig.url, sid, { content: 'turn two' })).status).toBe(200);
      const hist = provider.seen[2]!.map((m) => `${m.role}:${m.content}`);
      const p = hist.indexOf('user:turn one');
      const s = hist.indexOf('user:also mention pineapple');
      const a = hist.indexOf('assistant:answer one');
      expect(p).toBeGreaterThan(-1);
      expect(s).toBeGreaterThan(p);
      expect(a).toBeGreaterThan(s);
    } finally { hop1.resolve(); await rig.close(); }
  });
});

describe('duplicate-submit guard (T3 / U2 / V1)', () => {
  it('the same clientRequestId while busy → one queued item, same queueId; again after the drain claimed it → nothing new', async () => {
    const gate = deferred();
    const rig = await boot(new Script(async (i) => { if (i === 0) await gate.promise; return answer(`a${i}`); }));
    try {
      const sid = await newSession(rig.url);
      await post(rig.url, sid, { content: 'first', detach: true });
      const a = await (await post(rig.url, sid, { content: 'dup', detach: true, clientRequestId: 'r-1' })).json() as { queued: { queueId: string } };
      const b = await (await post(rig.url, sid, { content: 'dup', detach: true, clientRequestId: 'r-1' })).json() as { queued: { queueId: string } };
      expect(b.queued.queueId).toBe(a.queued.queueId);
      expect(kinds(rig, sid, 'message.queued')).toHaveLength(1);
      gate.resolve();
      await until(() => terminalCount(rig, sid) === 2);
      const late = await post(rig.url, sid, { content: 'dup', detach: true, clientRequestId: 'r-1' });
      expect(late.status).toBe(202);
      expect(((await late.json()) as { queued: { queueId: string } }).queued.queueId).toBe(a.queued.queueId);
      await new Promise((r) => setTimeout(r, 50));
      expect(kinds(rig, sid, 'turn.started')).toHaveLength(2);
    } finally { gate.resolve(); await rig.close(); }
  });

  it('a resend of a send that STARTED a turn returns that turn and never queues; different content → 409', async () => {
    const gate = deferred();
    const rig = await boot(new Script(async () => { await gate.promise; return answer('x'); }));
    try {
      const sid = await newSession(rig.url);
      const first = await (await post(rig.url, sid, { content: 'go', detach: true, clientRequestId: 'r-9' })).json() as { startedTurnId: string };
      const again = await post(rig.url, sid, { content: 'go', detach: true, clientRequestId: 'r-9' });
      expect(again.status).toBe(202);
      expect(((await again.json()) as { startedTurnId: string }).startedTurnId).toBe(first.startedTurnId);
      expect(kinds(rig, sid, 'message.queued')).toHaveLength(0);
      const reuse = await post(rig.url, sid, { content: 'other', detach: true, clientRequestId: 'r-9' });
      expect(reuse.status).toBe(409);
      expect(((await reuse.json()) as { code: string }).code).toBe('REQUEST_ID_REUSE');
    } finally { gate.resolve(); await rig.close(); }
  });
});

describe('shutdown, restart and the boot drain (F2 / F8 / T6)', () => {
  it('closing gate: a stopped turn with a queued item starts nothing; the next boot drains it once through the mount hooks', async () => {
    const gate = deferred();
    const first = await boot(new Script(async (_i, _m, o) => {
      await Promise.race([gate.promise, new Promise((r) => o.signal?.addEventListener('abort', r))]);
      return answer('x');
    }));
    const dir = first.dir;
    const sid = await newSession(first.url);
    await post(first.url, sid, { content: 'long turn', detach: true });
    expect((await post(first.url, sid, { content: 'waiting item', detach: true, mode: 'queue' })).status).toBe(202);
    // host shutdown order: closing gate FIRST, then abort the running turn
    first.auth.beginShutdown();
    first.auth.requestStop(sid);
    await until(() => terminalCount(first, sid) === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(kinds(first, sid, 'turn.started')).toHaveLength(1);
    expect(first.auth.pendingQueue(sid).map((e) => e.content)).toEqual(['waiting item']);
    await first.close();

    const hooks: string[] = [];
    const second = await boot(new Script(async () => answer('resumed')), {
      prepareTurn: (s) => { hooks.push(`prepare:${s}`); return null; },
      afterTurn: (s) => { hooks.push(`after:${s}`); },
    }, dir);
    try {
      await until(() => terminalCount(second, sid) === 2);
      expect(kinds(second, sid, 'turn.started')).toHaveLength(2);
      expect((kinds(second, sid, 'queue.removed').at(-1)!.detail as { reason: string }).reason).toBe('claimed');
      expect(hooks).toEqual([`prepare:${sid}`, `after:${sid}`]);
      expect(second.auth.pendingQueue(sid)).toEqual([]);
    } finally { gate.resolve(); await second.close(); }
  });

  it('legacy queue rows (no id) are never run by the boot drain', async () => {
    const first = await boot(new Script(async () => answer('x')));
    const sid = await newSession(first.url);
    first.sink.handle(sid, { kind: 'message.queue', sessionId: sid, content: 'Reply with exactly: OK', disposition: 'followup' }, 'legacy-1');
    const dir = first.dir;
    await first.close();
    const second = await boot(new Script(async () => answer('should not run')), {}, dir);
    try {
      await new Promise((r) => setTimeout(r, 150));
      expect(kinds(second, sid, 'turn.started')).toHaveLength(0);
      expect(second.auth.sessionsWithPending()).toEqual([]);
    } finally { await second.close(); }
  });

  it('legacy queue rows are never pulled into a claim-all turn by a new send', async () => {
    const rig = await boot(new Script(async (i) => answer(`a${i}`)));
    try {
      const sid = await newSession(rig.url);
      rig.sink.handle(sid, { kind: 'message.queue', sessionId: sid, content: 'Reply with exactly: OK', disposition: 'followup' }, 'legacy-2');
      const res = await post(rig.url, sid, { content: 'fresh', detach: true });
      expect(res.status).toBe(202);
      await until(() => terminalCount(rig, sid) === 1);
      await new Promise((r) => setTimeout(r, 50));
      expect(kinds(rig, sid, 'turn.started')).toHaveLength(1);
      expect((kinds(rig, sid, 'user_message.recorded').at(-1)!.detail as { content: string }).content).toBe('fresh');
      expect(kinds(rig, sid, 'queue.removed')).toHaveLength(0);
    } finally { await rig.close(); }
  });
});

describe('detached finalization retry (R2 / T4 / T5)', () => {
  it('finalize throws twice then succeeds → one terminal row, session free', async () => {
    const rig = await boot(new Script(async () => answer('done')), { finalizeRetryMs: [10, 10, 10] });
    try {
      const real = rig.auth.finalizeOwned.bind(rig.auth);
      let calls = 0;
      rig.auth.finalizeOwned = (async (...args: Parameters<ExecutionAuthority['finalizeOwned']>) => {
        calls += 1;
        if (calls <= 2) throw new Error('disk busy');
        return real(...args);
      }) as ExecutionAuthority['finalizeOwned'];
      const sid = await newSession(rig.url);
      await post(rig.url, sid, { content: 'go', detach: true });
      await until(() => terminalCount(rig, sid) === 1);
      expect(calls).toBe(3);
      expect(kinds(rig, sid, 'turn.completed')).toHaveLength(1);
      expect(kinds(rig, sid, 'session.notice')).toHaveLength(0);
      await until(() => rig.auth.readSession(sid).state === 'idle');
    } finally { await rig.close(); }
  });

  it('finalize always fails → a session.notice error row; the attempt stays reserved for recovery', async () => {
    const rig = await boot(new Script(async () => answer('done')), { finalizeRetryMs: [5, 5, 5] });
    try {
      rig.auth.finalizeOwned = (async () => { throw new Error('disk gone'); }) as ExecutionAuthority['finalizeOwned'];
      const sid = await newSession(rig.url);
      await post(rig.url, sid, { content: 'go', detach: true });
      await until(() => kinds(rig, sid, 'session.notice').length === 1);
      expect(kinds(rig, sid, 'session.notice')[0]!.detail).toMatchObject({ level: 'error' });
      expect(rig.auth.tryReserve(sid).status).toBe('busy');
    } finally { await rig.close(); }
  });

  it('shutdown during the retry backoff settles within the deadline', async () => {
    const rig = await boot(new Script(async () => answer('done')), { finalizeRetryMs: [30_000, 30_000, 30_000] });
    rig.auth.finalizeOwned = (async () => { throw new Error('disk gone'); }) as ExecutionAuthority['finalizeOwned'];
    const sid = await newSession(rig.url);
    let failedOnce = false;
    const real = rig.auth.finalizeOwned;
    rig.auth.finalizeOwned = (async (...a: Parameters<ExecutionAuthority['finalizeOwned']>) => { failedOnce = true; return real(...a); }) as ExecutionAuthority['finalizeOwned'];
    await post(rig.url, sid, { content: 'go', detach: true });
    await until(() => failedOnce);
    const t0 = Date.now();
    await rig.close(); // beginShutdown + drain awaits the tracked detached worker
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('tool ids (B5)', () => {
  it('results with no invocation id and no open call get distinct counter ids, never the bare tool name', async () => {
    const provider = new Script(async (_i, _m, o) => {
      const onTool = (o as { onTool?: (e: { phase: 'call' | 'result'; name: string; result?: string }) => void }).onTool;
      onTool?.({ phase: 'result', name: 'Read', result: 'one' });
      onTool?.({ phase: 'result', name: 'Read', result: 'two' });
      return answer('done');
    });
    const rig = await boot(provider);
    try {
      const sid = await newSession(rig.url);
      expect((await post(rig.url, sid, { content: 'go' })).status).toBe(200);
      const ids = kinds(rig, sid, 'tool_call_update').map((e) => (e.detail as { toolCallId: string }).toolCallId);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      expect(ids.every((x) => !x.endsWith('_Read'))).toBe(true);
    } finally { await rig.close(); }
  });
});
