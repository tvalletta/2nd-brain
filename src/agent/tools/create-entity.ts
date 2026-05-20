import type { AgentToolDef } from '../tool-registry.js';
import type { EntityKind } from '../../ingest/entity-resolver.js';
import { buildEntityIndex, resolveEntity } from '../../ingest/entity-resolver.js';
import { createEntityPage, type ExtractedEntityInfo } from '../../ingest/entity-writer.js';

export const createEntityTool: AgentToolDef = {
  name: 'create_entity',
  description:
    'Create a new entity page (person, project, concept, tool, etc). Checks for existing entities first to avoid duplicates. For projects, this creates a hub.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Entity name',
      },
      kind: {
        type: 'string',
        enum: ['person', 'project', 'concept', 'topic', 'decision', 'tool', 'organization'],
        description: 'Entity kind',
      },
      context: {
        type: 'string',
        description: 'Brief context or description of the entity',
      },
      role: {
        type: 'string',
        description: 'For persons: their role or title',
      },
    },
    required: ['name', 'kind'],
  },
  async execute(input, context) {
    const name = input.name as string;
    const kind = input.kind as EntityKind;

    // Check if entity already exists
    const index = await buildEntityIndex(context.vault);
    const resolution = resolveEntity({ name, kind }, index);

    if (resolution.status === 'matched') {
      return `Entity already exists: ${resolution.matchedPath}. Use update_protected_region to modify it.`;
    }

    const info: ExtractedEntityInfo = {
      name,
      kind,
      context: input.context as string | undefined,
      role: input.role as string | undefined,
      chunkRefs: [],
    };

    const path = await createEntityPage(context.vault, resolution, info, context.sourceFilePath);
    return `Created entity: ${path}`;
  },
};
