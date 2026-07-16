import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { filterItemsByIdPrefix, main } from '../../eval/pool/build-pool.js';

// ---------------------------------------------------------------------------
// main() merge-not-clobber path (I-review finding: the pure
// filterItemsByIdPrefix() tests above don't exercise main()'s actual
// file-read -> merge -> write path against a realistic pre-existing
// pool.json). These mocks stub every real-world dependency (fs, the sqlite
// db, the search variants, config loading) so main() runs deterministically
// and never touches the real repo's eval/dataset/pool.json.
// ---------------------------------------------------------------------------

const fsState = vi.hoisted(() => ({ files: new Map<string, string>() }));

function datasetKey(path: string): string | undefined {
  const suffixes = [
    'eval/dataset/queries.json',
    'eval/dataset/behavioral-signal.json',
    'eval/dataset/pool.json',
    'eval/dataset/judgments.json',
  ];
  return suffixes.find((s) => path.endsWith(s));
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (path: unknown, ...args: unknown[]) => {
      const key = datasetKey(String(path));
      if (key) {
        if (!fsState.files.has(key)) {
          const err = Object.assign(new Error(`ENOENT (mocked): ${key}`), { code: 'ENOENT' });
          throw err;
        }
        return fsState.files.get(key)!;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...args);
    },
    writeFileSync: (path: unknown, data: unknown, ...args: unknown[]) => {
      const key = datasetKey(String(path));
      if (key) {
        fsState.files.set(key, String(data));
        return;
      }
      return (actual.writeFileSync as (...a: unknown[]) => unknown)(path, data, ...args);
    },
  };
});

vi.mock('better-sqlite3', () => ({
  default: class FakeDatabase {
    prepare() {
      return { get: () => undefined };
    }
    close() {}
  },
}));

vi.mock('../../eval/run/variants.js', () => ({
  buildVariants: () => [
    {
      name: 'grep-first',
      keywordOnly: true,
      topK: 20,
      openStore: () => ({ search: async () => ({}), fts: { query: () => ({ hits: [] }) }, close: () => {} }),
      profile: {},
    },
    {
      name: 'as-deployed',
      keywordOnly: false,
      topK: 20,
      openStore: () => ({ search: async () => ({}), fts: { query: () => ({ hits: [] }) }, close: () => {} }),
      profile: {},
    },
  ],
}));

vi.mock('../../eval/run/normalize.js', () => ({
  toRunHits: () => [],
}));

vi.mock('../../src/config/loader.js', () => ({
  loadConfig: async () => ({
    stateDir: '.karpathy/state',
    vaultPath: '/fake/vault',
    embeddings: { provider: 'deterministic' },
  }),
}));

describe('filterItemsByIdPrefix', () => {
  const items = [
    { id: 'decisions-001', query: 'a' },
    { id: 'relationship-001', query: 'b' },
    { id: 'relationship-002', query: 'c' },
    { id: 'fuzzy-001', query: 'd' },
  ];

  it('returns all items when no prefix filter is given', () => {
    expect(filterItemsByIdPrefix(items, undefined)).toEqual(items);
  });

  it('returns only items whose id starts with the given prefix', () => {
    expect(filterItemsByIdPrefix(items, 'relationship-')).toEqual([
      { id: 'relationship-001', query: 'b' },
      { id: 'relationship-002', query: 'c' },
    ]);
  });

  it('supports comma-separated multiple prefixes', () => {
    expect(filterItemsByIdPrefix(items, 'relationship-,fuzzy-')).toEqual([
      { id: 'relationship-001', query: 'b' },
      { id: 'relationship-002', query: 'c' },
      { id: 'fuzzy-001', query: 'd' },
    ]);
  });
});

describe('main() --only merge path', () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
    fsState.files.clear();
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('merges the filtered subset into pre-existing pool.json without touching unrelated entries, and replaces (not duplicates) stale entries for re-pooled ids', async () => {
    // Simulates ~73 already-settled items via 2 representative unrelated
    // entries, plus one stale entry for an item_id that WILL be re-pooled
    // by this --only run (must be replaced, not duplicated).
    const existingPool = [
      {
        item_id: 'decisions-001',
        candidates: [
          { doc_id: 'wiki/decisions/foo.md', title: 'Foo Decision', excerpt: 'old excerpt', sources: ['grep-first'] },
        ],
      },
      {
        item_id: 'relationship-002',
        candidates: [
          { doc_id: 'wiki/rel/bar.md', title: 'Bar', excerpt: 'bar excerpt', sources: ['as-deployed', 'keyword-sweep'] },
        ],
      },
      {
        item_id: 'absent-001',
        candidates: [{ doc_id: 'stale/doc.md', title: 'Stale', excerpt: 'stale excerpt', sources: ['grep-first'] }],
      },
    ];
    fsState.files.set('eval/dataset/pool.json', JSON.stringify(existingPool));

    const queries = [
      { id: 'decisions-001', query: 'old query' },
      { id: 'relationship-002', query: 'another old query' },
      { id: 'absent-001', query: 'freshly added query' },
      { id: 'absent-002', query: 'second freshly added query' },
    ];
    fsState.files.set('eval/dataset/queries.json', JSON.stringify(queries));

    const behavioral = [
      { query: 'freshly added query', ts: '2026-07-01T00:00:00Z', opened: ['wiki/new/one.md'] },
      { query: 'second freshly added query', ts: '2026-07-01T00:00:00Z', opened: ['wiki/new/two.md'] },
    ];
    fsState.files.set('eval/dataset/behavioral-signal.json', JSON.stringify(behavioral));

    process.argv = ['node', 'build-pool.ts', '--only=absent-'];

    await main();

    const written = JSON.parse(fsState.files.get('eval/dataset/pool.json')!);
    expect(written).toHaveLength(4);

    // Unrelated pre-existing entries survive completely unchanged — presence AND content.
    expect(written.find((p: { item_id: string }) => p.item_id === 'decisions-001')).toEqual(existingPool[0]);
    expect(written.find((p: { item_id: string }) => p.item_id === 'relationship-002')).toEqual(existingPool[1]);

    // The stale entry for a re-pooled item_id is replaced, not duplicated.
    const absent001Entries = written.filter((p: { item_id: string }) => p.item_id === 'absent-001');
    expect(absent001Entries).toHaveLength(1);
    const absent001Candidates = absent001Entries[0].candidates as { doc_id: string; sources: string[] }[];
    expect(absent001Candidates.find((c) => c.doc_id === 'stale/doc.md')).toBeUndefined();
    const one = absent001Candidates.find((c) => c.doc_id === 'wiki/new/one.md');
    expect(one).toMatchObject({ doc_id: 'wiki/new/one.md', title: 'wiki/new/one.md', sources: ['behavioral'] });

    // The brand-new item's pool is present and correct.
    const absent002 = written.find((p: { item_id: string }) => p.item_id === 'absent-002');
    expect(absent002).toBeDefined();
    const two = (absent002.candidates as { doc_id: string; sources: string[] }[]).find((c) => c.doc_id === 'wiki/new/two.md');
    expect(two).toMatchObject({ doc_id: 'wiki/new/two.md', title: 'wiki/new/two.md', sources: ['behavioral'] });
  });
});
