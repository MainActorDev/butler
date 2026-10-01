/** The generic demo consumer (plan Stage 4, D15): a tiny Fastify app proving
 *  every core subsystem with ZERO domain coupling. ~5 tools; spec.validate is
 *  the JSON-schema ground truth; spec.publish is the act-class tool the draft
 *  policy REFUSES (condition 5). Doubles as the executable quickstart. */
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { ToolRegistry, DRAFT, ACT } from '../src/tools.ts';
import { MockProvider, type ScriptedTurn } from '../src/provider/mock.ts';
import { OpenAICompatProvider } from '../src/provider/openai-compat.ts';
import { registerConversationApi } from '../src/transport/conversation.ts';
import { mountMcp } from '../src/transport/mcp.ts';
import { fileConnector } from '../src/sources/file.ts';
import { ingest } from '../src/sources/connector.ts';
import { StorageRetriever } from '../src/memory/retrieval.ts';
import type { TurnEvent } from '../src/loop.ts';
import type { Policy } from '../src/tools.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN_GATE = process.env['DEMO_TOKEN'] ?? null; // optional bearer gate

export const SPEC_SCHEMA = {
  type: 'object',
  required: ['title', 'steps'],
  properties: {
    title: { type: 'string', description: 'short spec title' },
    summary: { type: 'string' },
    sourceRefs: { type: 'array', items: { type: 'string' }, description: 'sha256 of documents used (provenance)' },
    steps: { type: 'array', minItems: 1, items: { type: 'object', required: ['action'], properties: { action: { type: 'string' }, detail: { type: 'string' } } } },
  },
} as const;

/** minimal JSON-schema validator for the demo's spec shape (ground truth —
 *  the agent's drafts are judged by THIS, never by the model's own opinion) */
export function validateSpec(spec: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof spec !== 'object' || spec === null) return { ok: false, errors: ['spec must be an object'] };
  const s = spec as Record<string, unknown>;
  if (typeof s['title'] !== 'string' || !(s['title'] as string).trim()) errors.push('title: non-empty string required');
  if (!Array.isArray(s['steps']) || (s['steps'] as unknown[]).length === 0) errors.push('steps: non-empty array required');
  else {
    for (const [i, st] of (s['steps'] as unknown[]).entries()) {
      if (typeof st !== 'object' || st === null || typeof (st as Record<string, unknown>)['action'] !== 'string') errors.push(`steps[${i}]: {action: string} required`);
    }
  }
  if (s['sourceRefs'] !== undefined && (!Array.isArray(s['sourceRefs']) || !(s['sourceRefs'] as unknown[]).every((x) => typeof x === 'string'))) errors.push('sourceRefs: string[] when present');
  return { ok: errors.length === 0, errors };
}

export interface DemoBuild {
  app: ReturnType<typeof Fastify>;
  storage: SqliteStorage;
  retriever: StorageRetriever;
  registry: ToolRegistry;
  close(): Promise<void>;
}

export async function buildDemo(opts?: { scripted?: ScriptedTurn[]; policy?: Policy }): Promise<DemoBuild> {
  const storage = new SqliteStorage(process.env['DEMO_DB'] ?? join(HERE, 'demo.db'));
  const app = Fastify();
  await app.register(websocket);

  // WS channel: butler.* turn events (D10 — consumer carries the bus)
  const wsClients = new Set<{ send(data: string): void; on(ev: string, fn: () => void): void }>();
  app.get('/ws', { websocket: true }, (conn) => {
    const sock = conn as unknown as { send(data: string): void; on(ev: string, fn: () => void): void };
    wsClients.add(sock);
    sock.on('close', () => wsClients.delete(sock));
  });
  const emit = (e: TurnEvent & { sessionId: string }) => {
    const payload = JSON.stringify(e);
    for (const c of wsClients) { try { c.send(payload); } catch { /* client gone */ } }
  };

  // provider: live endpoint when configured, mock otherwise (honestly labeled)
  const provider = process.env['BUTLER_PROVIDER_BASE_URL']
    ? new OpenAICompatProvider({
        baseUrl: process.env['BUTLER_PROVIDER_BASE_URL'],
        apiKey: process.env['BUTLER_API_KEY'] ?? '',
        model: process.env['BUTLER_MODEL'] ?? 'gpt-4o-mini',
      })
    : new MockProvider(opts?.scripted ?? [
        { kind: 'assistant', content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'docs.search', arguments: '{"query":"spec requirements"}' } }] },
        { kind: 'assistant', content: 'Spec drafted from the ticket. (mock provider — set BUTLER_PROVIDER_BASE_URL for live)' },
      ]);

  // ingest the fixture "tickets" through the file connector (Stage 3 wiring)
  const fixturesDir = join(HERE, 'fixtures');
  const conn = fileConnector('demo-fixtures', { root: fixturesDir });
  const ingested = await ingest(conn, storage, { artifactsDir: join(HERE, 'artifacts') });
  const retriever = new StorageRetriever(storage);
  for (const d of ingested.documents) {
    retriever.registerChunks(await storage.documentChunks(d.sha256));
  }

  // the demo's generic tools
  const specs = new Map<string, unknown>();
  const registry = new ToolRegistry();
  registry
    .register({
      name: 'docs.search', description: 'search ingested documents for relevant chunks', permission: 'read',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      execute: async (args) => {
        const hits = await retriever.retrieve(String(args['query'] ?? ''), 3);
        return hits.length ? hits.map((h) => `[${h.kind} ${h.ref}${h.headingPath ? ` ${h.headingPath}` : ''}] ${h.content.slice(0, 400)}`).join('\n---\n') : 'no matching documents';
      },
    })
    .register({
      name: 'docs.get', description: 'read one ingested document by sha256 prefix', permission: 'read',
      parameters: { type: 'object', properties: { sha: { type: 'string' } }, required: ['sha'] },
      execute: async (args) => {
        const prefix = String(args['sha'] ?? '');
        for (const d of ingested.documents) {
          if (d.sha256.startsWith(prefix)) {
            const doc = await storage.getDocument(d.sha256);
            return doc?.content ?? `(binary at ${doc?.bytes_path ?? '?'})`;
          }
        }
        return `no document with sha256 prefix "${prefix}"`;
      },
    })
    .register({
      name: 'spec.draft', description: 'record a draft spec (JSON) — validation happens via spec.validate', permission: 'draft',
      parameters: { type: 'object', properties: { spec: { type: 'object' } }, required: ['spec'] },
      execute: async (args) => {
        const id = `spec_${Date.now().toString(36)}`;
        specs.set(id, args['spec']);
        return `draft recorded as ${id} — now call spec.validate`;
      },
    })
    .register({
      name: 'spec.validate', description: 'validate a draft spec against the schema — the ground truth', permission: 'draft',
      parameters: { type: 'object', properties: { specId: { type: 'string' } }, required: ['specId'] },
      execute: async (args) => {
        const spec = specs.get(String(args['specId'] ?? ''));
        if (!spec) return `error: no draft "${String(args['specId'])}" — call spec.draft first`;
        const v = validateSpec(spec);
        return v.ok ? `VALID — spec passes (title+steps present)` : `INVALID: ${v.errors.join('; ')}`;
      },
    })
    .register({
      name: 'note.save', description: 'save a provenance-stamped note (the distilled memory layer)', permission: 'draft',
      parameters: { type: 'object', properties: { scopeKey: { type: 'string' }, kind: { type: 'string' }, content: { type: 'string' }, sourceRef: { type: 'string' } }, required: ['scopeKey', 'kind', 'content', 'sourceRef'] },
      execute: async (args, ctx) => {
        const n = await storage.insertNote({
          scope_key: String(args['scopeKey']), kind: 'convention', content: String(args['content']),
          source_type: 'session', source_ref: String(args['sourceRef']), created_by: ctx.sessionId,
        });
        return `note ${n.id} saved`;
      },
    })
    .register({
      name: 'spec.publish', description: 'publish a validated spec (ACT-class: refused under the draft policy)', permission: 'act',
      parameters: { type: 'object', properties: { specId: { type: 'string' } }, required: ['specId'] },
      execute: async () => 'published',
    });

  const policy = opts?.policy ?? DRAFT;

  // optional token gate (simple bearer)
  if (TOKEN_GATE) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.url.startsWith('/ws')) return;
      if (req.headers['authorization'] !== `Bearer ${TOKEN_GATE}`) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    });
  }

  // serve the built demo UI at / (dev: `pnpm -C demo/ui dev` proxies /api,/ws,/mcp)
  const uiDist = join(HERE, 'ui', 'dist');
  try {
    await app.register(fastifyStatic, { root: uiDist });
  } catch { /* dist not built — API-only mode (tests) */ }

  await registerConversationApi(app, {
    storage, provider, registry, policy,
    systemPrompt: 'You are a spec-drafting assistant. Search docs, draft specs as JSON, validate them with spec.validate, and cite document sha256s. Never claim validity without the validator.',
    emit,
  });
  await mountMcp(app, { registry, policy, serverInfo: { name: 'butler-demo', version: '0.1.0' } });

  return {
    app, storage, retriever, registry,
    async close() { await app.close(); storage.close(); },
  };
}

// CLI entry: node demo/app.ts (tsx)
if (process.argv[1]?.endsWith('demo/app.ts')) {
  const demo = await buildDemo();
  const port = Number(process.env['DEMO_PORT'] ?? 8790);
  await demo.app.listen({ port: 8790 === port ? port : port, host: '127.0.0.1' });
  console.log(`butler demo on http://127.0.0.1:${port} — POST /api/agent/sessions, WS /ws, MCP POST /mcp (provider: ${process.env['BUTLER_PROVIDER_BASE_URL'] ? 'live' : 'mock'})`);
}
