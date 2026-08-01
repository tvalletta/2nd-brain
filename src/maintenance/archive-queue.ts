// Sub-project C, G3: archive queue at `{layout.system}/archive-queue.md`.
//
// Persistent store for archive candidates surfaced by rot-scan's existing
// stale+orphan+low-confidence rule. Operators resolve entries via
// `karpathy archivist` (interactive CLI) or the `resolve_archive_candidate`
// MCP tool. Deliberately mirrors reconciliation-queue.ts's shape and API —
// same problem shape (a detector produces candidates; a human resolves them
// at their own pace; resolutions persist and are never re-proposed), but a
// separate file/mechanism since the candidate shape (single `path` vs.
// `sourcePath`+`targetPath`) and decision vocabulary
// (archive/keep/supersede/skip vs. merge/rename/skip/manual) both differ.

import { nanoid } from 'nanoid';
import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';

export const ARCHIVE_QUEUE_REGION = 'archive-entries';

export type ArchiveQueueStatus = 'pending' | 'resolved' | 'skipped';
export type ArchiveDecision = 'archive' | 'keep' | 'supersede' | 'skip';

export interface ArchiveCandidate {
  path: string;
  title: string;
  reason: string;
  ageDays: number;
  confidence: string;
  retrievability?: number;
}

export interface ArchiveEntry extends ArchiveCandidate {
  id: string;
  status: ArchiveQueueStatus;
  decision?: ArchiveDecision;
  supersededByPath?: string;
  resolvedAt?: string;
}

export interface ArchiveQueue {
  entries: ArchiveEntry[];
}

export function archiveQueuePath(layout: VaultLayout): string {
  return `${layout.system}/archive-queue.md`;
}

const HEADER = `---
type: index
title: Archive queue
---

# Archive queue

Wiki pages the system has flagged as rot candidates (stale + orphan + low
confidence, per \`rot-scan\`). Use \`karpathy archivist\` to walk through
pending entries interactively, or the \`resolve_archive_candidate\` MCP tool
to resolve entries from within a Claude session.

Pending decisions are shown with **status: pending**. Resolved entries are
kept for audit purposes. Entries with **status: skipped** are not shown in
future archivist runs.

`;

export async function readArchiveQueue(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<ArchiveQueue> {
  const path = archiveQueuePath(layout);
  if (!(await vault.exists(path))) return { entries: [] };

  const content = await vault.read(path);
  const open = OPEN_TAG(ARCHIVE_QUEUE_REGION);
  const close = CLOSE_TAG(ARCHIVE_QUEUE_REGION);
  const openIdx = content.indexOf(open);
  const closeIdx = openIdx >= 0 ? content.indexOf(close, openIdx + open.length) : -1;

  if (openIdx < 0 || closeIdx < 0) return { entries: [] };

  const inner = content.slice(openIdx + open.length, closeIdx).trim();
  if (!inner) return { entries: [] };

  try {
    const entries = JSON.parse(inner) as ArchiveEntry[];
    return { entries: Array.isArray(entries) ? entries : [] };
  } catch {
    return { entries: [] };
  }
}

export async function writeArchiveQueue(
  vault: VaultAdapter,
  queue: ArchiveQueue,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<void> {
  await vault.ensureFolder(layout.system);

  const pending = queue.entries.filter((e) => e.status === 'pending').length;
  const resolved = queue.entries.filter((e) => e.status === 'resolved').length;
  const skipped = queue.entries.filter((e) => e.status === 'skipped').length;
  const summary = `*${pending} pending · ${resolved} resolved · ${skipped} skipped*\n\n`;

  const open = OPEN_TAG(ARCHIVE_QUEUE_REGION);
  const close = CLOSE_TAG(ARCHIVE_QUEUE_REGION);
  const json = JSON.stringify(queue.entries, null, 2);
  const body = `${HEADER}${summary}${open}\n${json}\n${close}\n`;

  await vault.atomicWrite(archiveQueuePath(layout), body);
}

/**
 * Append new candidates, deduplicated by `path` (unlike reconciliation-
 * queue's pair-key dedup — archive candidates are single notes, not pairs).
 * Existing entries in ANY status (pending/resolved/skipped) block
 * re-addition, so a 'keep' or 'skip' decision permanently silences that
 * candidate.
 */
export async function refreshArchiveQueue(
  vault: VaultAdapter,
  candidates: ArchiveCandidate[],
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<number> {
  const queue = await readArchiveQueue(vault, layout);
  const existing = new Set(queue.entries.map((e) => e.path));

  let added = 0;
  for (const candidate of candidates) {
    if (existing.has(candidate.path)) continue;
    existing.add(candidate.path);
    queue.entries.push({ id: nanoid(), status: 'pending', ...candidate });
    added++;
  }

  if (added > 0) {
    await writeArchiveQueue(vault, queue, layout);
  }

  return added;
}

/**
 * Apply a decision to a queue entry by id (queue bookkeeping only — no note
 * mutation). Returns the updated entry, or null if not found.
 */
export async function resolveArchiveEntry(
  vault: VaultAdapter,
  id: string,
  decision: ArchiveDecision,
  supersededByPath?: string,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<ArchiveEntry | null> {
  const queue = await readArchiveQueue(vault, layout);
  const entry = queue.entries.find((e) => e.id === id);
  if (!entry) return null;

  entry.status = decision === 'skip' ? 'skipped' : 'resolved';
  entry.decision = decision;
  entry.resolvedAt = new Date().toISOString();
  if (supersededByPath) entry.supersededByPath = supersededByPath;

  await writeArchiveQueue(vault, queue, layout);
  return entry;
}

/** Return only entries with status === 'pending'. */
export function pendingArchiveEntries(queue: ArchiveQueue): ArchiveEntry[] {
  return queue.entries.filter((e) => e.status === 'pending');
}

/**
 * Apply an archive/keep/supersede/skip decision end-to-end: 'archive' and
 * 'supersede' mutate the target note's frontmatter (never its body, never
 * deleting anything); 'keep' and 'skip' only update the queue entry. Shared
 * by `karpathy archivist` and the `resolve_archive_candidate` MCP tool so
 * the mutation logic lives in exactly one place.
 */
export async function applyArchiveDecision(
  vault: VaultAdapter,
  entry: ArchiveEntry,
  decision: ArchiveDecision,
  supersededByPath?: string,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<ArchiveEntry | null> {
  if (decision === 'archive' || decision === 'supersede') {
    const content = await vault.read(entry.path);
    const { data, body } = parseNote(content);
    data.status = 'archived';
    data.archived_at = new Date().toISOString();

    if (decision === 'archive') {
      data.archived_reason = entry.reason;
      if (data.type === 'project') data.project_status = 'archived';
    } else {
      data.archived_reason = 'superseded';
      const supersededBy = new Set((data.superseded_by as string[]) ?? []);
      if (supersededByPath) supersededBy.add(supersededByPath);
      data.superseded_by = [...supersededBy];
    }

    await vault.atomicWrite(entry.path, serializeNote(data, body));
  }

  return resolveArchiveEntry(vault, entry.id, decision, supersededByPath, layout);
}
