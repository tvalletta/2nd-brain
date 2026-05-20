import { z } from 'zod';
import { parseNote } from '../../vault/frontmatter.js';
import { getProtectedRegion } from '../../vault/protected-regions.js';
import type { MCPContext } from '../context.js';

const DetailLevel = z.enum(['metadata', 'summary', 'full']).default('summary');

const InputSchema = z.object({
  count: z.number().int().positive().default(10).describe('Number of recent sessions to return'),
  detail: DetailLevel.describe('Detail level: "metadata" (frontmatter only), "summary" (default — includes prompt/outcome summary), "full" (includes body)'),
});

export const definition = {
  name: 'get_recent_sessions',
  description: 'List recent AI session summaries sorted by date, newest first. When frontmatter summaries are not yet populated, automatically extracts outcome_summary from the decisions protected region so sessions are always informative. Use detail:"summary" (default) to see what was worked on and decided; detail:"full" to read the complete session body.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      count: { type: 'number' as const, description: 'Number of recent sessions to return (default 10)' },
      detail: {
        type: 'string' as const,
        enum: ['metadata', 'summary', 'full'],
        description: 'Detail level (default: summary)',
      },
    },
  },
};

interface SessionInfo {
  path: string;
  title: string;
  session_id: string;
  created_at: string;
  prompt_summary?: string;
  outcome_summary?: string;
  files_changed?: string[];
  body?: string;
}

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);

  let files: string[];
  try {
    files = await ctx.vault.listMarkdownFiles(ctx.config.layout.aiSummaries);
  } catch {
    return { content: [{ type: 'text' as const, text: 'No session summaries found.' }] };
  }

  const sessions: SessionInfo[] = [];

  for (const file of files) {
    let raw: string;
    try {
      raw = await ctx.vault.read(file);
    } catch {
      continue;
    }

    const { data, body } = parseNote(raw);
    const session: SessionInfo = {
      path: file,
      title: (data.title as string) ?? file,
      session_id: (data.session_id as string) ?? '',
      created_at: (data.created_at as string) ?? '',
    };

    if (input.detail === 'summary' || input.detail === 'full') {
      const promptSummary = (data.prompt_summary as string) ?? '';
      const outcomeSummary = (data.outcome_summary as string) ?? '';

      if (!promptSummary && !outcomeSummary) {
        // Frontmatter summaries not yet written — extract from decisions region
        const decisions = getProtectedRegion(raw, 'decisions');
        if (decisions?.trim()) {
          const trimmed = decisions.trim();
          session.outcome_summary = trimmed.length > 800 ? trimmed.slice(0, 800) + '...' : trimmed;
        }
        const toolActivity = getProtectedRegion(raw, 'tool-activity');
        if (toolActivity?.trim()) {
          // Extract a one-line prompt summary from tool-activity (first meaningful line)
          const firstLine = toolActivity.trim().split('\n').find((l) => l.trim().length > 10);
          if (firstLine) session.prompt_summary = firstLine.trim().slice(0, 200);
        }
      } else {
        session.prompt_summary = promptSummary;
        session.outcome_summary = outcomeSummary;
      }
      session.files_changed = (data.files_changed as string[]) ?? [];
    }

    if (input.detail === 'full') {
      session.body = body;
    }

    sessions.push(session);
  }

  sessions.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const trimmed = sessions.slice(0, input.count);

  if (trimmed.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No session summaries found.' }] };
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(trimmed, null, 2) }],
  };
}
