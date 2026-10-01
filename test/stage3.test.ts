import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { structuralChunks } from '../src/chunk.ts';
import { fileConnector } from '../src/sources/file.ts';
import { jiraConnector, githubConnector } from '../src/sources/jira-github.ts';
import { repoConnector } from '../src/sources/repo.ts';
import { ingest, sha256Hex } from '../src/sources/connector.ts';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { StorageRetriever } from '../src/memory/retrieval.ts';

let dir: string;
let storage: SqliteStorage;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'butler-s3-'));
  storage = SqliteStorage.memory();
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); storage.close(); });

describe('structural chunking', () => {
  it('markdown: heading-path chunks, hierarchy in path', () => {
    const md = `# Login\nintro text\n## Form\nfill the form\n## Errors\nshow alert\n# Home\ntap home`;
    const chunks = structuralChunks(md, 'markdown');
    expect(chunks.map((c) => c.headingPath)).toEqual(['Login', 'Login / Form', 'Login / Errors', 'Home']);
    expect(chunks[1]!.content).toContain('fill the form');
  });

  it('diff: one chunk per FILE (hunks together), path as heading', () => {
    const diff = `--- a/src/one.ts\n+++ b/src/one.ts\n@@ -1,2 +1,3 @@\n line\n+added\n--- a/src/two.ts\n+++ b/src/two.ts\n@@ -5,3 +5,4 @@\n ctx\n+new`;
    const chunks = structuralChunks(diff, 'diff');
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.headingPath).toBe('src/one.ts');
    expect(chunks[1]!.headingPath).toBe('src/two.ts');
    // both hunks of one.ts stayed together
    expect(chunks[0]!.content).toContain('+added');
    expect(chunks.every((c) => c.content.includes('@@'))).toBe(true);
  });

  it('jira-ticket: one chunk per FIELD: line', () => {
    const doc = `KEY: QA-1\nSUMMARY: login broken\nDESCRIPTION: the submit button does nothing\nCOMMENT (qa): repro on v2.3`;
    const chunks = structuralChunks(doc, 'jira-ticket');
    expect(chunks.length).toBe(4);
    expect(chunks[0]!.headingPath).toBe('KEY');
    expect(chunks[2]!.content).toContain('submit button');
  });

  it('plain text without structure → single chunk fallback', () => {
    expect(structuralChunks('just words', 'jira-ticket').length).toBe(1);
  });
});

describe('file connector + ingest', () => {
  it('ingests markdown tickets → documents + chunks, cache-first on re-ingest', async () => {
    writeFileSync(join(dir, 'ticket-1.md'), `# QA-101 Login regression\nsteps: open login, tap submit\nexpected: dashboard`);
    writeFileSync(join(dir, 'ticket-2.md'), `# QA-102 Logout crash\nlogout from profile crashes on iOS 26`);
    const conn = fileConnector('src_files', { root: dir });
    const r1 = await ingest(conn, storage, { artifactsDir: dir });
    expect(r1.documents.length).toBe(2);
    expect(r1.documents.every((d) => !d.cached && d.chunks > 0)).toBe(true);

    // re-ingest: same content → cached, chunks NOT re-written
    const r2 = await ingest(conn, storage, { artifactsDir: dir });
    expect(r2.documents.every((d) => d.cached)).toBe(true);

    // document rows carry provenance
    const doc = await storage.getDocument(r1.documents[0]!.sha256);
    expect(doc!.uri).toBe('file://ticket-1.md');
    expect(doc!.source_id).toBe('src_files');
  });

  it('binary files skip text content; stored via writeBinary hook', async () => {
    writeFileSync(join(dir, 'mock.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const wrote: string[] = [];
    const conn = fileConnector('src_files', { root: dir });
    const r = await ingest(conn, storage, { artifactsDir: dir, writeBinary: async (sha) => { wrote.push(sha); return `${dir}/${sha}.bin`; } });
    const bin = r.documents.find((d) => d.uri === 'file://mock.png');
    expect(bin).toBeTruthy();
    expect(wrote).toContain(bin!.sha256);
    const doc = await storage.getDocument(bin!.sha256);
    expect(doc!.content).toBeNull();
    expect(doc!.bytes_path).toBe(`${dir}/${bin!.sha256}.bin`);
  });

  it('oversize text truncates at the 2 MB cap with marker', async () => {
    const big = `${'x'.repeat(2 * 1024 * 1024 + 50_000)}`;
    writeFileSync(join(dir, 'big.md'), big);
    const conn = fileConnector('src_files', { root: dir });
    const r = await ingest(conn, storage, { artifactsDir: dir });
    const doc = await storage.getDocument(r.documents.find((d) => d.uri === 'file://big.md')!.sha256);
    expect(doc!.content!.length).toBeLessThanOrEqual(2 * 1024 * 1024 + 100);
    expect(doc!.content!.endsWith('[truncated at 2 MB cap]')).toBe(true);
  });
});

describe('jira + github connectors (recorded responses — no live network)', () => {
  const jiraBody = {
    issues: [{
      key: 'QA-9',
      fields: {
        summary: 'terms screen blank',
        description: 'opening terms shows white screen on v3',
        status: { name: 'Open' },
        comment: { comments: [{ author: { displayName: 'Rina' }, body: 'repro on staging' }] },
        attachment: [{ filename: 'screenshot.png', id: '1' }],
      },
    }],
  };

  it('jira: normalizes issues into field docs', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      expect(String(url)).toContain('/rest/api/3/search/jql');
      return new Response(JSON.stringify(jiraBody), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const conn = jiraConnector('src_jira', { baseUrl: 'https://j.example', project: 'QA' }, fetchImpl);
    const docs = await conn.fetch();
    expect(docs.length).toBe(1);
    expect(docs[0]!.uri).toBe('jira://QA-9');
    expect(docs[0]!.content).toContain('DESCRIPTION: opening terms shows white screen');
    expect(docs[0]!.content).toContain('COMMENT (Rina): repro on staging');

    // end-to-end: ingest → chunks → retrieval finds it
    const r = await ingest(conn, storage, { artifactsDir: dir });
    expect(r.documents[0]!.chunks).toBeGreaterThan(3);
    const retr = new StorageRetriever(storage);
    const all = await storage.documentChunks(r.documents[0]!.sha256);
    retr.registerChunks(all);
    const hit = await retr.retrieve('terms screen white blank', 3);
    expect(hit.some((h) => h.content.includes('white screen'))).toBe(true);
  });

  it('jira error → typed failure with status', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as typeof fetch;
    const conn = jiraConnector('src_jira_bad', { baseUrl: 'https://j.example', project: 'QA' }, fetchImpl);
    await expect(conn.fetch()).rejects.toThrow(/403/);
  });

  it('github: issues + PR + diff normalized; field discipline shared', async () => {
    const fetchImpl = (async (url: string | Request, init?: RequestInit) => {
      const u = String(url);
      const accept = (init?.headers as Record<string, string>)?.['accept'] ?? '';
      if (accept.includes('diff')) {
        return new Response('--- a/app.ts\n+++ b/app.ts\n@@ -1 +1,2 @@\n old\n+new line', { status: 200 });
      }
      if (u.includes('/issues/7') || u.includes('/pulls/7')) {
        return new Response(JSON.stringify({ number: 7, title: 'fix login', body: 'the fix', state: 'open', user: { login: 'dev' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/issues?')) {
        return new Response(JSON.stringify([{ number: 7, title: 'fix login', body: 'b', state: 'open', user: { login: 'dev' } }]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const conn = githubConnector('src_gh', { repo: 'acme/app', pulls: [7] }, fetchImpl);
    const docs = await conn.fetch();
    const uris = docs.map((d) => d.uri);
    expect(uris).toContain('github://acme/app/pulls/7');
    expect(uris).toContain('github://acme/app/pulls/7.diff');
    const diff = docs.find((d) => d.kind === 'diff')!;
    expect(diff.content).toContain('@@');
    const chunks = structuralChunks(diff.content ?? '', 'diff');
    expect(chunks[0]!.headingPath).toBe('app.ts');
  });
});

describe('repo connector', () => {
  it('local path: tree doc + file docs, skips binaries and node_modules', async () => {
    const repoDir = join(dir, 'repo');
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    mkdirSync(join(repoDir, 'node_modules', 'junk'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'login.ts'), 'export const login = () => true;\n');
    writeFileSync(join(repoDir, 'README.md'), '# demo repo\nlogin lives in src/login.ts');
    writeFileSync(join(repoDir, 'logo.png'), Buffer.from([0x89, 0x50]));
    writeFileSync(join(repoDir, 'node_modules', 'junk', 'x.ts'), 'junk');
    const conn = repoConnector('src_repo', { origin: repoDir });
    const docs = await conn.fetch();
    const uris = docs.map((d) => d.uri);
    expect(uris).toContain('repo://tree');
    expect(uris).toContain('repo://src/login.ts');
    expect(uris.some((u) => u.includes('node_modules'))).toBe(false);
    expect(uris.some((u) => u.endsWith('.png'))).toBe(false);
    // tree lists text files only
    const tree = docs.find((d) => d.uri === 'repo://tree')!;
    expect(tree.content).toContain('src/login.ts');
    expect(tree.content).not.toContain('logo.png');
  });
});

describe('content addressing', () => {
  it('same content → same sha (across sources); sha is stable', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
    expect(sha256Hex('hello')).not.toBe(sha256Hex('hellp'));
    expect(sha256Hex('hello')).toMatch(/^[a-f0-9]{64}$/);
  });
});
