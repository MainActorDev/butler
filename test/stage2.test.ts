import { describe, expect, it } from 'vitest';
import { ToolRegistry, PolicyRefusal, READ_ONLY, DRAFT, ACT, type ToolDef } from '../src/tools.ts';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { StorageRetriever, bm25Rank } from '../src/memory/retrieval.ts';

const tool = (name: string, permission: ToolDef['permission']): ToolDef => ({
  name, description: `${name} tool`, parameters: { type: 'object', properties: {} }, permission,
  execute: async () => `${name} ran`,
});

const CTX = { signal: undefined, sessionId: 's1' };

describe('tool registry + policy (condition 5)', () => {
  it('register → execute under an allowing policy', async () => {
    const r = new ToolRegistry().register(tool('docs.read', 'read'));
    expect(await r.execute('docs.read', {}, CTX, READ_ONLY)).toBe('docs.read ran');
  });

  it('draft policy refuses act-class tools with a NAMED typed error', async () => {
    const r = new ToolRegistry().register(tool('docs.read', 'read')).register(tool('spec.draft', 'draft')).register(tool('spec.publish', 'act'));
    const err = await r.execute('spec.publish', {}, CTX, DRAFT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyRefusal);
    const refusal = err as PolicyRefusal;
    expect(refusal.tool).toBe('spec.publish');
    expect(refusal.permission).toBe('act');
    expect(refusal.policy).toBe('draft');
    expect(refusal.message).toContain('requires act permission');
  });

  it('read-only refuses draft+act; act allows everything', async () => {
    const r = new ToolRegistry().register(tool('spec.draft', 'draft')).register(tool('spec.publish', 'act'));
    await expect(r.execute('spec.draft', {}, CTX, READ_ONLY)).rejects.toBeInstanceOf(PolicyRefusal);
    await expect(r.execute('spec.publish', {}, CTX, READ_ONLY)).rejects.toBeInstanceOf(PolicyRefusal);
    expect(await r.execute('spec.publish', {}, CTX, ACT)).toBe('spec.publish ran');
  });

  it('unknown tool → typed error naming available tools', async () => {
    const r = new ToolRegistry().register(tool('docs.read', 'read'));
    const err = await r.execute('nope', {}, CTX, ACT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyRefusal);
    expect((err as PolicyRefusal).message).toContain('docs.read');
  });

  it('duplicate + malformed names rejected at registration', () => {
    const r = new ToolRegistry().register(tool('a.b-c', 'read'));
    expect(() => r.register(tool('a.b-c', 'read'))).toThrow(/already registered/);
    expect(() => r.register(tool('BadName', 'read'))).toThrow(/\[a-z/);
  });

  it('providerTools filtered by policy; permission stamped in description', () => {
    const r = new ToolRegistry().register(tool('docs.read', 'read')).register(tool('spec.publish', 'act'));
    const forDraft = r.providerTools(DRAFT).map((t) => t.function.name);
    expect(forDraft).toEqual(['docs.read']);
    const forAct = r.providerTools(ACT).map((t) => t.function.name);
    expect(forAct).toContain('spec.publish');
  });
});

describe('sqlite storage (condition 4 + D16 seam)', () => {
  it('migrations are idempotent; sessions/messages round-trip', async () => {
    const s = SqliteStorage.memory();
    // re-run migrations by constructing again on same file — :memory: can't; the guarded DDL IS the idempotency proof via a second open of a file DB
    const created = await s.createSession({ id: 'sess_1', title: 'first' });
    expect(created.status).toBe('active');
    await s.appendMessage({ session_id: 'sess_1', role: 'user', content: 'hello', tool_calls_json: null, tool_results_json: null, tokens_in: 0, tokens_out: 0 });
    await s.appendMessage({ session_id: 'sess_1', role: 'assistant', content: 'hi', tool_calls_json: '[{"id":"c"}]', tool_results_json: null, tokens_in: 5, tokens_out: 3 });
    const msgs = await s.sessionMessages('sess_1');
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]!.tokens_out).toBe(3);
    await s.updateSession('sess_1', { status: 'ended', tokens_in: 5, tokens_out: 3 });
    expect((await s.getSession('sess_1'))!.status).toBe('ended');
    s.close();
  });

  it('orchestration seam: parent/depth + childSessions queryable (D16 anti-forgetting)', async () => {
    const s = SqliteStorage.memory();
    await s.createSession({ id: 'parent_1' });
    await s.createSession({ id: 'child_1', parent_session_id: 'parent_1', depth: 1 });
    await s.createSession({ id: 'child_2', parent_session_id: 'parent_1', depth: 1 });
    await s.createSession({ id: 'grandchild', parent_session_id: 'child_1', depth: 2 });
    const kids = await s.childSessions('parent_1');
    expect(kids.map((k) => k.id).sort()).toEqual(['child_1', 'child_2']);
    expect(kids.every((k) => k.depth === 1)).toBe(true);
    expect((await s.getSession('grandchild'))!.depth).toBe(2);
    s.close();
  });

  it('notes: provenance MANDATORY — rejects without source_ref', async () => {
    const s = SqliteStorage.memory();
    await expect(s.insertNote({ scope_key: 'app:x', kind: 'pitfall', content: 'n', source_type: 'run', source_ref: '', created_by: 't' })).rejects.toThrow(/provenance/);
    await expect(s.insertNote({ scope_key: 'app:x', kind: 'pitfall', content: 'n', source_type: 'run', source_ref: '   ', created_by: 't' })).rejects.toThrow(/provenance/);
    s.close();
  });

  it('notes: supersession — old note hidden from active, never deleted; double-supersede refused', async () => {
    const s = SqliteStorage.memory();
    const n1 = await s.insertNote({ scope_key: 'app:x', kind: 'convention', content: 'old belief', source_type: 'session', source_ref: 'sess_1', created_by: 't' });
    const n2 = await s.insertNote({ scope_key: 'app:x', kind: 'convention', content: 'corrected belief', source_type: 'session', source_ref: 'sess_9', created_by: 't' });
    await s.supersedeNote(n1.id, n2.id, Date.now());
    const active = await s.activeNotes('app:x');
    expect(active.map((a) => a.id)).toEqual([n2.id]);
    // audit trail survives: the row still exists, stamped
    const old = await s.getNote(n1.id);
    expect(old!.superseded_by).toBe(n2.id);
    expect(old!.superseded_at).not.toBeNull();
    await expect(s.supersedeNote(n1.id, n2.id, Date.now())).rejects.toThrow(/already superseded/);
    s.close();
  });

  it('file DB survives reopen (guarded migrations idempotent) — resumable from rows alone', async () => {
    const path = `/tmp/butler-test-${Date.now()}.db`;
    const a = new SqliteStorage(path);
    await a.createSession({ id: 'sess_persist', title: 'reopen me' });
    await a.appendMessage({ session_id: 'sess_persist', role: 'user', content: 'across restarts', tool_calls_json: null, tool_results_json: null, tokens_in: 0, tokens_out: 0 });
    a.close();
    const b = new SqliteStorage(path); // migrations run again — must be a no-op
    const msgs = await b.sessionMessages('sess_persist');
    expect(msgs[0]!.content).toBe('across restarts');
    b.close();
  });

  it('documents + chunks round-trip; re-ingest replaces chunks atomically', async () => {
    const s = SqliteStorage.memory();
    await s.upsertSource({ id: 'src_1', kind: 'file', config_json: '{}', status: 'active', last_synced_at: null });
    await s.upsertDocument({ sha256: 'a'.repeat(64), source_id: 'src_1', uri: 'file:///t.md', title: 'T', content: 'hello world', kind: 'markdown', fetched_at: Date.now(), bytes_path: null });
    await s.insertChunks('a'.repeat(64), [
      { ordinal: 0, heading_path: '# intro', content: 'hello world intro', tokens: 4 },
      { ordinal: 1, heading_path: '# body', content: 'the body text', tokens: 3 },
    ]);
    let chunks = await s.documentChunks('a'.repeat(64));
    expect(chunks.length).toBe(2);
    await s.insertChunks('a'.repeat(64), [{ ordinal: 0, heading_path: '# v2', content: 'replaced', tokens: 1 }]);
    chunks = await s.documentChunks('a'.repeat(64));
    expect(chunks.map((c) => c.content)).toEqual(['replaced']);
    s.close();
  });
});

describe('retrieval — BM25 (Stage 2 scope: notes + registered chunks)', () => {
  it('bm25Rank ranks the relevant doc first', () => {
    const docs = [
      { key: 'd1', kind: 'chunk' as const, content: 'login screen requires settle wait after navigation' },
      { key: 'd2', kind: 'chunk' as const, content: 'network profiles freeze responses as presets' },
      { key: 'd3', kind: 'chunk' as const, content: 'the login button moved in v2 redesign' },
    ];
    const r = bm25Rank('login settle wait', docs);
    expect(r[0]!.ref).toBe('d1');
    expect(r[0]!.score).toBeGreaterThan(0);
  });

  it('empty/short queries return nothing; scores sorted desc', () => {
    expect(bm25Rank('', [{ key: 'x', kind: 'note', content: 'y' }])).toEqual([]);
    const docs = [
      { key: 'a', kind: 'note' as const, content: 'alpha alpha alpha unique' },
      { key: 'b', kind: 'note' as const, content: 'alpha' },
    ];
    const r = bm25Rank('alpha', docs);
    expect(r.length).toBe(2);
    expect(r[0]!.score).toBeGreaterThanOrEqual(r[1]!.score);
  });

  it('StorageRetriever ranks notes by scope + content', async () => {
    const s = SqliteStorage.memory();
    await s.insertNote({ scope_key: 'app:login', kind: 'pitfall', content: 'login needs settle-wait before tapping submit', source_type: 'session', source_ref: 'sess_1', created_by: 't' });
    await s.insertNote({ scope_key: 'app:net', kind: 'convention', content: 'always freeze via traffic log', source_type: 'session', source_ref: 'sess_2', created_by: 't' });
    const r = new StorageRetriever(s);
    const out = await r.retrieve('login settle submit', 1);
    expect(out[0]!.ref).toMatch(/^note_/);
    expect(out[0]!.content).toContain('settle-wait');
    s.close();
  });
});
