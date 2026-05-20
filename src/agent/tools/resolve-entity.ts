import type { AgentToolDef } from '../tool-registry.js';
import { buildEntityIndex, resolveEntity } from '../../ingest/entity-resolver.js';
import type { EntityKind } from '../../ingest/entity-resolver.js';

export const resolveEntityTool: AgentToolDef = {
  name: 'resolve_entity',
  description:
    'Find an existing entity page by name and kind. Returns the matched path, or suggests creating a new page if not found.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Entity name to search for',
      },
      kind: {
        type: 'string',
        enum: ['person', 'project', 'concept', 'topic', 'decision', 'tool', 'organization'],
        description: 'Entity kind',
      },
    },
    required: ['name', 'kind'],
  },
  async execute(input, context) {
    const name = input.name as string;
    const kind = input.kind as EntityKind;

    const index = await buildEntityIndex(context.vault);
    const result = resolveEntity({ name, kind }, index);

    if (result.status === 'matched') {
      return `Found: ${result.matchedPath} (confidence: ${result.confidence.toFixed(2)})`;
    }

    return `Not found. Status: ${result.status}. Suggested path: ${result.suggestedPath ?? 'none'}`;
  },
};
