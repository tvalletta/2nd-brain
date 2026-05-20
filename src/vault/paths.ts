import type { KarpathyConfig, LayoutConfig } from '../config/schema.js';

export type EntityKind = 'person' | 'project' | 'concept' | 'decision' | 'tool' | 'topic' | 'organization';

/**
 * Maps entity kinds to subfolder names within `<layout.wiki>/...`. This
 * intentionally does NOT include the `wiki/` prefix — that comes from the
 * layout config so callers can be retargeted without code changes.
 */
const ENTITY_KIND_SUBFOLDER: Record<EntityKind, string> = {
  person: 'entities',
  project: 'projects',
  concept: 'concepts',
  decision: 'decisions',
  tool: 'tools',
  topic: 'topics',
  organization: 'organizations',
};

/**
 * Legacy export — preserved so any code importing `KIND_TO_FOLDER` (which is
 * widely used) continues to compile. Uses the default layout's `wiki` prefix.
 * Prefer `kindToFolder(layout, kind)` for new code so the layout config is
 * respected.
 */
export const KIND_TO_FOLDER: Record<EntityKind, string> = Object.fromEntries(
  (Object.keys(ENTITY_KIND_SUBFOLDER) as EntityKind[]).map((k) => [k, `wiki/${ENTITY_KIND_SUBFOLDER[k]}`]),
) as Record<EntityKind, string>;

/** Layout-aware entity-folder resolver. */
export function kindToFolder(layout: VaultLayout, kind: EntityKind): string {
  return `${layout.wiki}/${ENTITY_KIND_SUBFOLDER[kind]}`;
}

/**
 * Legacy: list of folders containing compilable/linkable wiki pages, using
 * default-layout paths. Prefer `wikiContentFolders(layout)` for layout-aware
 * code.
 */
export const WIKI_CONTENT_FOLDERS = [
  ...Object.values(KIND_TO_FOLDER),
  'wiki/sources',
  'wiki/sessions',
  'outputs/source-summaries',
] as const;

/** Layout-aware list of wiki content folders. */
export function wikiContentFolders(layout: VaultLayout): string[] {
  return [
    ...(Object.keys(ENTITY_KIND_SUBFOLDER) as EntityKind[]).map((k) => kindToFolder(layout, k)),
    `${layout.wiki}/sources`,
    `${layout.wiki}/sessions`,
    layout.sources,
  ];
}

/**
 * Wiki entity folders (concepts, projects, decisions, entities, etc.) plus
 * additional "notes" and "meetings" subfolders if they exist. Used by MCP
 * search tools that want to cover every machine-curated page.
 */
export function allWikiFolders(layout: VaultLayout): string[] {
  return [
    ...(Object.keys(ENTITY_KIND_SUBFOLDER) as EntityKind[]).map((k) => kindToFolder(layout, k)),
    `${layout.wiki}/notes`,
    `${layout.wiki}/meetings`,
  ];
}

/**
 * Every readable wiki + outputs folder. Used by `search-vault`, `get-note`,
 * `vault-status`, etc. — anywhere the search surface should span both
 * curated knowledge AND extraction records.
 */
export function searchableFolders(layout: VaultLayout): string[] {
  return [...allWikiFolders(layout), layout.aiSummaries, layout.sources];
}

// ---------------------------------------------------------------------------
// VaultLayout — physical paths for each logical concept
// ---------------------------------------------------------------------------

/**
 * Resolved vault layout. Identical shape to the Zod `LayoutConfig` type, but
 * exported separately so non-config-aware modules can accept a `VaultLayout`
 * without importing the schema.
 */
export type VaultLayout = LayoutConfig;

/** Pull the resolved layout out of a parsed KarpathyConfig. */
export function layoutFromConfig(config: Pick<KarpathyConfig, 'layout'>): VaultLayout {
  return config.layout;
}

/**
 * Legacy default layout. Use when you don't have a `KarpathyConfig` handy
 * (e.g. in tests or in legacy code paths that still need to call layout-aware
 * helpers). Matches what `layoutFromConfig` returns when no overrides are set.
 */
export const DEFAULT_LAYOUT: VaultLayout = {
  aiConversations: 'raw/ai-conversations',
  aiSummaries: 'outputs/session-summaries',
  aiLegacy: 'raw/legacy-sessions',
  wiki: 'wiki',
  sources: 'outputs/source-summaries',
  review: 'review',
  system: 'wiki/_system',
  extractions: 'outputs/extractions',
  reviews: 'outputs/reviews',
  digests: 'wiki/digests',
  vaultIndex: 'index.md',
  vaultLog: 'log.md',
  clippings: 'clippings',
};

// ---------------------------------------------------------------------------
// Filename / path helpers (unchanged)
// ---------------------------------------------------------------------------

export function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return normalized || 'untitled';
}

export function joinPath(folder: string, fileName: string): string {
  return `${folder}/${fileName}`;
}

function withCollisionSuffix(fileName: string, suffix: number): string {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex === -1) {
    return `${fileName}-${suffix}`;
  }
  const base = fileName.slice(0, dotIndex);
  const ext = fileName.slice(dotIndex);
  return `${base}-${suffix}${ext}`;
}

export function resolveAvailablePath(
  folder: string,
  initialFileName: string,
  existingPaths: Set<string>,
): string {
  let candidate = joinPath(folder, initialFileName);
  if (!existingPaths.has(candidate)) {
    return candidate;
  }

  let suffix = 2;
  while (existingPaths.has(candidate)) {
    candidate = joinPath(folder, withCollisionSuffix(initialFileName, suffix));
    suffix += 1;
  }
  return candidate;
}

export function buildNoteFilename(title: string): string {
  const slug = slugify(title);
  return `${slug}.md`;
}

export function normalizeFolder(folder: string): string {
  return folder.replace(/\/+$/, '').trim();
}
