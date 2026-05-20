import { PostToolUseInputSchema } from './types.js';
import type { HookOutput } from './types.js';
import type { HookContext } from './dispatch.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('hook:post-tool-use');

const TRACKED_TOOLS = new Set(['Write', 'Edit', 'Bash', 'NotebookEdit']);

export async function handlePostToolUse(
  input: unknown,
  ctx: HookContext,
): Promise<HookOutput> {
  const parsed = PostToolUseInputSchema.parse(input);

  // Only track meaningful tool uses
  if (!TRACKED_TOOLS.has(parsed.tool_name)) {
    return { continue: true };
  }

  await ctx.sessionLog.getOrCreateSessionNote(parsed.session_id, parsed.cwd);

  const toolInput = parsed.tool_input ?? {};
  let summary: string;

  switch (parsed.tool_name) {
    case 'Write':
    case 'Edit':
      summary = `${toolInput.file_path ?? 'unknown file'}`;
      break;
    case 'Bash':
      summary = String(toolInput.command ?? '').slice(0, 100);
      break;
    default:
      summary = parsed.tool_name;
  }

  await ctx.sessionLog.appendToolUse(parsed.session_id, parsed.tool_name, summary);
  log.debug('Tool use captured', { sessionId: parsed.session_id, tool: parsed.tool_name });

  return { continue: true };
}
