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
