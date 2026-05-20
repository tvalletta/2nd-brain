import { nanoid } from 'nanoid';
import type { AgentToolDef } from '../tool-registry.js';
import { serializeNote } from '../../vault/frontmatter.js';
import { OPEN_TAG, CLOSE_TAG } from '../../vault/protected-regions.js';
import { slugify } from '../../vault/paths.js';
import { nowISO } from '../../shared/date-utils.js';

export const createPageTool: AgentToolDef = {
  name: 'create_page',
  description:
    'Create a new wiki page with proper frontmatter. Use for creating concept, topic, or tool pages. For project sub-specs, use create_project_spec instead.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Page title',
      },
      type: {
        type: 'string',
        enum: ['concept', 'topic', 'tool', 'decision'],
        description: 'The note type',
      },
      content: {
        type: 'string',
        description: 'Markdown content for the main body section',
      },
      folder: {
        type: 'string',
        description: 'Optional: override the default folder for this type',
      },
    },
    required: ['title', 'type', 'content'],
  },
  async execute(input, context) {
    const title = input.title as string;
    const type = input.type as string;
    const content = input.content as string;

    const { layoutFromConfig } = await import('../../vault/paths.js');
    const layout = layoutFromConfig(context.config);
    const folderMap: Record<string, string> = {
      concept: `${layout.wiki}/concepts`,
      topic: `${layout.wiki}/topics`,
      tool: `${layout.wiki}/tools`,
      decision: `${layout.wiki}/decisions`,
    };

    const folder = (input.folder as string) ?? folderMap[type] ?? layout.wiki;
    await context.vault.ensureFolder(folder);

    const slug = slugify(title);
    const path = `${folder}/${slug}.md`;

    if (await context.vault.exists(path)) {
      return `Page already exists: ${path}. Use update_protected_region to modify it.`;
    }

    const now = nowISO();
    const regionId = type === 'decision' ? 'context' : 'definition';

    const frontmatter: Record<string, unknown> = {
      id: nanoid(),
      type,
      title,
      status: 'active',
      confidence: 'medium',
      review_state: 'unreviewed',
      created_at: now,
      updated_at: now,
      source_refs: [context.sourceFilePath],
      derived_from: [],
      aliases: [],
      links: [],
      change_origin: 'extraction',
      protected_regions: [regionId, 'sources', 'backlinks'],
    };

    const body = `
# ${title}

## ${regionId.charAt(0).toUpperCase() + regionId.slice(1)}
${OPEN_TAG(regionId)}
${content}
${CLOSE_TAG(regionId)}

## Source References
${OPEN_TAG('sources')}
${CLOSE_TAG('sources')}

## Backlinks
${OPEN_TAG('backlinks')}
${CLOSE_TAG('backlinks')}
`;

    const noteContent = serializeNote(frontmatter, body);
    await context.vault.atomicWrite(path, noteContent);

    return `Created: ${path}`;
  },
};
