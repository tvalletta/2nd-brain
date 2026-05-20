// A4 / D1: Research queue at `wiki/_system/research-queue.md`.
//
// Stack-ranked list of research candidates awaiting user approval. The file is
// the source of truth — Slack notifications are a fast-path nudge that points
// here, but users can edit this file directly to set decisions.
//
// Each row is a structured table line so it parses cleanly both ways.

import type { VaultAdapter } from '../vault/adapter.js';
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';

/** Legacy default-layout path. Prefer `researchQueuePath(layout)`. */
export const RESEARCH_QUEUE_PATH = `${DEFAULT_LAYOUT.system}/research-queue.md`;
/** Layout-aware research-queue path. */
export function researchQueuePath(layout: VaultLayout): string {
  return `${layout.system}/research-queue.md`;
}
const REGION_ID = 'queue-rows';

const HEADER = `---
type: index
title: Research queue
---

# Research queue

Stack-ranked candidates the system has flagged for research. Reply on Slack with
your picks (\`1 heavy, 2 medium, 3 skip\`), or set the **decision** column on a
row directly to one of: \`light\`, \`medium\`, \`heavy\`, \`skip\`.

| Slug | Score | Reason | Suggested | Decision | Status | Added | Completed |
|------|------:|--------|-----------|----------|--------|-------|-----------|
`;

export type ResearchDepth = 'light' | 'medium' | 'heavy' | 'skip';
export type ResearchStatus = 'pending' | 'completed' | 'expired';

export interface ResearchCandidate {
  slug: string;
  title: string;
  /** 0..1, the gap_score from D1. */
  score: number;
  /** Short why-line, e.g. "mentioned 6× in last week, no concept page yet". */
  reason: string;
  /** Default depth suggested by the ranker. */
  suggested: 'light' | 'medium' | 'heavy';
  decision?: ResearchDepth;
  status: ResearchStatus;
  addedAt: string;
  completedAt?: string;
  completedDepth?: ResearchDepth;
}

export interface ResearchQueue {
  candidates: ResearchCandidate[];
}

const ROW_RE =
  /^\|\s*`?([^|`]+?)`?\s*\|\s*([\d.]+)\s*\|\s*(.*?)\s*\|\s*(\w+)\s*\|\s*(\w+)?\s*\|\s*(\w+)\s*\|\s*([\dT:.\-Z]+)\s*\|\s*([\w@:.\-Z]+)?\s*\|/;

export async function readResearchQueue(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<ResearchQueue> {
  const path = researchQueuePath(layout);
  if (!(await vault.exists(path))) return { candidates: [] };
  const content = await vault.read(path);

  const open = OPEN_TAG(REGION_ID);
  const close = CLOSE_TAG(REGION_ID);
  const openIdx = content.indexOf(open);
  const closeIdx = openIdx >= 0 ? content.indexOf(close, openIdx + open.length) : -1;
  const inner = openIdx >= 0 && closeIdx >= 0 ? content.slice(openIdx + open.length, closeIdx) : content;

  const candidates: ResearchCandidate[] = [];
  for (const line of inner.split('\n')) {
    const m = line.match(ROW_RE);
    if (!m) continue;
    const decision = m[5] as ResearchDepth | undefined;
    const completedRaw = m[8];
    const [completedDepthPart, completedAtPart] = completedRaw ? completedRaw.split('@') : [];
    candidates.push({
      slug: m[1].trim(),
      title: m[1].trim(),
      score: Number(m[2]),
      reason: m[3].replace(/<br\s*\/?>/g, '\n'),
      suggested: m[4] as 'light' | 'medium' | 'heavy',
      decision: decision === undefined || decision === ('' as never) ? undefined : decision,
      status: m[6] as ResearchStatus,
      addedAt: m[7],
      completedDepth:
        completedDepthPart && /^(light|medium|heavy|skip)$/.test(completedDepthPart)
          ? (completedDepthPart as ResearchDepth)
          : undefined,
      completedAt: completedAtPart || undefined,
    });
  }
  return { candidates };
}

export async function writeResearchQueue(
  vault: VaultAdapter,
  queue: ResearchQueue,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<void> {
  await vault.ensureFolder(layout.system);
  const open = OPEN_TAG(REGION_ID);
  const close = CLOSE_TAG(REGION_ID);
  const rows = [...queue.candidates]
    .sort((a, b) => b.score - a.score)
    .map((c) => {
      const reason = c.reason.replace(/\n/g, '<br/>').replace(/\|/g, '\\|');
      const decision = c.decision ?? '';
      const completed = c.completedDepth ? `${c.completedDepth}@${c.completedAt ?? ''}` : '';
      return `| \`${c.slug}\` | ${c.score.toFixed(2)} | ${reason} | ${c.suggested} | ${decision} | ${c.status} | ${c.addedAt} | ${completed} |`;
    });
  const body = `${HEADER}${open}\n${rows.join('\n')}\n${close}\n`;
  await vault.atomicWrite(researchQueuePath(layout), body);
}

export async function upsertCandidate(
  vault: VaultAdapter,
  candidate: ResearchCandidate,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<void> {
  const queue = await readResearchQueue(vault, layout);
  const existingIdx = queue.candidates.findIndex((c) => c.slug === candidate.slug);
  if (existingIdx >= 0) {
    // Preserve user-set decision unless the candidate is being completed/expired.
    const prev = queue.candidates[existingIdx];
    queue.candidates[existingIdx] = {
      ...candidate,
      decision: candidate.decision ?? prev.decision,
    };
  } else {
    queue.candidates.push(candidate);
  }
  await writeResearchQueue(vault, queue, layout);
}
