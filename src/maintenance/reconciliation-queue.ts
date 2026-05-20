// §22: Curator reconciliation queue at `{layout.system}/reconciliation-queue.md`.
//
// Persistent store for entity merge/rename candidates detected by
// `detect-entity-dupes`. Operators resolve entries via `karpathy curator`
// (interactive CLI) or the `reconcile_entities` MCP tool.

import { nanoid } from 'nanoid';
import type { VaultAdapter } from '../vault/adapter.js';
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';

export const RECONCILIATION_QUEUE_REGION = 'reconciliation-entries';

export type ReconciliationStatus = 'pending' | 'resolved' | 'skipped';
export type ReconciliationDecision = 'merge' | 'rename' | 'skip' | 'manual';

export interface ReconciliationEntry {
  id: string;
  status: ReconciliationStatus;
  sourcePath: string;
  targetPath: string;
  sourceName: string;
  targetName: string;
  reason: string;
  confidence: number;
  decision?: ReconciliationDecision;
  newName?: string;
  resolvedAt?: string;
}

export interface ReconciliationQueue {
  entries: ReconciliationEntry[];
}

export function reconciliationQueuePath(layout: VaultLayout): string {
  return `${layout.system}/reconciliation-queue.md`;
}

const HEADER = `---
type: index
title: Reconciliation queue
---

# Reconciliation queue

Entity pairs the system has flagged as potential duplicates or name variants.
Use \`karpathy curator\` to walk through pending entries interactively, or the
\`reconcile_entities\` MCP tool to resolve entries from within a Claude session.

Pending decisions are shown with **status: pending**. Resolved entries are kept
for audit purposes. Entries with **status: skipped** are not shown in future
curator runs.

`;

export async function readReconciliationQueue(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<ReconciliationQueue> {
  const path = reconciliationQueuePath(layout);
  if (!(await vault.exists(path))) return { entries: [] };

  const content = await vault.read(path);
  const open = OPEN_TAG(RECONCILIATION_QUEUE_REGION);
  const close = CLOSE_TAG(RECONCILIATION_QUEUE_REGION);
  const openIdx = content.indexOf(open);
  const closeIdx = openIdx >= 0 ? content.indexOf(close, openIdx + open.length) : -1;

  if (openIdx < 0 || closeIdx < 0) return { entries: [] };

  const inner = content.slice(openIdx + open.length, closeIdx).trim();
  if (!inner) return { entries: [] };

  try {
    const entries = JSON.parse(inner) as ReconciliationEntry[];
    return { entries: Array.isArray(entries) ? entries : [] };
  } catch {
    return { entries: [] };
  }
}

export async function writeReconciliationQueue(
  vault: VaultAdapter,
  queue: ReconciliationQueue,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<void> {
  await vault.ensureFolder(layout.system);

  const pending = queue.entries.filter((e) => e.status === 'pending').length;
  const resolved = queue.entries.filter((e) => e.status === 'resolved').length;
  const skipped = queue.entries.filter((e) => e.status === 'skipped').length;
  const summary = `*${pending} pending · ${resolved} resolved · ${skipped} skipped*\n\n`;

  const open = OPEN_TAG(RECONCILIATION_QUEUE_REGION);
  const close = CLOSE_TAG(RECONCILIATION_QUEUE_REGION);
  const json = JSON.stringify(queue.entries, null, 2);
  const body = `${HEADER}${summary}${open}\n${json}\n${close}\n`;

  await vault.atomicWrite(reconciliationQueuePath(layout), body);
}

/**
 * Pair key for deduplication — normalized so (a,b) and (b,a) produce the same key.
 */
function pairKey(a: string, b: string): string {
  return [a, b].sort().join('||');
}

/**
 * Append new candidates to the queue without creating duplicates.
 * Existing entries (any status) block re-addition of the same pair.
 * Returns the number of new entries appended.
 */
export async function refreshQueue(
  vault: VaultAdapter,
  candidates: Array<{
    sourcePath: string;
    targetPath: string;
    sourceName: string;
    targetName: string;
    reason: string;
    confidence: number;
  }>,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<number> {
  const queue = await readReconciliationQueue(vault, layout);

  const existingKeys = new Set(
    queue.entries.map((e) => pairKey(e.sourcePath, e.targetPath)),
  );

  let added = 0;
  for (const candidate of candidates) {
    const key = pairKey(candidate.sourcePath, candidate.targetPath);
    if (existingKeys.has(key)) continue;

    existingKeys.add(key);
    queue.entries.push({
      id: nanoid(),
      status: 'pending',
      ...candidate,
    });
    added++;
  }

  if (added > 0) {
    await writeReconciliationQueue(vault, queue, layout);
  }

  return added;
}

/**
 * Apply a decision to a queue entry by id.
 * Returns the updated entry, or null if not found.
 */
export async function resolveEntry(
  vault: VaultAdapter,
  id: string,
  decision: ReconciliationDecision,
  newName?: string,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<ReconciliationEntry | null> {
  const queue = await readReconciliationQueue(vault, layout);
  const entry = queue.entries.find((e) => e.id === id);
  if (!entry) return null;

  entry.status = decision === 'skip' ? 'skipped' : 'resolved';
  entry.decision = decision;
  entry.resolvedAt = new Date().toISOString();
  if (newName) entry.newName = newName;

  await writeReconciliationQueue(vault, queue, layout);
  return entry;
}

/** Return only entries with status === 'pending'. */
export function pendingEntries(queue: ReconciliationQueue): ReconciliationEntry[] {
  return queue.entries.filter((e) => e.status === 'pending');
}
