import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { LLMClient } from '../../src/enrichment/llm-client.js';
import { triagePrompt } from '../pool/prompts.js';
import type { EvalItem } from './types.js';

export interface TriageProposal {
  id: string;
  proposed_category: 'plaud-ai-session' | 'entities' | 'hot-topics' | 'decisions';
  proposed_subtype: 'lookup' | 'synthesis' | 'relationship' | 'absent';
  drop: boolean;
  reason: string;
}

const TriageProposalSchema = z.object({
  id: z.string(),
  proposed_category: z.enum(['plaud-ai-session', 'entities', 'hot-topics', 'decisions']),
  proposed_subtype: z.enum(['lookup', 'synthesis', 'relationship', 'absent']),
  drop: z.boolean(),
  reason: z.string(),
});
const TriageResponseSchema = z.array(TriageProposalSchema);

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Propose corrected category/subtype/drop labels for each item, batching
 * `chunkSize` items per LLM call (default 25, small enough to stay well
 * within context for a 74-item dataset in ~3 calls). */
export async function triageItems(
  llm: LLMClient,
  items: EvalItem[],
  chunkSize = 25,
): Promise<TriageProposal[]> {
  const proposals: TriageProposal[] = [];
  for (const batch of chunk(items, chunkSize)) {
    const prompt = triagePrompt(
      batch.map((it) => ({
        id: it.id,
        query: it.query,
        category: it.category,
        subtype: it.subtype,
        source: it.source,
        intent: it.intent,
      })),
    );
    const result = await llm.extractStructured(prompt, TriageResponseSchema);
    proposals.push(...result);
  }
  return proposals;
}

const REPO_ROOT = join(import.meta.dirname, '..', '..');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { loadConfig } = await import('../../src/config/loader.js');
  const { createLLMForTier } = await import('../pool/llm.js');
  const config = await loadConfig(REPO_ROOT);
  const items: EvalItem[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8'),
  );
  if (dryRun) {
    console.log(`[dry-run] would triage ${items.length} items in chunks of 25 (~${Math.ceil(items.length / 25)} LLM calls)`);
    return;
  }
  const llm = createLLMForTier(config, 'medium');
  const proposals = await triageItems(llm, items);
  writeFileSync(join(REPO_ROOT, 'eval/dataset/triage-proposals.json'), JSON.stringify(proposals, null, 2));
  console.log(`Wrote ${proposals.length} triage proposals to eval/dataset/triage-proposals.json`);
  const drops = proposals.filter((p) => p.drop);
  console.log(`${drops.length} items flagged for drop:`, drops.map((d) => d.id));
}

if (process.argv[1]?.endsWith('triage.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
