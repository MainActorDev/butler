/** Structural chunking (plan Stage 3): boundaries follow document structure —
 *  markdown headings, ticket fields, diff hunks, file boundaries — never naive
 *  fixed windows (RAG survey / RAPTOR grounding, plan D6). */

export interface StructuralChunk {
  ordinal: number;
  headingPath: string;
  content: string;
  tokens: number;
}

function est(text: string): number { return Math.ceil(text.length / 4); }

/** markdown: one chunk per heading section (root preface if any) */
function chunkMarkdown(text: string): Array<{ path: string; body: string }> {
  const lines = text.split('\n');
  const out: Array<{ path: string; body: string }> = [];
  let path = '';
  let buf: string[] = [];
  const flush = () => { const body = buf.join('\n').trim(); if (body) out.push({ path, body }); buf = []; };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const level = m[1]!.length;
      const parts = path ? path.split(' / ') : [];
      parts.length = level - 1;
      parts[level - 1] = m[2]!.trim();
      path = parts.filter(Boolean).join(' / ');
      buf.push(line);
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/** diff: one chunk per FILE section (all its hunks together), path from +++ */
function chunkDiff(text: string): Array<{ path: string; body: string }> {
  const out: Array<{ path: string; body: string }> = [];
  let file = '';
  let buf: string[] = [];
  const flush = () => { const body = buf.join('\n').trim(); if (body) out.push({ path: file, body }); buf = []; };
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ')) {
      flush();
      file = line.replace(/^\+\+\+ /, '').replace(/^b\//, '');
      buf.push(line);
    } else if (file) {
      buf.push(line);
    } // preface before the first +++ is skipped (no file yet)
  }
  flush();
  return out;
}

/** jira ticket (normalized fields doc): one chunk per field */
function chunkTicket(text: string): Array<{ path: string; body: string }> {
  const out: Array<{ path: string; body: string }> = [];
  for (const line of text.split('\n')) {
    const m = /^([A-Z][A-Za-z0-9 _()\-]{1,48}):\s*(.*)$/.exec(line);
    if (m) out.push({ path: m[1]!.trim(), body: line.trim() });
  }
  // prose fallback when no field structure matched
  if (out.length === 0 && text.trim()) out.push({ path: '', body: text.trim() });
  return out;
}

export function structuralChunks(text: string, kind: string): StructuralChunk[] {
  const parts = kind === 'diff' ? chunkDiff(text)
    : kind === 'jira-ticket' ? chunkTicket(text)
    : chunkMarkdown(text); // default: markdown-ish (headings; harmless without)
  return parts.map((p, i) => ({ ordinal: i, headingPath: p.path, content: p.body, tokens: est(p.body) }));
}
