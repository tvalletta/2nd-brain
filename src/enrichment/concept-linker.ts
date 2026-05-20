import type { LLMClient } from './llm-client.js';
import type { EnrichmentResult } from './types.js';
import { linkConceptsPrompt } from './prompts.js';
import { z } from 'zod';
import { createLogger } from '../shared/logger.js';

const log = createLogger('concept-linker');

export async function findConceptLinks(
  llm: LLMClient,
  pageTitle: string,
  pageBody: string,
  knownConcepts: string[],
): Promise<EnrichmentResult<string[]>> {
  if (knownConcepts.length === 0) return { status: 'success', data: [] };

  try {
    const data = await llm.extractStructured(
      linkConceptsPrompt(pageTitle, pageBody, knownConcepts),
      z.array(z.string()),
    );
    return { status: 'success', data };
  } catch (err) {
    log.error('Concept linking failed', { error: (err as Error).message });
    return { status: 'error', error: (err as Error).message };
  }
}
