import { describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import type { Storage } from '../src/memory/contract.ts';

/** Storage contract suite — PARAMETERIZED over drivers (plan Stage F,
 *  condition 6). The sqlite leg always runs; the postgres leg runs when
 *  BUTLER_TEST_PG holds a connection string, otherwise skips honestly. */

function contractSuite(name: string, make: () => Promise<Storage>, skip?: boolean): void {
  (skip ? describe.skip : describe)(`storage contract — ${name}`, () => {
    it('sessions: create → get → update → list; orchestration seam queryable', async () => {
      const s = await make();
      const row = await s.createSession({ id: 'c1', title: 't' });
      expect(row.status).toBe('active');
      await s.createSession({ id: 'c1-child', parent_session_id: 'c1', depth: 1 });
      const kids = await s.childSessions('c1');
      expect(kids.map((k) => k.id)).toEqual(['c1-child']);
      await s.updateSession('c1', { status: 'ended', tokens_in: 5, tokens_out: 3 });
      const got = await s.getSession('c1');
      expect(got!.status).toBe('ended');
      expect(got!.tokens_out).toBe(3);
      expect((await s.listSessions(10)).length).toBeGreaterThanOrEqual(1);
    });

    it('messages: append preserves order; roles/tokens round-trip', async () => {
      const s = await make();
      await s.createSession({ id: 'm1' });
      for (const content of ['first', 'second', 'third']) {
        await s.appendMessage({ session_id: 'm1', role: 'user', content, tool_calls_json: null, tool_results_json: null, tokens_in: 0, tokens_out: 0 });
      }
      const msgs = await s.sessionMessages('m1');
      expect(msgs.map((m) => m.content)).toEqual(['first', 'second', 'third']);
      await s.appendMessage({ session_id: 'm1', role: 'assistant', content: null, tool_calls_json: '[{"id":"c"}]', tool_results_json: null, tokens_in: 7, tokens_out: 2 });
      const all = await s.sessionMessages('m1');
      expect(all[3]!.tool_calls_json).toContain('"c"');
      expect(all[3]!.tokens_in).toBe(7);
    });

    it('notes: provenance mandatory; supersession audits; activeNotes filters', async () => {
      const s = await make();
      await expect(s.insertNote({ scope_key: 'a', kind: 'pitfall', content: 'x', source_type: 's', source_ref: '', created_by: 't' })).rejects.toThrow(/provenance/);
      const n1 = await s.insertNote({ scope_key: 'scope/one', kind: 'convention', content: 'old', source_type: 's', source_ref: 'r1', created_by: 't' });
      const n2 = await s.insertNote({ scope_key: 'scope/two', kind: 'pitfall', content: 'new', source_type: 's', source_ref: 'r2', created_by: 't' });
      await s.supersedeNote(n1.id, n2.id, 123);
      const active = await s.activeNotes('scope/');
      expect(active.map((a) => a.id)).toEqual([n2.id]);
      const old = await s.getNote(n1.id);
      expect(old!.superseded_by).toBe(n2.id);
      await expect(s.supersedeNote(n1.id, n2.id, 456)).rejects.toThrow(/already superseded/);
      // P1 C2b: supersession with a REASON (contradiction state — refuted/refined/superseded)
      const n3 = await s.insertNote({ scope_key: 'app:x/y', kind: 'pitfall', content: 'v3', source_type: 'run', source_ref: 'run_3', created_by: 't' });
      await s.supersedeNote(n2.id, n3.id, 789, 'refuted');
      const refuted = await s.getNote(n2.id);
      expect(refuted!.superseded_reason).toBe('refuted');
      // unreasoned supersession stays valid (back-compat rows)
      const n4 = await s.insertNote({ scope_key: 'app:x/y', kind: 'pitfall', content: 'v4', source_type: 'run', source_ref: 'run_4', created_by: 't' });
      await s.supersedeNote(n3.id, n4.id, 790);
      expect((await s.getNote(n3.id))!.superseded_reason ?? null).toBe(null);

      // P1 C3: artifacts — versioned, append-only, per (kind,name) chain
      const a1 = await s.saveArtifact({ run_id: 'run_1', session_id: null, kind: 'knowledge', name: 'app:com.foo', body: '# v1 knowledge', provenance_json: '[]' });
      expect(a1.version).toBe(1);
      const a2 = await s.saveArtifact({ run_id: 'run_2', session_id: null, kind: 'knowledge', name: 'app:com.foo', body: '# v2 knowledge', provenance_json: '[]' });
      expect(a2.version).toBe(2);
      expect(a1.superseded_by).toBeNull(); expect(a2.superseded_by).toBeNull();
      const latest = await s.latestArtifact('knowledge', 'app:com.foo');
      expect(latest!.id).toBe(a2.id); expect(latest!.version).toBe(2);
      // old version still readable (append-only)
      expect((await s.getArtifact(a1.id))!.body).toBe('# v1 knowledge');
      // v1 row now points forward
      expect((await s.getArtifact(a1.id))!.superseded_by).toBe(a2.id);
      // listing filters
      expect((await s.listArtifacts({ kind: 'knowledge', runId: 'run_1' })).length).toBe(1);
      expect((await s.listArtifacts({ name: 'app:com.foo' })).length).toBe(2);
      expect((await s.listArtifacts({ kind: 'scope' })).length).toBe(0);
      // separate names version independently
      const b1 = await s.saveArtifact({ run_id: null, session_id: null, kind: 'scope', name: 'run_1/scope', body: 'scope', provenance_json: null });
      expect(b1.version).toBe(1);
    });

    it('sources + documents + chunks: round-trip; re-ingest replaces chunks', async () => {
      const s = await make();
      await s.upsertSource({ id: 'src1', kind: 'file', config_json: '{}', status: 'active', last_synced_at: null });
      const up = await s.upsertSource({ id: 'src1', kind: 'file', config_json: '{"x":1}', status: 'active', last_synced_at: 99 });
      expect(up.last_synced_at).toBe(99);
      await s.upsertDocument({ sha256: 'd1', source_id: 'src1', uri: 'u', title: 'T', content: 'hello', kind: 'markdown', fetched_at: 1, bytes_path: null });
      await s.insertChunks('d1', [{ ordinal: 0, heading_path: 'h', content: 'c0', tokens: 1 }, { ordinal: 1, heading_path: 'h', content: 'c1', tokens: 1 }]);
      expect((await s.documentChunks('d1')).length).toBe(2);
      await s.insertChunks('d1', [{ ordinal: 0, heading_path: 'h2', content: 'replaced', tokens: 1 }]);
      const chunks = await s.documentChunks('d1');
      expect(chunks.map((c) => c.content)).toEqual(['replaced']);
      expect((await s.listDocuments(10)).some((d) => d.sha256 === 'd1')).toBe(true);
      expect((await s.getDocument('d1'))!.title).toBe('T');
    });
  });
}

// sqlite leg — always
contractSuite('sqlite', async () => SqliteStorage.memory(), false);

// postgres leg — only with BUTLER_TEST_PG (plan F open item: default skip-honestly)
const PG = process.env['BUTLER_TEST_PG'];
if (PG) {
  contractSuite('postgres', async () => {
    const { PostgresStorage } = await import('../src/memory/postgres.ts');
    const suffix = Math.random().toString(36).slice(2, 8);
    const s = new PostgresStorage(PG);
    // fresh ids per run so legs are order-independent (no destructive cleanup in shared DBs)
    (s as unknown as { _idsuffix?: string })._idsuffix = suffix;
    return s;
  }, false);
} else {
  contractSuite('postgres (SKIPPED — set BUTLER_TEST_PG to run this leg)', async () => { throw new Error('unreachable'); }, true);
}
