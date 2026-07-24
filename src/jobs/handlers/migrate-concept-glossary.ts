// One-time migration: consolidates existing individual concept pages into
// the glossary (concept-glossary.ts) and deletes them, rewriting any
// wikilinks that pointed at them. Supports a dryRun flag to preview the
// change set without writing anything — see docs/superpowers/plans/
// 2026-07-24-taxonomy-extraction-redesign.md Task 7 for why this exists.
//
// migrateConceptsToGlossary is a plain function (not just a JobHandler) so
// the CLI command in karpathy.ts can call it directly with just
// {vault, config} — matching how mergeCommand() and similar one-off CLI
// commands in that file construct their dependencies, without needing to
// fake a full JobContext (llm/enqueue/etc., which this migration never uses).

import type { JobHandler, Job, JobContext } from '../types.js';
import type { VaultAdapter } from '../../vault/adapter.js';
import type { KarpathyConfig } from '../../config/schema.js';
import { parseNote } from '../../vault/frontmatter.js';
import { getProtectedRegion } from '../../vault/protected-regions.js';
import { layoutFromConfig, wikiContentFolders } from '../../vault/paths.js';
import { upsertConceptMention, conceptGlossaryPath } from '../../maintenance/concept-glossary.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('migrate-concept-glossary');

function extractSlug(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/, '') ?? path;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function migrateConceptsToGlossary(
  vault: VaultAdapter,
  config: KarpathyConfig,
  dryRun: boolean,
): Promise<void> {
  const layout = layoutFromConfig(config);
  const conceptsFolder = `${layout.wiki}/concepts`;

  const files = (await vault.listMarkdownFiles(conceptsFolder)).filter(
    (f) => !f.endsWith('_index.md') && !f.endsWith('glossary.md'),
  );

  log.info(dryRun ? 'DRY RUN: would migrate concept pages' : 'Migrating concept pages', { count: files.length });

  for (const path of files) {
    const content = await vault.read(path);
    const { data, body } = parseNote(content);
    const title = (data.title as string) ?? extractSlug(path);
    const definition = getProtectedRegion(body, 'definition') ?? '';
    const gloss = definition.trim() && definition.trim() !== 'Pending enrichment.' ? definition.trim() : '(no definition recorded)';
    const sourceRefs = (data.source_refs as string[]) ?? [path];
    const slug = extractSlug(path);

    if (dryRun) {
      log.info('DRY RUN: would upsert glossary entry and delete page', { title, path, sourceRefCount: sourceRefs.length });
      continue;
    }

    for (const ref of sourceRefs.length > 0 ? sourceRefs : [path]) {
      await upsertConceptMention(vault, layout, { name: title, gloss, sourceRef: ref });
    }

    let wikilinksRewritten = 0;
    const glossaryPath = conceptGlossaryPath(layout);
    // Scope is deliberately limited to wikiContentFolders(layout) — session
    // summaries, digests, and system files are NOT scanned. A concept
    // reference living in one of those becomes a dangling link once the
    // source concept page is deleted below. This is an accepted tradeoff
    // (Obsidian shows an unresolved link; no data is lost — the citation
    // still lives in the glossary), not a bug: expanding scope here raises
    // risk/cost right before a real-vault migration run.
    for (const folder of wikiContentFolders(layout)) {
      let candidateFiles: string[];
      try {
        candidateFiles = await vault.listMarkdownFiles(folder);
      } catch {
        continue;
      }
      for (const candidatePath of candidateFiles) {
        if (candidatePath === path || candidatePath === glossaryPath) continue;
        const candidateContent = await vault.read(candidatePath);
        const pattern = new RegExp(`\\[\\[${escapeRegex(slug)}(\\|[^\\]]+)?\\]\\]`, 'g');
        if (!pattern.test(candidateContent)) continue;
        const updated = candidateContent.replace(pattern, () => `[[glossary#${title}]]`);
        if (updated !== candidateContent) {
          await vault.atomicWrite(candidatePath, updated);
          wikilinksRewritten++;
        }
      }
    }

    await vault.delete(path);
    log.info('Migrated concept page', { title, path, wikilinksRewritten });
  }
}

export const migrateConceptGlossaryHandler: JobHandler = {
  async execute(job: Job, context: JobContext): Promise<void> {
    await migrateConceptsToGlossary(context.vault, context.config, Boolean(job.payload.dryRun));
  },
};
