import { writeFileSync } from 'node:fs';
import type { Judgment } from './judge.js';

/** Render a small, non-blocking diagnostic report listing every candidate
 * where the two judges disagreed by 2+ points. No checkboxes, no gate — for
 * whenever a human chooses to look, not something anyone must review. */
export function renderDisagreementReport(judgments: Judgment[]): string {
  const disagreements = judgments.filter((j) => j.disagreement);
  const lines: string[] = [
    '# Judge Disagreement Log',
    '',
    `${disagreements.length} candidate(s) where the two judges disagreed by 2+ points (out of ${judgments.length} total judgments). This is a diagnostic artifact, not a review requirement — nothing is blocked on it.`,
    '',
  ];
  if (disagreements.length === 0) {
    lines.push('No disagreements found.');
    return lines.join('\n');
  }
  const byItem = new Map<string, Judgment[]>();
  for (const j of disagreements) {
    if (!byItem.has(j.item_id)) byItem.set(j.item_id, []);
    byItem.get(j.item_id)!.push(j);
  }
  for (const [itemId, items] of byItem) {
    lines.push(`## ${itemId}`, '');
    for (const j of items) {
      lines.push(`- **${j.doc_id}** — medium judge: ${j.judge_a_label}, heavy judge: ${j.judge_b_label}, reconciled to: ${j.label} — ${j.reason}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function writeDisagreementReport(path: string, judgments: Judgment[]): void {
  writeFileSync(path, renderDisagreementReport(judgments));
}
