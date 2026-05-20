import { SessionStartInputSchema } from './types.js';
import type { HookOutput } from './types.js';
import type { HookContext } from './dispatch.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('hook:session-start');

export async function handleSessionStart(
  input: unknown,
  ctx: HookContext,
): Promise<HookOutput> {
  const parsed = SessionStartInputSchema.parse(input);

  // Initialize session note
  await ctx.sessionLog.getOrCreateSessionNote(parsed.session_id, parsed.cwd);

  // Load hot cache as additional context
  const context = await ctx.hotCache.toContext();

  log.info('Session started', { sessionId: parsed.session_id });

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context || undefined,
    },
  };
}
