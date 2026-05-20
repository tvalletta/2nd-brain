import type { LLMClient } from './llm-client.js';
import type { EnrichmentResult } from './types.js';
import { summarizeSourcePrompt, synthesizeSummariesPrompt, meetingSummarizePrompt, synthesizeMeetingSummariesPrompt } from './prompts.js';
import type { Chunk } from '../ingest/chunker.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('summarizer');

export async function summarizeSource(
  llm: LLMClient,
  title: string,
  text: string,
): Promise<EnrichmentResult<string>> {
  if (!text.trim()) return { status: 'success', data: 'No content to summarize.' };

  try {
    const result = await llm.complete(summarizeSourcePrompt(title, text));
    const summary = result.trim() || 'Summary generation failed.';
    return { status: 'success', data: summary };
  } catch (err) {
    log.error('Summarization failed', { error: (err as Error).message });
    return { status: 'error', error: (err as Error).message };
  }
}

export async function summarizeMeetingSource(
  llm: LLMClient,
  title: string,
  text: string,
): Promise<EnrichmentResult<string>> {
  if (!text.trim()) return { status: 'success', data: 'No content to summarize.' };

  try {
    const result = await llm.complete(meetingSummarizePrompt(title, text));
    const brief = result.trim() || 'Meeting brief generation failed.';
    return { status: 'success', data: brief };
  } catch (err) {
    log.error('Meeting summarization failed', { error: (err as Error).message });
    return { status: 'error', error: (err as Error).message };
  }
}

export async function summarizeMeetingChunks(
  llm: LLMClient,
  title: string,
  chunks: Chunk[],
): Promise<EnrichmentResult<string>> {
  if (chunks.length === 0) return { status: 'success', data: 'No content to summarize.' };

  if (chunks.length === 1) {
    return summarizeMeetingSource(llm, title, chunks[0].content);
  }

  try {
    const chunkBriefs: Array<{ chunkId: string; brief: string }> = [];

    for (const chunk of chunks) {
      try {
        const contextPrefix = chunk.headingContext ? `[${chunk.headingContext}]\n\n` : '';
        const raw = await llm.complete(
          meetingSummarizePrompt(`${title} (section ${chunk.index + 1}/${chunk.totalChunks})`, contextPrefix + chunk.content),
        );
        chunkBriefs.push({ chunkId: chunk.chunkId, brief: raw.trim() });
      } catch (err) {
        log.warn('Meeting chunk summarization failed, using placeholder', {
          chunkId: chunk.chunkId,
          error: (err as Error).message,
        });
        chunkBriefs.push({ chunkId: chunk.chunkId, brief: '(chunk brief unavailable)' });
      }
    }

    const result = await llm.complete(synthesizeMeetingSummariesPrompt(title, chunkBriefs));
    const synthesis = result.trim() || 'Meeting brief synthesis failed.';
    return { status: 'success', data: synthesis };
  } catch (err) {
    log.error('Meeting chunk summarization failed', { error: (err as Error).message });
    return { status: 'error', error: (err as Error).message };
  }
}

export async function summarizeChunks(
  llm: LLMClient,
  title: string,
  chunks: Chunk[],
): Promise<EnrichmentResult<string>> {
  if (chunks.length === 0) return { status: 'success', data: 'No content to summarize.' };

  // Single chunk — use direct summarization
  if (chunks.length === 1) {
    return summarizeSource(llm, title, chunks[0].content);
  }

  try {
    // Phase 1: summarize each chunk individually
    const chunkSummaries: Array<{ chunkId: string; summary: string }> = [];

    for (const chunk of chunks) {
      try {
        const contextPrefix = chunk.headingContext ? `[${chunk.headingContext}]\n\n` : '';
        const raw = await llm.complete(
          summarizeSourcePrompt(`${title} (section ${chunk.index + 1}/${chunk.totalChunks})`, contextPrefix + chunk.content),
        );
        chunkSummaries.push({ chunkId: chunk.chunkId, summary: raw.trim() });
      } catch (err) {
        log.warn('Chunk summarization failed, using placeholder', {
          chunkId: chunk.chunkId,
          error: (err as Error).message,
        });
        chunkSummaries.push({ chunkId: chunk.chunkId, summary: '(chunk summary unavailable)' });
      }
    }

    // Phase 2: synthesize chunk summaries into unified summary
    const result = await llm.complete(synthesizeSummariesPrompt(title, chunkSummaries));
    const synthesis = result.trim() || 'Summary synthesis failed.';
    return { status: 'success', data: synthesis };
  } catch (err) {
    log.error('Chunk summarization failed', { error: (err as Error).message });
    return { status: 'error', error: (err as Error).message };
  }
}
