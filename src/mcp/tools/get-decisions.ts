import { z } from 'zod';
import { parseNote } from '../../vault/frontmatter.js';
import type { MCPContext } from '../context.js';

const InputSchema = z.object({
  status: z.string().optional().describe('Filter by decision status (e.g. "active", "archived")'),
  project: z.string().optional().describe('Filter by project key'),
});

export const definition = {
  name: 'get_decisions',
  description: 'List all decision notes from the vault sorted by date, optionally filtered by status or project. Returns title, decision_status, and date (falls back to created_at when decision_date is unset). Call before making a new architectural or strategic choice to surface existing decisions.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      status: { type: 'string' as const, description: 'Filter by decision status' },
      project: { type: 'string' as const, description: 'Filter by project key' },
    },
  },
};

interface DecisionInfo {
  path: string;
  title: string;
  decision_status: string;
  decision_date: string;
  project_key?: string;
  status: string;
}

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);

  let files: string[];
  try {
    files = await ctx.vault.listMarkdownFiles(`${ctx.config.layout.wiki}/decisions`);
  } catch {
    return { content: [{ type: 'text' as const, text: 'No decisions found.' }] };
  }

  const decisions: DecisionInfo[] = [];

  for (const file of files) {
    // Skip the directory index file
    if (file.endsWith('/_index.md')) continue;

    let raw: string;
    try {
      raw = await ctx.vault.read(file);
    } catch {
      continue;
    }

    const { data } = parseNote(raw);
    const decisionStatus = (data.decision_status as string) ?? '';
    const projectKey = data.project_key as string | undefined;

    if (input.status && (data.status as string) !== input.status) continue;
    if (input.project && projectKey !== input.project) continue;

    decisions.push({
      path: file,
      title: (data.title as string) ?? file,
      decision_status: decisionStatus,
      decision_date: (data.decision_date as string) || (data.created_at as string) || '',
      project_key: projectKey,
      status: (data.status as string) ?? 'draft',
    });
  }

  if (decisions.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No matching decisions found.' }] };
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(decisions, null, 2) }],
  };
}
