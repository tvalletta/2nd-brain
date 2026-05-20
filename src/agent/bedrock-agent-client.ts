import { createLogger } from '../shared/logger.js';
import { withRetry, isTransientBedrockError } from '../shared/retry.js';

const log = createLogger('agent-client');

// --- Anthropic Messages API types (subset used for tool use) ---

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock;
export type MessageContent = ContentBlock[];

export interface Message {
  role: 'user' | 'assistant';
  content: string | (ContentBlock | ToolResultBlock)[];
}

export interface AgentClientConfig {
  region: string;
}

export interface AgentLoopOptions {
  model?: string;
  maxTurns?: number;
  maxTokens?: number;
  temperature?: number;
  system?: string;
  apiTimeoutMs?: number;
  apiRetryAttempts?: number;
  apiRetryBaseMs?: number;
}

export interface AgentLoopResult {
  finalMessage: string;
  toolCalls: number;
  turns: number;
}

export type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<string>;

/**
 * Create an agent client that can run multi-turn tool-use loops via Bedrock.
 * Uses @anthropic-ai/bedrock-sdk which provides the Anthropic Messages API
 * through AWS Bedrock.
 */
export function createAgentClient(config: AgentClientConfig) {
  let clientPromise: Promise<any> | null = null;

  async function getClient(): Promise<any> {
    if (clientPromise) return clientPromise;
    clientPromise = (async () => {
      const { AnthropicBedrock } = await import(
        /* @vite-ignore */ '@anthropic-ai/bedrock-sdk'
      );
      return new AnthropicBedrock({ awsRegion: config.region });
    })();
    return clientPromise;
  }

  return {
    /**
     * Run an agentic loop: send messages with tools, execute tool calls,
     * feed results back, repeat until the model stops calling tools.
     */
    async runAgentLoop(
      initialMessage: string,
      tools: ToolDefinition[],
      toolExecutor: ToolExecutor,
      options: AgentLoopOptions = {},
    ): Promise<AgentLoopResult> {
      const client = await getClient();
      const model = options.model ?? 'us.anthropic.claude-sonnet-4-6';
      const maxTurns = options.maxTurns ?? 20;
      const maxTokens = options.maxTokens ?? 8192;
      const temperature = options.temperature ?? 0.3;

      const messages: Message[] = [
        { role: 'user', content: initialMessage },
      ];

      const apiTimeoutMs = options.apiTimeoutMs ?? 120000;
      const apiRetryAttempts = options.apiRetryAttempts ?? 3;
      const apiRetryBaseMs = options.apiRetryBaseMs ?? 1000;

      let totalToolCalls = 0;
      let turns = 0;
      const runStart = Date.now();

      for (turns = 1; turns <= maxTurns; turns++) {
        log.debug('Agent turn', { turn: turns, model });

        const turnStart = Date.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response: any = await withRetry(
          () => client.messages.create({
            model,
            max_tokens: maxTokens,
            temperature,
            ...(options.system ? { system: options.system } : {}),
            tools,
            messages,
          }),
          {
            maxAttempts: apiRetryAttempts,
            baseDelayMs: apiRetryBaseMs,
            timeoutMs: apiTimeoutMs,
            shouldRetry: isTransientBedrockError,
          },
        );
        const apiLatencyMs = Date.now() - turnStart;

        log.debug('API response', {
          turn: turns,
          apiLatencyMs,
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          stopReason: response.stop_reason,
        });

        const contentBlocks = response.content as ContentBlock[];

        // Collect text and tool_use blocks
        const textParts: string[] = [];
        const toolUses: ToolUseBlock[] = [];

        for (const block of contentBlocks) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolUses.push(block);
          }
        }

        // Add assistant message to conversation
        messages.push({ role: 'assistant', content: contentBlocks });

        // If no tool calls, we're done
        if (toolUses.length === 0 || response.stop_reason === 'end_turn') {
          log.info('Agent loop complete', {
            turns,
            toolCalls: totalToolCalls,
            durationMs: Date.now() - runStart,
            finalTextLength: textParts.join('').length,
          });
          return {
            finalMessage: textParts.join('\n'),
            toolCalls: totalToolCalls,
            turns,
          };
        }

        // Execute tool calls and collect results
        const toolResults: ToolResultBlock[] = [];

        for (const toolUse of toolUses) {
          totalToolCalls++;
          const toolStart = Date.now();

          try {
            const result = await toolExecutor(toolUse.name, toolUse.input);
            log.debug('Tool executed', {
              name: toolUse.name,
              turn: turns,
              durationMs: Date.now() - toolStart,
            });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: result,
            });
          } catch (err) {
            const errorMessage = (err as Error).message;
            log.warn('Tool execution error', {
              name: toolUse.name,
              turn: turns,
              durationMs: Date.now() - toolStart,
              error: errorMessage,
            });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Error: ${errorMessage}`,
              is_error: true,
            });
          }
        }

        // Add tool results as a user message
        messages.push({ role: 'user', content: toolResults });
      }

      // Max turns exceeded
      log.warn('Agent loop hit max turns', {
        maxTurns,
        toolCalls: totalToolCalls,
        durationMs: Date.now() - runStart,
      });
      const lastAssistant = messages.filter((m) => m.role === 'assistant').pop();
      const lastText = Array.isArray(lastAssistant?.content)
        ? (lastAssistant.content as ContentBlock[])
            .filter((b): b is TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
        : '';

      return {
        finalMessage: lastText || '[Max turns exceeded]',
        toolCalls: totalToolCalls,
        turns: maxTurns,
      };
    },
  };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
