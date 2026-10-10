/** Postgres storage driver (plan Stage F, condition 6): the SAME Storage
 *  contract over pg. Migrations mirror the sqlite DDL (idempotent CREATE IF
 *  NOT EXISTS). Parameterized contract tests run this leg when BUTLER_TEST_PG
 *  is set; otherwise skipped honestly (sqlite leg always runs). */

import { Pool, type PoolClient } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import type {
  ArtifactRow,
  ChunkRow, DocumentRow, MessageRow, NewSession, NoteRow, SessionRow, SourceRow, Storage,
} from './contract.ts';

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS butler_sessions(
  id TEXT PRIMARY KEY,
  parent_session_id TEXT REFERENCES butler_sessions(id),
  depth INTEGER NOT NULL DEFAULT 0,
  user_id TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended','error')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  tokens_in BIGINT NOT NULL DEFAULT 0,
  tokens_out BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS butler_sessions_parent ON butler_sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS butler_messages(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES butler_sessions(id),
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  content TEXT,
  tool_calls_json TEXT,
  tool_results_json TEXT,
  tokens_in BIGINT NOT NULL DEFAULT 0,
  tokens_out BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS butler_messages_session ON butler_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS butler_notes(
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('pitfall','convention','env-gate','selector-trust','app-behavior')),
  content TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  superseded_by TEXT,
  superseded_at BIGINT,
  superseded_reason TEXT
);
CREATE INDEX IF NOT EXISTS butler_notes_scope ON butler_notes(scope_key);
ALTER TABLE butler_notes ADD COLUMN IF NOT EXISTS superseded_reason TEXT;

CREATE TABLE IF NOT EXISTS butler_sources(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('jira','github','repo','file')),
  config_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_synced_at BIGINT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS butler_documents(
  sha256 TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES butler_sources(id),
  uri TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  kind TEXT NOT NULL,
  fetched_at BIGINT NOT NULL,
  bytes_path TEXT
);

CREATE TABLE IF NOT EXISTS butler_document_chunks(
  id TEXT PRIMARY KEY,
  doc_sha256 TEXT NOT NULL REFERENCES butler_documents(sha256) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  heading_path TEXT NOT NULL,
  content TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  UNIQUE(doc_sha256, ordinal)
);

CREATE TABLE IF NOT EXISTS butler_artifacts(
  id TEXT PRIMARY KEY,
  run_id TEXT,
  session_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  provenance_json TEXT,
  superseded_by TEXT,
  created_at BIGINT NOT NULL,
  UNIQUE(kind, name, version)
);
CREATE INDEX IF NOT EXISTS butler_artifacts_kind_name ON butler_artifacts(kind, name);
CREATE INDEX IF NOT EXISTS butler_artifacts_run ON butler_artifacts(run_id);
`;

export class PostgresStorage implements Storage {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  /** for tests: create a fresh schema-owned namespace? v1: shared DDL, guarded */
  async migrate(): Promise<void> {
    await this.pool.query(MIGRATIONS);
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  }

  async createSession(s: NewSession): Promise<SessionRow> {
    const now = Date.now();
    const row: SessionRow = {
      id: s.id, parent_session_id: s.parent_session_id ?? null, depth: s.depth ?? 0,
      user_id: s.user_id ?? null, title: s.title ?? null, status: 'active',
      created_at: now, updated_at: now, tokens_in: 0, tokens_out: 0,
    };
    await this.pool.query(
      'INSERT INTO butler_sessions(id, parent_session_id, depth, user_id, title, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [row.id, row.parent_session_id, row.depth, row.user_id, row.title, row.status, row.created_at, row.updated_at],
    );
    return row;
  }

  private rowToSession(r: Record<string, unknown>): SessionRow {
    return {
      id: String(r['id']), parent_session_id: r['parent_session_id'] === null ? null : String(r['parent_session_id']),
      depth: Number(r['depth']), user_id: r['user_id'] === null ? null : String(r['user_id']),
      title: r['title'] === null ? null : String(r['title']), status: String(r['status']) as SessionRow['status'],
      created_at: Number(r['created_at']), updated_at: Number(r['updated_at']),
      tokens_in: Number(r['tokens_in']), tokens_out: Number(r['tokens_out']),
    };
  }

  async getSession(id: string): Promise<SessionRow | null> {
    const r = await this.pool.query('SELECT * FROM butler_sessions WHERE id = $1', [id]);
    return r.rows[0] ? this.rowToSession(r.rows[0]) : null;
  }

  async childSessions(parentId: string): Promise<SessionRow[]> {
    const r = await this.pool.query('SELECT * FROM butler_sessions WHERE parent_session_id = $1 ORDER BY created_at', [parentId]);
    return r.rows.map((x) => this.rowToSession(x));
  }

  async updateSession(id: string, patch: Partial<Pick<SessionRow, 'status' | 'title' | 'tokens_in' | 'tokens_out' | 'updated_at'>>): Promise<void> {
    const cur = await this.getSession(id);
    if (!cur) throw new Error(`session ${id} not found`);
    await this.pool.query(
      'UPDATE butler_sessions SET status=$1, title=$2, tokens_in=$3, tokens_out=$4, updated_at=$5 WHERE id=$6',
      [patch.status ?? cur.status, patch.title ?? cur.title, patch.tokens_in ?? cur.tokens_in, patch.tokens_out ?? cur.tokens_out, patch.updated_at ?? Date.now(), id],
    );
  }

  async listSessions(limit: number): Promise<SessionRow[]> {
    const r = await this.pool.query('SELECT * FROM butler_sessions ORDER BY created_at DESC LIMIT $1', [limit]);
    return r.rows.map((x) => this.rowToSession(x));
  }

  async appendMessage(m: Omit<MessageRow, 'id' | 'created_at'>): Promise<MessageRow> {
    const id = `msg_${randomUUID().slice(0, 12)}`;
    const created = Date.now();
    // preserve INSERT order under same-ms: ordinal suffix in id is random; order by created_at may tie.
    // rows carry a monotonic sequence via created_at + id; retrieval orders by created_at, id (see sessionMessages)
    await this.pool.query(
      'INSERT INTO butler_messages(id, session_id, role, content, tool_calls_json, tool_results_json, tokens_in, tokens_out, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, m.session_id, m.role, m.content, m.tool_calls_json, m.tool_results_json, m.tokens_in, m.tokens_out, created],
    );
    return { ...m, id, created_at: created };
  }

  async sessionMessages(sessionId: string): Promise<MessageRow[]> {
    const r = await this.pool.query('SELECT * FROM butler_messages WHERE session_id = $1 ORDER BY created_at ASC, id ASC', [sessionId]);
    return r.rows.map((x) => ({
      id: String(x['id']), session_id: String(x['session_id']), role: String(x['role']) as MessageRow['role'],
      content: x['content'] === null ? null : String(x['content']),
      tool_calls_json: x['tool_calls_json'] === null ? null : String(x['tool_calls_json']),
      tool_results_json: x['tool_results_json'] === null ? null : String(x['tool_results_json']),
      tokens_in: Number(x['tokens_in']), tokens_out: Number(x['tokens_out']), created_at: Number(x['created_at']),
    }));
  }

  async insertNote(n: Omit<NoteRow, 'id' | 'created_at' | 'superseded_by' | 'superseded_at' | 'superseded_reason'>): Promise<NoteRow> {
    if (!n.source_ref || !n.source_ref.trim()) throw new Error('note provenance is mandatory: source_ref required (no ref, no note)');
    const id = `note_${randomUUID().slice(0, 12)}`;
    const created = Date.now();
    await this.pool.query(
      'INSERT INTO butler_notes(id, scope_key, kind, content, source_type, source_ref, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, n.scope_key, n.kind, n.content, n.source_type, n.source_ref, n.created_by, created],
    );
    return { ...n, id, created_at: created, superseded_by: null, superseded_at: null, superseded_reason: null };
  }

  private rowToNote(x: Record<string, unknown>): NoteRow {
    return {
      id: String(x['id']), scope_key: String(x['scope_key']), kind: String(x['kind']) as NoteRow['kind'],
      content: String(x['content']), source_type: String(x['source_type']), source_ref: String(x['source_ref']),
      created_by: String(x['created_by']), created_at: Number(x['created_at']),
      superseded_by: x['superseded_by'] === null ? null : String(x['superseded_by']),
      superseded_at: x['superseded_at'] === null ? null : Number(x['superseded_at']),
      ...(x['superseded_reason'] !== null && x['superseded_reason'] !== undefined ? { superseded_reason: String(x['superseded_reason']) } : {}),
    } as NoteRow;
  }

  async activeNotes(scopeKeyPrefix?: string): Promise<NoteRow[]> {
    const r = scopeKeyPrefix === undefined
      ? await this.pool.query('SELECT * FROM butler_notes WHERE superseded_by IS NULL ORDER BY created_at DESC')
      : await this.pool.query('SELECT * FROM butler_notes WHERE superseded_by IS NULL AND scope_key LIKE $1 ORDER BY created_at DESC', [`${scopeKeyPrefix}%`]);
    return r.rows.map((x) => this.rowToNote(x));
  }

  async supersedeNote(id: string, byId: string, at: number, reason?: 'refuted' | 'refined' | 'superseded'): Promise<void> {
    const r = await this.pool.query('UPDATE butler_notes SET superseded_by=$1, superseded_at=$2, superseded_reason=$3 WHERE id=$4 AND superseded_by IS NULL', [byId, at, reason ?? null, id]);
    if (r.rowCount === 0) throw new Error(`note ${id} not found or already superseded`);
  }

  async getNote(id: string): Promise<NoteRow | null> {
    const r = await this.pool.query('SELECT * FROM butler_notes WHERE id = $1', [id]);
    return r.rows[0] ? this.rowToNote(r.rows[0]) : null;
  }

  // ── artifacts (P1 C3) ──
  async saveArtifact(a: Omit<ArtifactRow, 'id' | 'version' | 'superseded_by' | 'created_at'>): Promise<ArtifactRow> {
    const prev = await this.pool.query('SELECT id, version FROM butler_artifacts WHERE kind=$1 AND name=$2 ORDER BY version DESC LIMIT 1', [a.kind, a.name]);
    const version = (prev.rows[0]?.['version'] ? Number(prev.rows[0]['version']) : 0) + 1;
    const id = `art_${createHash('sha256').update(`${a.kind}:${a.name}:${version}:${Date.now()}:${randomUUID()}`).digest('hex').slice(0, 12)}`;
    const created_at = Date.now();
    await this.pool.query('INSERT INTO butler_artifacts(id, run_id, session_id, kind, name, version, body, provenance_json, superseded_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9)',
      [id, a.run_id, a.session_id, a.kind, a.name, version, a.body, a.provenance_json, created_at]);
    if (prev.rows[0]) await this.pool.query('UPDATE butler_artifacts SET superseded_by=$1 WHERE id=$2', [id, prev.rows[0]['id']]);
    return { ...a, id, version, superseded_by: null, created_at };
  }

  async getArtifact(id: string): Promise<ArtifactRow | null> {
    const r = await this.pool.query('SELECT * FROM butler_artifacts WHERE id = $1', [id]);
    return r.rows[0] ? this.rowToArtifact(r.rows[0]) : null;
  }

  async latestArtifact(kind: string, name: string): Promise<ArtifactRow | null> {
    const r = await this.pool.query('SELECT * FROM butler_artifacts WHERE kind=$1 AND name=$2 AND superseded_by IS NULL ORDER BY version DESC LIMIT 1', [kind, name]);
    return r.rows[0] ? this.rowToArtifact(r.rows[0]) : null;
  }

  async listArtifacts(filter?: { kind?: string; runId?: string; name?: string }): Promise<ArtifactRow[]> {
    const conds: string[] = [];
    const args: unknown[] = [];
    if (filter?.kind) { conds.push(`kind=$${args.length + 1}`); args.push(filter.kind); }
    if (filter?.runId) { conds.push(`run_id=$${args.length + 1}`); args.push(filter.runId); }
    if (filter?.name) { conds.push(`name=$${args.length + 1}`); args.push(filter.name); }
    const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
    const r = await this.pool.query(`SELECT * FROM butler_artifacts${where} ORDER BY created_at DESC`, args);
    return r.rows.map((x) => this.rowToArtifact(x));
  }

  private rowToArtifact(x: Record<string, unknown>): ArtifactRow {
    return {
      id: String(x['id']),
      run_id: x['run_id'] === null || x['run_id'] === undefined ? null : String(x['run_id']),
      session_id: x['session_id'] === null || x['session_id'] === undefined ? null : String(x['session_id']),
      kind: String(x['kind']), name: String(x['name']), version: Number(x['version']),
      body: String(x['body']),
      provenance_json: x['provenance_json'] === null || x['provenance_json'] === undefined ? null : String(x['provenance_json']),
      superseded_by: x['superseded_by'] === null || x['superseded_by'] === undefined ? null : String(x['superseded_by']),
      created_at: Number(x['created_at']),
    };
  }

  async upsertSource(s: Omit<SourceRow, 'created_at'>): Promise<SourceRow> {
    const existing = await this.pool.query('SELECT created_at FROM butler_sources WHERE id = $1', [s.id]);
    if ((existing.rowCount ?? 0) > 0) {
      await this.pool.query('UPDATE butler_sources SET kind=$1, config_json=$2, status=$3, last_synced_at=$4 WHERE id=$5', [s.kind, s.config_json, s.status, s.last_synced_at, s.id]);
      return { ...s, created_at: Number(existing.rows[0]!['created_at']) };
    }
    const created = Date.now();
    await this.pool.query('INSERT INTO butler_sources(id, kind, config_json, status, last_synced_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [s.id, s.kind, s.config_json, s.status, s.last_synced_at, created]);
    return { ...s, created_at: created };
  }

  async getSource(id: string): Promise<SourceRow | null> {
    const r = await this.pool.query('SELECT * FROM butler_sources WHERE id = $1', [id]);
    if (!r.rows[0]) return null;
    const x = r.rows[0];
    return {
      id: String(x['id']), kind: String(x['kind']) as SourceRow['kind'], config_json: String(x['config_json']),
      status: String(x['status']), last_synced_at: x['last_synced_at'] === null ? null : Number(x['last_synced_at']), created_at: Number(x['created_at']),
    };
  }

  async upsertDocument(d: DocumentRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO butler_documents(sha256, source_id, uri, title, content, kind, fetched_at, bytes_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(sha256) DO UPDATE SET fetched_at=excluded.fetched_at, content=excluded.content, title=excluded.title, bytes_path=excluded.bytes_path`,
      [d.sha256, d.source_id, d.uri, d.title, d.content, d.kind, d.fetched_at, d.bytes_path],
    );
  }

  private rowToDoc(x: Record<string, unknown>): DocumentRow {
    return {
      sha256: String(x['sha256']), source_id: String(x['source_id']), uri: String(x['uri']), title: String(x['title']),
      content: x['content'] === null ? null : String(x['content']), kind: String(x['kind']),
      fetched_at: Number(x['fetched_at']), bytes_path: x['bytes_path'] === null ? null : String(x['bytes_path']),
    };
  }

  async getDocument(sha256: string): Promise<DocumentRow | null> {
    const r = await this.pool.query('SELECT * FROM butler_documents WHERE sha256 = $1', [sha256]);
    return r.rows[0] ? this.rowToDoc(r.rows[0]) : null;
  }

  async listDocuments(limit: number): Promise<DocumentRow[]> {
    const r = await this.pool.query('SELECT * FROM butler_documents ORDER BY fetched_at DESC LIMIT $1', [limit]);
    return r.rows.map((x) => this.rowToDoc(x));
  }

  async insertChunks(docSha: string, chunks: Array<Omit<ChunkRow, 'id' | 'doc_sha256'>>): Promise<void> {
    await this.tx(async (c) => {
      await c.query('DELETE FROM butler_document_chunks WHERE doc_sha256 = $1', [docSha]);
      for (const [i, ch] of chunks.entries()) {
        const id = `chk_${createHash('sha256').update(`${docSha}:${i}`).digest('hex').slice(0, 16)}`;
        await c.query('INSERT INTO butler_document_chunks(id, doc_sha256, ordinal, heading_path, content, tokens) VALUES ($1,$2,$3,$4,$5,$6)', [id, docSha, ch.ordinal, ch.heading_path, ch.content, ch.tokens]);
      }
    });
  }

  async documentChunks(docSha: string): Promise<ChunkRow[]> {
    const r = await this.pool.query('SELECT * FROM butler_document_chunks WHERE doc_sha256 = $1 ORDER BY ordinal', [docSha]);
    return r.rows.map((x) => ({
      id: String(x['id']), doc_sha256: String(x['doc_sha256']), ordinal: Number(x['ordinal']),
      heading_path: String(x['heading_path']), content: String(x['content']), tokens: Number(x['tokens']),
    }));
  }
}
