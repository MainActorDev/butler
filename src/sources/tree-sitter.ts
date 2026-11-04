/** tree-sitter symbol chunks (plan Stage G, condition 7 → Stage-3 v2): repo
 *  sources may opt into symbol indexing — functions/types/classes become
 *  chunks with heading_path "symbol: <name> (<kind>)".
 *
 *  v2 (2026-10-21): real parsing via web-tree-sitter WASM grammars
 *  (tree-sitter-wasms pack — no native modules, no runtime network; the
 *  grammar set is CALLER-supplied policy, this module is pure mechanism).
 *  No grammar configured for a file → v1 dependency-free regex fallback for
 *  TS/JS-family files, [] otherwise (caller keeps plain file chunks).
 *  Grammar WASM fails to load → empty result, never fatal. */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language, Query, Node as TsNode } from 'web-tree-sitter';

export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'method' | 'const' | 'struct' | 'protocol' | 'enum';
  line: number;
  /** last line of the declaration (1-based, inclusive). Set by the
   *  tree-sitter path only; the v1 regex fallback cannot know it. */
  endLine?: number;
  /** enclosing class/interface/struct for methods and members (tree-sitter
   *  path only), or the receiver type of a Go method. */
  parent?: string;
}

/** caller policy: file extension → grammar. Value is either a grammar name
 *  in the tree-sitter-wasms pack ('typescript', 'python', …) or an ABSOLUTE
 *  path to a .wasm file (see grammars/README.md for the vendored-swift
 *  story). e.g. { swift: '/…/grammars/tree-sitter-swift.wasm', ts: 'typescript' } */
export type SymbolGrammars = Record<string, string>;

const require = createRequire(import.meta.url);

let parserInit: Promise<void> | null = null;
const grammarCache = new Map<string, Promise<Language | null>>();

function wasmSource(value: string): { key: string; src: string; family: string } {
  // absolute path → load as-is (family from the file name); bare name → pack
  if (value.startsWith('/')) {
    const base = value.split('/').pop() ?? value;
    return { key: value, src: value, family: base.replace(/^tree-sitter-/, '').replace(/\.wasm$/, '') };
  }
  const packDir = dirname(require.resolve('tree-sitter-wasms/package.json'));
  return { key: value, src: join(packDir, 'out', `tree-sitter-${value}.wasm`), family: value };
}

/** butler's shipped default: swift via the vendored 0.1.8 wasm (see
 *  grammars/README.md — pack swift >= 0.1.10 crashes Node 24 tier-up), the
 *  rest from the pack. Consumers pass their own map to override. */
export function defaultSymbolGrammars(): SymbolGrammars {
  return {
    swift: join(dirname(fileURLToPath(import.meta.url)), '../../grammars/tree-sitter-swift.wasm'),
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    tsx: 'tsx',
    js: 'typescript',
    mjs: 'typescript',
    cjs: 'typescript',
    py: 'python',
  };
}

async function loadParser(): Promise<void> {
  parserInit ??= Parser.init();
  return parserInit;
}

async function loadGrammar(key: string, src: string): Promise<Language | null> {
  if (!grammarCache.has(key)) {
    grammarCache.set(key, (async () => {
      try {
        await loadParser();
        return await Language.load(src);
      } catch {
        return null; // empty result per file; never fatal to the walk
      }
    })());
  }
  return grammarCache.get(key)!;
}

/** node.type → SymbolInfo kind, per grammar family. Verified against the
 *  tree-sitter-wasms grammars by parsing fixtures (test/tree-sitter-wasm.test.ts). */
const NODE_KINDS: Record<string, Record<string, SymbolInfo['kind']>> = {
  swift: {
    function_declaration: 'function',
    class_declaration: 'class',
    struct_declaration: 'struct',
    protocol_declaration: 'protocol',
    enum_declaration: 'enum',
    type_alias: 'type',
    property_declaration: 'const',
  },
  typescript: {
    function_declaration: 'function',
    class_declaration: 'class',
    interface_declaration: 'interface',
    type_alias_declaration: 'type',
    method_definition: 'method',
    enum_declaration: 'enum',
    lexical_declaration: 'const',
  },
  tsx: {
    function_declaration: 'function',
    class_declaration: 'class',
    interface_declaration: 'interface',
    type_alias_declaration: 'type',
    method_definition: 'method',
    enum_declaration: 'enum',
    lexical_declaration: 'const',
  },
  python: {
    function_definition: 'function',
    class_definition: 'class',
  },
  // type_spec is refined to struct/interface by its type child (below)
  go: {
    function_declaration: 'function',
    method_declaration: 'method',
    type_spec: 'type',
  },
};

/** node types whose name becomes `parent` for the symbols nested inside */
const CONTAINERS = new Set(['class_declaration', 'abstract_class_declaration', 'interface_declaration', 'class_definition', 'struct_declaration', 'protocol_declaration', 'enum_declaration']);

/** Go method receiver type: `(h *Handler)` → Handler, `(s Svc[T])` → Svc */
function goReceiver(node: TsNode): string | undefined {
  const text = node.childForFieldName('receiver')?.text ?? '';
  return /\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)/.exec(text)?.[1];
}

/** Tree-sitter symbols for one file. Returns [] when no grammar is configured
 *  for the extension or the grammar fails to load — the caller falls back. */
export async function extractSymbolsTree(source: string, filePath: string, grammars: SymbolGrammars): Promise<SymbolInfo[]> {
  const ext = /(?:^|\.)([a-z0-9]+)$/i.exec(filePath)?.[1]?.toLowerCase() ?? '';
  const value = grammars[ext];
  if (!value) return [];
  const { key, src, family } = wasmSource(value);
  const lang = await loadGrammar(key, src);
  if (!lang) return [];
  const kinds = NODE_KINDS[family];
  if (!kinds) return [];
  await loadParser();
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  const out: SymbolInfo[] = [];
  const endOf = (n: TsNode) => n.endPosition.row + 1;
  const visit = (node: TsNode, parent: string | undefined): void => {
    let kind = kinds[node.type];
    if (kind) {
      // swift models struct/class/extension all as class_declaration — the
      // keyword token child says which (verified against the 0.1.8 grammar)
      if (family === 'swift' && node.type === 'class_declaration') {
        const toks = [...Array(node.childCount).keys()].map((i) => node.child(i)?.type);
        kind = toks.includes('struct') ? 'struct' : toks.includes('enum') ? 'enum' : 'class';
      }
      // typescript: `const NAME = …` carries its identifier on the
      // variable_declarator child, not on the declaration itself
      if ((family === 'typescript' || family === 'tsx') && node.type === 'lexical_declaration') {
        for (let i = 0; i < node.childCount; i++) {
          const d = node.child(i)!;
          if (d.type === 'variable_declarator') {
            const dn = d.childForFieldName('name')?.text?.trim();
            if (dn) out.push({ name: dn, kind: 'const', line: (d.startPosition.row) + 1, endLine: endOf(d), ...(parent ? { parent } : {}) });
          }
        }
        kind = undefined; // handled per-declarator above
      }
      // go: `type X struct{…}` / `type X interface{…}` / `type X string`
      if (family === 'go' && node.type === 'type_spec') {
        const t = node.childForFieldName('type')?.type;
        kind = t === 'struct_type' ? 'struct' : t === 'interface_type' ? 'interface' : 'type';
      }
      // these grammars expose the declared identifier as the `name` field
      const nameNode = node.childForFieldName('name');
      const name = nameNode?.text?.trim();
      const owner = family === 'go' && node.type === 'method_declaration' ? goReceiver(node) : parent;
      if (kind && name) out.push({ name, kind, line: (nameNode?.startPosition.row ?? node.startPosition.row) + 1, endLine: endOf(node), ...(owner ? { parent: owner } : {}) });
    }
    const inner = CONTAINERS.has(node.type) ? (node.childForFieldName('name')?.text?.trim() || parent) : parent;
    for (let i = 0; i < node.childCount; i++) visit(node.child(i)!, inner);
  }
  try {
    if (tree) visit(tree.rootNode, undefined);
  } finally {
    tree?.delete(); // WASM memory: one tree + parser per file adds up on large repos
    parser.delete();
  }
  return out;
}

export interface QueryCapture {
  name: string;   // capture name without the `@`
  text: string;
  line: number;    // 1-based start line
  endLine: number; // 1-based end line, inclusive
}

const queryCache = new Map<string, Query | null>();

/** Run a caller-supplied tree-sitter query (S-expression, with `#eq?` /
 *  `#match?` predicates) over one file with the grammar the caller configured
 *  for its extension. One entry per match, its captures in pattern order, so
 *  related captures (a key and its value) stay together. Returns null when no
 *  grammar is configured, the grammar fails to load, or the query does not
 *  compile for that grammar; the caller falls back. The query itself is
 *  caller policy; this is mechanism only. */
export async function queryMatches(source: string, filePath: string, grammars: SymbolGrammars, query: string): Promise<QueryCapture[][] | null> {
  const ext = /(?:^|\.)([a-z0-9]+)$/i.exec(filePath)?.[1]?.toLowerCase() ?? '';
  const value = grammars[ext];
  if (!value) return null;
  const { key, src } = wasmSource(value);
  const lang = await loadGrammar(key, src);
  if (!lang) return null;
  const qk = `${key}\u0000${query}`;
  if (!queryCache.has(qk)) {
    try {
      queryCache.set(qk, new Query(lang, query));
    } catch {
      queryCache.set(qk, null);
    }
  }
  const q = queryCache.get(qk);
  if (!q) return null;
  await loadParser();
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  try {
    if (!tree) return null;
    return q.matches(tree.rootNode).map((m) => m.captures.map((c) => ({ name: c.name, text: c.node.text, line: c.node.startPosition.row + 1, endLine: c.node.endPosition.row + 1 })));
  } finally {
    tree?.delete();
    parser.delete();
  }
}

/** v1 structural symbol scan for TS/JS-family sources. Honest scope: regex
 *  over declaration forms; not a parser. Returns [] for non-matching files. */
export function extractSymbols(source: string, filePath: string): SymbolInfo[] {
  const isTsFamily = /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath);
  if (!isTsFamily) return [];
  const out: SymbolInfo[] = [];
  const lines = source.split('\n');
  for (const [i, line] of lines.entries()) {
    let m = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) { out.push({ name: m[1]!, kind: 'function', line: i + 1 }); continue; }
    m = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) { out.push({ name: m[1]!, kind: 'class', line: i + 1 }); continue; }
    m = /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) { out.push({ name: m[1]!, kind: 'interface', line: i + 1 }); continue; }
    m = /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (m) { out.push({ name: m[1]!, kind: 'type', line: i + 1 }); continue; }
    m = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/.exec(line);
    if (m) { out.push({ name: m[1]!, kind: 'function', line: i + 1 }); continue; }
    m = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_$]*)\s*=/.exec(line);
    if (m) { out.push({ name: m[1]!, kind: 'const', line: i + 1 }); continue; }
    m = /^\s{2,}(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/.exec(line);
    if (m && !['if', 'for', 'while', 'switch', 'catch', 'function'].includes(m[1]!)) {
      out.push({ name: m[1]!, kind: 'method', line: i + 1 });
    }
  }
  return out;
}

export interface SymbolChunk {
  ordinal: number;
  headingPath: string; // "symbol: runLoop (function)"
  content: string;     // the declaration line + body head (retrieval context)
  tokens: number;
}

/** one chunk per symbol — the Stage-3 shape (heading_path carries the symbol
 *  for structured filtering; v1 concatenated all symbols into doc content) */
export function symbolChunksFor(symbols: SymbolInfo[], source: string, filePath: string, contextLines = 6): SymbolChunk[] {
  const lines = source.split('\n');
  return symbols.map((s, i) => {
    const head = lines.slice(s.line - 1, s.line + contextLines).join('\n'); // decl + context
    return {
      ordinal: i,
      headingPath: `symbol: ${s.name} (${s.kind})`,
      content: `${filePath}:${s.line}\n${head}`,
      tokens: Math.ceil(head.length / 4),
    };
  });
}

/** best-effort symbols for a file: tree-sitter when a grammar is configured
 *  for the extension (even if it yields nothing — a truly declaration-free
 *  file must not fall through to the TS regex), else the v1 regex fallback. */
export async function symbolsFor(source: string, filePath: string, grammars: SymbolGrammars): Promise<SymbolInfo[]> {
  const ext = /(?:^|\.)([a-z0-9]+)$/i.exec(filePath)?.[1]?.toLowerCase() ?? '';
  if (grammars[ext]) return extractSymbolsTree(source, filePath, grammars);
  return extractSymbols(source, filePath);
}

/** pre-warm the WASM parser + configured grammars (one-time; else lazy per
 *  first file of each language) */
export async function prepareGrammars(grammars: SymbolGrammars): Promise<void> {
  const sources = [...new Set(Object.values(grammars))].map((v) => wasmSource(v));
  await Promise.all(sources.map((s) => loadGrammar(s.key, s.src)));
}
