import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import type { ItemPool, BehavioralEntry } from './build-pool.js';
import { filterItemsByIdPrefix } from './build-pool.js';
import { judgeItem, reconcileJudgments, type Judgment } from './judge.js';
import { applyBehavioralShortcut } from './behavioral-shortcut.js';
import { writeDisagreementReport } from './disagreement-report.js';

/** Judge one item end-to-end: behavioral shortcut first, then dual-judge
 * (medium + heavy tier) reconciliation for whatever candidates remain. Zero
 * LLM calls are made if every candidate is behaviorally shortcut. */
export async function judgeItemFull(
  judgeA: LLMClient,
  judgeB: LLMClient,
  item: { id: string; query: string; intent: string },
  pool: ItemPool,
  behavioral: BehavioralEntry[],
): Promise<Judgment[]> {
  const { shortcut, remaining } = applyBehavioralShortcut(item, pool, behavioral);
  if (remaining.candidates.length === 0) return shortcut;

  const [judgmentsA, judgmentsB] = await Promise.all([
    judgeItem(judgeA, item, remaining),
    judgeItem(judgeB, item, remaining),
  ]);
  const reconciled = reconcileJudgments(judgmentsA, judgmentsB);
  return [...shortcut, ...reconciled];
}

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** I13: config.llm.maxTokens (4096) is tuned for single-note extraction, not
 * grading a whole candidate pool in one call. Pools of ~90-100 output tokens
 * per candidate (observed) hit that ceiling above ~40 candidates, truncating
 * the JSON array mid-stream; extractJSON then finds the first complete inner
 * *object* and hands it to a schema expecting an array. The largest pool
 * observed so far is 61 candidates; 8192 covers that with headroom. */
const JUDGE_MAX_TOKENS = 8192;

export async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyPrefix = onlyArg?.slice('--only='.length);

  const allPools: ItemPool[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/pool.json'), 'utf8'));
  const allItems: { id: string; query: string; intent: string }[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8'),
  );
  const items = filterItemsByIdPrefix(allItems, onlyPrefix);
  console.log(onlyPrefix ? `Scoped to ${items.length}/${allItems.length} items matching "${onlyPrefix}"` : `Processing all ${items.length} items`);

  const behavioral: BehavioralEntry[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval/dataset/behavioral-signal.json'), 'utf8'),
  );
  const itemById = new Map(items.map((it) => [it.id, it]));
  const filteredItemIds = new Set(items.map((it) => it.id));
  const pools = allPools.filter((p) => filteredItemIds.has(p.item_id));

  if (dryRun) {
    let shortcutCount = 0;
    let itemsNeedingJudging = 0;
    for (const pool of pools) {
      const item = itemById.get(pool.item_id);
      if (!item) continue;
      const { shortcut, remaining } = applyBehavioralShortcut(item, pool, behavioral);
      shortcutCount += shortcut.length;
      if (remaining.candidates.length > 0) itemsNeedingJudging += 1;
    }
    console.log(
      `[dry-run] ${pools.length} items; ${shortcutCount} candidates behaviorally shortcut; ${itemsNeedingJudging} items need dual-judge grading (~${itemsNeedingJudging * 2} real LLM calls)`,
    );
    return;
  }

  const { loadConfig } = await import('../../src/config/loader.js');
  const { createLLMForTier } = await import('./llm.js');
  const config = await loadConfig(REPO_ROOT);
  const judgeA = createLLMForTier(config, 'medium', JUDGE_MAX_TOKENS);
  const judgeB = createLLMForTier(config, 'heavy', JUDGE_MAX_TOKENS);

  const allJudgments: Judgment[] = [];
  const failedItemIds = new Set<string>();
  for (const pool of pools) {
    const item = itemById.get(pool.item_id);
    if (!item) continue;
    try {
      const judgments = await judgeItemFull(judgeA, judgeB, item, pool, behavioral);
      allJudgments.push(...judgments);
      const disagreements = judgments.filter((j) => j.disagreement).length;
      console.log(`${item.id}: ${judgments.length} judgments (${disagreements} disagreements)`);
    } catch (err) {
      console.error(`Judge call FAILED for ${item.id} (${pool.candidates.length} candidates) — skipping: ${(err as Error).message}`);
      failedItemIds.add(item.id);
    }
  }

  if (failedItemIds.size > 0) {
    console.error(`${failedItemIds.size} item(s) failed judging and were skipped: ${[...failedItemIds].join(', ')}`);
  }

  // Merge with existing judgments.json when scoped — otherwise a --only run
  // would silently discard every already-judged item's data.
  let finalJudgments = allJudgments;
  if (onlyPrefix) {
    let existingJudgments: Judgment[] = [];
    try {
      existingJudgments = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/judgments.json'), 'utf8'));
    } catch {
      /* no existing judgments.json yet */
    }
    const newItemIds = new Set(allJudgments.map((j) => j.item_id));
    finalJudgments = [...existingJudgments.filter((j) => !newItemIds.has(j.item_id)), ...allJudgments];
  }

  writeFileSync(join(REPO_ROOT, 'eval/dataset/judgments.json'), JSON.stringify(finalJudgments, null, 2));
  console.log(`Wrote eval/dataset/judgments.json: ${finalJudgments.length} judgments across ${pools.length} items`);

  const outDir = join(REPO_ROOT, 'eval', 'results');
  mkdirSync(outDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const disagreementPath = join(outDir, `${date}-disagreements.md`);
  writeDisagreementReport(disagreementPath, finalJudgments);
  console.log(`Wrote disagreement log to eval/results/${date}-disagreements.md`);
}

if (process.argv[1]?.endsWith('judge-full.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
