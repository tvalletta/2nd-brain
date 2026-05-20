import { z } from 'zod';
import { parseNote, serializeNote } from '../../vault/frontmatter.js';
import { extractProtectedRegions, OPEN_TAG, CLOSE_TAG } from '../../vault/protected-regions.js';
import { nowISO } from '../../shared/date-utils.js';
import type { MCPContext } from '../context.js';

const InputSchema = z.object({
  path: z.string().describe('Vault-relative path to the note to update'),
  content: z.string().optional().describe('New body content (replaces body outside protected regions)'),
  frontmatter_updates: z
    .record(z.unknown())
    .optional()
    .describe('Partial frontmatter fields to merge (e.g. { status: "archived" })'),
  append: z
    .boolean()
    .default(false)
    .describe('If true, append content to the existing body instead of replacing'),
});

export const definition = {
  name: 'update_note',
  description:
    'Update an existing note. Can replace or append body content and/or merge frontmatter fields. Protected regions are always preserved.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string' as const, description: 'Vault-relative path to the note' },
      content: { type: 'string' as const, description: 'New body content (replaces body outside protected regions, or appends if append=true)' },
      frontmatter_updates: {
        type: 'object' as const,
        description: 'Partial frontmatter fields to merge (e.g. { "status": "archived" })',
      },
      append: { type: 'boolean' as const, description: 'If true, append content instead of replacing (default false)' },
    },
    required: ['path'] as const,
  },
};

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);

  const raw = await ctx.vault.read(input.path);
  const { data, body } = parseNote(raw);

  // Merge frontmatter updates
  const updatedData = { ...data };
  if (input.frontmatter_updates) {
    // Never allow overwriting core identity fields via this tool
    const forbidden = new Set(['id', 'created_at']);
    for (const [key, value] of Object.entries(input.frontmatter_updates)) {
      if (!forbidden.has(key)) {
        updatedData[key] = value;
      }
    }
  }
  updatedData.updated_at = nowISO();

  // Handle body content
  let updatedBody = body;
  if (input.content !== undefined) {
    if (input.append) {
      // Append mode: insert before the first protected region at the end, or just append
      const regions = extractProtectedRegions(body);
      if (regions.length > 0) {
        // Find the earliest protected region that appears near the end of the body
        // Insert new content just before the last heading that precedes a protected region
        const lastRegion = regions[regions.length - 1];
        const beforeRegion = body.slice(0, lastRegion.startIndex);
        const afterRegion = body.slice(lastRegion.startIndex);

        // Find the heading line before the region (e.g. "## Backlinks\n")
        const headingMatch = beforeRegion.match(/\n(#{1,6}\s[^\n]+)\n\s*$/);
        if (headingMatch) {
          const insertPoint = beforeRegion.lastIndexOf(headingMatch[1]);
          updatedBody =
            beforeRegion.slice(0, insertPoint).trimEnd() +
            '\n\n' +
            input.content +
            '\n\n' +
            beforeRegion.slice(insertPoint) +
            afterRegion;
        } else {
          updatedBody = beforeRegion.trimEnd() + '\n\n' + input.content + '\n' + afterRegion;
        }
      } else {
        updatedBody = body.trimEnd() + '\n\n' + input.content + '\n';
      }
    } else {
      // Replace mode: preserve protected regions
      const regions = extractProtectedRegions(body);
      if (regions.length > 0) {
        // Rebuild: new content + all protected region blocks
        const regionBlocks = regions.map((r) => {
          // Find the heading before this region in the original body
          const beforeRegion = body.slice(0, r.startIndex);
          const headingMatch = beforeRegion.match(/\n(#{1,6}\s[^\n]+)\n\s*$/);
          const heading = headingMatch ? headingMatch[1] + '\n' : '';
          return `${heading}${OPEN_TAG(r.id)}\n${r.content}\n${CLOSE_TAG(r.id)}`;
        });
        updatedBody = '\n' + input.content.trim() + '\n\n' + regionBlocks.join('\n\n') + '\n';
      } else {
        updatedBody = '\n' + input.content.trim() + '\n';
      }
    }
  }

  const updatedContent = serializeNote(updatedData, updatedBody);
  await ctx.vault.atomicWrite(input.path, updatedContent);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        path: input.path,
        message: 'Note updated.',
        fields_changed: input.frontmatter_updates ? Object.keys(input.frontmatter_updates) : [],
        body_changed: input.content !== undefined,
      }, null, 2),
    }],
  };
}
