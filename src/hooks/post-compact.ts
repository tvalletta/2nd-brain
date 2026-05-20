import { PostCompactInputSchema } from './types.js';
import type { HookOutput } from './types.js';
import type { HookContext } from './dispatch.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('hook:post-compact');

export async function handlePostCompact(
  input: unknown,
  ctx: HookContext,
): Promise<HookOutput> {
  const parsed = PostCompactInputSchema.parse(input);

  await ctx.sessionLog.getOrCreateSessionNote(parsed.session_id, parsed.cwd);

  // Save the compact summary — this is valuable context that would otherwise be lost
  if (parsed.compact_summary) {
    await ctx.sessionLog.appendCompactSummary(parsed.session_id, parsed.compact_summary);
  }

  // Flush hot cache to ensure it's persisted before context is compacted
  await ctx.hotCache.flush();

  // Drain the job queue in a background process (non-blocking)
  ctx.backgroundDrain();

  log.info('Post-compact processed (background drain spawned)', {
    sessionId: parsed.session_id,
    hasSummary: !!parsed.compact_summary,
  });

  return { continue: true };
}
