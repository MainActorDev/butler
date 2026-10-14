import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerConversationApi } from '../src/transport/conversation.ts';
import { EventSink } from '../src/orchestrate/event-sink.ts';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';

describe('v0.5.4 transport guard: empty answer after work', () => {
  it('a turn that streamed chunks and ends EMPTY → turn.failed, not turn.completed', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'guard-')), 't.db');
    const storage = new Database(dbPath);
    storage.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT, depth INTEGER, user_id TEXT, title TEXT, status TEXT, created_at INTEGER, updated_at INTEGER, tokens_in INTEGER, tokens_out INTEGER);
      INSERT INTO sessions VALUES('s1',NULL,0,'u','t','active',0,0,0,0);
      CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls_json TEXT, tool_results_json TEXT, tokens_in INTEGER, tokens_out INTEGER, created_at INTEGER);
      CREATE TABLE butler_messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, tool_calls_json TEXT, tool_results_json TEXT, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, created_at INTEGER NOT NULL);`);
    const sink = new EventSink(storage);
    const app = Fastify();
    const st = {
      getSession: async (id: string) => storage.prepare('SELECT * FROM sessions WHERE id=?').get(id),
      createSession: async () => ({}),
      sessionMessages: async (id: string) => storage.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY created_at').all(id) as never[],
      appendMessage: async () => {},
      updateSession: async () => {},
      activeNotes: async () => [],
      noteEmbeddings: async () => [],
    } as never;
    // provider: streams a delta via onDelta then returns EMPTY answer
    const provider = {
      complete: async (_m: unknown, _t: unknown, opts: { onDelta?: (d: string) => void }) => {
        opts.onDelta?.('Working: registry read done…');
        return { message: { role: 'assistant', content: '' }, finishReason: 'end_turn', usage: { promptTokens: 10, completionTokens: 5 } };
      },
    } as never;
    const registry = { list: () => [] } as never;
    await registerConversationApi(app, { storage: st, provider, registry, policy: { allows: 'read' }, systemPrompt: 's', sink, emit: () => {} } as never);
    const r = await app.inject({ method: 'POST', url: '/api/agent/sessions/s1/messages', payload: { content: 'do it' } });
    const body = r.json() as { turn?: { ok?: boolean; error?: string }; error?: string };
    expect(r.statusCode).toBe(200);
    expect((body.turn?.ok ?? false)).toBe(false);
    expect((body.turn?.error ?? body.error ?? '')).toContain('empty answer');
    const evs = sink.events('s1');
    expect(evs.at(-1)?.kind).toBe('turn.failed');
    expect(evs.some((e) => e.kind === 'chunk')).toBe(true);
  });
});
