import { z } from 'zod';
import { nanoid } from 'nanoid';
import { serializeNote } from '../../vault/frontmatter.js';
import { OPEN_TAG, CLOSE_TAG } from '../../vault/protected-regions.js';
import { slugify, resolveAvailablePath } from '../../vault/paths.js';
import { nowISO, todayStamp } from '../../shared/date-utils.js';
import type { MCPContext } from '../context.js';

const InputSchema = z.object({
  summary: z.string().describe('Summary of what was accomplished in this session'),
  files_changed: z.array(z.string()).default([]).describe('List of files modified'),
  decisions: z.array(z.string()).default([]).describe('Key decisions made during the session'),
  cwd: z.string().optional().describe('Working directory'),
  source: z.enum(['cursor', 'claude-code', 'manual']).default('manual').describe('Which client captured this session'),
});

export const definition = {
  name: 'log_session_summary',
  description:
    'Capture a session summary. Use at the end of a substantive task to record what was done, decisions made, and files changed.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      summary: { type: 'string' as const, description: 'Summary of what was accomplished' },
      files_changed: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'List of files modified',
      },
      decisions: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Key decisions made',
      },
      cwd: { type: 'string' as const, description: 'Working directory' },
      source: {
        type: 'string' as const,
        enum: ['cursor', 'claude-code', 'manual'],
        description: 'Which client captured this session',
      },
    },
    required: ['summary'] as const,
  },
};

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);
  const sessionId = nanoid(12);
  const date = todayStamp();
  const now = nowISO();

  const dir = ctx.config.layout.aiSummaries;
  await ctx.vault.ensureFolder(dir);

  const slug = slugify(`session-${date}-${sessionId.slice(0, 8)}`);
  const existingPaths = new Set(await ctx.vault.listMarkdownFiles(dir));
  const path = resolveAvailablePath(dir, `${slug}.md`, existingPaths);

  const frontmatter = {
    id: nanoid(),
    type: 'session_summary',
    title: `Session ${date} (${sessionId.slice(0, 8)})`,
    status: 'active',
    review_state: 'unreviewed',
    created_at: now,
    updated_at: now,
    session_id: sessionId,
    prompt_summary: input.summary.slice(0, 200),
    outcome_summary: input.summary,
    files_changed: input.files_changed,
    source_refs: [],
    derived_from: [],
    aliases: [],
    links: [],
    change_origin: 'hook_capture',
    protected_regions: ['prompts', 'tool-activity', 'decisions'],
  };

  let body = `
# Session ${date}

**Source:** ${input.source}
${input.cwd ? `**Working directory:** \`${input.cwd}\`` : ''}

## Summary
${input.summary}

## Prompts
${OPEN_TAG('prompts')}
Captured via ${input.source} MCP tool.
${CLOSE_TAG('prompts')}

## Tool Activity
${OPEN_TAG('tool-activity')}
${input.files_changed.length > 0 ? input.files_changed.map((f) => `- Modified: ${f}`).join('\n') : 'No file changes recorded.'}
${CLOSE_TAG('tool-activity')}

## Decisions & Insights
${OPEN_TAG('decisions')}
${input.decisions.length > 0 ? input.decisions.map((d) => `- ${d}`).join('\n') : 'No decisions recorded.'}
${CLOSE_TAG('decisions')}
`;

  const content = serializeNote(frontmatter, body);
  await ctx.vault.create(path, content);

  // Update hot cache
  const noteLink = path.replace(/\.md$/, '');
  await ctx.hotCache.appendSession({
    date,
    summary: input.summary.slice(0, 120),
    noteLink,
  });
  await ctx.hotCache.flush();

  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ path, session_id: sessionId, message: 'Session summary logged.' }, null, 2) }],
  };
}
