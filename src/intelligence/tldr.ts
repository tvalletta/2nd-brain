// A3: TL;DR via Chain of Density.
//
// Three-pass rewrite that progressively packs more entities into a fixed-length
// summary. The 3rd pass is the human-preferred sweet spot per the CoD paper.
// The result is written into a `tldr` protected region at the top of the note
// AND mirrored to frontmatter.tldr for cheap scanning.
//
// Cooldown: don't rewrite if last rewrite was < cooldownDays ago.

import type { LLMClient } from '../enrichment/llm-client.js';
import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import {
  OPEN_TAG,
  CLOSE_TAG,
  updateProtectedRegion,
} from '../vault/protected-regions.js';

export const TLDR_REGION_ID = 'tldr';

export interface TldrOptions {
  maxChars?: number;
  cooldownDays?: number;
  passes?: number;
}

const DEFAULT_OPTS: Required<TldrOptions> = {
  maxChars: 120,
  cooldownDays: 1,
  passes: 3,
};

export function buildCoDPrompt(args: {
  noteTitle: string;
  body: string;
  passes: number;
  maxChars: number;
}): string {
  return `You are writing a Chain of Density summary for a knowledge-base note.

Title: ${args.noteTitle}

Note content:
"""
${args.body.slice(0, 8000)}
"""

Produce a single TL;DR ≤${args.maxChars} characters that:
- States WHAT the note is about and the single most useful claim a reader needs.
- Names 2-4 of the most important entities (concepts/people/projects/tools) referenced in the note.
- Drops filler words and redundancies. No "this note describes..." prefaces.
- Uses present tense.

Internally do ${args.passes} Chain of Density passes (each pass adds 1-2 missing entities while keeping length under the cap), then return ONLY the final summary on a single line.

Do not include quotes, code fences, or commentary. Just the summary text.`;
}

export function postprocessTldr(raw: string, maxChars: number): string {
  let out = raw.trim();
  // Strip code fences / quotes / leading "TL;DR:" prefixes the model sometimes emits.
  out = out.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
  out = out.replace(/^["'`](.*)["'`]$/s, '$1');
  out = out.replace(/^TL;?DR\s*:?\s*/i, '');
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > maxChars) out = out.slice(0, maxChars - 1).trimEnd() + '…';
  return out;
}

function daysSince(iso: string | undefined, nowMs = Date.now()): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (nowMs - t) / 86400_000;
}

export interface UpdateTldrResult {
  updated: boolean;
  reason: 'cooldown' | 'no-change' | 'updated' | 'no-body';
  tldr?: string;
}

export async function updateTldr(args: {
  vault: VaultAdapter;
  llm: LLMClient;
  notePath: string;
  options?: TldrOptions;
  nowMs?: number;
}): Promise<UpdateTldrResult> {
  const opts = { ...DEFAULT_OPTS, ...(args.options ?? {}) };
  const content = await args.vault.read(args.notePath);
  const { data, body } = parseNote(content);
  const fm = data as Record<string, unknown>;

  const trimmedBody = body.replace(/%% [\s\S]*?%%/g, '').trim();
  if (!trimmedBody || trimmedBody.length < 60) {
    return { updated: false, reason: 'no-body' };
  }

  // Cooldown: skip if the last TL;DR rewrite was very recent.
  const rawLast = fm.tldr_updated_at;
  const lastTldrAt =
    typeof rawLast === 'string'
      ? rawLast
      : rawLast instanceof Date
        ? rawLast.toISOString()
        : undefined;
  if (daysSince(lastTldrAt, args.nowMs) < opts.cooldownDays) {
    return { updated: false, reason: 'cooldown' };
  }

  const title = typeof fm.title === 'string' ? fm.title : args.notePath;
  const prompt = buildCoDPrompt({
    noteTitle: title,
    body: trimmedBody,
    passes: opts.passes,
    maxChars: opts.maxChars,
  });
  const raw = await args.llm.complete(prompt, { temperature: 0.2, maxTokens: 200 });
  const tldr = postprocessTldr(raw, opts.maxChars);
  if (!tldr) return { updated: false, reason: 'no-change' };
  if (typeof fm.tldr === 'string' && fm.tldr === tldr) {
    return { updated: false, reason: 'no-change', tldr };
  }

  fm.tldr = tldr;
  fm.tldr_updated_at = new Date(args.nowMs ?? Date.now()).toISOString();

  // Mirror into protected region at the top of the body.
  const newBody = upsertTldrRegion(body, tldr);

  // Track region in frontmatter list.
  const regions = Array.isArray(fm.protected_regions) ? (fm.protected_regions as string[]) : [];
  if (!regions.includes(TLDR_REGION_ID)) {
    fm.protected_regions = [...regions, TLDR_REGION_ID];
  }

  const next = serializeNote(fm, newBody);
  await args.vault.atomicWrite(args.notePath, next);
  return { updated: true, reason: 'updated', tldr };
}

function upsertTldrRegion(body: string, tldr: string): string {
  const open = OPEN_TAG(TLDR_REGION_ID);
  const close = CLOSE_TAG(TLDR_REGION_ID);
  if (body.includes(open)) {
    return updateProtectedRegion(body, TLDR_REGION_ID, `> **TL;DR** — ${tldr}`);
  }
  // Insert near the top, after a single H1 if present.
  const lines = body.split('\n');
  let insertAt = 0;
  if (lines[0]?.startsWith('# ')) {
    insertAt = 1;
    while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt += 1;
  }
  const block = `${open}\n> **TL;DR** — ${tldr}\n${close}`;
  const before = lines.slice(0, insertAt).join('\n');
  const after = lines.slice(insertAt).join('\n');
  return `${before ? before + '\n\n' : ''}${block}\n\n${after}`;
}
