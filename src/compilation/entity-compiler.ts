import type { VaultAdapter } from '../vault/adapter.js';
import type { LLMClient } from '../enrichment/llm-client.js';
import type { CompilableEntity } from './compiler.js';
import type { EntityKind } from '../ingest/entity-resolver.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { updateProtectedRegion, getProtectedRegion } from '../vault/protected-regions.js';
import { nowISO } from '../shared/date-utils.js';
import { createLogger } from '../shared/logger.js';
import { compileEntityPrompt } from '../enrichment/prompts.js';
import { enrichConceptFromWeb, isDefinitionThin } from '../enrichment/web-enricher.js';

const log = createLogger('entity-compiler');

export interface EntityReference {
  sourcePath: string;
  context: string;
  date: string;
}

/**
 * Maps entity kinds to their protected region IDs for compilation.
 * Project hubs (_index.md) use the hub layout: overview, specs, people, sessions, sources.
 * Legacy single-page projects had: overview, people, decisions, concepts, sessions, sources.
 * The compiler handles both — it only updates regions that exist in the page.
 */
const KIND_SECTIONS: Record<EntityKind, string[]> = {
  person: ['summary', 'projects', 'topics', 'timeline', 'sources'],
  project: ['overview', 'specs', 'people', 'sessions', 'sources'],
  concept: ['definition', 'projects', 'people', 'related-concepts', 'discussions', 'sources'],
  topic: ['definition', 'projects', 'people', 'related-concepts', 'discussions', 'sources'],
  decision: ['context', 'outcome', 'people', 'sources'],
  tool: ['summary', 'projects', 'related-concepts', 'sources'],
  organization: ['summary', 'people', 'projects', 'sources'],
};

/**
 * Compile an entity page by synthesizing existing content with new information
 * using an LLM. Updates protected regions in place, preserving human-authored
 * content by asking the LLM to enrich rather than replace.
 *
 * @returns The path of the written page.
 */
export async function compileEntityPage(
  entity: CompilableEntity,
  existingPagePath: string | null,
  sourcePath: string,
  context: { vault: VaultAdapter; llm: LLMClient },
): Promise<string> {
  const { vault, llm } = context;

  if (!existingPagePath) {
    throw new Error(`No page path provided for entity "${entity.name}"`);
  }

  const currentContent = await vault.read(existingPagePath);
  const { data, body } = parseNote(currentContent);

  // Collect all references: existing source_refs + the new sourcePath
  const sourceRefs = (data.source_refs as string[]) ?? [];
  if (!sourceRefs.includes(sourcePath)) {
    sourceRefs.push(sourcePath);
  }
  data.source_refs = sourceRefs;
  data.updated_at = nowISO();

  // Gather existing content from all protected regions
  const sections = KIND_SECTIONS[entity.kind] ?? [];
  const existingSections: Record<string, string> = {};
  for (const section of sections) {
    const content = getProtectedRegion(body, section);
    if (content !== null) {
      existingSections[section] = content;
    }
  }

  // Consolidate existing section content into a single block for the prompt
  const existingContentBlock = Object.entries(existingSections)
    .filter(([, v]) => v.trim() && v.trim() !== 'Pending enrichment.')
    .map(([section, content]) => `## ${section}\n${content}`)
    .join('\n\n') || null;

  // Build references from sourceRefs
  const references = sourceRefs.map((ref) => ({
    source: ref,
    context: ref === sourcePath ? entity.context : '',
  }));

  // Map entity relationships to the prompt format
  const relatedEntities = entity.relationships.map((r) => ({
    name: r.target,
    kind: r.targetKind,
    relationship: r.relationship,
  }));

  // Build the compilation prompt
  const prompt = compileEntityPrompt(
    entity.name,
    entity.kind,
    existingContentBlock,
    references,
    relatedEntities,
  );

  log.info('Compiling entity page', {
    name: entity.name,
    kind: entity.kind,
    path: existingPagePath,
    sectionCount: sections.length,
  });

  const llmResponse = await llm.complete(prompt, { maxTokens: 4096, temperature: 0.3 });

  // Parse the LLM response into sections
  const compiledSections = parseSectionResponse(llmResponse, sections);

  // Update each protected region with compiled content
  let updatedBody = body;
  for (const section of sections) {
    const compiledContent = compiledSections[section];
    if (!compiledContent) continue;

    const existingContent = existingSections[section] ?? '';
    const trimmedExisting = existingContent.trim();

    // If region already has substantial content, only update if compiled content
    // is non-trivially different (avoid clobbering human edits with less info)
    if (
      trimmedExisting &&
      trimmedExisting !== 'Pending enrichment.' &&
      compiledContent.trim() === trimmedExisting
    ) {
      log.debug('Skipping unchanged section', { section, entity: entity.name });
      continue;
    }

    updatedBody = updateProtectedRegion(updatedBody, section, compiledContent);
  }

  // Web enrichment for thin concept/topic definitions
  if (
    (entity.kind === 'concept' || entity.kind === 'topic') &&
    isDefinitionThin(getProtectedRegion(updatedBody, 'definition'))
  ) {
    try {
      const enrichment = await enrichConceptFromWeb(entity.name, llm);
      if (enrichment) {
        updatedBody = updateProtectedRegion(updatedBody, 'definition', enrichment.definition);
        log.info('Enriched thin concept definition from LLM knowledge', {
          name: entity.name,
          definitionLength: enrichment.definition.length,
        });
      }
    } catch (err) {
      log.warn('Web enrichment failed for concept', {
        name: entity.name,
        error: (err as Error).message,
      });
    }
  }

  const result = serializeNote(data, updatedBody);
  await vault.atomicWrite(existingPagePath, result);

  log.info('Entity page compiled', {
    path: existingPagePath,
    sectionsUpdated: Object.keys(compiledSections).length,
  });

  return existingPagePath;
}

/**
 * Parse an LLM response that uses section headers like:
 *
 * SUMMARY:
 * (content)
 * PROJECTS:
 * (content)
 *
 * Returns a map of lowercase section ID to content.
 */
function parseSectionResponse(
  response: string,
  expectedSections: string[],
): Record<string, string> {
  const result: Record<string, string> = {};

  // Build a pattern that matches section headers in the LLM response.
  // Section headers are the region IDs, uppercased, with hyphens replaced by spaces or kept.
  // Match patterns like "SUMMARY:", "RELATED-CONCEPTS:", "RELATED CONCEPTS:" etc.
  const sectionPattern = /^([A-Z][A-Z\s-]+):\s*$/gm;
  const matches: Array<{ name: string; index: number; endIndex: number }> = [];

  let match;
  while ((match = sectionPattern.exec(response)) !== null) {
    matches.push({
      name: match[1].trim(),
      index: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];

    const contentStart = current.endIndex;
    const contentEnd = next ? next.index : response.length;
    const content = response.slice(contentStart, contentEnd).trim();

    // Normalize the section name to match expected region IDs
    const normalizedName = current.name.toLowerCase().replace(/\s+/g, '-');

    // Find the matching expected section
    const matchedSection = expectedSections.find((s) => {
      const sNorm = s.toLowerCase();
      return sNorm === normalizedName || sNorm === normalizedName.replace(/-/g, '');
    });

    if (matchedSection && content) {
      result[matchedSection] = content;
    }
  }

  return result;
}
