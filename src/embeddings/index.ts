/** Embedding seam (plan Stage E): provider-agnostic interface, OpenAI-compatible
 *  HTTP adapter, and a DETERMINISTIC hash-based mock for hermetic CI. Live
 *  endpoint is env-gated (z.ai global has no embeddings — see plan R5/F5). */

export interface EmbeddingProvider {
  readonly model: string;
  /** embed texts; returns one vector per input, consistent dimensionality */
  embed(texts: string[], signal?: AbortSignal | undefined): Promise<number[][]>;
  readonly dimensions: number;
}

/** Deterministic hash-embedding: same text → same vector, no network.
 *  Not semantically meaningful — it exists so hybrid retrieval CODE PATHS are
 *  fully testable in CI; quality claims need a real provider. */
export class HashEmbedding implements EmbeddingProvider {
  readonly model = 'hash-mock';
  constructor(readonly dimensions = 64) {}

  async embed(texts: string[], _signal?: AbortSignal | undefined): Promise<number[][]> {
    void _signal;
    return texts.map((t) => this.one(t));
  }

  private cache = new Map<string, number[]>();
  private one(text: string): number[] {
    const hit = this.cache.get(text);
    if (hit) return hit;
    const out = new Array<number>(this.dimensions).fill(0);
    // tokenize on word boundaries; each word hashes into buckets (sign from another bit)
    for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      let h = 2166136261;
      for (let i = 0; i < word.length; i++) { h ^= word.charCodeAt(i); h = Math.imul(h, 16777619); }
      const bucket = Math.abs(h) % this.dimensions;
      const sign = (h & 0x80000000) === 0 ? 1 : -1;
      out[bucket] = (out[bucket] ?? 0) + sign;
    }
    // L2 normalize
    const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
    const v = out.map((x) => x / norm);
    this.cache.set(text, v);
    return v;
  }
}

/** Token-overlap embedding (R2-F3): deterministic, no network — but unlike
 *  HashEmbedding it ranks by SHARED VOCABULARY, which is the honest local
 *  option for note retrieval (domain notes share exact terms: 'voucher',
 *  'identifier', 'home'). IDF-weighted tokens over a fixed vocab dim, so
 *  cosine ≈ supervised token overlap. Used as the default embedder when no
 *  embeddings endpoint is configured; a real provider replaces it via env.
 *  Quality ceiling: lexical, not semantic — synonyms don't match. */
export class TokenEmbedding implements EmbeddingProvider {
  readonly model = 'token-overlap-v1';
  readonly dimensions = 4096;
  private readonly idf = new Map<string, number>();
  private fitted = false;

  /** corpus fit: compute IDF over known notes (once per process) */
  fit(corpus: string[]): void {
    const df = new Map<string, number>();
    for (const doc of corpus) {
      for (const t of new Set(this.tokens(doc))) df.set(t, (df.get(t) ?? 0) + 1);
    }
    for (const [t, n] of df) this.idf.set(t, Math.log((corpus.length + 1) / (n + 0.5)));
    this.fitted = true;
  }

  private tokens(text: string): string[] {
    return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  }

  async embed(texts: string[], _signal?: AbortSignal | undefined): Promise<number[][]> {
    void _signal;
    return texts.map((t) => this.one(t));
  }

  private one(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    for (const tok of this.tokens(text)) {
      let h = 5381;
      for (let i = 0; i < tok.length; i++) h = (Math.imul(h, 33) + tok.charCodeAt(i)) | 0;
      const bucket = Math.abs(h) % this.dimensions;
      const weight = this.fitted ? (this.idf.get(tok) ?? 1.5) : 1;
      v[bucket] = (v[bucket] ?? 0) + weight;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

/** OpenAI-compatible /embeddings adapter (injectable fetch for tests). */
export class OpenAICompatEmbedding implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: { baseUrl: string; apiKey: string; model: string; dimensions: number }, opts?: { fetchImpl?: typeof fetch }) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.dimensions = cfg.dimensions;
    this.fetchImpl = opts?.fetchImpl ?? fetch;
  }

  async embed(texts: string[], signal?: AbortSignal | undefined): Promise<number[][]> {
    const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`embeddings failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const out = body.data?.map((d) => d.embedding ?? []) ?? [];
    if (out.length !== texts.length) throw new Error(`embeddings: expected ${texts.length} vectors, got ${out.length}`);
    return out;
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
