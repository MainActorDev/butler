import { describe, expect, it } from 'vitest';
import { extractSymbols, symbolChunks } from '../src/sources/tree-sitter.ts';
import { repoConnector } from '../src/sources/repo.ts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Stage G (condition 7): symbol chunks for repo sources — the shape, the
 *  opt-in, and the fallback (non-TS files → plain chunks only). */

const SAMPLE = `import { x } from 'y';

export interface ToolDef {
  name: string;
}

export type Permission = 'read' | 'draft' | 'act';

export class ToolRegistry {
  register(tool: ToolDef): this { return this; }
  async execute(name: string): Promise<string> { return name; }
}

export async function runLoop(prompt: string): Promise<string> {
  return prompt;
}

const DEFAULT_BUDGET = { maxHops: 12 };

export const makeThing = (a: string) => a;
`;

describe('extractSymbols (TS-family structural scan)', () => {
  it('finds functions, classes, interfaces, types, consts, methods — with lines', () => {
    const syms = extractSymbols(SAMPLE, 'src/sample.ts');
    const names = syms.map((s) => `${s.name}:${s.kind}`);
    expect(names).toContain('ToolDef:interface');
    expect(names).toContain('Permission:type');
    expect(names).toContain('ToolRegistry:class');
    expect(names).toContain('register:method');
    expect(names).toContain('execute:method');
    expect(names).toContain('runLoop:function');
    expect(names).toContain('DEFAULT_BUDGET:const');
    expect(names).toContain('makeThing:function');
    const rl = syms.find((s) => s.name === 'runLoop')!;
    expect(rl.line).toBeGreaterThan(10);
    // control-flow keywords are NOT methods
    expect(syms.some((s) => s.name === 'if' || s.name === 'for')).toBe(false);
  });

  it('non-TS files → no symbols (fallback to plain chunks)', () => {
    expect(extractSymbols('def f(): pass', 'script.py')).toEqual([]);
    expect(extractChunksPlain()).toBe(true);
    function extractChunksPlain(): boolean {
      const chunks = symbolChunks('def f(): pass', 'script.py');
      return chunks.length === 0;
    }
  });

  it('symbolChunks carry heading_path + file:line + context', () => {
    const chunks = symbolChunks(SAMPLE, 'src/sample.ts');
    const rl = chunks.find((c) => c.headingPath === 'symbol: runLoop (function)')!;
    expect(rl.content).toContain('src/sample.ts:');
    expect(rl.content).toContain('export async function runLoop');
    expect(rl.tokens).toBeGreaterThan(5);
  });
});

describe('repo connector symbols opt-in', () => {
  it('symbols: true emits a #symbols doc per TS file; default does not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-sym-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const alpha = () => 1;\nexport function beta(): number { return 2; }\n');

    const plain = await repoConnector('r1', { origin: dir }).fetch();
    expect(plain.some((d) => d.uri.endsWith('#symbols'))).toBe(false);

    const withSym = await repoConnector('r2', { origin: dir, symbols: true }).fetch();
    const symDoc = withSym.find((d) => d.uri.endsWith('src/a.ts#symbols'));
    expect(symDoc).toBeTruthy();
    expect(symDoc!.content).toContain('symbol: alpha (function)');
    expect(symDoc!.content).toContain('symbol: beta (function)');
    rmSync(dir, { recursive: true, force: true });
  });
});
