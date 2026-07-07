import { describe, it, expect } from 'vitest';
import { applyBehavioralShortcut } from '../../eval/pool/behavioral-shortcut.js';
import type { ItemPool, BehavioralEntry } from '../../eval/pool/build-pool.js';

describe('applyBehavioralShortcut', () => {
  const pool: ItemPool = {
    item_id: 'x-001',
    candidates: [
      { doc_id: 'a.md', title: 'A', excerpt: 'exc-a', sources: ['grep-first'] },
      { doc_id: 'b.md', title: 'B', excerpt: 'exc-b', sources: ['as-deployed'] },
    ],
  };

  it('shortcuts a candidate whose doc_id was actually opened after a matching real search', () => {
    const behavioral: BehavioralEntry[] = [
      { query: 'what did we decide about x', ts: '2026-01-01T00:00:00Z', opened: ['a.md'] },
    ];
    const { shortcut, remaining } = applyBehavioralShortcut(
      { id: 'x-001', query: 'What did we decide about X' }, // case/whitespace differs, should still match via normalization
      pool,
      behavioral,
    );
    expect(shortcut).toHaveLength(1);
    expect(shortcut[0]).toMatchObject({ item_id: 'x-001', doc_id: 'a.md', label: 2, label_provenance: 'behavioral' });
    expect(remaining.candidates).toHaveLength(1);
    expect(remaining.candidates[0].doc_id).toBe('b.md');
  });

  it('shortcuts nothing when no behavioral entry matches the query', () => {
    const behavioral: BehavioralEntry[] = [
      { query: 'a totally different query', ts: '2026-01-01T00:00:00Z', opened: ['a.md'] },
    ];
    const { shortcut, remaining } = applyBehavioralShortcut({ id: 'x-001', query: 'what did we decide about x' }, pool, behavioral);
    expect(shortcut).toHaveLength(0);
    expect(remaining.candidates).toHaveLength(2);
  });

  it('shortcuts nothing when the matched entry opened a doc_id not in this pool', () => {
    const behavioral: BehavioralEntry[] = [
      { query: 'what did we decide about x', ts: '2026-01-01T00:00:00Z', opened: ['some-other-doc.md'] },
    ];
    const { shortcut, remaining } = applyBehavioralShortcut({ id: 'x-001', query: 'what did we decide about x' }, pool, behavioral);
    expect(shortcut).toHaveLength(0);
    expect(remaining.candidates).toHaveLength(2);
  });
});
