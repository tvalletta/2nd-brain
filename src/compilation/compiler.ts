import type { VaultAdapter } from '../vault/adapter.js';
import type { LLMClient } from '../enrichment/llm-client.js';
import type { KarpathyConfig } from '../config/schema.js';
import type { EntityKind } from '../ingest/entity-resolver.js';
import { buildEntityIndex, resolveEntity } from '../ingest/entity-resolver.js';
import { createEntityPage } from '../ingest/entity-writer.js';
import { compileEntityPage } from './entity-compiler.js';
import { layoutFromConfig } from '../vault/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('compiler');

export interface CompilationResult {
  created: string[];
  updated: string[];
  skipped: string[];
}

export interface CompilableEntity {
  name: string;
  kind: EntityKind;
  context: string;
  role?: string;
  status?: string;
  definition?: string;
  relationships: Array<{
    target: string;
    targetKind: string;
    relationship: string;
  }>;
  chunkRefs: string[];
}

export async function compileFromSource(
  sourcePath: string,
  entities: CompilableEntity[],
  context: { vault: VaultAdapter; llm: LLMClient; config: KarpathyConfig },
): Promise<CompilationResult> {
  const { vault, llm, config } = context;
  const layout = layoutFromConfig(config);
  const result: CompilationResult = {
    created: [],
    updated: [],
    skipped: [],
  };

  log.info('Starting compilation', { sourcePath, entityCount: entities.length });

  const entityIndex = await buildEntityIndex(vault, layout);

  for (const entity of entities) {
    const resolution = resolveEntity(
      { name: entity.name, kind: entity.kind },
      entityIndex,
      layout,
    );

    log.debug('Entity resolution', {
      name: entity.name,
      kind: entity.kind,
      status: resolution.status,
      matchedPath: resolution.matchedPath,
    });

    if (resolution.status === 'ambiguous') {
      log.warn('Ambiguous entity match, skipping', {
        name: entity.name,
        kind: entity.kind,
        candidates: resolution.candidates?.map((c) => c.path),
      });
      result.skipped.push(entity.name);
      continue;
    }

    let existingPagePath: string | null = null;

    if (resolution.status === 'new') {
      // Create a new page using entity-writer, then compile on top
      const createdPath = await createEntityPage(vault, resolution, {
        name: entity.name,
        kind: entity.kind,
        role: entity.role,
        context: entity.context,
        definition: entity.definition,
        status: entity.status,
        chunkRefs: entity.chunkRefs,
      }, sourcePath, layout);

      existingPagePath = createdPath;

      log.info('Created new entity page', { path: createdPath, name: entity.name });

      // Update the index so subsequent entities can find this page
      const slug = createdPath.split('/').pop()?.replace(/\.md$/, '') ?? '';
      entityIndex.bySlug.set(slug, createdPath);
      entityIndex.byCanonicalName.set(entity.name.toLowerCase(), createdPath);

      result.created.push(createdPath);
    } else {
      // Matched existing page
      existingPagePath = resolution.matchedPath!;
    }

    try {
      const compiledPath = await compileEntityPage(
        entity,
        existingPagePath,
        sourcePath,
        { vault, llm },
      );

      if (resolution.status === 'matched' && !result.created.includes(compiledPath)) {
        result.updated.push(compiledPath);
      }
    } catch (err) {
      log.error('Failed to compile entity page', {
        name: entity.name,
        path: existingPagePath,
        error: (err as Error).message,
      });
      result.skipped.push(entity.name);
    }
  }

  log.info('Compilation complete', {
    created: result.created.length,
    updated: result.updated.length,
    skipped: result.skipped.length,
  });

  return result;
}
