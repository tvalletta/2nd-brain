import type { JobHandler, Job, JobContext } from '../types.js';
import { parseNote, serializeNote } from '../../vault/frontmatter.js';
import { updateProtectedRegion } from '../../vault/protected-regions.js';
import { chunkDocument } from '../../ingest/chunker.js';
import { summarizeSource, summarizeChunks } from '../../enrichment/summarizer.js';
import { nowISO } from '../../shared/date-utils.js';
import { createLogger } from '../../shared/logger.js';
import type { SourceType } from '../../ingest/classifier.js';

const log = createLogger('handler:summarize-source');

export const summarizeSourceHandler: JobHandler = {
  async execute(job: Job, context: JobContext): Promise<void> {
    const summaryPath = job.targetPath;
    if (!summaryPath) throw new Error('summarize-source: no targetPath');

    const rawPath = job.payload.rawPath as string;
    if (!rawPath) throw new Error('summarize-source: no rawPath in payload');

    // Read the raw file content
    const rawContent = await context.vault.read(rawPath);

    // Read the source summary to get metadata
    const summaryContent = await context.vault.read(summaryPath);
    const { data, body } = parseNote(summaryContent);
    const sourceType = (data.source_type as SourceType) ?? 'plaintext';
    const sourceHash = (data.source_hash as string) ?? '';

    // Chunk the content
    const chunkResult = chunkDocument(rawContent, sourceType, sourceHash, {
      maxChunkSize: context.config.enrichment.maxChunkSize,
      overlap: context.config.enrichment.chunkOverlap,
    });

    // Summarize
    const title = (data.title as string) ?? 'Untitled';
    const summaryResult = chunkResult.chunks.length === 1
      ? await summarizeSource(context.llm, title, chunkResult.chunks[0].content)
      : await summarizeChunks(context.llm, title, chunkResult.chunks);
    if (summaryResult.status === 'error') throw new Error(`Summarization failed: ${summaryResult.error}`);
    const summary = summaryResult.data;

    // Update the source summary note
    let updatedBody = updateProtectedRegion(body, 'summary', summary);
    data.ingest_status = 'summarized';
    data.confidence = 'medium';
    data.chunk_count = chunkResult.chunks.length;
    data.chunk_strategy = chunkResult.strategy;
    data.updated_at = nowISO();

    const updated = serializeNote(data, updatedBody);
    await context.vault.atomicWrite(summaryPath, updated);

    log.info('Source summarized', {
      path: summaryPath,
      chunks: chunkResult.chunks.length,
      strategy: chunkResult.strategy,
    });
  },
};
