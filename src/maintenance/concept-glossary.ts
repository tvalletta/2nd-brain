// Concept glossary at `{layout.wiki}/concepts/glossary.md`.
//
// Concepts no longer become individual wiki pages. Every concept mention
// across all ingested sources lands as a bulleted line under that concept's
// heading in this one file. Deliberately not `_index.md` — that file is
// auto-rebuilt by rebuildVaultIndex() and this glossary needs to survive
// that rebuild untouched.

import type { VaultAdapter } from '../vault/adapter.js';
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
      const mentionLines = entry.mentions
        .map((m) => `- "${m.gloss}" — [[${m.sourceRef}]] (${m.date})`)
        .join('\n');
      return `## ${entry.name}\n*Last mentioned: ${lastMention?.date ?? 'unknown'}*\n${mentionLines}`;
    })
    .join('\n\n');
}

export async function upsertConceptMention(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
  concept: { name: string; gloss: string; sourceRef: string },
): Promise<void> {
  const path = conceptGlossaryPath(layout);
  await vault.ensureFolder(`${layout.wiki}/concepts`);

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

  const entries = parseGlossary(inner);
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
  const alreadyMentioned = existing?.mentions.some((m) => m.sourceRef === sourceRefSlug) ?? false;
  if (alreadyMentioned) return;

  if (existing) {
    existing.mentions.push({ gloss: normalizedGloss, sourceRef: sourceRefSlug, date: today });
  } else {
    entries.set(key, {
      name: concept.name,
      mentions: [{ gloss: normalizedGloss, sourceRef: sourceRefSlug, date: today }],
    });
  }

  const body = `${HEADER}${open}\n${renderGlossary(entries)}\n${close}\n`;
  await vault.atomicWrite(path, body);
}
