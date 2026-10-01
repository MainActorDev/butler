import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** UI boundary (plan rev 2, review F6): the demo UI may not import core
 *  internals — it is a consumer like any other; package access via the public
 *  barrel only (and the cleanest UI uses fetch/WS exclusively). */

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo', 'ui', 'src');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith('.ts') || p.endsWith('.vue')) out.push(p);
  }
  return out;
}

describe('UI boundary (F6)', () => {
  it('demo/ui/src never imports ../../src or the package internals', () => {
    const violations: string[] = [];
    for (const f of files(UI)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        if (spec.includes('../src') || spec.includes('../../src') || spec.startsWith('@mainactordev/butler')) {
          violations.push(`${f}: ${spec}`);
        }
      }
    }
    expect(violations.join('\n')).toBe('');
  });
});
