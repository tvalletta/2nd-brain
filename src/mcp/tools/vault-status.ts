import { parseNote } from '../../vault/frontmatter.js';
import { listReviewItems } from '../../review/review-queue.js';
import type { MCPContext } from '../context.js';

export const definition = {
  name: 'vault_status',
  description:
    'Get a quick overview of the vault: note counts by type and status, recent activity, and review queue size.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

interface VaultStatus {
  total_notes: number;
  by_type: Record<string, number>;
  by_status: Record<string, number>;
  recent_activity: { last_24h: number; last_7d: number };
  review_queue_size: number;
}

export async function handle(_args: Record<string, unknown>, ctx: MCPContext) {
  const { searchableFolders } = await import('../../vault/paths.js');
  const folders = searchableFolders(ctx.config.layout);

  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let totalNotes = 0;
  let last24h = 0;
  let last7d = 0;

  const now = Date.now();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  for (const folder of folders) {
    let files: string[];
    try {
      files = await ctx.vault.listMarkdownFiles(folder);
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const raw = await ctx.vault.read(file);
        const { data } = parseNote(raw);
        totalNotes++;

        const noteType = (data.type as string) ?? 'unknown';
        byType[noteType] = (byType[noteType] ?? 0) + 1;

        const status = (data.status as string) ?? 'unknown';
        byStatus[status] = (byStatus[status] ?? 0) + 1;

        const updatedAt = (data.updated_at as string) ?? (data.created_at as string) ?? '';
        if (updatedAt >= oneDayAgo) last24h++;
        if (updatedAt >= sevenDaysAgo) last7d++;
      } catch {
        // skip unreadable
      }
    }
  }

  let reviewQueueSize = 0;
  try {
    const items = await listReviewItems(ctx.vault);
    reviewQueueSize = items.length;
  } catch {
    // review folder may not exist
  }

  const status: VaultStatus = {
    total_notes: totalNotes,
    by_type: byType,
    by_status: byStatus,
    recent_activity: { last_24h: last24h, last_7d: last7d },
    review_queue_size: reviewQueueSize,
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
  };
}
