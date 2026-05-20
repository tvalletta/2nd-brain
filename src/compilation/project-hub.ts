import { nanoid } from 'nanoid';
import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { updateProtectedRegion, OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { slugify, DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';
import { nowISO } from '../shared/date-utils.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('project-hub');

export interface ProjectHub {
  /** Path to the hub index page, e.g. wiki/projects/{slug}/_index.md */
  indexPath: string;
  /** Paths to all sub-spec pages */
  specPaths: string[];
  /** The project slug */
  projectSlug: string;
  /** Whether the hub was just created (vs already existing) */
  created: boolean;
}

export interface ProjectSpecInfo {
  path: string;
  specType: string;
  title: string;
  frontmatter: Record<string, unknown>;
}

/**
 * Get or create a project hub directory with an _index.md.
 * If a legacy single-file project page exists at wiki/projects/{slug}.md,
 * it will NOT be automatically migrated — use migrateProjectsToHubs() for that.
 */
export async function getOrCreateProjectHub(
  vault: VaultAdapter,
  projectSlug: string,
  projectName: string,
  sourcePath?: string,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<ProjectHub> {
  const projectsBase = `${layout.wiki}/projects`;
  const hubDir = `${projectsBase}/${projectSlug}`;
  const indexPath = `${hubDir}/_index.md`;

  // Check if hub already exists
  if (await vault.exists(indexPath)) {
    const specPaths = await listSpecPaths(vault, hubDir);
    return { indexPath, specPaths, projectSlug, created: false };
  }

  // Check if a legacy single-page project exists
  const legacyPath = `${projectsBase}/${projectSlug}.md`;
  if (await vault.exists(legacyPath)) {
    // Legacy page exists — don't auto-migrate, just return the legacy path info.
    // The migration script should handle this.
    return {
      indexPath: legacyPath,
      specPaths: [],
      projectSlug,
      created: false,
    };
  }

  // Create the hub
  await vault.ensureFolder(hubDir);

  const now = nowISO();
  const frontmatter: Record<string, unknown> = {
    id: nanoid(),
    type: 'project',
    title: projectName,
    project_key: projectSlug,
    project_status: 'active',
    status: 'active',
    confidence: 'medium',
    review_state: 'unreviewed',
    created_at: now,
    updated_at: now,
    source_refs: sourcePath ? [sourcePath] : [],
    derived_from: [],
    aliases: [],
    links: [],
    change_origin: 'extraction',
    protected_regions: ['overview', 'specs', 'people', 'sessions', 'sources', 'backlinks'],
  };

  const body = `
# ${projectName}

## Overview
${OPEN_TAG('overview')}
Pending enrichment.
${CLOSE_TAG('overview')}

## Specifications
${OPEN_TAG('specs')}
${CLOSE_TAG('specs')}

## Key People
${OPEN_TAG('people')}
${CLOSE_TAG('people')}

## Recent Sessions
${OPEN_TAG('sessions')}
${CLOSE_TAG('sessions')}

## Source References
${OPEN_TAG('sources')}
${CLOSE_TAG('sources')}

## Backlinks
${OPEN_TAG('backlinks')}
${CLOSE_TAG('backlinks')}
`;

  const content = serializeNote(frontmatter, body);
  await vault.atomicWrite(indexPath, content);
  log.info('Project hub created', { slug: projectSlug, path: indexPath });

  return { indexPath, specPaths: [], projectSlug, created: true };
}

/**
 * List all sub-spec pages for a project hub.
 */
export async function listProjectSpecs(
  vault: VaultAdapter,
  projectSlug: string,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<ProjectSpecInfo[]> {
  const hubDir = `${layout.wiki}/projects/${projectSlug}`;
  const files = await listSpecPaths(vault, hubDir);
  const specs: ProjectSpecInfo[] = [];

  for (const path of files) {
    try {
      const content = await vault.read(path);
      const { data } = parseNote(content);
      specs.push({
        path,
        specType: (data.spec_type as string) ?? extractSpecTypeFromPath(path),
        title: (data.title as string) ?? '',
        frontmatter: data,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return specs;
}

/**
 * Create a new project sub-spec page.
 * Returns the path of the created page.
 */
export async function createProjectSpec(
  vault: VaultAdapter,
  projectSlug: string,
  specType: string,
  title: string,
  initialContent: string,
  sourcePath?: string,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<string> {
  const hubDir = `${layout.wiki}/projects/${projectSlug}`;
  await vault.ensureFolder(hubDir);

  const specPath = `${hubDir}/${slugify(specType)}.md`;
  const now = nowISO();

  const frontmatter: Record<string, unknown> = {
    id: nanoid(),
    type: 'project_spec',
    title,
    project_key: projectSlug,
    spec_type: specType,
    status: 'active',
    confidence: 'medium',
    review_state: 'unreviewed',
    created_at: now,
    updated_at: now,
    last_reinforced: now,
    reinforcement_count: 1,
    conversations_since_update: 0,
    stale_threshold: 10,
    source_refs: sourcePath ? [sourcePath] : [],
    derived_from: [],
    aliases: [],
    links: [],
    change_origin: 'extraction',
    protected_regions: ['content', 'backlinks'],
  };

  const body = `
# ${title}

${OPEN_TAG('content')}
${initialContent || 'Pending enrichment.'}
${CLOSE_TAG('content')}

## Backlinks
${OPEN_TAG('backlinks')}
${CLOSE_TAG('backlinks')}
`;

  const content = serializeNote(frontmatter, body);
  await vault.atomicWrite(specPath, content);
  log.info('Project spec created', { slug: projectSlug, specType, path: specPath });

  // Update the hub's specs region
  await updateHubSpecsList(vault, projectSlug, layout);

  return specPath;
}

/**
 * Update a project sub-spec's content protected region.
 * Optionally marks it as reinforced (resets conversations_since_update).
 */
export async function updateProjectSpec(
  vault: VaultAdapter,
  specPath: string,
  newContent: string,
  reinforced: boolean = true,
  sourcePath?: string,
): Promise<void> {
  const content = await vault.read(specPath);
  const { data, body } = parseNote(content);

  let updatedBody = updateProtectedRegion(body, 'content', newContent);

  const now = nowISO();
  data.updated_at = now;

  if (reinforced) {
    data.last_reinforced = now;
    data.reinforcement_count = ((data.reinforcement_count as number) ?? 0) + 1;
    data.conversations_since_update = 0;
  }

  if (sourcePath) {
    const refs = (data.source_refs as string[]) ?? [];
    if (!refs.includes(sourcePath)) {
      refs.push(sourcePath);
      data.source_refs = refs;
    }
  }

  const result = serializeNote(data, updatedBody);
  await vault.atomicWrite(specPath, result);
  log.info('Project spec updated', { path: specPath, reinforced });
}

/**
 * Check if a project is using the hub model (directory with _index.md)
 * vs legacy single-file model.
 */
export async function isProjectHub(
  vault: VaultAdapter,
  projectSlug: string,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<boolean> {
  return vault.exists(`${layout.wiki}/projects/${projectSlug}/_index.md`);
}

// --- Internal helpers ---

async function listSpecPaths(vault: VaultAdapter, hubDir: string): Promise<string[]> {
  try {
    const files = await vault.listMarkdownFiles(hubDir);
    return files.filter((f) => !f.endsWith('_index.md'));
  } catch {
    return [];
  }
}

function extractSpecTypeFromPath(path: string): string {
  const fileName = path.split('/').pop()?.replace(/\.md$/, '') ?? '';
  return fileName;
}

/**
 * Update the hub's specs protected region with links to all sub-specs.
 */
async function updateHubSpecsList(
  vault: VaultAdapter,
  projectSlug: string,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<void> {
  const indexPath = `${layout.wiki}/projects/${projectSlug}/_index.md`;
  if (!(await vault.exists(indexPath))) return;

  const specs = await listProjectSpecs(vault, projectSlug, layout);
  if (specs.length === 0) return;

  const specsList = specs
    .map((s) => {
      const slug = s.path.split('/').pop()?.replace(/\.md$/, '') ?? '';
      return `- [[${slug}]] — ${s.title}`;
    })
    .join('\n');

  const content = await vault.read(indexPath);
  const { data, body } = parseNote(content);
  const updatedBody = updateProtectedRegion(body, 'specs', specsList);
  data.updated_at = nowISO();
  const result = serializeNote(data, updatedBody);
  await vault.atomicWrite(indexPath, result);
}
