import { normalizeName, levenshtein } from '../ingest/entity-resolver.js';
import { stripHonorifics, firstNamesEquivalent, initialsMatch } from '../ingest/name-variants.js';
import type { EntityIndex } from '../ingest/entity-resolver.js';
import { kindToFolder, type VaultLayout } from '../vault/paths.js';
import type { MergeCandidate } from './entity-merger.js';

export interface NameVariantMatch {
  confidence: number;
  reason: string;
}

/**
 * Pure, vault-I/O-free scoring function. No shared-source-reference
 * requirement (that's the entire point — see B2c design §0.1's Bryan/Pino
 * evidence). Always returns a confidence well below AUTO_MERGE_THRESHOLD
 * (0.85); every result of this function is destined for the human-reviewed
 * reconciliation queue, never an automatic merge.
 */
export function personNameVariantScore(
  nameA: string, aliasesA: string[],
  nameB: string, aliasesB: string[],
): NameVariantMatch | null {
  const candidatesA = [nameA, ...aliasesA].map((n) => normalizeName(stripHonorifics(n)));
  const candidatesB = [nameB, ...aliasesB].map((n) => normalizeName(stripHonorifics(n)));

  for (const a of candidatesA) {
    for (const b of candidatesB) {
      if (a === b) continue; // exact matches are handled upstream by resolveEntity already
      if (a.length < 3 || b.length < 3) continue; // avoid single-letter/initial noise

      // Tier A: one name fully contained in the other ("Bryan" inside "Bryan Pino").
      if (a.includes(b) || b.includes(a)) {
        return { confidence: 0.5, reason: `"${a}" and "${b}" — one name is fully contained in the other` };
      }

      // Tier B: same (or near-identical) surname + nickname/initials-equivalent first name.
      const ta = a.split(' ');
      const tb = b.split(' ');
      if (ta.length >= 2 && tb.length >= 2) {
        const lastA = ta[ta.length - 1];
        const lastB = tb[tb.length - 1];
        if (lastA === lastB || levenshtein(lastA, lastB) <= 1) {
          const firstA = ta[0];
          const firstB = tb[0];
          if (firstNamesEquivalent(firstA, firstB) || initialsMatch(firstA, firstB) || initialsMatch(firstB, firstA)) {
            return { confidence: 0.65, reason: `"${nameA}" and "${nameB}" — same surname, equivalent first name/initial` };
          }
        }
      }
    }
  }
  return null;
}

/**
 * O(n) check of a single freshly-created person page against every existing
 * person page already in a pre-built EntityIndex. Used at ingest time so a
 * same-day bare-name mention gets a same-day reconciliation-queue entry,
 * rather than waiting for the next scheduled detect-entity-dupes sweep.
 */
export function findNameVariantCandidatesForNewPage(
  index: EntityIndex,
  layout: VaultLayout,
  newEntry: { name: string; path: string; aliases: string[] },
): MergeCandidate[] {
  const personFolder = kindToFolder(layout, 'person');
  const candidates: MergeCandidate[] = [];

  for (const existing of index.allEntries) {
    if (existing.path === newEntry.path) continue;
    if (!existing.path.startsWith(personFolder)) continue;

    const scored = personNameVariantScore(newEntry.name, newEntry.aliases, existing.name, existing.aliases);
    if (scored) {
      const [source, target] = newEntry.name.length >= existing.name.length
        ? [{ path: existing.path, name: existing.name }, { path: newEntry.path, name: newEntry.name }]
        : [{ path: newEntry.path, name: newEntry.name }, { path: existing.path, name: existing.name }];
      candidates.push({
        sourcePath: source.path, targetPath: target.path,
        sourceName: source.name, targetName: target.name,
        reason: scored.reason, confidence: scored.confidence,
      });
    }
  }
  return candidates;
}
