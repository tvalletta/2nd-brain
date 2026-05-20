import { z } from 'zod';

export const BaseHookInputSchema = z.object({
  hook_event_name: z.string(),
  session_id: z.string(),
  transcript_path: z.string().optional(),
  cwd: z.string(),
});

export const SessionStartInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('SessionStart'),
  source: z.string().optional(),
});

export const UserPromptSubmitInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('UserPromptSubmit'),
  prompt: z.string(),
});

export const PostToolUseInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('PostToolUse'),
  tool_name: z.string(),
  tool_input: z.record(z.unknown()).optional(),
  tool_response: z.unknown().optional(),
  tool_use_id: z.string().optional(),
});

export const PostCompactInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('PostCompact'),
  trigger: z.string().optional(),
  compact_summary: z.string().optional(),
});

export const StopInputSchema = BaseHookInputSchema.extend({
  hook_event_name: z.literal('Stop'),
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: z.string().optional(),
});

export interface HookOutput {
  continue?: boolean;
  suppressOutput?: boolean;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    [key: string]: unknown;
  };
}
