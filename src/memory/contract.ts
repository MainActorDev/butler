/** Storage contract (plan Stage 2) — the persistence seam. The sqlite driver
 *  implements it; a future postgres driver can too. Consumers own the DB. */

export interface SessionRow {
  id: string;
  /** orchestration seam (D16) — unused in v1 machinery, tested */
  parent_session_id: string | null;
  depth: number;
  user_id: string | null;
  title: string | null;
  status: 'active' | 'ended' | 'error';
  created_at: number;
  updated_at: number;
  tokens_in: number;
  tokens_out: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls_json: string | null;
  tool_results_json: string | null;
  tokens_in: number;
  tokens_out: number;
  created_at: number;
}

export type NoteKind = 'pitfall' | 'convention' | 'env-gate' | 'selector-trust' | 'app-behavior';

export interface NoteRow {
  id: string;
  scope_key: string;
  kind: NoteKind;
  content: string;
  source_type: string;
  /** provenance — MANDATORY: run id / session id / uri the note came from */
  source_ref: string;
  created_by: string;
  created_at: number;
  superseded_by: string | null;
  superseded_at: number | null;
  /** P1 D6c: why the note was superseded — contradictions are FLAGGED, not silently dropped. Read-path only. */
  superseded_reason?: 'refuted' | 'refined' | 'superseded' | null;
}

export interface SourceRow {
  id: string;
  kind: 'jira' | 'github' | 'repo' | 'file';
  config_json: string;
  status: string;
  last_synced_at: number | null;
  created_at: number;
}

export interface DocumentRow {
  sha256: string;
  source_id: string;
  uri: string;
  title: string;
  /** text content (≤ 2 MB, D12); binaries live at bytes_path */
  content: string | null;
  kind: string;
  fetched_at: number;
  bytes_path: string | null;
}

export interface ChunkRow {
  id: string;
  doc_sha256: string;
  ordinal: number;
  heading_path: string;
  content: string;
  tokens: number;
}

/** P1 C3: durable pipeline outputs — versioned, append-only, provenance-carrying. */
export interface ArtifactRow {
  id: string;
  run_id: string | null;
  session_id: string | null;
  kind: string;              // 'knowledge' | 'scope' | 'breakdown' | 'a11y-report' | …
  name: string;              // stable per-entity page name, e.g. 'app:com.foo'
  version: number;           // 1-based, monotonic per (kind, name)
  body: string;              // markdown
  provenance_json: string | null; // refs/sources the body integrates
  superseded_by: string | null;   // append-only chain like notes
  created_at: number;
}

export interface NewSession {
  id: string;
  parent_session_id?: string | null;
  depth?: number;
  user_id?: string | null;
  title?: string | null;
}

export interface Storage {
  // sessions
  createSession(s: NewSession): Promise<SessionRow>;
  getSession(id: string): Promise<SessionRow | null>;
  /** orchestration seam: children of a session (D16) */
  childSessions(parentId: string): Promise<SessionRow[]>;
  updateSession(id: string, patch: Partial<Pick<SessionRow, 'status' | 'title' | 'tokens_in' | 'tokens_out' | 'updated_at'>>): Promise<void>;
  listSessions(limit: number): Promise<SessionRow[]>;

  // messages
  appendMessage(m: Omit<MessageRow, 'id' | 'created_at'>): Promise<MessageRow>;
  sessionMessages(sessionId: string): Promise<MessageRow[]>;

  // partial-turn stash (no-hassle resume, 2026-10-21 plan): a budget-exhausted
  // chat turn parks its transcript (tool results included, opaque JSON) here;
  // the NEXT message in the same session takes it — one-shot, consumed on
  // read — to seed the loop so the model continues instead of redoing hops.
  stashPartial(sessionId: string, turnId: string, json: string): Promise<void>;
  takePartial(sessionId: string): Promise<{ turnId: string; json: string } | null>;
  /** chat-reliability F1/F2 (optional capability, authority-driven hosts):
   *  non-destructive peek + exact compare-and-delete of the continuation
   *  stash. The authority peeks during preparation and consumes ONLY at the
   *  committed execution boundary, so a failed preparation never destroys a
   *  continuation. */
  peekPartial?(sessionId: string): Promise<{ turnId: string; json: string; created_at: number } | null>;
  consumePartialExact?(sessionId: string, turnId: string, json: string): Promise<boolean>;

  // notes (explicit-write only; supersession, never delete)
  insertNote(n: Omit<NoteRow, 'id' | 'created_at' | 'superseded_by' | 'superseded_at' | 'superseded_reason'>): Promise<NoteRow>;
  activeNotes(scopeKeyPrefix?: string): Promise<NoteRow[]>;
  /** R2-F3: retrieval-based memory — stored note embeddings (optional capability) */
  noteEmbeddings(model?: string): Promise<Array<{ noteId: string; model: string; dim: number; vector: Float32Array }>>;
  saveNoteEmbedding(noteId: string, model: string, dim: number, vector: Float32Array): Promise<void>;
  supersedeNote(id: string, byId: string, at: number, reason?: 'refuted' | 'refined' | 'superseded'): Promise<void>;
  getNote(id: string): Promise<NoteRow | null>;

  // artifacts (P1 C3 — versioned, append-only, per-entity knowledge pages)
  saveArtifact(a: Omit<ArtifactRow, 'id' | 'version' | 'superseded_by' | 'created_at'>): Promise<ArtifactRow>;
  getArtifact(id: string): Promise<ArtifactRow | null>;
  latestArtifact(kind: string, name: string): Promise<ArtifactRow | null>;
  listArtifacts(filter?: { kind?: string; runId?: string; name?: string }): Promise<ArtifactRow[]>;

  // sources + documents + chunks (Stage 3 fills the connectors; rows now)
  upsertSource(s: Omit<SourceRow, 'created_at'>): Promise<SourceRow>;
  getSource(id: string): Promise<SourceRow | null>;
  upsertDocument(d: DocumentRow): Promise<void>;
  getDocument(sha256: string): Promise<DocumentRow | null>;
  listDocuments(limit: number): Promise<DocumentRow[]>;
  insertChunks(docSha: string, chunks: Array<Omit<ChunkRow, 'id' | 'doc_sha256'>>): Promise<void>;
  documentChunks(docSha: string): Promise<ChunkRow[]>;

  close(): void;
}
