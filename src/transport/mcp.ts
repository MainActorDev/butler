/** MCP transport (plan Stage 4, D11/D14): the same ToolRegistry exposed via
 *  the official SDK's streamable-HTTP transport, mounted on an existing
 *  Fastify app. tools/list + tools/call drive the identical policy-gated
 *  registry — MCP clients (Claude Code, Codex, Hermes, Cursor) get the same
 *  surface as the conversation API. */
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ToolRegistry, Policy } from '../tools.ts';

export interface McpMountOpts {
  registry: ToolRegistry;
  policy: Policy;
  serverInfo: { name: string; version: string };
  /** optional instructions returned on initialize — clients inject this
   *  into their model's context as 'how to use this server'. */
  instructions?: string;
  /** mount path (default /mcp) */
  path?: string;
  /** context for executions */
  sessionId?: string;
}

/** Mount a stateless MCP endpoint (sessionless mode — one transport per
 *  request; the SDK handles the JSON-RPC lifecycle). */
export async function mountMcp(app: FastifyInstance, opts: McpMountOpts): Promise<void> {
  const path = opts.path ?? '/mcp';

  app.post(path, async (req, reply) => {
    // one server+transport per request (stateless mode); the SDK owns the
    // JSON-RPC lifecycle, we bridge to the SAME policy-gated registry
    const real = new McpServer({ ...opts.serverInfo, ...(opts.instructions ? { instructions: opts.instructions } : {}) });
    for (const tool of opts.registry.list()) {
      if (!permits(opts.policy, tool.permission)) continue;
      real.registerTool(
        tool.name,
        { description: `${tool.description} [${tool.permission}]`, inputSchema: z.object({ args: z.record(z.string(), z.unknown()).optional() }) },
        async (input: { args?: Record<string, unknown> | undefined }) => {
          try {
            const out = await opts.registry.execute(tool.name, (input?.args as Record<string, unknown>) ?? {}, { signal: undefined, sessionId: opts.sessionId ?? 'mcp' }, opts.policy);
            return { content: [{ type: 'text' as const, text: out }] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: 'text' as const, text: `error: ${msg}` }], isError: true };
          }
        },
      );
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never); // exactOptionalPropertyTypes vs SDK literal
    reply.header('cache-control', 'no-store');
    await real.connect(transport as never); // SDK Transport iface vs exactOptionalPropertyTypes
    // hand the raw request/response to the transport (bypass fastify serialization)
    req.raw.on('close', () => { void transport.close(); });
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // streamable-HTTP GET/DELETE (server-initiated streams not used in stateless mode)
  app.get(path, async (_req, reply) => reply.code(405).send({ error: 'streaming not supported in stateless mode' }));
  app.delete(path, async (_req, reply) => reply.code(405).send({ error: 'stateless — nothing to terminate' }));
}

function permits(policy: Policy, permission: 'read' | 'draft' | 'act'): boolean {
  const rank = (p: 'read' | 'draft' | 'act') => (p === 'read' ? 0 : p === 'draft' ? 1 : 2);
  return rank(permission) <= rank(policy.allows);
}
