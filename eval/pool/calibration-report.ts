import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalItem } from '../dataset/types.js';
import type { TriageProposal } from '../dataset/triage.js';
import type { Judgment } from './judge.js';
import type { ItemPool } from './build-pool.js';

/** Pick a stratified sample across (category, subtype) pairs — round-robin
 * one item per group per round, so no single group dominates a small sample.
 * Deterministic: groups sorted by key, items within a group sorted by id. */
export function stratifiedSample(items: EvalItem[], size: number): EvalItem[] {
  const groups = new Map<string, EvalItem[]>();
  for (const it of items) {
    const key = `${it.category}::${it.subtype}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(it);
  }
  for (const group of groups.values()) group.sort((a, b) => a.id.localeCompare(b.id));

  const keys = [...groups.keys()].sort();
  const sample: EvalItem[] = [];
  let round = 0;
  while (sample.length < size && keys.some((k) => (groups.get(k)?.length ?? 0) > round)) {
    for (const key of keys) {
      if (sample.length >= size) break;
      const group = groups.get(key)!;
      if (round < group.length) sample.push(group[round]);
    }
    round += 1;
  }
  return sample;
}

export function renderCalibrationReport(
  items: EvalItem[],
  judgmentsByItem: Map<string, Judgment[]>,
  triageByItemId?: Map<string, TriageProposal>,
): string {
  const lines: string[] = ['# Judge Calibration Sample', '', "For each candidate, mark agree or write a correction.", ''];

  if (triageByItemId && triageByItemId.size > 0) {
    lines.push('## Category/Subtype Triage Proposals', '');
    for (const [id, proposal] of triageByItemId) {
      lines.push(
        `- **${id}** -> category: ${proposal.proposed_category}, subtype: ${proposal.proposed_subtype}${proposal.drop ? ', DROP' : ''} — ${proposal.reason}`,
      );
      lines.push(`  - Tom's call: [ ] agree   [ ] correct to: ____`);
    }
    lines.push('');
  }

  for (const item of items) {
    lines.push(`## ${item.id}`, '', `**Query:** ${item.query}`, `**Intent:** ${item.intent || '(none)'}`, `**Category/Subtype:** ${item.category} / ${item.subtype}`, '');
    const judgments = judgmentsByItem.get(item.id) ?? [];
    if (judgments.length === 0) {
      lines.push('_(no pooled candidates)_', '');
      continue;
    }
    for (const j of judgments) {
      lines.push(`- **${j.doc_id}** — label ${j.label} — ${j.reason}`);
      lines.push(`  - Tom's call: [ ] agree   [ ] correct to: ____`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function writeCalibrationReport(
  path: string,
  items: EvalItem[],
  judgmentsByItem: Map<string, Judgment[]>,
  triageByItemId?: Map<string, TriageProposal>,
): void {
  writeFileSync(path, renderCalibrationReport(items, judgmentsByItem, triageByItemId));
}

const REPO_ROOT = join(import.meta.dirname, '..', '..');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { loadConfig } = await import('../../src/config/loader.js');
  const { createLLMForTier } = await import('./llm.js');
  const { judgeItem } = await import('./judge.js');

  const items: EvalItem[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8'));
  const triageProposals: TriageProposal[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval/dataset/triage-proposals.json'), 'utf8'),
  );
  const triageByItemId = new Map(triageProposals.map((p) => [p.id, p]));
  const pools: ItemPool[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/pool.json'), 'utf8'));
  const poolByItemId = new Map(pools.map((p) => [p.item_id, p]));

  // Stratify using triage-proposed categories/subtypes when available (a
  // preview, not applied back to queries.json — applying corrections is a
  // later, human-gated step).
  const itemsForStratification: EvalItem[] = items.map((it) => {
    const proposal = triageByItemId.get(it.id);
    if (!proposal || proposal.drop) return it;
    return { ...it, category: proposal.proposed_category, subtype: proposal.proposed_subtype };
  });
  const dropped = new Set(
    [...triageByItemId.values()].filter((p) => p.drop).map((p) => p.id),
  );
  const eligible = itemsForStratification.filter((it) => !dropped.has(it.id) && poolByItemId.has(it.id));

  const sample = stratifiedSample(eligible, 20);
  console.log(`Selected ${sample.length} calibration items across ${new Set(sample.map((it) => `${it.category}::${it.subtype}`)).size} category/subtype groups`);

  if (dryRun) {
    console.log('[dry-run] would judge:', sample.map((it) => it.id));
    return;
  }

  const config = await loadConfig(REPO_ROOT);
  const llm = createLLMForTier(config, 'medium');
  const judgmentsByItem = new Map<string, Judgment[]>();
  const allJudgments: Judgment[] = [];
  const failedItemIds: string[] = [];
  for (const item of sample) {
    const pool = poolByItemId.get(item.id)!;
    try {
      const judgments = await judgeItem(llm, item, pool);
      judgmentsByItem.set(item.id, judgments);
      allJudgments.push(...judgments);
      console.log(`Judged ${item.id}: ${judgments.length} labels`);
    } catch (err) {
      // A single item's LLM response occasionally fails structured-output
      // parsing (e.g. a pooled candidate's excerpt contains a quote
      // character the model echoes back unescaped in `reason`). Don't let
      // one bad item crash the whole calibration run and re-bill every
      // item judged before it — log clearly and continue. NOTE: this item
      // will render as "(no pooled candidates)" below even though it had
      // real candidates; see console output / task report for which items
      // this affected.
      console.error(`Judge call FAILED for ${item.id} (pool had ${pool.candidates.length} candidates) — skipping: ${(err as Error).message}`);
      judgmentsByItem.set(item.id, []);
      failedItemIds.push(item.id);
    }
  }
  if (failedItemIds.length > 0) {
    console.error(`${failedItemIds.length} item(s) failed judging and were skipped: ${failedItemIds.join(', ')}`);
  }

  writeFileSync(join(REPO_ROOT, 'eval/dataset/judgments.json'), JSON.stringify(allJudgments, null, 2));
  console.log(`Wrote eval/dataset/judgments.json: ${allJudgments.length} judgments across ${sample.length} calibration items (NOT the full pool — full-scale judging is a later, gated step)`);

  const outDir = join(REPO_ROOT, 'eval', 'results');
  mkdirSync(outDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const outPath = join(outDir, `${date}-calibration-sample.md`);
  writeCalibrationReport(outPath, sample, judgmentsByItem, triageByItemId);
  console.log(`Wrote calibration report to eval/results/${date}-calibration-sample.md`);
}

if (process.argv[1]?.endsWith('calibration-report.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
