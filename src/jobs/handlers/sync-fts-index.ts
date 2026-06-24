// Job handler: sync-fts-index
//
// Walks every markdown directory in the configured layout, diffs the {path,
// mtime} set against `fts_meta`, and incrementally upserts/deletes the FTS5
// virtual table. Cheap (no API calls, no LLM): the spec measures ~56ms for
// the 22k-file stat walk + ~8ms per changed file, so the 5-minute scheduler
// cadence has plenty of headroom.
//
// Triggered by:
//   - the 5-minute intel-tick scheduler (primary)
//   - the Stop hook at session end (catch session-created content)
//   - the chokidar watcher for single-file events (real-time supplement)
//   - the `karpathy maintenance --populate-fts` command (initial seed)

import type { JobHandler } from '../types.js';
import { z } from 'zod';
import { openHybridStoreFromConfig } from '../../search/factory.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('sync-fts-index');

const Payload = z
  .object({
    /** Optional override — defaults to all readable wiki + outputs folders. */
    folders: z.array(z.string()).optional(),
    /** Single-file mode (chokidar add/change). */
    file: z.string().optional(),
    /** Single-file delete (chokidar unlink). */
    deletedFile: z.string().optional(),
  })
  .passthrough();

export const syncFtsIndexHandler: JobHandler = {
  async execute(job, ctx) {
    const payload = Payload.parse(job.payload ?? {});
    const store = openHybridStoreFromConfig(ctx.config, ctx.projectRoot);
    try {
      // ---- Single-file path (watcher events) ------------------------------
      if (payload.deletedFile) {
        await store.deleteDoc(payload.deletedFile);
        log.info('FTS doc deleted', { docId: payload.deletedFile });
        return;
      }
      if (payload.file) {
        // Single-file watcher event — upsert just this doc, then stamp
        // fts_meta with its mtime so the next full sync sees it as known.
        // We pass [dirname(file)] to syncFTS; sync() is mtime-aware so it
        // only re-reads the changed/new entry under that dir on the first
        // call after the change.
        const { dirname, resolve, relative } = await import('node:path');
        const { stat } = await import('node:fs/promises');
        const targetAbs = resolve(ctx.config.vaultPath, payload.file);
        const targetRel = relative(ctx.config.vaultPath, targetAbs);
        try {
          // Confirm the file exists; if not, treat as delete.
          await stat(targetAbs);
        } catch {
          await store.deleteDoc(targetRel);
          log.info('FTS single-file delete (file missing)', { docId: targetRel });
          return;
        }
        const dir = dirname(targetRel);
        const stats = await store.syncFTS([dir]);
        log.info('FTS single-file sync', { file: targetRel, ...stats });
        return;
      }

      // ---- Full sync path -------------------------------------------------
      // Per design doc §2: FTS5 covers ALL vault markdown — scanned directly
      // from disk regardless of whether the embedding pipeline has touched
      // it. Walk the vault root; `walkMarkdown` already skips dotfiles
      // (`.obsidian/`, `.git/`, etc).
      const dirs = payload.folders ?? ['.'];

      const stats = await store.syncFTS(dirs);
      log.info('FTS sync complete', { ...stats });
    } finally {
      store.close();
    }
  },
};
