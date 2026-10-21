/** xerjSidecar — optional one-call runner that brings up a local
 *  Elasticsearch-compatible sidecar (xerj) and returns a Retriever over it.
 *  GENERIC mechanism only: this module knows "an ES-compatible binary + a
 *  corpus enumerator", never a consumer's vocabulary (the genericity law).
 *
 *  Posture (Stage-2 plan, operator decisions D2/D4):
 *  - nothing spawns unless a consumer CALLS this function; import is inert
 *  - no binary bundling, no silent installs — a missing binary returns a
 *    degraded result carrying the exact install command to run
 *  - every failure is a degraded result, never a throw: boot must survive
 *
 *  corpus provider (S2-F2): butler has no list-all-documents seam
 *  (retrieval.ts:90-107), so the consumer supplies the enumerator. */
import { spawn, type ChildProcess } from 'node:child_process';
import { EsCompatRetriever } from './retrieval/es-compat.ts';
import type { RetrievedChunk } from './memory/retrieval.ts';

/** One indexable document. `_id` conventions power provenance mapping:
 *  `<docSha256>#<ordinal>` (chunks) / `note:<id>` (notes). */
export interface EsCorpusDoc { _id: string; content: string; ref: string; kind: 'chunk' | 'note'; ordinal?: number; heading_path?: string }

export interface XerjSidecarOpts {
  /** where the sidecar stores its index (consumer owns lifecycle of the dir) */
  dataDir: string;
  /**Enumerator over the corpus to index. Called on every reconcile. */
  corpus: () => AsyncIterable<EsCorpusDoc>;
  baseUrl?: string;
  index?: string;
  /** explicit binary path; default: resolve `xerj` on PATH */
  binaryPath?: string;
  /** skip spawn entirely (attach to an already-running node) */
  attachOnly?: boolean;
  /** health-wait budget ms (default 30_000) */
  startupTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** injectable spawn for tests */
  spawnImpl?: (binary: string, args: string[]) => { pid?: number; killed: boolean; kill(): void };
  log?: (line: string) => void;
}

export interface XerjSidecarResult {
  retriever: EsCompatRetriever | null;
  degraded: string | null;
  /** index-side count after reconcile (null when degraded) */
  indexedCount: number | null;
  stop(): void;
}

const INSTALL_HINT = 'xerj is not on PATH. Install it explicitly (one-time, per machine):\n  curl -fsSL https://xerj.org/get | sh';

export async function xerjSidecar(opts: XerjSidecarOpts): Promise<XerjSidecarResult> {
  const log = opts.log ?? (() => {});
  const baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:9200').replace(/\/$/, '');
  const index = opts.index ?? 'butler-corpus';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const noopStop = (): void => undefined;

  // 1. already healthy? attach (idempotent — safe against double bring-up)
  if (await healthy(fetchImpl, baseUrl)) return finish(await reconcile(opts, index, log, fetchImpl));

  // 2. spawn (unless attach-only), wait for health
  if (opts.attachOnly) {
    return { retriever: null, degraded: `no healthy sidecar at ${baseUrl} (attachOnly)`, indexedCount: null, stop: noopStop };
  }
  const binary = opts.binaryPath ?? 'xerj';
  let child: { pid?: number; killed: boolean; kill(): void } | null = null;
  try {
    child = opts.spawnImpl
      ? opts.spawnImpl(binary, sidecarArgs(opts.dataDir))
      : spawn(binary, sidecarArgs(opts.dataDir), { stdio: 'ignore', detached: false });
  } catch (err) {
    return { retriever: null, degraded: `failed to start sidecar: ${(err as Error).message}\n${INSTALL_HINT}`, indexedCount: null, stop: noopStop };
  }
  // spawn success ≠ binary exists (ENOENT surfaces async via 'error'); poll health regardless
  const deadline = Date.now() + (opts.startupTimeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (await healthy(fetchImpl, baseUrl)) return finish(await reconcile(opts, index, log, fetchImpl));
    await sleep(500);
  }
  child.kill();
  return {
    retriever: null,
    degraded: `sidecar did not become healthy at ${baseUrl} within ${opts.startupTimeoutMs ?? 30_000}ms\n${INSTALL_HINT}`,
    indexedCount: null,
    stop: noopStop,
  };

  function finish(r: XerjSidecarResult): XerjSidecarResult {
    return { ...r, stop: () => child?.kill() };
  }
}

function sidecarArgs(dataDir: string): string[] {
  // flags PINNED: loopback + insecure is the documented one-user dev-machine
  // trust boundary (xerj docs/SECURITY_MODEL.md). Mode defaults to the lexical
  // embedder — BM25-only per Stage-1 verdict; no --embed-mode flag shipped.
  return ['--insecure', '--data-dir', dataDir];
}

async function healthy(fetchImpl: typeof fetch, baseUrl: string): Promise<boolean> {
  try {
    const res = await fetchImpl(baseUrl, { method: 'GET' });
    return res.ok;
  } catch { return false; }
}

/** Top-up reconcile (S2-F2/S2-F4): mget existence checks per batch, bulk the
 *  misses, retries. Ported from the Stage-1 spike builder, which survived a
 *  live corpus and an 85-minute neural ingest. Count assertion aborts the
 *  TOP-UP only — serving continues on the shorter index (degraded note rides
 *  the consumer's staleNote channel). */
async function reconcile(opts: XerjSidecarOpts, index: string, log: (s: string) => void, fetchImpl: typeof fetch): Promise<{ retriever: EsCompatRetriever; degraded: string | null; indexedCount: number | null }> {
  const baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:9200').replace(/\/$/, '');
  const retriever = new EsCompatRetriever({ baseUrl, index, fetchImpl });
  // ensure index exists (idempotent)
  const put = await fetchImpl(`${baseUrl}/${index}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
  if (put && !put.ok && put.status !== 400) log(`[xerj-sidecar] index create returned ${put.status} (continuing)`);
  let sent = 0;
  const BATCH = 500;
  let batch: EsCorpusDoc[] = [];
  for await (const doc of opts.corpus()) {
    batch.push(doc);
    if (batch.length >= BATCH) { sent += await sendBatch(batch); batch = []; }
  }
  if (batch.length) sent += await sendBatch(batch);
  if (sent > 0) log(`[xerj-sidecar] indexed ${sent} docs into ${index}`);
  const cnt = (await fetchImpl(`${baseUrl}/${index}/_count`).then((r) => r.json()).catch(() => null)) as { count: number } | null;
  return { retriever, degraded: null, indexedCount: cnt?.count ?? null };

  async function sendBatch(docs: EsCorpusDoc[]): Promise<number> {
    // existence check: skip ids already indexed (resume-safety, cheap on BM25)
    const missing = await missingIds(docs.map((d) => d._id));
    if (missing.size === 0) return 0;
    const send = docs.filter((d) => missing.has(d._id));
    const ndjson = send.map((d) => `${JSON.stringify({ index: { _index: index, _id: d._id } })}\n${JSON.stringify(d)}`).join('\n') + '\n';
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetchImpl(`${baseUrl}/_bulk?refresh=false`, { method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: ndjson, signal: AbortSignal.timeout(120_000) });
        if (res.ok) {
          const body = (await res.json()) as { errors?: boolean };
          if (!body.errors) return send.length;
          throw new Error('bulk reported item errors');
        }
        throw new Error(`bulk status ${res.status}`);
      } catch (err) {
        lastErr = err;
        await sleep(2_000 * attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async function missingIds(ids: string[]): Promise<Set<string>> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetchImpl(`${baseUrl}/${index}/_mget`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
        if (!res.ok) throw new Error(`mget ${res.status}`);
        const body = (await res.json()) as { docs?: Array<{ _id: string; found: boolean }> };
        const present = new Set((body.docs ?? []).filter((d) => d.found).map((d) => d._id));
        return new Set(ids.filter((id) => !present.has(id)));
      } catch { await sleep(1_000 * attempt); }
    }
    return new Set(ids); // fail closed: re-send (idempotent overwrite)
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/** Convenience: build corpus docs from butler rows (the shapes butler already
 *  defines) — consumers reading their own DB can use this directly. */
export function chunkToEsDoc(row: { doc_sha256: string; ordinal: number; heading_path: string; content: string }): EsCorpusDoc {
  return { _id: `${row.doc_sha256}#${row.ordinal}`, content: row.content, ref: row.doc_sha256, kind: 'chunk', ordinal: row.ordinal, heading_path: row.heading_path };
}

export function noteToEsDoc(row: { id: string; kind: string; scope_key: string; content: string }): EsCorpusDoc {
  return { _id: `note:${row.id}`, content: `${row.kind} ${row.scope_key}: ${row.content}`, ref: row.id, kind: 'note' };
}

export type { RetrievedChunk };
