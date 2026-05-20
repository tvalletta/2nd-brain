import type { ContentCategory } from '../../ingest/content-router.js';

/**
 * Build the initial user message for the ingest agent.
 * Contains the source file content and metadata to orient the agent.
 */
export function buildIngestUserPrompt(params: {
  sourcePath: string;
  contentCategory: ContentCategory;
  projectSlug?: string;
  content: string;
  maxContentLength?: number;
}): string {
  const maxLen = params.maxContentLength ?? 100_000;
  const truncated = params.content.length > maxLen;
  const content = truncated
    ? params.content.slice(0, maxLen) + '\n\n[... content truncated ...]'
    : params.content;

  const parts: string[] = [
    `## Source File`,
    `- **Path:** ${params.sourcePath}`,
    `- **Category:** ${params.contentCategory}`,
  ];

  if (params.projectSlug) {
    parts.push(`- **Project slug:** ${params.projectSlug}`);
  }

  if (truncated) {
    parts.push(`- **Note:** Content was truncated from ${params.content.length} to ${maxLen} characters`);
  }

  parts.push('', '## File Content', '', content);

  parts.push('', '## Instructions');
  parts.push(
    'Process this source file according to the system instructions. ' +
    'Use tools to explore existing wiki state, then synthesize knowledge from this file ' +
    'into the appropriate project hub sub-specs (or other wiki pages). ' +
    'When finished, call `mark_complete` with a summary of what you did.',
  );

  return parts.join('\n');
}
