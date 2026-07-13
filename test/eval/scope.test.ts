import { describe, it, expect } from 'vitest';
import { restrictToScope, SCOPE_MATCHED_PREFIXES } from '../../eval/score/scope.js';
import type { RunHit } from '../../eval/run/types.js';

function hit(path: string): RunHit {
  return { path, rank: 0, final: 1, excerpt: '' };
}

describe('SCOPE_MATCHED_PREFIXES', () => {
  it('is the exact 4-folder list search-vault.ts scans by default (spec §7.6/§19)', () => {
    expect(SCOPE_MATCHED_PREFIXES).toEqual([
      'Curated/wiki',
      'AI Conversations/_summaries',
      'Curated/sources',
      'Curated/review',
    ]);
  });
});

describe('restrictToScope', () => {
  it('keeps only returned hits under the 4 scope-matched prefixes', () => {
    const returned = [hit('Curated/wiki/foo.md'), hit('Plaud/bar.md'), hit('Curated/sources/baz.md')];
    const relevant = new Set(['Curated/wiki/foo.md', 'Plaud/bar.md']);
    const restricted = restrictToScope(returned, relevant);
    expect(restricted.returned.map((h) => h.path)).toEqual(['Curated/wiki/foo.md', 'Curated/sources/baz.md']);
  });

  it('keeps only relevant doc_ids under the 4 scope-matched prefixes', () => {
    const relevant = new Set(['Curated/wiki/foo.md', 'Plaud/bar.md', 'Curated/review/baz.md']);
    const restricted = restrictToScope([], relevant);
    expect(restricted.relevantDocIds).toEqual(new Set(['Curated/wiki/foo.md', 'Curated/review/baz.md']));
  });

  it('is a prefix match, not exact-equality — a path just under the folder still counts', () => {
    const returned = [hit('Curated/sources/deep/nested/note.md')];
    const restricted = restrictToScope(returned, new Set());
    expect(restricted.returned).toHaveLength(1);
  });
});
