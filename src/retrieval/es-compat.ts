/** EsCompatRetriever — a Retriever backed by any Elasticsearch-compatible
 *  HTTP endpoint (xerj in practice; ES/OpenSearch work too). BM25-only by
 *  design (Stage-1 evidence: hybrid/semantic added nothing on the eval corpus
 *  and cost 10–30 s per fresh query). Documents must be indexed with stable
 *  ids — `<docSha256>#<ordinal>` for chunks, `note:<id>` for notes — so hits
 *  map back to RetrievedChunk with citation provenance intact.
 *  Failures THROW: degradation to another retriever is the runner's decision
 *  (see xerj-sidecar.ts), mirroring StorageRetriever's philosophy that a
 *  configured mode is never silently swapped (retrieval.ts:70-71). */
import type { Retriever, RetrievedChunk } from '../memory/retrieval.ts';

export interface EsCompatOpts {
  baseUrl: string;
  index: string;
  /** injectable for tests (butler pattern, embeddings/index.ts:99-105) */
  fetchImpl?: typeof fetch;
  /** content field name (default 'content') */
  field?: string;
}

interface EsHit { _id: string; _score?: number; _source?: Record<string, unknown> }

export class EsCompatRetriever implements Retriever {
  private readonly baseUrl: string;
  private readonly index: string;
  private readonly field: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: EsCompatOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.index = opts.index;
    this.field = opts.field ?? 'content';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async retrieve(query: string, topK: number): Promise<RetrievedChunk[]> {
    // documented xerj match form (docs/recipes/all-way-search.md §2); plain
    // ES `match` — no semantic_text mapping required for this path
    const res = await this.fetchImpl(`${this.baseUrl}/${this.index}/_search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: topK, query: { match: { [this.field]: query } } }),
    });
    if (!res.ok) {
      throw new Error(`es-compat search failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    const body = (await res.json()) as { hits?: { hits?: EsHit[] } };
    return (body.hits?.hits ?? []).map((h) => this.map(h));
  }

  private map(h: EsHit): RetrievedChunk {
    const src = h._source ?? {};
    if (h._id.startsWith('note:')) {
      return { kind: 'note', ref: h._id.slice(5), content: String(src[this.field] ?? ''), score: Number(h._score ?? 0) };
    }
    const ref = h._id.split('#')[0] ?? h._id;
    const ordinal = Number(h._id.split('#')[1] ?? src['ordinal'] ?? NaN);
    return {
      kind: 'chunk',
      ref,
      ordinal: Number.isFinite(ordinal) ? ordinal : undefined,
      headingPath: src['heading_path'] !== undefined ? String(src['heading_path']) : undefined,
      content: String(src[this.field] ?? ''),
      score: Number(h._score ?? 0),
    };
  }
}
