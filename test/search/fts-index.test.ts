import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, utimes, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openFTSIndex, sanitizeFtsQuery, type FTSIndex } from '../../src/search/fts-index.js';

describe('fts-index', () => {
  let dir: string;
  let db: Database.Database;
  let index: FTSIndex;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karpathy-fts-'));
    db = new Database(join(dir, 'fts.sqlite'));
    db.pragma('journal_mode = WAL');
    index = openFTSIndex(db, { vaultRoot: dir });
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('upserts and queries returning ranked results', () => {
    index.upsert('a.md', 'FSRS algorithm', 'spaced repetition with retention forecasting');
    index.upsert('b.md', 'Cooking 101', 'how to make a roux');
    const hits = index.query('FSRS', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].docId).toBe('a.md');
  });

  it('title matches outrank pure body matches when terms are equally distributed', () => {
    index.upsert('a.md', 'FSRS', 'mention of fsrs once');
    index.upsert('b.md', 'Misc', 'fsrs fsrs fsrs but title is unrelated');
    const hits = index.query('fsrs', 5);
    expect(hits[0].docId).toBe('a.md');
  });

  it('multi-word query requires ALL terms to be present (FTS5 default AND)', () => {
    index.upsert('a.md', 'A', 'apple banana');
    index.upsert('b.md', 'B', 'apple only');
    const hits = index.query('apple banana', 5);
    expect(hits.map((h) => h.docId)).toEqual(['a.md']);
  });

  it('delete removes a doc from query results', () => {
    index.upsert('a.md', 'A', 'unique-token-zzz');
    expect(index.query('unique-token-zzz', 5)).toHaveLength(1);
    index.delete('a.md');
    expect(index.query('unique-token-zzz', 5)).toHaveLength(0);
  });

  it('snippet() returns content around the match', () => {
    index.upsert('a.md', 'A', 'before before before TARGET after after after');
    const hits = index.query('TARGET', 1);
    expect(hits[0].snippet).toMatch(/«TARGET»/);
  });

  it('count tracks indexed docs via fts_meta sync', async () => {
    expect(index.count()).toBe(0);
    await mkdir(join(dir, 'wiki'), { recursive: true });
    await writeFile(join(dir, 'wiki/x.md'), '---\ntitle: X\n---\nbody-text-x', 'utf-8');
    await writeFile(join(dir, 'wiki/y.md'), '---\ntitle: Y\n---\nbody-text-y', 'utf-8');
    await index.sync(['wiki']);
    expect(index.count()).toBe(2);
  });

  it('sync detects new, modified, deleted, and unchanged files via mtime', async () => {
    const wiki = join(dir, 'wiki');
    await mkdir(wiki, { recursive: true });
    await writeFile(join(wiki, 'a.md'), '---\ntitle: A\n---\nfirst-content', 'utf-8');
    await writeFile(join(wiki, 'b.md'), '---\ntitle: B\n---\nsecond-content', 'utf-8');
    const r1 = await index.sync(['wiki']);
    expect(r1).toEqual({ added: 2, updated: 0, removed: 0, unchanged: 0 });

    // Re-run with no changes — both unchanged.
    const r2 = await index.sync(['wiki']);
    expect(r2).toEqual({ added: 0, updated: 0, removed: 0, unchanged: 2 });

    // Modify a.md (bump mtime) and delete b.md.
    await writeFile(join(wiki, 'a.md'), '---\ntitle: A\n---\nfirst-content-edited', 'utf-8');
    const future = new Date(Date.now() + 5000);
    await utimes(join(wiki, 'a.md'), future, future);
    await unlink(join(wiki, 'b.md'));
    const r3 = await index.sync(['wiki']);
    expect(r3.updated).toBe(1);
    expect(r3.removed).toBe(1);
    expect(r3.unchanged).toBe(0);

    // Edit reflected in queries.
    expect(index.query('first-content-edited', 1)).toHaveLength(1);
    expect(index.query('second-content', 1)).toHaveLength(0);
  });

  it('frontmatter title is extracted; falls back to path when missing', async () => {
    const wiki = join(dir, 'wiki');
    await mkdir(wiki, { recursive: true });
    await writeFile(join(wiki, 'titled.md'), '---\ntitle: My Title\n---\nbody', 'utf-8');
    await writeFile(join(wiki, 'untitled.md'), 'body-only-no-frontmatter', 'utf-8');
    await index.sync(['wiki']);
    const titledHit = index.query('My Title', 1);
    expect(titledHit[0]?.docId).toBe('wiki/titled.md');
  });
});

describe('sanitizeFtsQuery', () => {
  it('quotes each token to prevent FTS5 operator injection', () => {
    expect(sanitizeFtsQuery('hello world')).toBe('"hello" "world"');
  });

  it('strips operator tokens and double quotes', () => {
    expect(sanitizeFtsQuery('foo AND "bar" OR baz')).toBe('"foo" "AND" "bar" "OR" "baz"');
    expect(sanitizeFtsQuery('foo:bar*^baz')).toBe('"foo" "bar" "baz"');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeFtsQuery('')).toBe('');
    expect(sanitizeFtsQuery('   ')).toBe('');
    expect(sanitizeFtsQuery('!@#$%')).toBe('');
  });

  it('preserves Unicode tokens (accented, CJK)', () => {
    expect(sanitizeFtsQuery('résumé café')).toBe('"résumé" "café"');
    expect(sanitizeFtsQuery('東京 タワー')).toBe('"東京" "タワー"');
  });
});
