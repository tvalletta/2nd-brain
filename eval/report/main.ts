import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/loader.js';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { createLLMForTier } from '../pool/llm.js';
import { computeDisagreementSample } from './answer-quality-sample.js';
import { generateAnswers } from './generate-answers.js';
import { judgeAnswerQuality, type AnswerQualityResult } from './judge-answer-quality.js';
import { findLatestRunsFile } from '../score/build-scorecard.js';
import type { RunResult } from '../run/types.js';
import type { Judgment } from '../pool/judge.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CONTENDERS = ['grep-first', 'as-deployed', 'full-cov-hybrid'];
const DOC_CHAR_CAP = 8000;

function renderMarkdown(results: AnswerQualityResult[]): string {
  const lines: string[] = ['# Downstream Answer-Quality Check', ''];
  const tally = new Map<string, { wins: number; losses: number; ties: number }>();

  for (const result of results) {
    lines.push(`## ${result.item_id}`, '', `**Query:** ${result.query}`, '');
    for (const comparison of result.comparisons) {
      lines.push(`- **${comparison.variantA} vs ${comparison.variantB}**: ${comparison.winner === 'tie' ? 'tie' : `${comparison.winner} wins`} — ${comparison.reason}`);
      for (const variant of [comparison.variantA, comparison.variantB]) {
        if (!tally.has(variant)) tally.set(variant, { wins: 0, losses: 0, ties: 0 });
      }
      if (comparison.winner === 'tie') {
        tally.get(comparison.variantA)!.ties++;
        tally.get(comparison.variantB)!.ties++;
      } else {
        tally.get(comparison.winner)!.wins++;
        const loser = comparison.winner === comparison.variantA ? comparison.variantB : comparison.variantA;
        tally.get(loser)!.losses++;
      }
    }
    lines.push('');
  }

  lines.push('## Aggregate tally', '', '| Variant | Wins | Losses | Ties |', '|---|---|---|---|');
  for (const [variant, counts] of tally) {
    lines.push(`| ${variant} | ${counts.wins} | ${counts.losses} | ${counts.ties} |`);
  }
  return lines.join('\n');
}

async function main() {
  const config = await loadConfig(REPO_ROOT);
  const vault = createFsAdapter(config.vaultPath);

  const resultsDir = join(REPO_ROOT, 'eval', 'results');
  const runsResults: RunResult[] = JSON.parse(readFileSync(findLatestRunsFile(resultsDir), 'utf-8')).results;
  const judgments: Judgment[] = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/judgments.json'), 'utf-8'));

  const sample = computeDisagreementSample(runsResults, judgments, CONTENDERS);
  process.stdout.write(`Found ${sample.length} disagreement-driven items.\n`);

  const answerLLM = createLLMForTier(config, 'medium');
  const answerSets = await generateAnswers(sample, vault, answerLLM, DOC_CHAR_CAP);

  const judgeLLM = createLLMForTier(config, 'heavy');
  const results = await judgeAnswerQuality(answerSets, judgeLLM);

  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(join(REPO_ROOT, `eval/results/${today}-answer-quality.json`), JSON.stringify(results, null, 2));
  writeFileSync(join(REPO_ROOT, `eval/results/${today}-answer-quality.md`), renderMarkdown(results));
  process.stdout.write(`Wrote eval/results/${today}-answer-quality.{json,md}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
