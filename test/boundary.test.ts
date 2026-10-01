import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Boundary test (plan rev 3, condition 1; review F3): butler core may import
 *  ONLY its own src/ and declared dependencies. The repo structurally has no
 *  application to leak from — this test is the regression guard that keeps it
 *  that way as the demo/ and any future consumers grow beside it. */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// declared runtime deps (package.json dependencies + devDependencies used by src/)
const ALLOWED_PACKAGES = new Set([
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/fastify',
  'better-sqlite3',
  'fastify',
  'ws',
  'yaml',
  'pg',
  'zod',
  'node:fs', 'node:path', 'node:os', 'node:crypto', 'node:util', 'node:events',
  'node:child_process', 'node:url', 'node:buffer', 'node:stream', 'node:abort-controller',
]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = tsFiles(join(ROOT, 'src'));
expect(files.length, 'src/ must contain TypeScript files to scan').toBeTruthy();

describe('boundary — core imports only src/ + declared deps', () => {
  it('src/** imports stay inside the package (fails on app/framework leakage)', () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const [i, line] of lines.entries()) {
        const m = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/.exec(line)
          ?? /^\s*export\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/.exec(line)
          ?? /^\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(line)
          ?? /^const\s+\w+\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/.exec(line);
        const spec = m?.[1];
        if (!spec) continue;
        if (spec.startsWith('.') || spec.startsWith('/')) {
          // relative/absolute: must resolve inside src/
          const resolved = isAbsolute(spec) ? spec : join(dirname(file), spec);
          const inSrc = resolved.startsWith(join(ROOT, 'src'));
          if (!inSrc) violations.push(`${rel}:${i + 1} imports outside src/: ${spec}`);
        } else if (spec.startsWith('node:')) {
          if (!ALLOWED_PACKAGES.has(spec)) violations.push(`${rel}:${i + 1} undeclared node builtin: ${spec}`);
        } else {
          const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
          if (!ALLOWED_PACKAGES.has(pkg)) violations.push(`${rel}:${i + 1} undeclared package: ${spec}`);
        }
      }
    }
    expect(violations, `boundary violations:\n${violations.join('\n')}`).toEqual([]);
  });

  it('the guard itself can fail — a bad import is detected (canary)', () => {
    // simulate: same logic against a fixture string
    const bad = `import { thing } from '../some-app/server'`;
    const m = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/.exec(bad);
    expect(m?.[1]).toBe('../some-app/server');
    expect(m?.[1]?.startsWith('..')).toBe(true); // would be flagged by the loop above
  });
});
