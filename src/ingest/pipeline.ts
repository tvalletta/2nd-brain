import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { VaultAdapter } from '../vault/adapter.js';
import { classifyFile, type SourceType } from './classifier.js';
import { routeContent } from './content-router.js';
import { extractText } from './extractors/index.js';
import { serializeNote } from '../vault/frontmatter.js';
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { slugify, resolveAvailablePath, DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';
import { nowISO, todayStamp } from '../shared/date-utils.js';
import { createLogger } from '../shared/logger.js';
import type { Job, JobCreateInput } from '../jobs/types.js';

const log = createLogger('ingest');

export interface IngestResult {
  rawPath: string;
  sourceSummaryPath: string;
  sourceType: SourceType;
  sourceHash: string;
}

/**
 * Core ingest logic: copies file to raw/, creates source summary.
 * Used by both the synchronous `ingestFile` and the job handler.
 */
export async function ingestFileCore(
  filePath: string,
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<IngestResult> {
  const absPath = resolve(filePath);
  const fileName = basename(absPath);
  const sourceType = classifyFile(fileName);

  // Read the file content
  const content = await readFile(absPath, 'utf-8');
  const sourceHash = createHash('sha256').update(content).digest('hex').slice(0, 16);

  // Copy to raw/ (immutable evidence)
  const date = todayStamp();
  const rawDir = `raw/${date}`;
  await vault.ensureFolder(rawDir);
  const rawPath = `${rawDir}/${fileName}`;

  if (!(await vault.exists(rawPath))) {
    await vault.create(rawPath, content);
  }

  // Create source summary note in the configured sources folder.
  const summaryDir = layout.sources;
  await vault.ensureFolder(summaryDir);

  const title = fileName.replace(/\.[^.]+$/, '');
  const slug = slugify(title);
  const existingPaths = new Set(await vault.listMarkdownFiles(summaryDir));
  const summaryPath = resolveAvailablePath(summaryDir, `${slug}.md`, existingPaths);

  // Content-aware routing determines extraction strategy
  const routing = routeContent(fileName, content);
  const extractedText = extractText(routing.category, sourceType, content);

  const frontmatter = {
    id: nanoid(),
    type: 'source_summary',
    title,
    status: 'draft',
    confidence: 'low',
    review_state: 'unreviewed',
    created_at: nowISO(),
    updated_at: nowISO(),
    source_type: sourceType,
    source_path: rawPath,
    ingest_status: 'detected',
    source_hash: sourceHash,
    content_category: routing.category,
    chunk_count: 1,
    source_refs: [rawPath],
    derived_from: [],
    aliases: [],
    links: [],
    change_origin: 'extraction',
    protected_regions: ['summary', 'entities', 'claims', 'relationships', 'backlinks'],
  };

  const body = `
# ${title}

**Source:** \`${rawPath}\`
**Type:** ${sourceType}
**Hash:** ${sourceHash}

## Original Content

${extractedText}

## Summary
${OPEN_TAG('summary')}
Pending extraction.
${CLOSE_TAG('summary')}

## Extracted Entities
${OPEN_TAG('entities')}
No entities extracted yet.
${CLOSE_TAG('entities')}

## Key Claims
${OPEN_TAG('claims')}
${CLOSE_TAG('claims')}

## Relationships
${OPEN_TAG('relationships')}
${CLOSE_TAG('relationships')}

## Backlinks
${OPEN_TAG('backlinks')}
${CLOSE_TAG('backlinks')}
`;

  const noteContent = serializeNote(frontmatter, body);
  await vault.create(summaryPath, noteContent);

  log.info('File ingested', { rawPath, summaryPath, sourceType, sourceHash });

  return { rawPath, sourceSummaryPath: summaryPath, sourceType, sourceHash };
}

/**
 * Synchronous (immediate) ingest — for CLI and backward compat.
 */
export async function ingestFile(
  filePath: string,
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<IngestResult> {
  return ingestFileCore(filePath, vault, layout);
}

/**
 * Queued ingest — enqueues the ingest-raw-file job for async processing.
 */
export async function ingestFileQueued(
  filePath: string,
  enqueue: (input: JobCreateInput) => Promise<Job>,
): Promise<Job> {
  return enqueue({
    type: 'ingest-raw-file',
    payload: { filePath: resolve(filePath) },
    trigger: 'cli',
    priority: 20,
  });
}
