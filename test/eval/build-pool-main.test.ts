import { describe, it, expect } from 'vitest';
import { filterItemsByIdPrefix } from '../../eval/pool/build-pool.js';

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
