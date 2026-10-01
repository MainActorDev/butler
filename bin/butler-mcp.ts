#!/usr/bin/env node
/** butler-mcp — stdio MCP server over the same ToolRegistry (plan Stage C,
 *  condition 3). Mounts Butler in Claude Code / Codex / Hermes configs:
 *
 *    {"mcpServers": {"butler": {"command": "npx", "args": ["tsx",
 *      "path/to/butler/bin/butler-mcp.ts"], "env": {…}}}}
 *
 *  Default serves the DEMO registry (read+draft tools over the fixture
 *  corpus, in-memory storage) — a runnable smoke target. `--registry <module>`
 *  loads a consumer module exporting `buildRegistry(opts)` for real use. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ToolRegistry, DRAFT, ACT, type Policy } from '../src/tools.ts';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { StorageRetriever } from '../src/memory/retrieval.ts';
import { fileConnector } from '../src/sources/file.ts';
import { ingest } from '../src/sources/connector.ts';
import { validateSpec } from '../demo/app.ts';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): { registry?: string; policy: string; db: string } {
  const out = { policy: 'draft', db: join(HERE, '..', 'butler-mcp.db') } as { registry?: string; policy: string; db: string };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--registry') out.registry = argv[++i];
    else if (argv[i] === '--policy') out.policy = argv[++i] ?? 'draft';
    else if (argv[i] === '--db') out.db = argv[++i] ?? out.db;
  }
  return out;
}

/** demo registry builder — shared by the bin default and tests. */
export async function buildDemoRegistry(dbPath: string): Promise<{ registry: ToolRegistry; storage: SqliteStorage; retriever: StorageRetriever }> {
  const storage = new SqliteStorage(dbPath);
  const conn = fileConnector('demo-fixtures', { root: join(HERE, '..', 'demo', 'fixtures') });
  const ingested = await ingest(conn, storage, { artifactsDir: join(HERE, '..', 'demo', 'artifacts') });
  const retriever = new StorageRetriever(storage);
  for (const d of ingested.documents) retriever.registerChunks(await storage.documentChunks(d.sha256));

  const specs = new Map<string, unknown>();
  const registry = new ToolRegistry()
    .register({
      name: 'docs.search', description: 'search ingested fixture documents (BM25)', permission: 'read',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      execute: async (args) => {
        const hits = await retriever.retrieve(String(args['query'] ?? ''), 3);
        return hits.map((h) => `[${h.kind} ${h.ref.slice(0, 12)}] ${h.content.slice(0, 300)}`).join('\n---\n') || 'no matching documents';
      },
    })
    .register({
      name: 'docs.get', description: 'read one document by sha256 prefix', permission: 'read',
      parameters: { type: 'object', properties: { sha: { type: 'string' } }, required: ['sha'] },
      execute: async (args) => {
        const prefix = String(args['sha'] ?? '');
        for (const d of ingested.documents) {
          if (d.sha256.startsWith(prefix)) return (await storage.getDocument(d.sha256))?.content ?? '(binary)';
        }
        return `no document with sha256 prefix "${prefix}"`;
      },
    })
    .register({
      name: 'spec.draft', description: 'record a draft spec', permission: 'draft',
      parameters: { type: 'object', properties: { spec: { type: 'object' } }, required: ['spec'] },
      execute: async (args) => { const id = `spec_${Date.now().toString(36)}`; specs.set(id, args['spec']); return id; },
    })
    .register({
      name: 'spec.validate', description: 'validate a draft spec against the schema (ground truth)', permission: 'draft',
      parameters: { type: 'object', properties: { specId: { type: 'string' } }, required: ['specId'] },
      execute: async (args) => {
        const spec = specs.get(String(args['specId']));
        if (!spec) return `error: no draft "${String(args['specId'])}"`;
        const v = validateSpec(spec);
        return v.ok ? 'VALID' : `INVALID: ${v.errors.join('; ')}`;
      },
    })
    .register({
      name: 'spec.publish', description: 'publish a validated spec (act-class — refused under draft policy)', permission: 'act',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => 'published',
    });
  return { registry, storage, retriever };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const policy: Policy = args.policy === 'act' ? ACT : DRAFT;

  const { registry } = await buildDemoRegistry(args.db);
  const server = new McpServer({ name: 'butler-mcp', version: '0.1.0' });
  for (const tool of registry.list()) {
    const allowed = policy.allows === 'act' || (policy.allows === 'draft' && tool.permission !== 'act') || (policy.allows === 'read' && tool.permission === 'read');
    if (!allowed) continue;
    server.registerTool(
      tool.name,
      { description: `${tool.description} [${tool.permission}]`, inputSchema: z.object({ args: z.record(z.string(), z.unknown()).optional() }) },
      async (input: { args?: Record<string, unknown> }) => {
        try {
          const out = await registry.execute(tool.name, input?.args ?? {}, { signal: undefined, sessionId: 'mcp-stdio' }, policy);
          return { content: [{ type: 'text' as const, text: out }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport as never);
  console.error(`butler-mcp: serving ${registry.list().length} tools over stdio (policy: ${policy.name})`);
}

if (process.argv[1]?.includes('butler-mcp')) {
  void main();
}
