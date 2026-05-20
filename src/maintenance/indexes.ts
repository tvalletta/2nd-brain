import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote } from '../vault/frontmatter.js';
import { updateProtectedRegion, getProtectedRegion, OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { nowISO } from '../shared/date-utils.js';
import { createLogger } from '../shared/logger.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';

const log = createLogger('indexes');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IndexEntry {
  /** Vault-relative path, e.g. "wiki/entities/alice-chen.md" */
  path: string;
  /** Slug derived from filename, used for wikilinks */
  slug: string;
  title: string;
  type: string;
  status: string;
  /** Full note body (used for extracting wikilinks in category indexes) */
  body: string;
  /** Full frontmatter bag for type-specific fields */
  data: Record<string, unknown>;
}

/** Describes a category index that should be built */
interface CategorySpec {
  /** Vault folder to scan, e.g. "wiki/entities" */
  folder: string;
  /** Output index path */
  indexPath: string;
  /** Heading used in the master index */
  masterHeading: string;
  /** NoteType values that belong to this category */
  noteTypes: string[];
  /** How to render the category index body */
  renderer: (entries: IndexEntry[]) => string;
  /** Protected region id for the category index */
  regionId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract all [[wikilink]] targets from a string */
function extractWikilinks(text: string): string[] {
  const matches = text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
  const links: string[] = [];
  for (const m of matches) {
    links.push(m[1].trim());
  }
  return links;
}

/** Get wikilinks from a specific protected region of a note body */
function linksFromRegion(body: string, regionId: string): string[] {
  // Reconstruct full content with a fake frontmatter so getProtectedRegion works
  const regionContent = getProtectedRegion(body, regionId);
  if (!regionContent) return [];
  return extractWikilinks(regionContent);
}

function slugFromPath(path: string): string {
  const parts = path.split('/');
  const filename = parts.pop()?.replace(/\.md$/, '') ?? path;
  // For hub files named _index, use the parent directory name as slug
  return filename === '_index' ? (parts.pop() ?? filename) : filename;
}

/** Safely coerce a frontmatter value to string (gray-matter auto-parses dates to Date objects) */
function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (value == null) return '';
  return String(value);
}

/** Default threshold below which entities are annotated as needing review */
const LOW_CONFIDENCE_THRESHOLD = 0.7;

/** Return a confidence annotation tag if entity confidence is below threshold */
function confidenceTag(data: Record<string, unknown>, threshold = LOW_CONFIDENCE_THRESHOLD): string {
  const confidence = data.confidence;
  if (typeof confidence !== 'number') return '';
  if (confidence < threshold) return ' `[needs review]`';
  return '';
}

/** Coerce a date-like frontmatter value to a display-friendly date string (YYYY-MM-DD) */
function asDateDisplay(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') {
    // If it looks like an ISO date, trim to just the date portion
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    return value;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Entry collection
// ---------------------------------------------------------------------------

async function collectEntries(
  vault: VaultAdapter,
  folder: string,
  noteTypes?: string[],
): Promise<IndexEntry[]> {
  const paths = await vault.listMarkdownFiles(folder);
  const entries: IndexEntry[] = [];

  for (const path of paths) {
    // Skip the category-level _index.md (directly inside `folder`) but NOT
    // hub-level _index.md files nested one level deeper (e.g. projects/sandbox-expansions/_index.md).
    if (path === `${folder}/_index.md`) continue;
    try {
      const content = await vault.read(path);
      const { data, body } = parseNote(content);
      const type = (data.type as string) ?? 'unknown';

      // If noteTypes filter is provided, skip entries that don't match.
      // This prevents project sub-specs (type: project_spec) from appearing
      // in the projects index alongside actual project hub entries.
      if (noteTypes && noteTypes.length > 0 && !noteTypes.includes(type)) {
        continue;
      }

      entries.push({
        path,
        slug: slugFromPath(path),
        title: (data.title as string) ?? slugFromPath(path),
        type,
        status: (data.status as string) ?? 'unknown',
        body,
        data,
      });
    } catch {
      entries.push({
        path,
        slug: slugFromPath(path),
        title: slugFromPath(path),
        type: 'unknown',
        status: 'unknown',
        body: '',
        data: {},
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Index page scaffolding
// ---------------------------------------------------------------------------

function makeIndexFrontmatter(
  id: string,
  title: string,
  regions: string[],
): string {
  const now = nowISO();
  const regionYaml = regions.map((r) => `  - ${r}`).join('\n');
  return `---
id: ${id}
type: index
title: ${title}
status: active
created_at: ${now}
updated_at: ${now}
source_refs: []
derived_from: []
aliases: []
links: []
change_origin: deterministic_maintenance
protected_regions:
${regionYaml}
---`;
}

async function ensureIndexPage(
  vault: VaultAdapter,
  indexPath: string,
  id: string,
  title: string,
  heading: string,
  regionIds: string[],
): Promise<string> {
  if (await vault.exists(indexPath)) {
    return vault.read(indexPath);
  }

  const regionBlocks = regionIds
    .map((r) => `${OPEN_TAG(r)}\n${CLOSE_TAG(r)}`)
    .join('\n\n');

  const content = `${makeIndexFrontmatter(id, title, regionIds)}

# ${heading}

${regionBlocks}
`;
  // Ensure the folder exists before writing
  const folder = indexPath.split('/').slice(0, -1).join('/');
  if (folder) await vault.ensureFolder(folder);
  await vault.write(indexPath, content);
  return content;
}

// ---------------------------------------------------------------------------
// Category renderers
// ---------------------------------------------------------------------------

function renderAlphabetical(entries: IndexEntry[], descriptionFn?: (e: IndexEntry) => string): string {
  if (entries.length === 0) return 'No pages yet.';
  const sorted = [...entries].sort((a, b) => a.title.localeCompare(b.title));
  return sorted
    .map((e) => {
      const desc = descriptionFn ? descriptionFn(e) : `${e.title} (${e.status})`;
      return `- [[${e.slug}]] — ${desc}${confidenceTag(e.data)}`;
    })
    .join('\n');
}

function renderEntitiesCategory(entries: IndexEntry[]): string {
  if (entries.length === 0) return 'No pages yet.';
  const sorted = [...entries].sort((a, b) => a.title.localeCompare(b.title));
  return sorted
    .map((e) => {
      const entityKind = (e.data.entity_kind as string) ?? 'person';
      const projects = linksFromRegion(e.body, 'projects');
      let line = `- [[${e.slug}]] — ${e.title}`;
      if (entityKind !== 'person') line += ` [${entityKind}]`;
      line += ` (${e.status})${confidenceTag(e.data)}`;
      if (projects.length > 0) {
        line += ` | Projects: ${projects.map((p) => `[[${p}]]`).join(', ')}`;
      }
      return line;
    })
    .join('\n');
}

function renderProjectsCategory(entries: IndexEntry[]): string {
  if (entries.length === 0) return 'No pages yet.';

  const groups: Record<string, IndexEntry[]> = {
    active: [],
    completed: [],
    archived: [],
    other: [],
  };

  for (const e of entries) {
    const ps = ((e.data.project_status as string) ?? e.status).toLowerCase();
    if (ps === 'active') groups.active.push(e);
    else if (ps === 'completed') groups.completed.push(e);
    else if (ps === 'archived') groups.archived.push(e);
    else groups.other.push(e);
  }

  const sections: string[] = [];
  for (const [label, items] of [
    ['Active', groups.active],
    ['Completed', groups.completed],
    ['Archived', groups.archived],
    ['Other', groups.other],
  ] as [string, IndexEntry[]][]) {
    if (items.length === 0) continue;
    const sorted = [...items].sort((a, b) => a.title.localeCompare(b.title));
    const lines = sorted.map((e) => {
      const people = linksFromRegion(e.body, 'people');
      let line = `- [[${e.slug}]] — ${e.title}`;
      if (people.length > 0) {
        line += ` | People: ${people.map((p) => `[[${p}]]`).join(', ')}`;
      }
      return line;
    });
    sections.push(`## ${label}\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}

function renderDecisionsCategory(entries: IndexEntry[]): string {
  if (entries.length === 0) return 'No pages yet.';
  // Sort by decision_date descending, falling back to created_at
  const sorted = [...entries].sort((a, b) => {
    const dateA = asString(a.data.decision_date) || asString(a.data.created_at);
    const dateB = asString(b.data.decision_date) || asString(b.data.created_at);
    return dateB.localeCompare(dateA);
  });
  return sorted
    .map((e) => {
      const decisionStatus = asString(e.data.decision_status) || 'proposed';
      const date = asDateDisplay(e.data.decision_date);
      const people = linksFromRegion(e.body, 'people');
      let line = `- [[${e.slug}]] — ${e.title}`;
      if (date) line += ` (${date})`;
      line += ` [${decisionStatus}]${confidenceTag(e.data)}`;
      if (people.length > 0) {
        line += ` | People: ${people.map((p) => `[[${p}]]`).join(', ')}`;
      }
      return line;
    })
    .join('\n');
}

function renderToolsCategory(entries: IndexEntry[]): string {
  if (entries.length === 0) return 'No pages yet.';
  const sorted = [...entries].sort((a, b) => a.title.localeCompare(b.title));
  return sorted
    .map((e) => {
      const cat = (e.data.tool_category as string) ?? '';
      let line = `- [[${e.slug}]] — ${e.title} (${e.status})${confidenceTag(e.data)}`;
      if (cat) line += ` [${cat}]`;
      return line;
    })
    .join('\n');
}

function renderOrganizationsCategory(entries: IndexEntry[]): string {
  if (entries.length === 0) return 'No pages yet.';
  const sorted = [...entries].sort((a, b) => a.title.localeCompare(b.title));
  return sorted
    .map((e) => {
      const orgType = (e.data.org_type as string) ?? '';
      let line = `- [[${e.slug}]] — ${e.title} (${e.status})${confidenceTag(e.data)}`;
      if (orgType && orgType !== 'other') line += ` [${orgType}]`;
      return line;
    })
    .join('\n');
}

function renderSourcesCategory(entries: IndexEntry[]): string {
  if (entries.length === 0) return 'No pages yet.';
  // Sort by created_at descending (most recent first)
  const sorted = [...entries].sort((a, b) => {
    const dateA = asString(a.data.created_at);
    const dateB = asString(b.data.created_at);
    return dateB.localeCompare(dateA);
  });
  return sorted
    .map((e) => {
      const sourceType = asString(e.data.source_type);
      const ingestStatus = asString(e.data.ingest_status);
      let line = `- [[${e.slug}]] — ${e.title}`;
      if (sourceType) line += ` [${sourceType}]`;
      if (ingestStatus) line += ` (${ingestStatus})`;
      return line;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Category specifications
// ---------------------------------------------------------------------------

function categorySpecs(layout: VaultLayout): CategorySpec[] {
  return [
    {
      folder: `${layout.wiki}/entities`,
      indexPath: `${layout.wiki}/entities/_index.md`,
      masterHeading: 'People',
      noteTypes: ['entity'],
      renderer: renderEntitiesCategory,
      regionId: 'entries',
    },
    {
      folder: `${layout.wiki}/projects`,
      indexPath: `${layout.wiki}/projects/_index.md`,
      masterHeading: 'Projects',
      noteTypes: ['project'],
      renderer: renderProjectsCategory,
      regionId: 'entries',
    },
    {
      folder: `${layout.wiki}/concepts`,
      indexPath: `${layout.wiki}/concepts/_index.md`,
      masterHeading: 'Concepts',
      noteTypes: ['concept'],
      renderer: renderAlphabetical,
      regionId: 'entries',
    },
    {
      folder: `${layout.wiki}/topics`,
      indexPath: `${layout.wiki}/topics/_index.md`,
      masterHeading: 'Topics',
      noteTypes: ['topic'],
      renderer: renderAlphabetical,
      regionId: 'entries',
    },
    {
      folder: `${layout.wiki}/decisions`,
      indexPath: `${layout.wiki}/decisions/_index.md`,
      masterHeading: 'Decisions',
      noteTypes: ['decision'],
      renderer: renderDecisionsCategory,
      regionId: 'entries',
    },
    {
      folder: `${layout.wiki}/tools`,
      indexPath: `${layout.wiki}/tools/_index.md`,
      masterHeading: 'Tools',
      noteTypes: ['tool'],
      renderer: renderToolsCategory,
      regionId: 'entries',
    },
    {
      folder: `${layout.wiki}/organizations`,
      indexPath: `${layout.wiki}/organizations/_index.md`,
      masterHeading: 'Organizations',
      noteTypes: ['organization'],
      renderer: renderOrganizationsCategory,
      regionId: 'entries',
    },
    {
      folder: layout.sources,
      indexPath: `${layout.sources}/_index.md`,
      masterHeading: 'Sources',
      noteTypes: ['source_summary'],
      renderer: renderSourcesCategory,
      regionId: 'entries',
    },
  ];
}

// ---------------------------------------------------------------------------
// Master index rendering
// ---------------------------------------------------------------------------

function renderMasterSection(heading: string, entries: IndexEntry[]): string {
  if (entries.length === 0) return '';
  const sorted = [...entries].sort((a, b) => a.title.localeCompare(b.title));
  const lines = sorted.map((e) => `- [[${e.slug}]] — ${e.title} (${e.status})${confidenceTag(e.data)}`);
  return `## ${heading}\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rebuild a single category index for the given folder.
 * Returns the number of entries found.
 */
export async function rebuildCategoryIndex(
  vault: VaultAdapter,
  folder: string,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<number> {
  const spec = categorySpecs(layout).find((s) => s.folder === folder);
  if (!spec) {
    log.warn('No category spec found for folder', { folder });
    return 0;
  }

  const entries = await collectEntries(vault, spec.folder, spec.noteTypes);

  const id = spec.folder.replace(/\//g, '-') + '-index';
  const title = `${spec.masterHeading} Index`;
  const heading = spec.masterHeading;

  let content = await ensureIndexPage(vault, spec.indexPath, id, title, heading, [spec.regionId]);

  const rendered = spec.renderer(entries);
  content = updateProtectedRegion(content, spec.regionId, rendered);
  await vault.write(spec.indexPath, content);

  log.info('Category index rebuilt', { folder: spec.folder, entries: entries.length });
  return entries.length;
}

/**
 * Rebuild the master wiki index at wiki/_index.md.
 * This is the backward-compatible entry point that also rebuilds all category indexes.
 *
 * Returns the total number of entries across all categories.
 */
export async function rebuildWikiIndex(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<number> {
  const specs = categorySpecs(layout);

  // Collect entries for every category
  const categoryEntries = new Map<CategorySpec, IndexEntry[]>();
  let totalCount = 0;

  for (const spec of specs) {
    const entries = await collectEntries(vault, spec.folder, spec.noteTypes);
    categoryEntries.set(spec, entries);
    totalCount += entries.length;
  }

  // --- Build master index ---
  const masterPath = `${layout.wiki}/_index.md`;
  let masterContent = await ensureIndexPage(
    vault,
    masterPath,
    'wiki-index',
    'Wiki Index',
    'Wiki Index',
    ['pages'],
  );

  // Render the master body: one section per non-empty category
  const masterSections: string[] = [];
  for (const spec of specs) {
    const entries = categoryEntries.get(spec) ?? [];
    const section = renderMasterSection(spec.masterHeading, entries);
    if (section) masterSections.push(section);
  }

  const masterBody = masterSections.length > 0
    ? masterSections.join('\n\n')
    : 'No pages yet.';

  masterContent = updateProtectedRegion(masterContent, 'pages', masterBody);
  await vault.write(masterPath, masterContent);

  // --- Build category indexes ---
  for (const spec of specs) {
    const entries = categoryEntries.get(spec) ?? [];

    const id = spec.folder.replace(/\//g, '-') + '-index';
    const title = `${spec.masterHeading} Index`;

    let content = await ensureIndexPage(
      vault,
      spec.indexPath,
      id,
      title,
      spec.masterHeading,
      [spec.regionId],
    );

    const rendered = spec.renderer(entries);
    content = updateProtectedRegion(content, spec.regionId, rendered);
    await vault.write(spec.indexPath, content);
  }

  log.info('All indexes rebuilt', { total: totalCount });
  return totalCount;
}

/**
 * Rebuild all indexes: master index + every category index.
 * Returns the total number of entries across all categories.
 */
export async function rebuildAllIndexes(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<number> {
  return rebuildWikiIndex(vault, layout);
}
