// Job handler: embedding-index
//
// Re-embeds a single note (or all notes when no targetPath provided). Reads
// the note, chunks it, and replaces the doc in the embedding store. Skips
// when text is unchanged (chunk_hash collision is enough — no need to re-embed).

import type { JobHandler } from '../types.js';
import { z } from 'zod';
import { parseNote } from '../../vault/frontmatter.js';
import { chunkText } from '../../embeddings/store.js';
import { openHybridStoreFromConfig } from '../../search/factory.js';
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

    // Use HybridStore so the FTS5 keyword index and the embedding store are
    // updated together — keeps Layer 3 (ingest-pipeline sync) in lockstep
    // per §24.3 of the spec.
    const store = openHybridStoreFromConfig(ctx.config, ctx.projectRoot);
    try {
      for (const path of targets) {
        try {
          const raw = await ctx.vault.read(path);
          const { data, body } = parseNote(raw);
          const fm = data as Record<string, unknown>;
          // Ollama's nomic-embed-text caps at 2048 tokens. For wikilink-dense
          // markdown (e.g. an auto-generated `_index.md`) tokens are ~2.5
          // chars each — a 6 000 char chunk is ~2 400 tokens, over the cap.
          // 4 000 chars × 2.5 ch/tok = 1 600 tokens, safe for any density.
          // Bedrock Titan v2 (8 192 tokens) accepts these too.
          const chunks = chunkText(body, 1200, 4000);
          const title = typeof fm.title === 'string' && fm.title.length > 0 ? fm.title : path;
          await store.upsertDoc(
            path,
            title,
            body,
            chunks.map((c) => ({
              doc_id: path,
              chunk_index: c.index,
              chunk_hash: c.hash,
              text: c.text,
              metadata: {
                type: typeof fm.type === 'string' ? fm.type : 'unknown',
                title,
                project_slug: typeof fm.project_slug === 'string' ? fm.project_slug : undefined,
                tags: Array.isArray(fm.tags) ? fm.tags : undefined,
                updated_at: typeof fm.updated_at === 'string' ? fm.updated_at : undefined,
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
