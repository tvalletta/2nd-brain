import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import { ingestFile } from '../../ingest/pipeline.js';
import type { MCPContext } from '../context.js';

const InputSchema = z.object({
  content: z.string().describe('Raw content to ingest'),
  title: z.string().describe('Filename for the raw file (e.g. "meeting-notes.md")'),
  source_type: z.string().optional().describe('File type hint (markdown, plaintext, json, etc.)'),
});

export const definition = {
  name: 'ingest_content',
  description:
    'Ingest raw content (text, markdown, JSON) into the vault. Content is stored in raw/ and a source summary note is created.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      content: { type: 'string' as const, description: 'Raw content to ingest' },
      title: { type: 'string' as const, description: 'Filename for the raw file (e.g. "meeting-notes.md")' },
      source_type: { type: 'string' as const, description: 'File type hint' },
    },
    required: ['content', 'title'] as const,
  },
};

export async function handle(args: Record<string, unknown>, ctx: MCPContext) {
  const input = InputSchema.parse(args);

  // Write content to a temp file so ingestFile can read it
  const ext = input.title.includes('.') ? '' : '.md';
  const tempPath = join(tmpdir(), `karpathy-ingest-${nanoid(8)}${ext}`);
  await writeFile(tempPath, input.content, 'utf-8');

  // Rename temp file to match the desired title
  const titledPath = join(tmpdir(), input.title);
  const { rename } = await import('node:fs/promises');
  await rename(tempPath, titledPath);

  const result = await ingestFile(titledPath, ctx.vault, ctx.config.layout);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        rawPath: result.rawPath,
        summaryPath: result.sourceSummaryPath,
        sourceType: result.sourceType,
        sourceHash: result.sourceHash,
        message: 'Content ingested successfully.',
      }, null, 2),
    }],
  };
}
