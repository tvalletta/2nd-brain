import { z } from 'zod';
import { nanoid } from 'nanoid';
import { serializeNote } from '../../vault/frontmatter.js';
import { OPEN_TAG, CLOSE_TAG } from '../../vault/protected-regions.js';
import { slugify, buildNoteFilename, resolveAvailablePath } from '../../vault/paths.js';
import { nowISO } from '../../shared/date-utils.js';
import type { MCPContext } from '../context.js';

function typeFolders(layout: { wiki: string }): Record<string, string> {
  return {
    entity: `${layout.wiki}/entities`,
    concept: `${layout.wiki}/concepts`,
    decision: `${layout.wiki}/decisions`,
    project: `${layout.wiki}/projects`,
    note: `${layout.wiki}/notes`,
  };
}

const InputSchema = z.object({
  title: z.string().describe('Title for the new note'),
  content: z.string().describe('Body content for the note'),
  type: z.enum(['entity', 'concept', 'decision', 'project', 'note']).default('note').describe('Note type'),
  entity_kind: z.string().optional().describe('Entity kind (person, org, tool) — only if type=entity'),
  project_key: z.string().optional().describe('Project key — only if type=decision'),
});

export const definition = {
  name: 'log_insight',
  description:
    'Create a new note in the vault — an entity, concept, decision, project, or general note. Use when a conversation surfaces something worth remembering.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string' as const, description: 'Title for the new note' },
      content: { type: 'string' as const, description: 'Body content' },
      type: {
        type: 'string' as const,
        enum: ['entity', 'concept', 'decision', 'project', 'note'],
        description: 'Note type (default: note)',
      },
      entity_kind: { type: 'string' as const, description: 'Entity kind — only if type=entity' },
      project_key: { type: 'string' as const, description: 'Project key — only if type=decision' },
    },
    required: ['title', 'content'] as const,
  },
};

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);
  const folder = typeFolders(ctx.config.layout)[input.type];
  const now = nowISO();

  await ctx.vault.ensureFolder(folder);

  const fileName = buildNoteFilename(input.title);
  const existingPaths = new Set(await ctx.vault.listMarkdownFiles(folder));
  const path = resolveAvailablePath(folder, fileName, existingPaths);

  const frontmatter: Record<string, unknown> = {
    id: nanoid(),
    type: input.type === 'note' ? 'concept' : input.type,
    title: input.title,
    status: 'active',
    review_state: 'unreviewed',
    created_at: now,
    updated_at: now,
    source_refs: [],
    derived_from: [],
    aliases: [],
    links: [],
    change_origin: 'extraction',
    protected_regions: ['backlinks'],
  };

  if (input.type === 'entity' && input.entity_kind) {
    frontmatter.entity_kind = input.entity_kind;
    frontmatter.canonical_name = input.title;
  }
  if (input.type === 'decision') {
    frontmatter.decision_status = 'active';
    frontmatter.decision_date = now.slice(0, 10);
    if (input.project_key) frontmatter.project_key = input.project_key;
  }
  if (input.type === 'project') {
    frontmatter.project_key = input.project_key ?? slugify(input.title);
    frontmatter.project_status = 'active';
  }

  const body = `
# ${input.title}

${input.content}

## Backlinks
${OPEN_TAG('backlinks')}
${CLOSE_TAG('backlinks')}
`;

  const noteContent = serializeNote(frontmatter, body);
  await ctx.vault.create(path, noteContent);

  // Add to hot cache entities if it's an entity-like type
  if (['entity', 'project', 'concept'].includes(input.type)) {
    await ctx.hotCache.addEntity({
      name: input.title,
      link: path.replace(/\.md$/, ''),
      description: input.content.slice(0, 80),
    });
    await ctx.hotCache.flush();
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ path, message: `${input.type} note created.` }, null, 2) }],
  };
}
