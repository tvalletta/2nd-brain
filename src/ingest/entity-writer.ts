import { nanoid } from 'nanoid';
import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { updateProtectedRegion, getProtectedRegion, OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import {
  slugify,
  resolveAvailablePath,
  kindToFolder,
  DEFAULT_LAYOUT,
  type VaultLayout,
} from '../vault/paths.js';
import { nowISO } from '../shared/date-utils.js';
import { createLogger } from '../shared/logger.js';
import type { EntityResolution, EntityKind } from './entity-resolver.js';
import { getOrCreateProjectHub } from '../compilation/project-hub.js';

const log = createLogger('entity-writer');

export interface ExtractedEntityInfo {
  name: string;
  kind: EntityKind;
  role?: string;
  context?: string;
  definition?: string;
  status?: string;
  chunkRefs: string[];
}

export interface MergeResult {
  changed: boolean;
  fieldsUpdated: string[];
}

export async function createEntityPage(
  vault: VaultAdapter,
  resolution: EntityResolution,
  info: ExtractedEntityInfo,
  sourcePath: string,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<string> {
  // Projects use the hub model — delegate to project-hub.ts
  if (info.kind === 'project') {
    const projectSlug = slugify(info.name);
    const hub = await getOrCreateProjectHub(vault, projectSlug, info.name, sourcePath, layout);
    log.info('Entity page created (project hub)', { path: hub.indexPath, kind: info.kind, name: info.name });
    return hub.indexPath;
  }

  const folder = kindToFolder(layout, info.kind);
  await vault.ensureFolder(folder);

  const slug = slugify(info.name);
  const existingPaths = new Set(await vault.listMarkdownFiles(folder));
  const filePath = resolution.suggestedPath && !existingPaths.has(resolution.suggestedPath)
    ? resolution.suggestedPath
    : resolveAvailablePath(folder, `${slug}.md`, existingPaths);

  const now = nowISO();
  const mention = formatMention(sourcePath, info.context ?? info.definition ?? '', info.chunkRefs);

  const frontmatter = buildFrontmatter(info, now, sourcePath);

  const summaryContent = buildSummaryContent(info);
  const body = buildBody(info.name, info.kind, summaryContent, mention);
  const content = serializeNote(frontmatter, body);

  await vault.atomicWrite(filePath, content);
  log.info('Entity page created', { path: filePath, kind: info.kind, name: info.name });
  return filePath;
}

export async function mergeEntityPage(
  vault: VaultAdapter,
  path: string,
  info: ExtractedEntityInfo,
  sourcePath: string,
): Promise<MergeResult> {
  const content = await vault.read(path);
  const { data, body } = parseNote(content);
  const fieldsUpdated: string[] = [];

  // Idempotent: skip if this source is already referenced
  const sourceRefs = (data.source_refs as string[]) ?? [];
  if (sourceRefs.includes(sourcePath)) {
    return { changed: false, fieldsUpdated: [] };
  }

  // Update source_refs
  sourceRefs.push(sourcePath);
  data.source_refs = sourceRefs;
  data.updated_at = nowISO();
  fieldsUpdated.push('source_refs', 'updated_at');

  // Add alias if new name variant
  const aliases = (data.aliases as string[]) ?? [];
  const canonicalName = (data.canonical_name as string) ?? (data.title as string) ?? '';
  if (
    info.name.toLowerCase() !== canonicalName.toLowerCase() &&
    !aliases.some((a) => a.toLowerCase() === info.name.toLowerCase())
  ) {
    aliases.push(info.name);
    data.aliases = aliases;
    fieldsUpdated.push('aliases');
  }

  // Append to mentions/timeline region
  let updatedBody = body;
  const mention = formatMention(sourcePath, info.context ?? info.definition ?? '', info.chunkRefs);
  const mentionsRegion = getMentionsRegionId(info.kind);
  const currentMentions = getProtectedRegion(updatedBody, mentionsRegion) ?? '';
  const newMentions = currentMentions.trim()
    ? `${currentMentions.trim()}\n${mention}`
    : mention;
  updatedBody = updateProtectedRegion(updatedBody, mentionsRegion, newMentions);
  fieldsUpdated.push(mentionsRegion);

  // Append to summary if we have new context
  const newContext = info.context ?? info.definition ?? '';
  if (newContext) {
    const sourceSlug = extractSlug(sourcePath);
    const today = nowISO().slice(0, 10);
    const addition = `\n\nPer [[${sourceSlug}]] (${today}): ${newContext}`;

    const summaryRegionId = getSummaryRegionId(info.kind);
    const currentSummary = getProtectedRegion(updatedBody, summaryRegionId) ?? '';
    // Only append if this source's context isn't already in the summary
    if (!currentSummary.includes(`[[${sourceSlug}]]`)) {
      updatedBody = updateProtectedRegion(updatedBody, summaryRegionId, currentSummary.trim() + addition);
      fieldsUpdated.push('summary');
    }
  }

  const result = serializeNote(data, updatedBody);
  await vault.atomicWrite(path, result);
  log.info('Entity page merged', { path, fieldsUpdated });
  return { changed: true, fieldsUpdated };
}

export function formatMention(sourcePath: string, context: string, chunkRefs: string[]): string {
  const sourceSlug = extractSlug(sourcePath);
  const chunkPart = chunkRefs.length > 0 ? ` (chunks: ${chunkRefs.join(', ')})` : '';
  const contextPart = context ? `: "${truncate(context, 200)}"` : '';
  return `- [[${sourceSlug}]]${chunkPart}${contextPart}`;
}

// --- Helpers ---

function extractSlug(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/, '') ?? path;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function getSummaryRegionId(kind: EntityKind): string {
  switch (kind) {
    case 'project': return 'overview';
    case 'concept': return 'definition';
    case 'topic': return 'definition';
    default: return 'summary';
  }
}

function getMentionsRegionId(kind: EntityKind): string {
  switch (kind) {
    case 'person': return 'timeline';
    case 'concept': return 'discussions';
    case 'topic': return 'discussions';
    default: return 'sources';
  }
}

function buildFrontmatter(
  info: ExtractedEntityInfo,
  now: string,
  sourcePath: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: nanoid(),
    title: info.name,
    status: 'active',
    confidence: 'medium',
    review_state: 'unreviewed',
    created_at: now,
    updated_at: now,
    source_refs: [sourcePath],
    derived_from: [],
    aliases: [],
    links: [],
    change_origin: 'extraction',
  };

  switch (info.kind) {
    case 'person':
      return {
        ...base,
        type: 'entity',
        entity_kind: 'person',
        canonical_name: info.name,
        protected_regions: ['summary', 'projects', 'topics', 'timeline', 'sources', 'backlinks'],
      };
    case 'project':
      return {
        ...base,
        type: 'project',
        project_key: slugify(info.name),
        project_status: info.status ?? 'active',
        protected_regions: ['overview', 'people', 'decisions', 'concepts', 'sessions', 'sources', 'backlinks'],
      };
    case 'concept':
      return {
        ...base,
        type: 'concept',
        protected_regions: ['definition', 'projects', 'people', 'related-concepts', 'discussions', 'sources', 'backlinks'],
      };
    case 'topic':
      return {
        ...base,
        type: 'topic',
        protected_regions: ['definition', 'projects', 'people', 'related-concepts', 'discussions', 'sources', 'backlinks'],
      };
    case 'decision':
      return {
        ...base,
        type: 'decision',
        decision_status: info.status ?? 'proposed',
        protected_regions: ['context', 'outcome', 'people', 'sources', 'backlinks'],
      };
    case 'tool':
      return {
        ...base,
        type: 'tool',
        protected_regions: ['summary', 'projects', 'related-concepts', 'sources', 'backlinks'],
      };
    case 'organization':
      return {
        ...base,
        type: 'organization',
        org_type: 'other',
        protected_regions: ['summary', 'people', 'projects', 'sources', 'backlinks'],
      };
  }
}

function buildSummaryContent(info: ExtractedEntityInfo): string {
  const parts: string[] = [];
  if (info.role) parts.push(info.role);
  if (info.context) parts.push(info.context);
  if (info.definition) parts.push(info.definition);
  return parts.join('. ') || '';
}

function buildBody(name: string, kind: EntityKind, summary: string, mention: string): string {
  switch (kind) {
    case 'person':
      return `
# ${name}

## Summary
${OPEN_TAG('summary')}
${summary || 'Pending enrichment.'}
${CLOSE_TAG('summary')}

## Projects
${OPEN_TAG('projects')}
${CLOSE_TAG('projects')}

## Topics & Interests
${OPEN_TAG('topics')}
${CLOSE_TAG('topics')}

## Interactions Timeline
${OPEN_TAG('timeline')}
${mention}
${CLOSE_TAG('timeline')}

## Source References
${OPEN_TAG('sources')}
${CLOSE_TAG('sources')}

## Backlinks
${OPEN_TAG('backlinks')}
${CLOSE_TAG('backlinks')}
`;
    case 'project':
      return `
# ${name}

## Overview
${OPEN_TAG('overview')}
${summary || 'Pending enrichment.'}
${CLOSE_TAG('overview')}

## Key People
${OPEN_TAG('people')}
${CLOSE_TAG('people')}

## Decisions
${OPEN_TAG('decisions')}
${CLOSE_TAG('decisions')}

## Related Concepts
${OPEN_TAG('concepts')}
${CLOSE_TAG('concepts')}

## Sessions
${OPEN_TAG('sessions')}
${CLOSE_TAG('sessions')}

## Source References
${OPEN_TAG('sources')}
${CLOSE_TAG('sources')}

## Backlinks
${OPEN_TAG('backlinks')}
${CLOSE_TAG('backlinks')}
`;
    case 'concept':
      return `
# ${name}

## Definition
${OPEN_TAG('definition')}
${summary || 'Pending enrichment.'}
${CLOSE_TAG('definition')}

## Related Projects
${OPEN_TAG('projects')}
${CLOSE_TAG('projects')}

## Related People
${OPEN_TAG('people')}
${CLOSE_TAG('people')}

## Connected Concepts
${OPEN_TAG('related-concepts')}
${CLOSE_TAG('related-concepts')}

## Discussions
${OPEN_TAG('discussions')}
${mention}
${CLOSE_TAG('discussions')}

## Source References
${OPEN_TAG('sources')}
${CLOSE_TAG('sources')}

## Backlinks
${OPEN_TAG('backlinks')}
${CLOSE_TAG('backlinks')}
`;
    case 'topic':
      return `
# ${name}

## Definition
${OPEN_TAG('definition')}
${summary || 'Pending enrichment.'}
${CLOSE_TAG('definition')}

## Related Projects
${OPEN_TAG('projects')}
${CLOSE_TAG('projects')}

## Related People
${OPEN_TAG('people')}
${CLOSE_TAG('people')}

## Connected Concepts
${OPEN_TAG('related-concepts')}
${CLOSE_TAG('related-concepts')}

## Discussions
${OPEN_TAG('discussions')}
${mention}
${CLOSE_TAG('discussions')}

## Source References
${OPEN_TAG('sources')}
${CLOSE_TAG('sources')}

## Backlinks
${OPEN_TAG('backlinks')}
${CLOSE_TAG('backlinks')}
`;
    case 'decision':
      return `
# ${name}

## Context
${OPEN_TAG('context')}
${summary || 'Pending enrichment.'}
${CLOSE_TAG('context')}

## Outcome
${OPEN_TAG('outcome')}
${CLOSE_TAG('outcome')}

## Key People
${OPEN_TAG('people')}
${CLOSE_TAG('people')}

## Source References
${OPEN_TAG('sources')}
${CLOSE_TAG('sources')}

## Backlinks
${OPEN_TAG('backlinks')}
${CLOSE_TAG('backlinks')}
`;
    case 'tool':
      return `
# ${name}

## Summary
${OPEN_TAG('summary')}
${summary || 'Pending enrichment.'}
${CLOSE_TAG('summary')}

## Used In Projects
${OPEN_TAG('projects')}
${CLOSE_TAG('projects')}

## Related Concepts
${OPEN_TAG('related-concepts')}
${CLOSE_TAG('related-concepts')}

## Source References
${OPEN_TAG('sources')}
${CLOSE_TAG('sources')}

## Backlinks
${OPEN_TAG('backlinks')}
${CLOSE_TAG('backlinks')}
`;
    case 'organization':
      return `
# ${name}

## Summary
${OPEN_TAG('summary')}
${summary || 'Pending enrichment.'}
${CLOSE_TAG('summary')}

## People
${OPEN_TAG('people')}
${CLOSE_TAG('people')}

## Projects
${OPEN_TAG('projects')}
${CLOSE_TAG('projects')}

## Source References
${OPEN_TAG('sources')}
${CLOSE_TAG('sources')}

## Backlinks
${OPEN_TAG('backlinks')}
${CLOSE_TAG('backlinks')}
`;
  }
}
