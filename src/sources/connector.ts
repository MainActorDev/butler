/** SourceConnector seam (plan Stage 3): fetch → normalize → content-addressed
 *  documents. Ingestion is not believing — documents are evidence with
 *  provenance (sha256 + source + fetched_at), never truth. Cache-first:
 *  unchanged content skips re-chunking. Caps per D12. */
import { createHash } from 'node:crypto';
import type { Storage, DocumentRow, ChunkRow } from '../memory/contract.ts';
import { structuralChunks, type StructuralChunk } from '../chunk.ts';

export interface NormalizedDocument {
  uri: string;
  title: string;
  /** text content (markdown/body) — null for binaries */
  content: string | null;
  kind: string;
  /** binary bytes when content is null → stored at bytes_path */
  bytes?: Uint8Array;
  /** PRE-CHUNKED content (Stage-3 F1 passthrough): when present, ingest
   *  stores these chunks verbatim instead of re-chunking `content`. Lets a
   *  connector emit structured chunks (e.g. per-symbol heading_path) while
   *  `content` stays a browsable summary. Ordinals as given, 0-based. */
  chunks?: StructuralChunk[];
}

export interface SourceConnector {
  readonly kind: 'jira' | 'github' | 'repo' | 'file';
  readonly sourceId: string;
  /** fetch documents for the source's current scope; cheap when cached */
  fetch(signal?: AbortSignal | undefined): Promise<NormalizedDocument[]>;
  /** per-source chunk budget for ingest() (default MAX_CHUNKS_PER_SOURCE).
   *  Docs past it are recorded in `skipped`, not ingested. */
  readonly maxChunks?: number;
}

export const MAX_TEXT_BYTES = 2 * 1024 * 1024; // D12: 2 MB text/doc
export const MAX_CHUNKS_PER_SOURCE = 10_000;   // D12

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** rough token estimate (~4 chars/token — fine for budgets, not billing) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface IngestResult {
  documents: Array<{ sha256: string; uri: string; title: string; chunks: number; cached: boolean }>;
  skipped: Array<{ uri: string; reason: string }>;
}

/** Ingest one connector's fetch into storage: content-address, cap, chunk.
 *  Binary artifacts land under artifactsDir; text rows carry the content. */
export async function ingest(
  connector: SourceConnector,
  storage: Storage,
  opts: { artifactsDir: string; writeBinary?: (sha: string, bytes: Uint8Array) => Promise<string>; signal?: AbortSignal | undefined },
): Promise<IngestResult> {
  const out: IngestResult = { documents: [], skipped: [] };
  const docs = await connector.fetch(opts.signal);
  // the source row must exist before documents reference it (FK) — upsert it
  await storage.upsertSource({ id: connector.sourceId, kind: connector.kind, config_json: '{}', status: 'active', last_synced_at: Date.now() });
  let totalChunks = 0;
  const maxChunks = connector.maxChunks ?? MAX_CHUNKS_PER_SOURCE;

  for (const doc of docs) {
    if (opts.signal?.aborted) break;
    const isText = doc.content !== null;
    const textBytes = isText ? Buffer.byteLength(doc.content!, 'utf8') : (doc.bytes?.length ?? 0);

    if (isText && textBytes > MAX_TEXT_BYTES) {
      // cap: truncate with marker (plan D12 — chunked then truncated)
      doc.content = `${doc.content!.slice(0, MAX_TEXT_BYTES)}\n\n[truncated at 2 MB cap]`;
    }
    if (!isText && textBytes > 20 * 1024 * 1024) {
      out.skipped.push({ uri: doc.uri, reason: `binary exceeds 20 MB (${textBytes} bytes)` });
      continue;
    }

    const sha = sha256Hex(isText ? doc.content! : doc.bytes ?? '');
    const existing = await storage.getDocument(sha);
    if (existing) {
      out.documents.push({ sha256: sha, uri: doc.uri, title: doc.title, chunks: (await storage.documentChunks(sha)).length, cached: true });
      continue;
    }

    let bytesPath: string | null = null;
    if (!isText && doc.bytes && opts.writeBinary) {
      bytesPath = await opts.writeBinary(sha, doc.bytes);
    }

    await storage.upsertDocument({
      sha256: sha, source_id: connector.sourceId, uri: doc.uri, title: doc.title,
      content: isText ? doc.content : null, kind: doc.kind, fetched_at: Date.now(), bytes_path: bytesPath,
    });

    let chunks: Array<Omit<ChunkRow, 'id' | 'doc_sha256'>> = [];
    if (isText) {
      chunks = (doc.chunks ?? structuralChunks(doc.content!, doc.kind)).map((c) => ({ ordinal: c.ordinal, heading_path: c.headingPath, content: c.content, tokens: c.tokens }));
      if (totalChunks + chunks.length > maxChunks) {
        chunks = chunks.slice(0, Math.max(0, maxChunks - totalChunks));
        if (chunks.length === 0) { out.skipped.push({ uri: doc.uri, reason: 'chunk cap reached for source' }); continue; }
      }
      totalChunks += chunks.length;
      await storage.insertChunks(sha, chunks);
    }
    out.documents.push({ sha256: sha, uri: doc.uri, title: doc.title, chunks: chunks.length, cached: false });
  }
  return out;
}
