import type { JobContext } from '../jobs/types.js';
import type { ContentCategory } from '../ingest/content-router.js';
import type { ToolDefinition, ToolExecutor } from './bedrock-agent-client.js';
import { TimeoutError } from '../shared/retry.js';

/**
 * An agent tool definition with its execute function.
 */
export interface AgentToolDef {
  /** Tool name (used in tool_use blocks) */
  name: string;
  /** Description shown to the model */
  description: string;
  /** JSON Schema for the tool input */
  input_schema: Record<string, unknown>;
  /** Execute the tool and return a string result */
  execute: (input: Record<string, unknown>, context: AgentContext) => Promise<string>;
}

/**
 * Extended job context for agent tools.
 */
export interface AgentContext extends JobContext {
  sourceFilePath: string;
  sourceContent: string;
  contentCategory: ContentCategory;
  projectSlug?: string;
}

/**
 * Create a tool executor function from a registry of tool definitions.
 * The executor dispatches tool calls to the correct tool and passes context.
 * Applies an optional per-tool timeout.
 */
export function createToolExecutor(
  tools: AgentToolDef[],
  context: AgentContext,
  toolTimeoutMs?: number,
): ToolExecutor {
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  return async (name: string, input: Record<string, unknown>): Promise<string> => {
    const tool = toolMap.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    if (toolTimeoutMs && toolTimeoutMs > 0) {
      return Promise.race([
        tool.execute(input, context),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new TimeoutError(toolTimeoutMs)), toolTimeoutMs),
        ),
      ]);
    }

    return tool.execute(input, context);
  };
}

/**
 * Convert AgentToolDef[] to ToolDefinition[] for the Bedrock API.
 */
export function toToolDefinitions(tools: AgentToolDef[]): ToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}
