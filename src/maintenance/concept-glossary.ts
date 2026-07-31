// Concept glossary at `{layout.wiki}/concepts/glossary.md`.
//
// Concepts no longer become individual wiki pages. Every concept mention
// across all ingested sources lands as a bulleted line under that concept's
// heading in this one file. Deliberately not `_index.md` — that file is
// auto-rebuilt by rebuildVaultIndex() and this glossary needs to survive
// that rebuild untouched.
//
// B2b: dedup is now content-aware (not just sourceRef-aware), and concepts
// that accumulate enough mentions get an LLM-synthesized rollup line
// (`synthesis`) rendered above their raw mention list.

import { z } from 'zod';
import type { VaultAdapter } from '../vault/adapter.js';
import type { LLMClient } from '../enrichment/llm-client.js';
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';
import { normalizeName } from '../ingest/entity-resolver.js';

const REGION_ID = 'glossary-entries';

export function conceptGlossaryPath(layout: VaultLayout): string {
  return `${layout.wiki}/concepts/glossary.md`;
}

const HEADER = `---
type: index
title: Concept glossary
---

# Concept glossary

Every concept mentioned across ingested sources, consolidated here instead
of as individual pages. Each entry lists every source that mentioned it.

`;

export interface ConceptMention {
  sourceRef: string;
  gloss: string;
  date: string;
}

export interface ConceptEntry {
  name: string;
  mentions: ConceptMention[];
  /** LLM-synthesized rollup line, present once mention count has crossed the threshold. */
  synthesis?: string;
  /** Mention count at last synthesis, to detect "grown enough to re-synthesize". */
  synthesizedAtCount?: number;
}

export interface UpsertConceptMentionResult {
  mentionCount: number;
  /**
   * True exactly once, the ingest call that pushes mentionCount to (or past)
   * the configured threshold for the first time, or that grows it by another
   * full threshold-worth since the last synthesis.
   */
  crossedSynthesisThreshold: boolean;
}

function extractSlug(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/, '') ?? path;
}

function parseGlossary(inner: string): Map<string, ConceptEntry> {
  const entries = new Map<string, ConceptEntry>();
  const lines = inner.split('\n');
  let current: ConceptEntry | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^## (.+)$/);
    if (headingMatch) {
      current = { name: headingMatch[1].trim(), mentions: [] };
      entries.set(normalizeName(current.name), current);
      continue;
    }
    if (!current) continue;
    const synthesisMatch = line.match(/^\*(?!Last mentioned:)(.+)\*$/);
    if (synthesisMatch) {
      const rawSynthesisLine = synthesisMatch[1];
      const countMatch = rawSynthesisLine.match(/^(.*) \(as of (\d+) mentions?\)$/);
      if (countMatch) {
        current.synthesis = countMatch[1].trim();
        current.synthesizedAtCount = Number(countMatch[2]);
      } else {
        current.synthesis = rawSynthesisLine.trim();
      }
      continue;
    }
    // Match: - "gloss text" — [[slug]] (YYYY-MM-DD)
    const mentionMatch = line.match(/^- "(.*)" — \[\[(.+?)\]\] \((.+?)\)$/);
    if (mentionMatch) {
      current.mentions.push({ gloss: mentionMatch[1], sourceRef: mentionMatch[2], date: mentionMatch[3] });
    }
  }

  return entries;
}

function renderGlossary(entries: Map<string, ConceptEntry>): string {
  const sorted = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  return sorted
    .map((entry) => {
      const lastMention = entry.mentions[entry.mentions.length - 1];
      const synthesisLine = entry.synthesis
        ? `*${entry.synthesis} (as of ${entry.synthesizedAtCount ?? entry.mentions.length} mentions)*\n`
        : '';
      const mentionLines = entry.mentions
        .map((m) => `- "${m.gloss}" — [[${m.sourceRef}]] (${m.date})`)
        .join('\n');
      return `## ${entry.name}\n*Last mentioned: ${lastMention?.date ?? 'unknown'}*\n${synthesisLine}${mentionLines}`;
    })
    .join('\n\n');
}

async function readEntries(vault: VaultAdapter, path: string): Promise<Map<string, ConceptEntry>> {
  const open = OPEN_TAG(REGION_ID);
  const close = CLOSE_TAG(REGION_ID);
  let inner = '';
  if (await vault.exists(path)) {
    const content = await vault.read(path);
    const openIdx = content.indexOf(open);
    const closeIdx = openIdx >= 0 ? content.indexOf(close, openIdx + open.length) : -1;
    if (openIdx >= 0 && closeIdx >= 0) {
      inner = content.slice(openIdx + open.length, closeIdx);
    }
  }
  return parseGlossary(inner);
}

async function writeEntries(vault: VaultAdapter, path: string, entries: Map<string, ConceptEntry>): Promise<void> {
  const open = OPEN_TAG(REGION_ID);
  const close = CLOSE_TAG(REGION_ID);
  const body = `${HEADER}${open}\n${renderGlossary(entries)}\n${close}\n`;
  await vault.atomicWrite(path, body);
}

export async function upsertConceptMention(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
  concept: { name: string; gloss: string; sourceRef: string },
  options: { synthesisThreshold?: number } = {},
): Promise<UpsertConceptMentionResult> {
  const path = conceptGlossaryPath(layout);
  await vault.ensureFolder(`${layout.wiki}/concepts`);

  const entries = await readEntries(vault, path);
  const key = normalizeName(concept.name);
  const sourceRefSlug = extractSlug(concept.sourceRef);
  const today = new Date().toISOString().slice(0, 10);
  // The mention format is strictly single-line (parsed by a regex anchored
  // per line), but glosses can come from LLM-generated multi-paragraph prose
  // (e.g. entity-compiler.ts's "definition" region). A newline would break
  // the rendered line across multiple unparseable lines, silently dropping
  // the mention on the next read-parse-rewrite cycle. Normalize up front.
  const normalizedGloss = concept.gloss.replace(/\s*\n+\s*/g, ' ').trim();

  const existing = entries.get(key);
  const sameSourceRef = existing?.mentions.some((m) => m.sourceRef === sourceRefSlug) ?? false;
  const sameGlossText =
    existing?.mentions.some((m) => m.gloss.trim().toLowerCase() === normalizedGloss.toLowerCase()) ?? false;
  if (sameSourceRef || sameGlossText) {
    return { mentionCount: existing?.mentions.length ?? 0, crossedSynthesisThreshold: false };
  }

  let updatedEntry: ConceptEntry;
  if (existing) {
    existing.mentions.push({ gloss: normalizedGloss, sourceRef: sourceRefSlug, date: today });
    updatedEntry = existing;
  } else {
    updatedEntry = { name: concept.name, mentions: [{ gloss: normalizedGloss, sourceRef: sourceRefSlug, date: today }] };
    entries.set(key, updatedEntry);
  }

  const threshold = options.synthesisThreshold ?? 3;
  const mentionCount = updatedEntry.mentions.length;
  const crossedSynthesisThreshold =
    mentionCount >= threshold &&
    (updatedEntry.synthesizedAtCount === undefined || mentionCount >= updatedEntry.synthesizedAtCount + threshold);

  await writeEntries(vault, path, entries);
  return { mentionCount, crossedSynthesisThreshold };
}

const GlossarySynthesisSchema = z.object({ synthesis: z.string() });

function buildGlossarySynthesisPrompt(name: string, mentions: ConceptMention[]): string {
  const list = mentions.map((m, i) => `[${i + 1}] ${m.gloss}`).join('\n');
  return `Multiple sources in a personal knowledge base have mentioned the concept "${name}". Write ONE 1-2 sentence description that captures what this concept means and why it keeps coming up, grounded only in the mentions below — do not invent detail beyond what they state.

Mentions:
${list}

Output ONLY a single fenced \`\`\`json block:
{"synthesis": "..."}`;
}

/**
 * Re-read the glossary, synthesize a short rollup line for `conceptName`
 * from its current mention list, and write it back — a normal
 * read-modify-write cycle reusing the same parseGlossary/renderGlossary
 * round-trip `upsertConceptMention` already uses. No-ops (does not call the
 * LLM) if the concept has no mentions on file, which should not normally
 * happen since this is only ever called after `upsertConceptMention`
 * reports `crossedSynthesisThreshold: true`.
 */
export async function synthesizeConceptEntry(
  vault: VaultAdapter,
  layout: VaultLayout,
  conceptName: string,
  llm: LLMClient,
): Promise<void> {
  const path = conceptGlossaryPath(layout);
  const entries = await readEntries(vault, path);
  const key = normalizeName(conceptName);
  const entry = entries.get(key);
  if (!entry || entry.mentions.length === 0) return;

  const prompt = buildGlossarySynthesisPrompt(entry.name, entry.mentions);
  const parsed = await llm.extractStructured(prompt, GlossarySynthesisSchema);

  entry.synthesis = parsed.synthesis.trim();
  entry.synthesizedAtCount = entry.mentions.length;

  await writeEntries(vault, path, entries);
}
