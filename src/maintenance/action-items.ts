// Action items, recovered from the extraction pipeline's action_items field.
// Tracked as a markdown checklist, not individual pages: per-project at
// `{layout.wiki}/projects/{slug}/action-items.md` (reusing the existing
// project-spec mechanism in project-hub.ts, which always targets a region
// literally named 'content') plus a vault-wide rollup at
// `{layout.system}/action-items.md` (this module's own 'action-item-entries'
// region). '_general'/'_discovery' project slugs (cwd-classifier.ts's
// non-project buckets) skip the per-project file.

import { nanoid } from 'nanoid';
import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { getProtectedRegion, updateProtectedRegion, OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';
import { nowISO } from '../shared/date-utils.js';
import { getOrCreateProjectHub, createProjectSpec, updateProjectSpec } from '../compilation/project-hub.js';

const ROLLUP_REGION_ID = 'action-item-entries';
const NON_PROJECT_SLUGS = new Set(['_general', '_discovery']);

export interface ActionItem {
  id: string;
  task: string;
  sourceRef: string;
  projectSlug?: string; // present only on rollup entries
  status: 'open' | 'done';
}

function extractSlug(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/, '') ?? path;
}

// Render order is: checkbox, task, optional "(projectSlug)", then the
// source/id suffix — the parse regex below must mirror this exact order.
const ITEM_RE = /^- \[( |x)\] (.+?)(?: \((.+?)\))? — from \[\[(.+?)\]\] `id:([a-zA-Z0-9_-]+)`$/;

function parseChecklist(inner: string): ActionItem[] {
  const items: ActionItem[] = [];
  for (const line of inner.split('\n')) {
    const m = line.match(ITEM_RE);
    if (!m) continue;
    items.push({
      status: m[1] === 'x' ? 'done' : 'open',
      task: m[2],
      projectSlug: m[3] || undefined,
      sourceRef: m[4],
      id: m[5],
    });
  }
  return items;
}

function renderChecklist(items: ActionItem[], includeProject: boolean): string {
  return items
    .map((item) => {
      const box = item.status === 'done' ? 'x' : ' ';
      const projectPart = includeProject && item.projectSlug ? ` (${item.projectSlug})` : '';
      return `- [${box}] ${item.task}${projectPart} — from [[${extractSlug(item.sourceRef)}]] \`id:${item.id}\``;
    })
    .join('\n');
}

function mergeNewItem(existing: ActionItem[], task: string, sourceRef: string, projectSlug?: string): ActionItem[] {
  // Parsed items only ever carry the slug (renderChecklist always writes
  // extractSlug(sourceRef) into the line), so a raw path like
  // 'sources/s1.md' must be normalized the same way before comparing —
  // otherwise every re-run against an already-rendered file appends a
  // duplicate. Mirrors the sourceRefSlug idiom in concept-glossary.ts.
  const sourceSlug = extractSlug(sourceRef);
  const alreadyPresent = existing.some((i) => i.task === task && i.sourceRef === sourceSlug && i.projectSlug === projectSlug);
  if (alreadyPresent) return existing;
  return [...existing, { id: nanoid(8), task, sourceRef, projectSlug, status: 'open' }];
}

export async function upsertActionItem(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
  item: { task: string; sourceRef: string; projectSlug: string },
): Promise<void> {
  // --- Rollup: fully custom file/region, always updated. ---
  const rollupPath = `${layout.system}/action-items.md`;
  const open = OPEN_TAG(ROLLUP_REGION_ID);
  const close = CLOSE_TAG(ROLLUP_REGION_ID);

  const rollupExists = await vault.exists(rollupPath);
  let rollupInner = '';
  if (rollupExists) {
    rollupInner = getProtectedRegion(await vault.read(rollupPath), ROLLUP_REGION_ID) ?? '';
  } else {
    await vault.ensureFolder(layout.system);
  }
  const rollupRendered = renderChecklist(
    mergeNewItem(parseChecklist(rollupInner), item.task, item.sourceRef, item.projectSlug),
    true,
  );

  if (rollupExists) {
    const content = await vault.read(rollupPath);
    const { data, body } = parseNote(content);
    const updatedBody = updateProtectedRegion(body, ROLLUP_REGION_ID, rollupRendered);
    await vault.atomicWrite(rollupPath, serializeNote({ ...data, updated_at: nowISO() }, updatedBody));
  } else {
    const now = nowISO();
    const frontmatter = { id: nanoid(), type: 'index', title: 'Action items', created_at: now, updated_at: now, protected_regions: [ROLLUP_REGION_ID] };
    const body = `\n# Action items\n\nEvery open action item across all projects.\n\n## Items\n${open}\n${rollupRendered}\n${close}\n`;
    await vault.atomicWrite(rollupPath, serializeNote(frontmatter, body));
  }

  if (NON_PROJECT_SLUGS.has(item.projectSlug)) return;

  // --- Per-project: reuses project-hub.ts's spec-file mechanism. ---
  await getOrCreateProjectHub(vault, item.projectSlug, item.projectSlug, item.sourceRef, layout);
  const specPath = `${layout.wiki}/projects/${item.projectSlug}/action-items.md`;

  if (!(await vault.exists(specPath))) {
    const rendered = renderChecklist(mergeNewItem([], item.task, item.sourceRef), false);
    await createProjectSpec(vault, item.projectSlug, 'action-items', 'Action Items', rendered, item.sourceRef, layout);
    return;
  }

  const existingContent = getProtectedRegion(await vault.read(specPath), 'content') ?? '';
  const mergedItems = mergeNewItem(parseChecklist(existingContent), item.task, item.sourceRef);
  await updateProjectSpec(vault, specPath, renderChecklist(mergedItems, false), false, item.sourceRef);
}
