import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Stage C (condition 3): the stdio bin speaks MCP to a REAL SDK client —
 *  initialize, tools/list (policy-filtered), tools/call round-trip. */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DB = join(HERE, '..', 'butler-mcp-test.db');

describe('butler-mcp stdio bin (condition 3)', () => {
  it('SDK client connects over stdio; tools/list filters act tools; tools/call executes', async () => {
    rmSync(DB, { force: true });
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', join(HERE, '..', 'bin', 'butler-mcp.ts'), '--db', DB],
      stderr: 'ignore',
    });
    const client = new Client({ name: 'butler-test-client', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('docs.search');
    expect(names).toContain('spec.validate');
    expect(names).not.toContain('spec.publish'); // act-class filtered under draft policy

    const result = await client.callTool({ name: 'docs.search', arguments: { args: { query: 'logout confirmation' } } });
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('');
    expect(text).toContain('DEMO-102'); // whole pipeline: fixtures → ingest → BM25 → MCP

    await client.close();
    rmSync(DB, { force: true });
    rmSync(`${DB}-shm`, { force: true });
    rmSync(`${DB}-wal`, { force: true });
  });
});
