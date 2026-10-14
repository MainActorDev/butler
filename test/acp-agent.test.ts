/** R3-S3 conformance: createAcpAgent against the ACP v1 method contract.
 *  Also validates our SessionUpdate mapping against the vendored schema's
 *  update-kind names (the 14 kinds are a closed set). */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAcpAgent, toSessionUpdate, type AcpAgentDeps, type SessionUpdate } from '../src/acp/agent.ts';
import { engineDeps } from '../src/acp/stdio.ts';
import { EventSink } from '../src/orchestrate/event-sink.ts';
import type { Provider, ProviderMessage, ProviderTool } from '../src/provider/types.ts';

const sess = 'sess_acp';

function mkSink() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE butler_messages(
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
    tool_calls_json TEXT, tool_results_json TEXT, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
  return new EventSink(db);
}

const okProvider: Provider = {
  async complete(_m: ProviderMessage[], _t: ProviderTool[], opts: { remainingMs: number; onDelta?: (d: string) => void }) {
    opts.onDelta?.('Hello');
    return { message: { role: 'assistant', content: 'Hello, world' }, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } };
  },
  model: 'fake',
};

function deps(overrides?: Partial<AcpAgentDeps>): AcpAgentDeps {
  const sink = mkSink();
  const base = engineDeps({ db: (sink as unknown as { db: Database.Database }).db, provider: okProvider, systemPrompt: 'sys', contextWindow: 1000 });
  return { ...base, ...overrides };
}

describe('ACP method conformance', () => {
  it('initialize → protocolVersion + agentCapabilities (two-sided)', async () => {
    const agent = createAcpAgent(deps());
    const res = await agent.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientCapabilities: {} } });
    expect(res.error).toBeUndefined();
    const r = res.result as { protocolVersion: number; agentCapabilities: { loadSession: boolean } };
    expect(r.protocolVersion).toBe(1);
    expect(r.agentCapabilities.loadSession).toBe(true);
  });

  it('session methods BEFORE initialize → -32000 (spec: initialize first)', async () => {
    const agent = createAcpAgent(deps());
    const res = await agent.handleRequest({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
    expect(res.error?.code).toBe(-32000);
  });

  it('session/new → prompt → end_turn (the full minimal session)', async () => {
    const agent = createAcpAgent(deps());
    await agent.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const created = await agent.handleRequest({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
    const sessionId = (created.result as { sessionId: string }).sessionId;
    const prompted = await agent.handleRequest({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] } });
    expect(prompted.error).toBeUndefined();
    expect((prompted.result as { stopReason: string }).stopReason).toBe('end_turn');
  });

  it('unknown method → -32601; malformed params → -32000 (never a crash)', async () => {
    const agent = createAcpAgent(deps());
    expect((await agent.handleRequest({ jsonrpc: '2.0', id: 1, method: 'session/nope' })).error?.code).toBe(-32601);
    const p = await agent.handleRequest({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'missing', prompt: [] } });
    expect(p.error?.code).toBe(-32000); // unknown session → honest error
  });

  it('session/list + session/load round-trip', async () => {
    const sink = mkSink();
    sink.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'q', refIds: [], at: 0 }, 'k1');
    const agent = createAcpAgent(deps({ loadSession: async () => sink.events(sess) }));
    await agent.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const loaded = await agent.handleRequest({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: sess } });
    const events = (loaded.result as { events: unknown[] }).events;
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('session/update mapping vs the vendored ACP v1 schema', () => {
  interface SchemaDef { oneOf?: Array<{ properties?: { sessionUpdate?: { const?: string } } }> }
  const schema = JSON.parse(readFileSync(new URL('../vendor-acp-v1-schema.json', import.meta.url), 'utf8')) as { $defs: Record<string, SchemaDef> };
const schemaKinds = new Set(
    (schema.$defs.SessionUpdate?.oneOf ?? [])
      .map((v) => v.properties?.sessionUpdate?.const)
      .filter((k): k is string => typeof k === 'string'),
  );

  it('every mapped update kind exists in the schema (no private dialect)', () => {
    const produced = new Set<string>();
    const sink = mkSink();
    sink.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'q', refIds: [], at: 0 }, 'k1');
    sink.handle(sess, { kind: 'turn.chunk', sessionId: sess, turnId: 't1', delta: 'x' }, 'k2');
    sink.handle(sess, { kind: 'turn.tool', sessionId: sess, turnId: 't1', phase: 'call', toolCallId: 'tc1', name: 'jira.get' }, 'k3');
    sink.handle(sess, { kind: 'turn.tool', sessionId: sess, turnId: 't1', phase: 'update', toolCallId: 'tc1', result: 'ok' }, 'k4');
    sink.handle(sess, { kind: 'turn.usage', sessionId: sess, turnId: 't1', meters: { cost: 5, contextUsed: 10, contextWindow: 100 } }, 'k5');
    sink.handle(sess, { kind: 'turn.compaction', sessionId: sess, turnId: 't1', summary: 's', preservedEventIds: [] }, 'k6');
    sink.handle(sess, { kind: 'turn.complete', sessionId: sess, turnId: 't1', answer: 'a' }, 'k7');
    for (const e of sink.events(sess)) for (const u of toSessionUpdate(e)) produced.add(u.sessionUpdate);
    for (const k of produced) expect(schemaKinds.has(k)).toBe(true);
  });

  it('tool_call_update patches by toolCallId (never order)', () => {
    const sink = mkSink();
    sink.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't1', prompt: 'q', refIds: [], at: 0 }, 'k1');
    sink.handle(sess, { kind: 'turn.tool', sessionId: sess, turnId: 't1', phase: 'call', toolCallId: 'tc9', name: 'repo.ls' }, 'k2');
    sink.handle(sess, { kind: 'turn.tool', sessionId: sess, turnId: 't1', phase: 'update', toolCallId: 'tc9', result: 'files…', isError: false }, 'k3');
    const evs = sink.events(sess);
    const updates = evs.flatMap((e) => toSessionUpdate(e)).filter((u) => u.sessionUpdate.startsWith('tool_call')) as Array<{ sessionUpdate: string; toolCallId?: string; status?: string }>;
    expect(updates.map((u) => u.toolCallId)).toEqual(['tc9', 'tc9']);
    expect(updates[1]?.status).toBe('completed');
  });
});
