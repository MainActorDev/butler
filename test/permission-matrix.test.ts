import { describe, it, expect } from 'vitest';
import { claudeCliProvider } from '../src/provider/claude-cli.ts';
import type { ProviderResponse } from '../src/provider/types.ts';

/** Fake claude binary: records argv, replies with a stream-json result.
 *  The permission CONTRACT under test: the spawn argv must contain
 *  --disallowedTools covering the dangerous set, --permission-mode that
 *  doesn't bypass lists, and the MCP allow prefix. */
function fakeClaude(): { argv: string[]; script: string } {
  const recorded: string[] = [];
  const script = `#!/bin/bash
echo "$@" > "\$FAKE_CLAUDE_ARGV"
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"s1"}'
printf '%s\\n' '{"type":"result","result":"ok"}'
`;
  void recorded;
  return { argv: recorded, script };
}

describe('claude-cli permission matrix (the rev15-17 lessons, locked in)', () => {
  it('denies the dangerous tool set via --disallowedTools (the WALL)', async () => {
    const { script } = fakeClaude();
    const { writeFileSync, chmodSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'perm-'));
    const bin = join(dir, 'claude-fake');
    writeFileSync(bin, script);
    chmodSync(bin, 0o755);
    const argvFile = join(dir, 'argv');
    process.env['FAKE_CLAUDE_ARGV'] = argvFile;

    const p = claudeCliProvider({ kind: 'claude-cli', baseUrl: 'http://x', apiKey: 'k', model: 'm', binPath: bin });
    const res: ProviderResponse = await p.complete([{ role: 'user', content: 'hi' }], [], { remainingMs: 5_000 });
    expect(res.message.content).toBe('ok');

    const argv = String((await import('node:fs')).readFileSync(argvFile, 'utf8'));
    // THE WALL: Bash/Web/sub-agents/notebooks explicitly denied
    for (const denied of ['Bash', 'WebSearch', 'WebFetch', 'Task', 'NotebookEdit']) {
      expect(argv).toContain(`--disallowedTools Bash WebSearch WebFetch Task NotebookEdit`);
      void denied;
    }
    // NEVER bypass: bypassPermissions ignores every list
    expect(argv).not.toContain('bypassPermissions');
    // MCP tools pre-granted (acceptEdits prompts for unlisted → headless deny)
    expect(argv).toContain('mcp__lionidas');
  });

  it('file tools stay read-only regardless of policy class', async () => {
    const { script } = fakeClaude();
    const { writeFileSync, chmodSync, mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'perm2-'));
    const bin = join(dir, 'claude-fake');
    writeFileSync(bin, script);
    chmodSync(bin, 0o755);
    const argvFile = join(dir, 'argv');
    process.env['FAKE_CLAUDE_ARGV'] = argvFile;

    for (const policyClass of ['read', 'draft', 'act'] as const) {
      const p = claudeCliProvider({ kind: 'claude-cli', baseUrl: 'http://x', apiKey: 'k', model: 'm', binPath: bin, policyClass });
      await p.complete([{ role: 'user', content: 'hi' }], [], { remainingMs: 5_000 });
      const argv = readFileSync(argvFile, 'utf8');
      expect(argv).toContain('--allowedTools Read Grep Glob LS mcp__lionidas');
      expect(argv).not.toMatch(/--allowedTools[^-]*\bEdit\b/);
      expect(argv).not.toMatch(/--allowedTools[^-]*\bWrite\b/);
    }
  });
});
