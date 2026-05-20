// A4: Lightweight catalog at vault root (`index.md`).
//
// Lists every concept, topic, and project page with TL;DR and last_verified.
// Sorted by hot_score desc, then last_verified desc. Re-projected on each run
// — never edited in place by humans.

import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote } from '../vault/frontmatter.js';
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';

/** Legacy default-layout path. Prefer `vaultIndexPath(layout)`. */
export const VAULT_INDEX_PATH = DEFAULT_LAYOUT.vaultIndex;
/** Layout-aware path to `index.md`. */
export function vaultIndexPath(layout: VaultLayout = DEFAULT_LAYOUT): string {
  return layout.vaultIndex;
}
const REGION_ID = 'index-entries';

const HEADER = `---
type: index
title: Index
---

# Index

Auto-generated catalog of concept, topic, and project pages.
Sorted by hot_score, then by last_verified.

`;

interface IndexEntry {
  path: string;
  title: string;
  type: string;
  tldr: string;
  lastVerified: string;
  hotScore: number;
}

function targetFolders(layout: VaultLayout): string[] {
  return [`${layout.wiki}/concepts`, `${layout.wiki}/topics`, `${layout.wiki}/projects`];
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return '';
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && !Number.isNaN(v) ? v : 0;
}

export async function rebuildVaultIndex(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<{ entries: number }> {
  const entries: IndexEntry[] = [];

  for (const folder of targetFolders(layout)) {
    if (!(await vault.exists(folder))) continue;
    const files = await vault.listMarkdownFiles(folder);
    for (const path of files) {
      // Skip directory index pages — they're projections of subentries.
      if (path.endsWith('/_index.md') || path.endsWith('index.md')) continue;
      const content = await vault.read(path);
      const { data } = parseNote(content);
      const fm = data as Record<string, unknown>;
      const type = asString(fm.type) || 'unknown';
      if (!['concept', 'topic', 'project', 'project_spec'].includes(type)) continue;
      entries.push({
        path,
        title: asString(fm.title) || path,
        type,
        tldr: asString(fm.tldr),
        lastVerified: asString(fm.last_verified) || asString(fm.updated_at),
        hotScore: asNumber(fm.hot_score),
      });
    }
  }

  entries.sort((a, b) => {
    if (b.hotScore !== a.hotScore) return b.hotScore - a.hotScore;
    return (b.lastVerified || '').localeCompare(a.lastVerified || '');
  });

  const lines = entries.map((e) => {
    const link = `[[${e.path.replace(/\.md$/, '')}|${e.title}]]`;
    const tldr = e.tldr ? ` — ${e.tldr}` : '';
    const dateBadge = e.lastVerified ? ` · ${e.lastVerified.slice(0, 10)}` : '';
    const heatBadge = e.hotScore > 0 ? ` · 🔥${e.hotScore.toFixed(2)}` : '';
    return `- ${link} *(${e.type})*${tldr}${dateBadge}${heatBadge}`;
  });

  const open = OPEN_TAG(REGION_ID);
  const close = CLOSE_TAG(REGION_ID);
  const body = `${HEADER}${open}\n${lines.join('\n')}\n${close}\n`;
  const path = vaultIndexPath(layout);
  // Ensure parent dir exists (e.g. `Curated/` when layout overrides to `Curated/index.md`).
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  if (dir) await vault.ensureFolder(dir);
  await vault.atomicWrite(path, body);
  return { entries: entries.length };
}
