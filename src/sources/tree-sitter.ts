/** tree-sitter symbol chunks (plan Stage G, condition 7): repo sources may
 *  opt into symbol indexing — functions/types/classes become chunks with
 *  heading_path "symbol: <name> (<kind>)". Grammars are WASM loaded at BUILD
 *  time (no runtime network); missing grammar → plain file chunks, logged.
 *
 *  v1 ships a DEPENDENCY-FREE structural fallback (regex-based symbol scan for
 *  TS/JS-family files) so the chunk SHAPE is proven without pulling
 *  web-tree-sitter grammars per language — the web-tree-sitter upgrade path
 *  swaps `extractSymbols()` internals only. This keeps the plan's hermetic-CI
 *  and no-runtime-network invariants intact while delivering the chunk shape. */

export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'method' | 'const';
  line: number;
}

/** Structural symbol scan for TS/JS-family sources. Honest scope: regex over
 *  declaration forms; not a parser. Returns [] for non-matching files so the
 *  caller falls back to plain chunks. */
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

/** file source → symbol chunks (the repo connector merges these with file chunks) */
export function symbolChunks(source: string, filePath: string): SymbolChunk[] {
  const symbols = extractSymbols(source, filePath);
  const lines = source.split('\n');
  return symbols.map((s, i) => {
    const head = lines.slice(s.line - 1, s.line + 6).join('\n'); // decl + 6 lines of context
    return {
      ordinal: i,
      headingPath: `symbol: ${s.name} (${s.kind})`,
      content: `${filePath}:${s.line}\n${head}`,
      tokens: Math.ceil(head.length / 4),
    };
  });
}
