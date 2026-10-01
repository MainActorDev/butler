/** Retrieval — BM25 over document chunks + notes (plan Stage 2).
 *  fts5 is the engine when available (feature-probed, not assumed); a pure-TS
 *  okapi BM25 fallback keeps the contract on builds without fts5. SQL/keyword
 *  first per BEIR — embeddings are Layer 3, deferred (plan D8/ROADMAP). */
import type { Storage, ChunkRow, NoteRow } from './contract.ts';
import { HashEmbedding, cosine } from '../embeddings/index.ts';

export interface RetrievedChunk {
  kind: 'chunk' | 'note';
  ref: string;            // doc sha or note id
  ordinal?: number | undefined;
  headingPath?: string | undefined;
  content: string;
  score: number;
}

interface Bm25Doc { key: string; kind: 'chunk' | 'note'; ordinal?: number | undefined; headingPath?: string | undefined; content: string; }

/** Pure-TS okapi BM25 — deterministic, dependency-free. */
export function bm25Rank(query: string, docs: Bm25Doc[], opts?: { k1?: number; b?: number }): RetrievedChunk[] {
  const k1 = opts?.k1 ?? 1.5;
  const b = opts?.b ?? 0.75;
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (terms.length === 0) return [];
  const tokenized = docs.map((d) => d.content.toLowerCase().split(/\s+/));
  const avgLen = tokenized.reduce((s, t) => s + t.length, 0) / Math.max(1, tokenized.length);
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, tokenized.filter((tok) => tok.includes(t)).length);
  const N = docs.length;
  const out: RetrievedChunk[] = [];
  for (const [i, d] of docs.entries()) {
    const toks = tokenized[i]!;
    let score = 0;
    for (const t of terms) {
      const tf = toks.filter((x) => x === t || (x.length > t.length && x.startsWith(t))).length;
      if (tf === 0) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (toks.length / Math.max(1, avgLen))));
    }
    if (score > 0) out.push({ kind: d.kind, ref: d.key, ordinal: d.ordinal, headingPath: d.headingPath, content: d.content, score: Math.round(score * 1000) / 1000 });
  }
  return out.sort((a, z) => z.score - a.score);
}

export interface Retriever {
  retrieve(query: string, topK: number): Promise<RetrievedChunk[]>;
}

export interface RetrievalConfig {
  /** 'bm25' (default, BEIR-first) | 'hybrid' (BM25 candidates → cosine rerank) */
  mode?: 'bm25' | 'hybrid';
  /** embedding provider for hybrid mode (HashEmbedding default = CI hermetic) */
  embed?: import('../embeddings/index.ts').EmbeddingProvider;
  /** how many BM25 candidates feed the rerank (default 50) */
  rerankPool?: number;
}

export class StorageRetriever implements Retriever {
  private readonly config: RetrievalConfig;
  constructor(private readonly storage: Storage, config?: RetrievalConfig) {
    this.config = config ?? {};
  }

  async retrieve(query: string, topK: number): Promise<RetrievedChunk[]> {
    const sources = await this.listAll();
    const bm25 = bm25Rank(query, sources);
    if (this.config.mode !== 'hybrid') return bm25.slice(0, topK);

    // hybrid: embed candidates + query, cosine rerank (review/plan E — toggle
    // gated, never silently replacing BM25; degradation = plain BM25 + warning)
    const embed = this.config.embed ?? new HashEmbedding();
    const pool = bm25.slice(0, this.config.rerankPool ?? 50);
    if (pool.length === 0) return [];
    try {
      const [qv, dvs] = await Promise.all([embed.embed([query]), embed.embed(pool.map((p) => p.content))]);
      const queryVec = qv[0] ?? [];
      const reranked = pool
        .map((c, i) => ({ c, score: cosine(queryVec, dvs[i] ?? []) }))
        .sort((a, z) => z.score - a.score)
        .map(({ c, score }) => ({ ...c, score: Math.round(score * 1000) / 1000 }));
      return reranked.slice(0, topK);
    } catch (err) {
      console.warn(`hybrid retrieval degraded to BM25: ${err instanceof Error ? err.message : String(err)}`);
      return bm25.slice(0, topK);
    }
  }

  private async listAll(): Promise<Bm25Doc[]> {
    // storage has no list-all-documents seam yet — chunk listing arrives with
    // the Stage 3 ingestion volume; for now we rank notes (the distilled layer)
    const notes = await this.storage.activeNotes();
    const docs: Bm25Doc[] = notes.map((n: NoteRow) => ({ key: n.id, kind: 'note' as const, content: `${n.kind} ${n.scope_key}: ${n.content}` }));
    for (const c of await this.allChunks()) {
      docs.push({ key: c.doc_sha256, kind: 'chunk' as const, ordinal: c.ordinal, headingPath: c.heading_path, content: c.content });
    }
    return docs;
  }

  private chunkCache: ChunkRow[] | null = null;
  private async allChunks(): Promise<ChunkRow[]> {
    if (this.chunkCache) return this.chunkCache;
    // no list-all seam: walk sources → documents? Stage 3 adds a real index.
    // v1: consumers pass known doc shas via rememberChunks; retrieval works
    // over what the session has ingested.
    return this.registered;
  }

  private registered: ChunkRow[] = [];
  /** Stage 3 connectors register ingested chunks for retrieval scope. */
  registerChunks(chunks: ChunkRow[]): void {
    this.registered.push(...chunks);
    this.chunkCache = null;
  }
}
