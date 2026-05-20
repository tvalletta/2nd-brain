import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { JobHandler, Job, JobContext } from '../types.js';
import { classifyFile } from '../../ingest/classifier.js';
import { routeContent, isAIConversation } from '../../ingest/content-router.js';
import { extractText } from '../../ingest/extractors/index.js';
import { serializeNote } from '../../vault/frontmatter.js';
import { OPEN_TAG, CLOSE_TAG } from '../../vault/protected-regions.js';
import { slugify, resolveAvailablePath } from '../../vault/paths.js';
import { nowISO, todayStamp } from '../../shared/date-utils.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:ingest-raw-file');

export const ingestRawFileHandler: JobHandler = {
  async execute(job: Job, context: JobContext): Promise<void> {
    const filePath = (job.payload.filePath as string) ?? job.targetPath;
    if (!filePath) throw new Error('ingest-raw-file: no filePath in payload or targetPath');

    const absPath = resolve(filePath);
    const fileName = basename(absPath);
    const sourceType = classifyFile(fileName);

    const content = await readFile(absPath, 'utf-8');
    const sourceHash = createHash('sha256').update(content).digest('hex').slice(0, 16);

    // Check for duplicate by hash
    const existingSummaries = await context.vault.listMarkdownFiles(context.config.layout.sources);
    for (const sp of existingSummaries) {
      try {
        const existing = await context.vault.read(sp);
        if (existing.includes(`source_hash: "${sourceHash}"`)) {
          log.info('Skipping duplicate source', { sourceHash, existing: sp });
          return;
        }
      } catch { /* ignore read errors */ }
    }

    // Content-aware routing: determine what this file is
    const routing = routeContent(filePath, content);

    // Determine raw path.
    //
    // Three cases:
    //   1. Session export passed `vaultRawPath` — file already at the right
    //      place (`AI Conversations/claude/<project>/...`).
    //   2. File is already inside the vault (e.g. file watcher saw a new
    //      `Plaud/p-...md`) — point at its existing location, do NOT copy.
    //      The legacy `raw/<date>/` copy step was for external ingest only
    //      and creates unwanted duplicates with the new vault layout.
    //   3. File comes from outside the vault — fall back to legacy
    //      `raw/<date>/` copy as an immutable evidence dump.
    let rawPath: string;
    const vaultRawPath = job.payload.vaultRawPath as string | undefined;
    const vaultPath = context.vaultPath;

    if (vaultRawPath && await context.vault.exists(vaultRawPath)) {
      // Case 1: session export already placed the file in the vault
      rawPath = vaultRawPath;
    } else if (vaultPath && absPath.startsWith(vaultPath)) {
      // Case 2: file already inside the vault — use its current location
      rawPath = absPath.slice(vaultPath.length + 1); // strip vaultPath + '/'
    } else {
      // Case 3: external source — copy to legacy raw/<date>/ as evidence
      const date = todayStamp();
      const rawDir = `raw/${date}`;
      await context.vault.ensureFolder(rawDir);
      rawPath = `${rawDir}/${fileName}`;
      if (!(await context.vault.exists(rawPath))) {
        await context.vault.create(rawPath, content);
      }
    }

    // Create source summary
    const summaryDir = context.config.layout.sources;
    await context.vault.ensureFolder(summaryDir);
    const title = fileName.replace(/\.[^.]+$/, '');
    const slug = slugify(title);
    const existingPaths = new Set(await context.vault.listMarkdownFiles(summaryDir));
    const summaryPath = resolveAvailablePath(summaryDir, `${slug}.md`, existingPaths);

    const extractedText = extractText(routing.category, sourceType, content);

    const frontmatter: Record<string, unknown> = {
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
      chunk_count: 1,
      content_category: routing.category,
      source_refs: [rawPath],
      derived_from: [],
      aliases: [],
      links: [],
      change_origin: 'extraction',
      protected_regions: ['summary', 'entities', 'claims', 'relationships', 'backlinks'],
    };

    // Add project slug for AI conversations
    if (routing.cwdClassification?.slug) {
      frontmatter.project_slug = routing.cwdClassification.slug;
    }

    const body = `
# ${title}

**Source:** \`${rawPath}\`
**Type:** ${sourceType}
**Category:** ${routing.category}
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
    await context.vault.create(summaryPath, noteContent);

    log.info('File ingested', {
      rawPath,
      summaryPath,
      sourceType,
      sourceHash,
      contentCategory: routing.category,
      projectSlug: routing.cwdClassification?.slug,
    });

    // Cascade: route based on content category and agent config
    if (context.config.agent.enabled && isAIConversation(routing.category)) {
      // Agent path: AI conversations get agent-driven synthesis
      log.info('Routing to agent-ingest', {
        contentCategory: routing.category,
        projectSlug: routing.cwdClassification?.slug,
      });
      await context.enqueue({
        type: 'agent-ingest',
        targetPath: summaryPath,
        payload: {
          sourceSummaryPath: summaryPath,
          rawPath,
          sourceHash,
          contentCategory: routing.category,
          projectSlug: routing.cwdClassification?.slug,
        },
        trigger: 'cascade',
        priority: 25,
        dedupeKey: `agent-ingest:${sourceHash}`,
      });
    } else {
      // Deterministic path: existing classify-source cascade
      await context.enqueue({
        type: 'classify-source',
        targetPath: summaryPath,
        payload: {
          rawPath,
          sourceHash,
          contentCategory: routing.category,
          projectSlug: routing.cwdClassification?.slug,
        },
        trigger: 'cascade',
        priority: 30,
        dedupeKey: `classify:${sourceHash}`,
      });
    }

    // Always index the source summary for retrieval (B4 / B3).
    await context.enqueue({
      type: 'embedding-index',
      targetPath: summaryPath,
      trigger: 'cascade',
      priority: 45,
      dedupeKey: `embed:${sourceHash}`,
    });
  },
};
