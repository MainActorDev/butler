/** sqlite driver (plan Stage 2) — better-sqlite3, guarded migrations
 *  (idempotent CREATE IF NOT EXISTS), WAL mode. The consumer owns the file. */
import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import type {
  ArtifactRow, ChunkRow, DocumentRow, MessageRow, NewSession, NoteRow, SessionRow, SourceRow, Storage,
} from './contract.ts';

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS butler_sessions(
  id TEXT PRIMARY KEY,
  parent_session_id TEXT REFERENCES butler_sessions(id),
  depth INTEGER NOT NULL DEFAULT 0,
  user_id TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended','error')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS butler_sessions_parent ON butler_sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS butler_messages(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES butler_sessions(id),
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  content TEXT,
  tool_calls_json TEXT,
  tool_results_json TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS butler_messages_session ON butler_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS butler_notes(
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('pitfall','convention','env-gate','selector-trust','app-behavior')),
  content TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,   -- provenance is MANDATORY (no ref, no note)
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  superseded_by TEXT,
  superseded_at INTEGER,
  superseded_reason TEXT
);
CREATE INDEX IF NOT EXISTS butler_notes_scope ON butler_notes(scope_key);

CREATE TABLE IF NOT EXISTS butler_note_embeddings(
  note_id TEXT PRIMARY KEY REFERENCES butler_notes(id),
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS butler_sources(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('jira','github','repo','file')),
  config_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS butler_documents(
  sha256 TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES butler_sources(id),
  uri TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,                -- text only; ≤ 2 MB (D12)
  kind TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  bytes_path TEXT              -- binaries: consumer artifacts dir
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
  created_at INTEGER NOT NULL,
  UNIQUE(kind, name, version)
);
CREATE INDEX IF NOT EXISTS butler_artifacts_kind_name ON butler_artifacts(kind, name);
CREATE INDEX IF NOT EXISTS butler_artifacts_run ON butler_artifacts(run_id);

CREATE TABLE IF NOT EXISTS butler_turn_partials(
  session_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export class SqliteStorage implements Storage {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  /** in-memory helper for tests */
  static memory(): SqliteStorage { return new SqliteStorage(':memory:'); }

  /** R3-S5: raw handle for the EventSink (durable engine shares the DB file;
   *  the sink owns ONLY its own tables — single-writer rule enforced by tests). */
  handle(): Database.Database { return this.db; }

  private migrate(): void {
    this.db.exec(MIGRATIONS);
    // P1 D6c guarded migration: pre-existing DBs created butler_notes without
    // superseded_reason; SQLite has no ADD COLUMN IF NOT EXISTS — a duplicate
    // column error means the column is already present, which is success.
    try { this.db.exec('ALTER TABLE butler_notes ADD COLUMN superseded_reason TEXT'); } catch { /* already there */ }
  }

  close(): void { this.db.close(); }

  async createSession(s: NewSession): Promise<SessionRow> {
    const now = Date.now();
    const row: SessionRow = {
      id: s.id, parent_session_id: s.parent_session_id ?? null, depth: s.depth ?? 0,
      user_id: s.user_id ?? null, title: s.title ?? null, status: 'active',
      created_at: now, updated_at: now, tokens_in: 0, tokens_out: 0,
    };
    this.db.prepare('INSERT INTO butler_sessions(id, parent_session_id, depth, user_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(row.id, row.parent_session_id, row.depth, row.user_id, row.title, row.status, row.created_at, row.updated_at);
    return row;
  }

  async getSession(id: string): Promise<SessionRow | null> {
    return (this.db.prepare('SELECT * FROM butler_sessions WHERE id = ?').get(id) as SessionRow | undefined) ?? null;
  }

  async childSessions(parentId: string): Promise<SessionRow[]> {
    return this.db.prepare('SELECT * FROM butler_sessions WHERE parent_session_id = ? ORDER BY created_at').all(parentId) as SessionRow[];
  }

  async updateSession(id: string, patch: Partial<Pick<SessionRow, 'status' | 'title' | 'tokens_in' | 'tokens_out' | 'updated_at'>>): Promise<void> {
    const cur = await this.getSession(id);
    if (!cur) throw new Error(`session ${id} not found`);
    this.db.prepare('UPDATE butler_sessions SET status = ?, title = ?, tokens_in = ?, tokens_out = ?, updated_at = ? WHERE id = ?')
      .run(patch.status ?? cur.status, patch.title ?? cur.title, patch.tokens_in ?? cur.tokens_in, patch.tokens_out ?? cur.tokens_out, patch.updated_at ?? Date.now(), id);
  }

  async listSessions(limit: number): Promise<SessionRow[]> {
    return this.db.prepare('SELECT * FROM butler_sessions ORDER BY created_at DESC LIMIT ?').all(limit) as SessionRow[];
  }

  async appendMessage(m: Omit<MessageRow, 'id' | 'created_at'>): Promise<MessageRow> {
    const id = `msg_${randomUUID().slice(0, 12)}`;
    const created = Date.now();
    this.db.prepare('INSERT INTO butler_messages(id, session_id, role, content, tool_calls_json, tool_results_json, tokens_in, tokens_out, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, m.session_id, m.role, m.content, m.tool_calls_json, m.tool_results_json, m.tokens_in, m.tokens_out, created);
    return { ...m, id, created_at: created };
  }

  async stashPartial(sessionId: string, turnId: string, json: string): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO butler_turn_partials(session_id, turn_id, json, created_at) VALUES (?,?,?,?)').run(sessionId, turnId, json, Date.now());
  }

  async takePartial(sessionId: string): Promise<{ turnId: string; json: string } | null> {
    const row = this.db.prepare('SELECT turn_id, json FROM butler_turn_partials WHERE session_id = ?').get(sessionId) as { turn_id: string; json: string } | undefined;
    if (!row) return null;
    this.db.prepare('DELETE FROM butler_turn_partials WHERE session_id = ?').run(sessionId);
    return { turnId: row.turn_id, json: row.json };
  }

  /** chat-reliability F1/F2: non-destructive peek — preparation validates without consuming. */
  async peekPartial(sessionId: string): Promise<{ turnId: string; json: string; created_at: number } | null> {
    const row = this.db.prepare('SELECT turn_id, json, created_at FROM butler_turn_partials WHERE session_id = ?').get(sessionId) as { turn_id: string; json: string; created_at: number } | undefined;
    return row ? { turnId: row.turn_id, json: row.json, created_at: row.created_at } : null;
  }

  /** chat-reliability F1/F2: exact CAS delete — consumes the stash only if it
   *  is still the exact (turnId, json) we snapshotted at the execution boundary. */
  async consumePartialExact(sessionId: string, turnId: string, json: string): Promise<boolean> {
    return this.db.prepare('DELETE FROM butler_turn_partials WHERE session_id = ? AND turn_id = ? AND json = ?').run(sessionId, turnId, json).changes > 0;
  }

  /** chat-reliability finalizeOwned: sync, in-transaction session accounting. */
  applyAccountingSync(sessionId: string, patch: { status?: 'active' | 'ended' | 'error'; tokensInDelta?: number; tokensOutDelta?: number }): void {
    const cur = this.db.prepare('SELECT status, tokens_in, tokens_out FROM butler_sessions WHERE id = ?').get(sessionId) as { status: string; tokens_in: number; tokens_out: number } | undefined;
    if (!cur) throw new Error(`session ${sessionId} not found`);
    this.db.prepare('UPDATE butler_sessions SET status = ?, tokens_in = ?, tokens_out = ?, updated_at = ? WHERE id = ?')
      .run(patch.status ?? cur.status, cur.tokens_in + (patch.tokensInDelta ?? 0), cur.tokens_out + (patch.tokensOutDelta ?? 0), Date.now(), sessionId);
  }

  /** chat-reliability finalizeOwned: sync, in-transaction budget-stash write. */
  stashPartialSync(sessionId: string, turnId: string, json: string): void {
    this.db.prepare('INSERT OR REPLACE INTO butler_turn_partials(session_id, turn_id, json, created_at) VALUES (?,?,?,?)').run(sessionId, turnId, json, Date.now());
  }

  async sessionMessages(sessionId: string): Promise<MessageRow[]> {
    return this.db.prepare('SELECT * FROM butler_messages WHERE session_id = ? ORDER BY rowid').all(sessionId) as MessageRow[];
  }

  async insertNote(n: Omit<NoteRow, 'id' | 'created_at' | 'superseded_by' | 'superseded_at' | 'superseded_reason'>): Promise<NoteRow> {
    if (!n.source_ref || !n.source_ref.trim()) throw new Error('note provenance is mandatory: source_ref required (no ref, no note)');
    const id = `note_${randomUUID().slice(0, 12)}`;
    const created = Date.now();
    this.db.prepare('INSERT INTO butler_notes(id, scope_key, kind, content, source_type, source_ref, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, n.scope_key, n.kind, n.content, n.source_type, n.source_ref, n.created_by, created);
    return { ...n, id, created_at: created, superseded_by: null, superseded_at: null, superseded_reason: null };
  }

  async activeNotes(scopeKeyPrefix?: string): Promise<NoteRow[]> {
    if (scopeKeyPrefix === undefined) {
      return this.db.prepare('SELECT * FROM butler_notes WHERE superseded_by IS NULL ORDER BY created_at DESC').all() as NoteRow[];
    }
    return this.db.prepare('SELECT * FROM butler_notes WHERE superseded_by IS NULL AND scope_key LIKE ? ORDER BY created_at DESC').all(`${scopeKeyPrefix}%`) as NoteRow[];
  }

  // ── note embeddings (R2-F3): retrieval-based memory ──
  async saveNoteEmbedding(noteId: string, model: string, dim: number, vector: Float32Array): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO butler_note_embeddings(note_id, model, dim, vector, created_at) VALUES (?,?,?,?,?)')
      .run(noteId, model, dim, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), Date.now());
  }
  async noteEmbeddings(model?: string): Promise<Array<{ noteId: string; model: string; dim: number; vector: Float32Array }>> {
    const rows = (model
      ? this.db.prepare('SELECT note_id, model, dim, vector FROM butler_note_embeddings WHERE model = ?').all(model)
      : this.db.prepare('SELECT note_id, model, dim, vector FROM butler_note_embeddings').all()) as Array<{ note_id: string; model: string; dim: number; vector: Buffer }>;
    return rows.map((r) => ({ noteId: r.note_id, model: r.model, dim: r.dim, vector: new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength / 4) }));
  }

  async supersedeNote(id: string, byId: string, at: number, reason?: 'refuted' | 'refined' | 'superseded'): Promise<void> {
    const r = this.db.prepare('UPDATE butler_notes SET superseded_by = ?, superseded_at = ?, superseded_reason = ? WHERE id = ? AND superseded_by IS NULL').run(byId, at, reason ?? null, id);
    if (r.changes === 0) throw new Error(`note ${id} not found or already superseded`);
  }

  async getNote(id: string): Promise<NoteRow | null> {
    return (this.db.prepare('SELECT * FROM butler_notes WHERE id = ?').get(id) as NoteRow | undefined) ?? null;
  }

  // ── artifacts (P1 C3): versioned per (kind,name); append-only chain ──
  async saveArtifact(a: Omit<ArtifactRow, 'id' | 'version' | 'superseded_by' | 'created_at'>): Promise<ArtifactRow> {
    const prev = this.db.prepare('SELECT id, version FROM butler_artifacts WHERE kind = ? AND name = ? ORDER BY version DESC LIMIT 1').get(a.kind, a.name) as { id: string; version: number } | undefined;
    const version = (prev?.version ?? 0) + 1;
    const id = `art_${createHash('sha256').update(`${a.kind}:${a.name}:${version}:${Date.now()}:${randomUUID()}`).digest('hex').slice(0, 12)}`;
    const created_at = Date.now();
    this.db.prepare('INSERT INTO butler_artifacts(id, run_id, session_id, kind, name, version, body, provenance_json, superseded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
      .run(id, a.run_id, a.session_id, a.kind, a.name, version, a.body, a.provenance_json, created_at);
    if (prev) this.db.prepare('UPDATE butler_artifacts SET superseded_by = ? WHERE id = ?').run(id, prev.id);
    return { ...a, id, version, superseded_by: null, created_at };
  }

  async getArtifact(id: string): Promise<ArtifactRow | null> {
    return (this.db.prepare('SELECT * FROM butler_artifacts WHERE id = ?').get(id) as ArtifactRow | undefined) ?? null;
  }

  async latestArtifact(kind: string, name: string): Promise<ArtifactRow | null> {
    return (this.db.prepare('SELECT * FROM butler_artifacts WHERE kind = ? AND name = ? AND superseded_by IS NULL ORDER BY version DESC LIMIT 1').get(kind, name) as ArtifactRow | undefined) ?? null;
  }

  async listArtifacts(filter?: { kind?: string; runId?: string; name?: string }): Promise<ArtifactRow[]> {
    const conds: string[] = [];
    const args: unknown[] = [];
    if (filter?.kind) { conds.push('kind = ?'); args.push(filter.kind); }
    if (filter?.runId) { conds.push('run_id = ?'); args.push(filter.runId); }
    if (filter?.name) { conds.push('name = ?'); args.push(filter.name); }
    const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM butler_artifacts${where} ORDER BY created_at DESC`).all(...args) as ArtifactRow[];
  }

  async upsertSource(s: Omit<SourceRow, 'created_at'>): Promise<SourceRow> {
    const existing = this.db.prepare('SELECT created_at FROM butler_sources WHERE id = ?').get(s.id) as { created_at: number } | undefined;
    if (existing) {
      this.db.prepare('UPDATE butler_sources SET kind = ?, config_json = ?, status = ?, last_synced_at = ? WHERE id = ?')
        .run(s.kind, s.config_json, s.status, s.last_synced_at, s.id);
      return { ...s, created_at: existing.created_at };
    }
    const created = Date.now();
    this.db.prepare('INSERT INTO butler_sources(id, kind, config_json, status, last_synced_at, created_at) VALUES (?,?,?,?,?,?)')
      .run(s.id, s.kind, s.config_json, s.status, s.last_synced_at, created);
    return { ...s, created_at: created };
  }

  async getSource(id: string): Promise<SourceRow | null> {
    return (this.db.prepare('SELECT * FROM butler_sources WHERE id = ?').get(id) as SourceRow | undefined) ?? null;
  }

  async upsertDocument(d: DocumentRow): Promise<void> {
    this.db.prepare(`INSERT INTO butler_documents(sha256, source_id, uri, title, content, kind, fetched_at, bytes_path)
                     VALUES (?,?,?,?,?,?,?,?)
                     ON CONFLICT(sha256) DO UPDATE SET fetched_at = excluded.fetched_at, content = excluded.content, title = excluded.title, bytes_path = excluded.bytes_path`)
      .run(d.sha256, d.source_id, d.uri, d.title, d.content, d.kind, d.fetched_at, d.bytes_path);
  }

  async getDocument(sha256: string): Promise<DocumentRow | null> {
    return (this.db.prepare('SELECT * FROM butler_documents WHERE sha256 = ?').get(sha256) as DocumentRow | undefined) ?? null;
  }

  async listDocuments(limit: number): Promise<DocumentRow[]> {
    return this.db.prepare('SELECT * FROM butler_documents ORDER BY fetched_at DESC LIMIT ?').all(limit) as DocumentRow[];
  }

  async insertChunks(docSha: string, chunks: Array<Omit<ChunkRow, 'id' | 'doc_sha256'>>): Promise<void> {
    const tx = this.db.transaction((list: Array<Omit<ChunkRow, 'id' | 'doc_sha256'>>) => {
      this.db.prepare('DELETE FROM butler_document_chunks WHERE doc_sha256 = ?').run(docSha);
      const ins = this.db.prepare('INSERT INTO butler_document_chunks(id, doc_sha256, ordinal, heading_path, content, tokens) VALUES (?,?,?,?,?,?)');
      for (const [i, c] of list.entries()) ins.run(`chk_${createHash('sha256').update(`${docSha}:${i}`).digest('hex').slice(0, 16)}`, docSha, c.ordinal, c.heading_path, c.content, c.tokens);
    });
    tx(chunks);
  }

  async documentChunks(docSha: string): Promise<ChunkRow[]> {
    return this.db.prepare('SELECT * FROM butler_document_chunks WHERE doc_sha256 = ? ORDER BY ordinal').all(docSha) as ChunkRow[];
  }
}
