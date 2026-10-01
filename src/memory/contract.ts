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

  // notes (explicit-write only; supersession, never delete)
  insertNote(n: Omit<NoteRow, 'id' | 'created_at' | 'superseded_by' | 'superseded_at'>): Promise<NoteRow>;
  activeNotes(scopeKeyPrefix?: string): Promise<NoteRow[]>;
  supersedeNote(id: string, byId: string, at: number): Promise<void>;
  getNote(id: string): Promise<NoteRow | null>;

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
