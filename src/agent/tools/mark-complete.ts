import type { AgentToolDef } from '../tool-registry.js';

/**
 * The mark_complete tool signals that the agent has finished processing.
 * Its result is captured by the runner as the structured output of the agent run.
 */
export const markCompleteTool: AgentToolDef = {
  name: 'mark_complete',
  description:
    'Signal that processing is complete. Call this when you have finished synthesizing the source file into the wiki. Include a structured summary of what was done.',
  input_schema: {
    type: 'object',
    properties: {
      conversation_intent: {
        type: 'string',
        enum: ['exploration', 'decision', 'implementation', 'review', 'planning', 'learning', 'troubleshooting'],
        description: 'The classified intent of the conversation (for AI conversations)',
      },
      project_slug: {
        type: 'string',
        description: 'The project this content was associated with (if any)',
      },
      specs_updated: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of sub-spec types that were updated (e.g. ["technical", "decisions"])',
      },
      specs_created: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of sub-spec types that were newly created',
      },
      entities_created: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of entity pages that were created',
      },
      pages_updated: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of other wiki pages that were updated',
      },
      summary: {
        type: 'string',
        description: 'Brief human-readable summary of what was processed',
      },
    },
    required: ['summary'],
  },
  async execute(input) {
    // The tool result is captured by the runner; here we just return success
    return JSON.stringify({
      status: 'complete',
      ...input,
    });
  },
};
