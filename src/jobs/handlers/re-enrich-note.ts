// §23.2: Re-enrichment of existing wiki notes.
//
// Reads a wiki note, strips machine-owned protected regions to isolate
// human-authored text, runs entity extraction on that text, and cascades
// into link-concepts and update-backlinks.

import type { JobHandler, Job, JobContext } from '../types.js';
import { parseNote, serializeNote } from '../../vault/frontmatter.js';
import { extractProtectedRegions } from '../../vault/protected-regions.js';
import { extractEntitiesRich, extractEntitiesRichFromChunks } from '../../enrichment/entity-extractor-rich.js';
import { chunkDocument } from '../../ingest/chunker.js';
import { isNoiseEntity } from '../../enrichment/entity-filter.js';
import { nowISO } from '../../shared/date-utils.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:re-enrich-note');

/** Minimum character count after stripping regions to bother extracting. */
const MIN_TEXT_LENGTH = 50;

/**
 * Remove all protected-region blocks from a body string, leaving only the
 * human-authored text between (and around) the blocks.
 */
function stripProtectedRegions(body: string): string {
  const regions = extractProtectedRegions(body);
  if (regions.length === 0) return body;

  // Remove regions from right to left so indices stay valid.
  const sorted = [...regions].sort((a, b) => b.startIndex - a.startIndex);
  let stripped = body;
  for (const region of sorted) {
    stripped = stripped.slice(0, region.startIndex) + stripped.slice(region.endIndex);
  }
  return stripped.replace(/\n{3,}/g, '\n\n').trim();
}

export const reEnrichNoteHandler: JobHandler = {
  async execute(job: Job, context: JobContext): Promise<void> {
    const notePath = (job.payload.notePath as string | undefined) ?? job.targetPath;
    if (!notePath) throw new Error('re-enrich-note: notePath required in payload or targetPath');

    if (!(await context.vault.exists(notePath))) {
      throw new Error(`re-enrich-note: note not found: ${notePath}`);
    }

    const content = await context.vault.read(notePath);
    const { data, body } = parseNote(content);

    const humanText = stripProtectedRegions(body);

    if (humanText.length < MIN_TEXT_LENGTH) {
      log.info('re-enrich-note: insufficient human-authored text, skipping extraction', {
        path: notePath,
        length: humanText.length,
      });
      // Still update last_verified — the note was inspected.
      data.last_verified = nowISO();
      data.updated_at = nowISO();
      await context.vault.atomicWrite(notePath, serializeNote(data, body));
      return;
    }

    // Chunk and extract entities from human-authored text.
    const chunkResult = chunkDocument(humanText, 'plaintext', '', {
      maxChunkSize: context.config.enrichment.maxChunkSize,
      overlap: context.config.enrichment.chunkOverlap,
    });

    const extractResult = chunkResult.chunks.length === 1
      ? await extractEntitiesRich(context.llm, chunkResult.chunks[0].content)
      : await extractEntitiesRichFromChunks(context.llm, chunkResult.chunks);

    if (extractResult.status === 'error') {
      throw new Error(`re-enrich-note: extraction failed: ${extractResult.error}`);
    }

    const entities = extractResult.data;
    const customBlocklist = context.config.enrichment.entityBlocklist ?? [];
    const minConfidence = context.config.enrichment.minEntityConfidence ?? 0.3;

    // Filter noise entities before deciding whether to cascade.
    function isUsable(name: string, kind: string, confidence?: number): boolean {
      if (isNoiseEntity(name, kind, customBlocklist)) return false;
      if (confidence !== undefined && confidence < minConfidence) return false;
      return true;
    }

    const hasEntities =
      (entities.people ?? []).some((e) => isUsable(e.name, 'person', e.confidence)) ||
      (entities.projects ?? []).some((e) => isUsable(e.name, 'project', e.confidence)) ||
      (entities.concepts ?? []).some((e) => isUsable(e.name, 'concept', e.confidence)) ||
      (entities.topics ?? []).some((e) => isUsable(e.name, 'topic', e.confidence)) ||
      (entities.decisions ?? []).some((e) => isUsable(e.title, 'decision', e.confidence)) ||
      (entities.tools ?? []).some((e) => isUsable(e.name, 'tool', e.confidence)) ||
      (entities.organizations ?? []).some((e) => isUsable(e.name, 'organization', e.confidence));

    if (hasEntities) {
      await context.enqueue({
        type: 'link-concepts',
        targetPath: notePath,
        payload: { entities },
        trigger: 'cascade',
        priority: 60,
        dedupeKey: `link-concepts:${notePath}`,
      });
    }

    await context.enqueue({
      type: 'update-backlinks',
      targetPath: notePath,
      trigger: 'cascade',
      priority: 10,
      dedupeKey: `backlinks:${notePath}`,
    });

    // Update frontmatter timestamps.
    data.last_verified = nowISO();
    data.updated_at = nowISO();
    await context.vault.atomicWrite(notePath, serializeNote(data, body));

    log.info('re-enrich-note complete', {
      path: notePath,
      humanTextLength: humanText.length,
      entitiesFound: hasEntities,
    });
  },
};
