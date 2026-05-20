// A1: One-shot backfill that fills time-aware fields for legacy notes.
//
// - `last_verified` ← `updated_at` if missing
// - `stability`     ← domain default (from inferDomain)
// - `half_life_domain` ← inferred from `type`
// - `tldr`          ← first non-empty body sentence (≤120 chars)
//
// Idempotent: only writes when at least one field is missing. Touches frontmatter
// only; never edits body content.

import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { defaultStability, inferDomain } from '../vault/half-life.js';

const TLDR_MAX = 120;

function asISOString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}

export interface BackfillResult {
  filesScanned: number;
  filesUpdated: number;
  fieldsAdded: Record<string, number>;
}

const MIN_PARAGRAPH = 30;

export function deriveTldr(body: string): string | null {
  // Drop frontmatter (defensive), protected regions, and headings.
  const stripped = body
    .replace(/^---[\s\S]*?---\n?/, '')
    .replace(/%% [\s\S]*?%%/g, '')
    .replace(/^#+\s.*$/gm, '');

  // Walk paragraphs (blank-line separated). Skip bullet-only blocks and very-short fragments.
  const paragraphs = stripped.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  let chosen: string | null = null;
  for (const p of paragraphs) {
    const lines = p.split('\n').map((l) => l.trim());
    const allBullets = lines.every((l) => /^[-*+]\s+/.test(l));
    if (allBullets) continue;
    const joined = lines.join(' ').replace(/\s+/g, ' ').trim();
    if (joined.length < MIN_PARAGRAPH) continue;
    chosen = joined;
    break;
  }
  if (!chosen) {
    // Fall back to the longest paragraph available (still skip empty).
    chosen = paragraphs.sort((a, b) => b.length - a.length)[0] ?? null;
  }
  if (!chosen) return null;

  const match = chosen.match(/^([^\n.!?]+[.!?]?)/);
  const first = (match?.[1] ?? chosen).trim();
  if (!first) return null;
  return first.length > TLDR_MAX ? first.slice(0, TLDR_MAX - 1).trimEnd() + '…' : first;
}

export async function backfillTimeAwareFields(
  vault: VaultAdapter,
  folders: string[] = ['wiki'],
): Promise<BackfillResult> {
  const result: BackfillResult = {
    filesScanned: 0,
    filesUpdated: 0,
    fieldsAdded: {},
  };

  const seen = new Set<string>();
  for (const folder of folders) {
    if (!(await vault.exists(folder))) continue;
    const files = await vault.listMarkdownFiles(folder);
    for (const path of files) {
      if (seen.has(path)) continue;
      seen.add(path);
      result.filesScanned += 1;

      const content = await vault.read(path);
      const { data, body } = parseNote(content);
      if (!data || typeof data !== 'object') continue;

      const fm = data as Record<string, unknown>;
      let changed = false;
      const bump = (k: string) => {
        result.fieldsAdded[k] = (result.fieldsAdded[k] ?? 0) + 1;
        changed = true;
      };

      const updatedAtStr = asISOString(fm.updated_at);
      if (fm.last_verified == null && updatedAtStr) {
        fm.last_verified = updatedAtStr;
        bump('last_verified');
      } else if (fm.last_verified instanceof Date) {
        fm.last_verified = (fm.last_verified as Date).toISOString();
      }
      if (fm.updated_at instanceof Date && updatedAtStr) {
        fm.updated_at = updatedAtStr;
      }
      if (fm.half_life_domain == null && typeof fm.type === 'string') {
        fm.half_life_domain = inferDomain(fm.type);
        bump('half_life_domain');
      }
      if (fm.stability == null) {
        fm.stability = defaultStability((fm.half_life_domain as string | undefined) ?? undefined);
        bump('stability');
      }
      if (fm.tldr == null) {
        const tldr = deriveTldr(body);
        if (tldr) {
          fm.tldr = tldr;
          bump('tldr');
        }
      }

      if (changed) {
        const next = serializeNote(fm, body);
        await vault.atomicWrite(path, next);
        result.filesUpdated += 1;
      }
    }
  }

  return result;
}
