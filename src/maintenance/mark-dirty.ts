// Phase 0 (cascading curation): mark-dirty primitive.
//
// Records a piece of evidence on a note's frontmatter without rewriting its
// body. Downstream `evaluate-refresh-candidates` checks the threshold and
// decides whether to enqueue `topic-refresh`. This is the keystone for the
// "write-time cheap, refresh-time batched" principle.
//
// Properties:
// - Idempotent on (notePath, ref): the same evidence ref is recorded once.
// - Atomic write via VaultAdapter.atomicWrite.
// - Bounded: silently caps `pending_evidence` length at MAX_PENDING (oldest
//   evicted) so a runaway producer can't unbound the frontmatter.

import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote, serializeNote, type PendingEvidence } from '../vault/frontmatter.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('mark-dirty');

/** Hard cap so a runaway producer can't blow up frontmatter. */
export const MAX_PENDING_EVIDENCE = 50;

export interface MarkDirtyInput {
  notePath: string;
  ref: string;
  reason?: string;
  at?: string;
}

export interface MarkDirtyResult {
  notePath: string;
  pendingCount: number;
  added: boolean;
  reason: 'added' | 'duplicate' | 'capped' | 'missing';
}

/**
 * Append `ref` to the note's `pending_evidence` and bump `pending_evidence_count`.
 * Returns `added: false` if the note doesn't exist, the ref is already
 * recorded, or if no change was required.
 */
export async function markDirty(
  vault: VaultAdapter,
  input: MarkDirtyInput,
): Promise<MarkDirtyResult> {
  const { notePath, ref } = input;
  if (!(await vault.exists(notePath))) {
    log.debug('markDirty: note missing', { notePath });
    return { notePath, pendingCount: 0, added: false, reason: 'missing' };
  }

  const raw = await vault.read(notePath);
  const { data, body } = parseNote(raw);

  const existing = Array.isArray(data.pending_evidence)
    ? (data.pending_evidence as PendingEvidence[])
    : [];

  // Idempotency: skip if ref already recorded.
  if (existing.some((e) => e?.ref === ref)) {
    return {
      notePath,
      pendingCount: existing.length,
      added: false,
      reason: 'duplicate',
    };
  }

  // Important: omit `reason` when undefined — YAML serializer (gray-matter via
  // js-yaml) refuses to dump `undefined` values.
  const entry: PendingEvidence = {
    ref,
    at: input.at ?? new Date().toISOString(),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };

  let nextEvidence: PendingEvidence[] = [...existing, entry];
  let resultReason: MarkDirtyResult['reason'] = 'added';

  if (nextEvidence.length > MAX_PENDING_EVIDENCE) {
    // Drop oldest — keep the newest MAX_PENDING_EVIDENCE entries.
    nextEvidence = nextEvidence.slice(-MAX_PENDING_EVIDENCE);
    resultReason = 'capped';
  }

  const updated = {
    ...data,
    pending_evidence: nextEvidence,
    pending_evidence_count: nextEvidence.length,
    updated_at: new Date().toISOString(),
  };

  await vault.atomicWrite(notePath, serializeNote(updated, body));
  return {
    notePath,
    pendingCount: nextEvidence.length,
    added: true,
    reason: resultReason,
  };
}

/**
 * Clear `pending_evidence` after `topic-refresh` consumes it. Returns the
 * cleared entries so the caller can persist them as `source_refs`/log lines.
 */
export async function clearPendingEvidence(
  vault: VaultAdapter,
  notePath: string,
): Promise<PendingEvidence[]> {
  if (!(await vault.exists(notePath))) return [];
  const raw = await vault.read(notePath);
  const { data, body } = parseNote(raw);
  const existing = Array.isArray(data.pending_evidence)
    ? (data.pending_evidence as PendingEvidence[])
    : [];
  if (existing.length === 0) return [];

  const updated = {
    ...data,
    pending_evidence: [],
    pending_evidence_count: 0,
    last_verified: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await vault.atomicWrite(notePath, serializeNote(updated, body));
  return existing;
}
