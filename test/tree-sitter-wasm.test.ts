import { describe, expect, it } from 'vitest';
import { extractSymbolsTree, symbolsFor, defaultSymbolGrammars, prepareGrammars, symbolChunksFor, queryMatches } from '../src/sources/tree-sitter.ts';
import { repoDocumentFor } from '../src/sources/repo.ts';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { ingest } from '../src/sources/connector.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Stage-3 v2: tree-sitter WASM extraction over the shipped grammars
 *  (vendored swift — see grammars/README.md — + pack typescript/tsx/python).
 *  Hermetic: grammars load from node_modules, no network. */

const SWIFT = `import Foundation

public struct PostalRule { let code: String }

public final class AddressValidator {
  public func validate(_ code: String) -> Bool { return !code.isEmpty }
}

protocol Validating { func validate(_ code: String) -> Bool }

enum Region { case intl, domestic }
`;

const TS = `export interface Rule { code: string }
export type Alias = string;
export class Validator { method(x: string): boolean { return true } }
export function validate(code: string): boolean { return true }
export const MAX = 10;
`;

const PY = `def top_level(): pass

class Thing:
    def method(self): pass
`;

describe('tree-sitter WASM extraction (defaultSymbolGrammars)', () => {
  it('swift: struct/class/protocol/enum + functions with lines', async () => {
    const g = defaultSymbolGrammars();
    const syms = await extractSymbolsTree(SWIFT, 'a.swift', g);
    const names = syms.map((s) => `${s.name}:${s.kind}`);
    expect(names).toContain('PostalRule:struct');
    expect(names).toContain('AddressValidator:class');
    expect(names).toContain('validate:function');
    expect(names).toContain('Validating:protocol');
    expect(names).toContain('Region:enum');
    const v = syms.find((s) => s.name === 'validate')!;
    expect(v.line).toBeGreaterThan(3);
  });

  it('typescript: interface/type/class/method/function/const', async () => {
    const g = defaultSymbolGrammars();
    const syms = await extractSymbolsTree(TS, 'a.ts', g);
    const names = syms.map((s) => `${s.name}:${s.kind}`);
    expect(names).toContain('Rule:interface');
    expect(names).toContain('Alias:type');
    expect(names).toContain('Validator:class');
    expect(names).toContain('method:method');
    expect(names).toContain('validate:function');
    expect(names).toContain('MAX:const');
  });

  it('python: functions and classes', async () => {
    const g = defaultSymbolGrammars();
    const syms = await extractSymbolsTree(PY, 'a.py', g);
    const names = syms.map((s) => `${s.name}:${s.kind}`);
    expect(names).toContain('top_level:function');
    expect(names).toContain('Thing:class');
    expect(names).toContain('method:function');
  });

  it('symbolsFor: grammar-configured extension uses tree-sitter even when the file has no decls', async () => {
    const g = defaultSymbolGrammars();
    // a decl-free swift body (property/func/class-free): plain statements
    expect(await symbolsFor('print("hi")\n', 'a.swift', g)).toEqual([]); // swift path, NOT the regex
    expect((await symbolsFor('export function f() {}\n', 'a.ts', g)).length).toBeGreaterThan(0);
  });

  it('prepareGrammars warms the set (idempotent)', async () => {
    const g = defaultSymbolGrammars();
    await prepareGrammars(g);
    await prepareGrammars(g);
  });

  it('symbolChunksFor emits one chunk per symbol with structured heading', async () => {
    const g = defaultSymbolGrammars();
    const syms = await extractSymbolsTree(SWIFT, 'a.swift', g);
    const chunks = symbolChunksFor(syms, SWIFT, 'a.swift');
    expect(chunks.length).toBe(syms.length);
    const rule = chunks.find((c) => c.headingPath === 'symbol: PostalRule (struct)')!;
    expect(rule.content).toContain('a.swift:');
    expect(rule.content).toContain('public struct PostalRule');
  });
});

describe('repoDocumentFor (per-file normalize, F3)', () => {
  it('one changed file → file doc + per-symbol doc, no walk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-docfor-'));
    writeFileSync(join(dir, 'a.swift'), SWIFT);
    const cfg = { origin: dir, symbols: true, symbolGrammars: defaultSymbolGrammars() };
    const docs = await repoDocumentFor(cfg, join(dir, 'a.swift'));
    expect(docs?.map((d) => d.uri)).toContain('repo://a.swift');
    const sym = docs?.find((d) => d.uri === 'repo://a.swift#symbols');
    expect(sym?.chunks?.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('outside root / skipped dir / missing file → null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-docfor2-'));
    const cfg = { origin: dir, symbols: true };
    expect(await repoDocumentFor(cfg, '/etc/hosts')).toBeNull();
    expect(await repoDocumentFor(cfg, join(dir, 'nope.swift'))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ingest chunks passthrough (F1)', () => {
  it('pre-chunked docs land verbatim — heading_path per symbol, idempotent re-ingest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-passthru-'));
    const storage = new SqliteStorage(join(dir, 't.db'));
    const repoDir = mkdtempSync(join(tmpdir(), 'butler-passthru-repo-'));
    writeFileSync(join(repoDir, 'a.swift'), SWIFT);
    const connector = {
      kind: 'repo' as const,
      sourceId: 't-passthru',
      fetch: async () => (await repoDocumentFor({ origin: repoDir, symbols: true, symbolGrammars: defaultSymbolGrammars() }, join(repoDir, 'a.swift')))!,
    };
    const r1 = await ingest(connector, storage, { artifactsDir: dir });
    expect(r1.documents.some((d) => d.uri.endsWith('#symbols'))).toBe(true);
    const sha = r1.documents.find((d) => d.uri.endsWith('#symbols'))!.sha256;
    const chunks = await storage.documentChunks(sha);
    expect(chunks.some((c) => c.heading_path === 'symbol: PostalRule (struct)')).toBe(true);
    // content-addressed idempotence: re-ingest → cached, chunks unchanged
    const r2 = await ingest(connector, storage, { artifactsDir: dir });
    expect(r2.documents.find((d) => d.uri.endsWith('#symbols'))!.cached).toBe(true);
    await storage.close?.();
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });
});

/** ranges, parents, Go, caller queries: what a consumer needs to cut one chunk
 *  per symbol with exact lines and run its own extraction queries. */
const TS_RANGES = `export class BoardPage {
  readonly menu: string;

  constructor() {
    this.menu = 'x';
  }

  async openMenu(): Promise<void> {
    await go();
  }
}

export async function createShipment(
  deps: Deps,
): Promise<void> {
  return;
}

export const tabs = [
  { name: 'a', title: 'Belum Dijemput' },
];
`;

const GO = `package main

type Handler struct {
  svc Service
}

type Service interface {
  Do() error
}

type ID string

func (h *Handler) Transfer(c echo.Context) error {
  return nil
}

func Register(e *echo.Echo, h *Handler) {
  g := e.Group("/v1/dashboard-pickup")
  g.POST("/transfer", h.Transfer)
  g.Use(mw)
}
`;

describe('symbol ranges, parents, Go and caller queries', () => {
  const g = { ...defaultSymbolGrammars(), go: 'go' };

  it('typescript: endLine is the last line of the declaration; methods name their class', async () => {
    const syms = await extractSymbolsTree(TS_RANGES, 'p.ts', g);
    const by = (n: string) => syms.find((s) => s.name === n)!;
    expect(by('BoardPage')).toMatchObject({ kind: 'class', line: 1, endLine: 11 });
    expect(by('BoardPage').parent).toBeUndefined();
    expect(by('constructor')).toMatchObject({ kind: 'method', line: 4, endLine: 6, parent: 'BoardPage' });
    expect(by('openMenu')).toMatchObject({ kind: 'method', line: 8, endLine: 10, parent: 'BoardPage' });
    expect(by('createShipment')).toMatchObject({ kind: 'function', line: 13, endLine: 17 });
    expect(by('tabs')).toMatchObject({ kind: 'const', line: 19, endLine: 21 });
  });

  it('go: struct/interface/type, functions, methods with their receiver as parent', async () => {
    const syms = await extractSymbolsTree(GO, 'h.go', g);
    const got = syms.map((s) => `${s.name}:${s.kind}:${s.line}-${s.endLine}:${s.parent ?? ''}`);
    expect(got).toEqual(['Handler:struct:3-5:', 'Service:interface:7-9:', 'ID:type:11-11:', 'Transfer:method:13-15:Handler', 'Register:function:17-21:']);
  });

  it('go is not in the shipped default map: no grammar, no symbols (callers opt in)', async () => {
    expect(defaultSymbolGrammars()['go']).toBeUndefined();
    expect(await symbolsFor(GO, 'h.go', defaultSymbolGrammars())).toEqual([]);
  });

  it('the regex fallback keeps its shape (no endLine/parent it cannot know)', async () => {
    const syms = await symbolsFor('export function f() {}\n', 'a.ts', {});
    expect(syms).toEqual([{ name: 'f', kind: 'function', line: 1 }]);
  });

  it('queryMatches: one entry per match, captures together, predicates applied', async () => {
    const q = `(call_expression
      function: (selector_expression field: (field_identifier) @verb (#match? @verb "^(GET|POST|PUT|PATCH|DELETE)$"))
      arguments: (argument_list . (interpreted_string_literal) @path))`;
    const m = await queryMatches(GO, 'h.go', g, q);
    expect(m).toEqual([[{ name: 'verb', text: 'POST', line: 19, endLine: 19 }, { name: 'path', text: '"/transfer"', line: 19, endLine: 19 }]]);
    const pairs = await queryMatches(TS_RANGES, 'p.ts', g, `(pair key: (property_identifier) @k (#eq? @k "title") value: (string (string_fragment) @v))`);
    expect(pairs).toEqual([[{ name: 'k', text: 'title', line: 20, endLine: 20 }, { name: 'v', text: 'Belum Dijemput', line: 20, endLine: 20 }]]);
  });

  it('queryMatches returns null when there is no grammar or the query does not compile', async () => {
    expect(await queryMatches(GO, 'h.rs', g, '(identifier) @x')).toBeNull();
    expect(await queryMatches(GO, 'h.go', g, '(no_such_node) @x')).toBeNull();
  });
});
