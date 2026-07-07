import type { ItemPool, PoolCandidate, BehavioralEntry } from './build-pool.js';
import type { Judgment } from './judge.js';

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Split an item's pool into candidates confirmed relevant by real
 * behavioral evidence (Tom actually opened this note after a matching real
 * search) vs. candidates that still need LLM judging. Behaviorally-confirmed
 * candidates never need a judge call — real usage is stronger evidence than
 * any LLM's opinion. */
export function applyBehavioralShortcut(
  item: { id: string; query: string },
  pool: ItemPool,
  behavioral: BehavioralEntry[],
): { shortcut: Judgment[]; remaining: ItemPool } {
  const match = behavioral.find((b) => norm(b.query) === norm(item.query));
  const openedDocIds = new Set(match?.opened ?? []);

  const shortcut: Judgment[] = [];
  const remainingCandidates: PoolCandidate[] = [];
  for (const c of pool.candidates) {
    if (openedDocIds.has(c.doc_id)) {
      shortcut.push({
        item_id: item.id,
        doc_id: c.doc_id,
        label: 2,
        reason: 'Confirmed relevant by real behavioral signal (opened after a matching real search).',
        label_provenance: 'behavioral',
      });
    } else {
      remainingCandidates.push(c);
    }
  }
  return { shortcut, remaining: { item_id: pool.item_id, candidates: remainingCandidates } };
}
