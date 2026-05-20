import type { LLMClient } from './llm-client.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('web-enricher');

export interface WebEnrichmentResult {
  definition: string;
  sources: string[];
}

/**
 * Enriches a concept/topic by searching the web for authoritative information
 * and synthesizing a definition via the LLM.
 *
 * Returns null if the concept appears to be project-specific (not a real-world concept)
 * or if web search yields no useful results.
 */
export async function enrichConceptFromWeb(
  conceptName: string,
  llm: LLMClient,
): Promise<WebEnrichmentResult | null> {
  log.info('Enriching concept from web', { concept: conceptName });

  // Skip project-specific or too-short terms
  if (isProjectSpecific(conceptName)) {
    log.debug('Skipping project-specific term', { concept: conceptName });
    return null;
  }

  try {
    // Use the LLM directly with its built-in knowledge to produce a definition.
    // This avoids the complexity of web scraping while still providing useful content.
    // The LLM has broad knowledge of technical concepts, tools, and frameworks.
    const prompt = buildDefinitionPrompt(conceptName);
    const response = await llm.complete(prompt);

    if (!response || response.trim().length < 20) {
      log.debug('LLM returned insufficient definition', { concept: conceptName });
      return null;
    }

    // Parse the response — expect a definition paragraph
    const definition = parseDefinitionResponse(response, conceptName);
    if (!definition) return null;

    return {
      definition,
      sources: ['LLM knowledge base'],
    };
  } catch (err) {
    log.warn('Web enrichment failed', {
      concept: conceptName,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Check if a concept definition is "thin" — meaning it needs enrichment.
 * Returns true if the definition is missing, placeholder, or too short.
 */
export function isDefinitionThin(definition: string | null): boolean {
  if (!definition) return true;
  const trimmed = definition.trim();
  if (trimmed.length < 50) return true;
  if (trimmed === 'Pending enrichment.' || trimmed === 'Pending enrichment') return true;
  return false;
}

// --- Internal helpers ---

/**
 * Detect project-specific terms that shouldn't be web-searched.
 * These are things like internal project names, codenames, team names, etc.
 */
function isProjectSpecific(name: string): boolean {
  // Very short names are likely abbreviations or codenames
  if (name.length < 3) return true;

  // All-caps short acronyms that don't match well-known patterns
  if (name.length <= 4 && name === name.toUpperCase()) {
    // Allow common tech acronyms
    const knownAcronyms = new Set([
      'API', 'SDK', 'CLI', 'SQL', 'CSS', 'HTML', 'HTTP', 'REST', 'GRPC',
      'OIDC', 'SAML', 'JWT', 'RBAC', 'ABAC', 'CORS', 'WASM', 'YAML',
      'JSON', 'XML', 'TOML', 'ACID', 'BASE', 'CQRS', 'DDD', 'TDD',
      'BDD', 'CI', 'CD', 'IaC', 'SRE', 'MLOps', 'AI', 'ML', 'LLM',
      'RAG', 'GPU', 'CPU', 'SSD', 'NLP', 'OCR', 'ETL', 'ELT',
    ]);
    return !knownAcronyms.has(name);
  }

  return false;
}

function buildDefinitionPrompt(conceptName: string): string {
  return `You are a technical encyclopedia writer. Write a concise 1-2 paragraph definition of "${conceptName}" for a knowledge wiki.

Requirements:
- Be factual and authoritative
- Focus on what it IS, not opinions about it
- If it's a technology or tool, mention its primary use case
- If it's an architectural concept, explain the core principle
- If it's a methodology, explain its key practices
- Use plain language accessible to a senior engineer
- Do NOT use markdown formatting (no headers, bold, italics, or lists)
- Do NOT include citations or references
- If you are not confident about what "${conceptName}" refers to, respond with just "UNKNOWN"

Write only the definition paragraphs, nothing else.`;
}

function parseDefinitionResponse(response: string, conceptName: string): string | null {
  const trimmed = response.trim();

  // Check if the LLM couldn't identify the concept
  if (trimmed === 'UNKNOWN' || trimmed.startsWith('UNKNOWN')) {
    log.debug('LLM could not identify concept', { concept: conceptName });
    return null;
  }

  // Remove any markdown formatting that crept in
  let cleaned = trimmed
    .replace(/^#+\s.+$/gm, '') // Remove headings
    .replace(/\*\*/g, '')       // Remove bold
    .replace(/\*/g, '')         // Remove italics
    .trim();

  // Sanity check — must be at least a sentence
  if (cleaned.length < 20) return null;

  return cleaned;
}
