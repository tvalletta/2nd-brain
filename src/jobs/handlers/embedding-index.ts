// Job handler: embedding-index
//
// Re-embeds a single note (or all notes when no targetPath provided). Reads
// the note, chunks it, and replaces the doc in the embedding store. Skips
// when text is unchanged (chunk_hash collision is enough — no need to re-embed).

import type { JobHandler } from '../types.js';
import { z } from 'zod';
import { parseNote } from '../../vault/frontmatter.js';
import { openStoreFromConfig } from '../../embeddings/factory.js';
import { chunkText } from '../../embeddings/store.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('emb-index');

const Payload = z
  .object({
    paths: z.array(z.string()).optional(),
    folder: z.string().optional(),
  })
  .passthrough();

export const embeddingIndexHandler: JobHandler = {
  async execute(job, ctx) {
    const payload = Payload.parse(job.payload ?? {});
    const targets: string[] = [];
    if (job.targetPath) targets.push(job.targetPath);
    if (payload.paths) targets.push(...payload.paths);

    if (targets.length === 0) {
      const folder = payload.folder ?? 'wiki';
      if (!(await ctx.vault.exists(folder))) return;
      targets.push(...(await ctx.vault.listMarkdownFiles(folder)));
    }

    const store = openStoreFromConfig(ctx.config, ctx.projectRoot);
    try {
      for (const path of targets) {
        try {
          const raw = await ctx.vault.read(path);
          const { data, body } = parseNote(raw);
          const fm = data as Record<string, unknown>;
          const chunks = chunkText(body);
          if (chunks.length === 0) {
            store.deleteDoc(path);
            continue;
          }
          await store.replaceDoc(
            path,
            chunks.map((c) => ({
              doc_id: path,
              chunk_index: c.index,
              chunk_hash: c.hash,
              text: c.text,
              metadata: {
                type: typeof fm.type === 'string' ? fm.type : 'unknown',
                title: typeof fm.title === 'string' ? fm.title : path,
                project_slug: typeof fm.project_slug === 'string' ? fm.project_slug : undefined,
                tags: Array.isArray(fm.tags) ? fm.tags : undefined,
              },
            })),
          );
        } catch (err) {
          log.warn('Failed to index note', { path, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } finally {
      store.close();
    }
  },
};
