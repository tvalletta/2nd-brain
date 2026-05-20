import { UserPromptSubmitInputSchema } from './types.js';
import type { HookOutput } from './types.js';
import type { HookContext } from './dispatch.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('hook:prompt-submit');

export async function handleUserPromptSubmit(
  input: unknown,
  ctx: HookContext,
): Promise<HookOutput> {
  const parsed = UserPromptSubmitInputSchema.parse(input);

  await ctx.sessionLog.getOrCreateSessionNote(parsed.session_id, parsed.cwd);
  await ctx.sessionLog.appendPrompt(parsed.session_id, parsed.prompt);

  log.debug('Prompt captured', { sessionId: parsed.session_id });

  return { continue: true };
}
