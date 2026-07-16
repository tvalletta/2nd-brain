import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { filterItemsByIdPrefix } from '../../eval/pool/build-pool.js';
import { main } from '../../eval/pool/judge-full.js';

// ---------------------------------------------------------------------------
// main() merge-not-clobber path (I-review finding: the pure
// filterItemsByIdPrefix() tests above don't exercise main()'s actual
// file-read -> merge -> write path against a realistic pre-existing
// judgments.json). These mocks stub fs, config loading, and LLM client
// construction so main() runs deterministically, makes zero real LLM calls
// (every candidate here is behaviorally shortcut), and never touches the
// real repo's eval/dataset/judgments.json.
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
      // Disagreement report: real path/date, but under eval/results — swallow
      // rather than writing into the real repo during a test run.
      if (String(path).includes('eval/results')) return;
      return (actual.writeFileSync as (...a: unknown[]) => unknown)(path, data, ...args);
    },
  };
});

vi.mock('../../src/config/loader.js', () => ({
  loadConfig: async () => ({
    llm: { provider: 'bedrock', region: 'us-west-2', maxTokens: 4096, models: { fast: 'x', medium: 'x', heavy: 'x' } },
  }),
}));

vi.mock('../../eval/pool/llm.js', () => ({
  createLLMForTier: vi.fn(() => ({
    complete: vi.fn(async () => {
      throw new Error('unexpected real LLM call in test — every candidate should be behaviorally shortcut');
    }),
    extractStructured: vi.fn(async () => {
      throw new Error('unexpected real LLM call in test — every candidate should be behaviorally shortcut');
    }),
  })),
}));

describe('filterItemsByIdPrefix for judge-full', () => {
  const items = [
    { id: 'decisions-001', query: 'a', intent: '' },
    { id: 'relationship-001', query: 'b', intent: '' },
    { id: 'relationship-002', query: 'c', intent: '' },
    { id: 'fuzzy-001', query: 'd', intent: '' },
  ];

  it('returns all items when no prefix filter is given', () => {
    expect(filterItemsByIdPrefix(items, undefined)).toEqual(items);
  });

  it('returns only items whose id starts with the given prefix', () => {
    expect(filterItemsByIdPrefix(items, 'relationship-')).toEqual([
      { id: 'relationship-001', query: 'b', intent: '' },
      { id: 'relationship-002', query: 'c', intent: '' },
    ]);
  });

  it('supports comma-separated multiple prefixes', () => {
    expect(filterItemsByIdPrefix(items, 'relationship-,fuzzy-')).toEqual([
      { id: 'relationship-001', query: 'b', intent: '' },
      { id: 'relationship-002', query: 'c', intent: '' },
      { id: 'fuzzy-001', query: 'd', intent: '' },
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

  it('merges the filtered subset into pre-existing judgments.json without touching unrelated entries, and replaces (not duplicates) stale entries for re-judged ids', async () => {
    // Simulates ~73 already-settled items via 2 representative unrelated
    // entries, plus one stale entry for an item_id that WILL be re-judged
    // by this --only run (must be replaced, not duplicated).
    const existingJudgments = [
      {
        item_id: 'decisions-001',
        doc_id: 'wiki/decisions/foo.md',
        label: 2,
        reason: 'old reason',
        label_provenance: 'llm',
        judge_a_label: 2,
        judge_b_label: 2,
        disagreement: false,
      },
      {
        item_id: 'relationship-002',
        doc_id: 'wiki/rel/bar.md',
        label: 1,
        reason: 'old reason 2',
        label_provenance: 'behavioral',
      },
      {
        item_id: 'absent-001',
        doc_id: 'stale/doc.md',
        label: 0,
        reason: 'stale judgment to be replaced',
        label_provenance: 'llm',
        judge_a_label: 0,
        judge_b_label: 0,
        disagreement: false,
      },
    ];
    fsState.files.set('eval/dataset/judgments.json', JSON.stringify(existingJudgments));

    const pools = [
      {
        item_id: 'absent-001',
        candidates: [{ doc_id: 'wiki/new/one.md', title: 'One', excerpt: 'exc1', sources: ['behavioral'] }],
      },
      {
        item_id: 'absent-002',
        candidates: [{ doc_id: 'wiki/new/two.md', title: 'Two', excerpt: 'exc2', sources: ['behavioral'] }],
      },
    ];
    fsState.files.set('eval/dataset/pool.json', JSON.stringify(pools));

    const queries = [
      { id: 'decisions-001', query: 'old query', intent: '' },
      { id: 'relationship-002', query: 'another old query', intent: '' },
      { id: 'absent-001', query: 'freshly added query', intent: 'find the new thing' },
      { id: 'absent-002', query: 'second freshly added query', intent: 'find the other new thing' },
    ];
    fsState.files.set('eval/dataset/queries.json', JSON.stringify(queries));

    // Every candidate in both new pools is behaviorally confirmed, so
    // judgeItemFull never calls the (mocked, throwing) judge LLMs.
    const behavioral = [
      { query: 'freshly added query', ts: '2026-07-01T00:00:00Z', opened: ['wiki/new/one.md'] },
      { query: 'second freshly added query', ts: '2026-07-01T00:00:00Z', opened: ['wiki/new/two.md'] },
    ];
    fsState.files.set('eval/dataset/behavioral-signal.json', JSON.stringify(behavioral));

    process.argv = ['node', 'judge-full.ts', '--only=absent-'];

    await main();

    const written = JSON.parse(fsState.files.get('eval/dataset/judgments.json')!);
    expect(written).toHaveLength(4);

    // Unrelated pre-existing entries survive completely unchanged — presence AND content.
    expect(written.find((j: { item_id: string }) => j.item_id === 'decisions-001')).toEqual(existingJudgments[0]);
    expect(written.find((j: { item_id: string }) => j.item_id === 'relationship-002')).toEqual(existingJudgments[1]);

    // The stale judgment for a re-judged item_id is replaced, not duplicated.
    const absent001Entries = written.filter((j: { item_id: string }) => j.item_id === 'absent-001');
    expect(absent001Entries).toHaveLength(1);
    expect(absent001Entries[0].doc_id).toBe('wiki/new/one.md');
    expect(absent001Entries[0]).toMatchObject({ label: 2, label_provenance: 'behavioral' });

    // The brand-new item's judgment is present and correct.
    const absent002 = written.find((j: { item_id: string }) => j.item_id === 'absent-002');
    expect(absent002).toMatchObject({ doc_id: 'wiki/new/two.md', label: 2, label_provenance: 'behavioral' });
  });
});
