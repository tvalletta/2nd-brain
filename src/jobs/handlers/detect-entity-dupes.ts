import type { JobHandler, Job, JobContext } from '../types.js';
import { detectMergeCandidates, mergeEntities, AUTO_MERGE_THRESHOLD } from '../../compilation/entity-merger.js';
import { refreshQueue } from '../../maintenance/reconciliation-queue.js';
import { appendLogEntry } from '../../maintenance/vault-log.js';
import { createLogger } from '../../shared/logger.js';
import { layoutFromConfig } from '../../vault/paths.js';

const log = createLogger('handler:detect-entity-dupes');

export const detectEntityDupesHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    const layout = layoutFromConfig(context.config);
    const candidates = await detectMergeCandidates(context.vault, layout);

    const autoCandidates = candidates.filter((c) => c.confidence >= AUTO_MERGE_THRESHOLD);
    const queueCandidates = candidates.filter((c) => c.confidence < AUTO_MERGE_THRESHOLD);

    let merged = 0;
    for (const c of autoCandidates) {
      try {
        await mergeEntities(c.sourcePath, c.targetPath, context.vault, layout);
      } catch (err) {
        // Isolate per-candidate failures (e.g. target deleted concurrently)
        // so one bad candidate doesn't abort the rest of the run. The next
        // daily scan re-detects from scratch and will retry.
        log.warn('Auto-merge failed; leaving candidate for next scan', {
          sourcePath: c.sourcePath,
          targetPath: c.targetPath,
          error: (err as Error).message,
        });
        continue;
      }

      // The merge itself succeeded — the source page is already gone, so it
      // won't be re-detected on the next scan regardless of what happens
      // below. Count it now, and log any log-write failure separately so we
      // never misreport a successful merge as a failed one.
      merged++;

      try {
        await appendLogEntry(
          context.vault,
          { kind: 'entity:automerge', message: `${c.sourceName} → ${c.targetName} (confidence ${c.confidence.toFixed(2)})` },
          layout,
        );
      } catch (err) {
        log.warn('Auto-merge succeeded but failed to write log entry', {
          sourcePath: c.sourcePath,
          targetPath: c.targetPath,
          error: (err as Error).message,
        });
      }
    }

    const added = queueCandidates.length > 0 ? await refreshQueue(context.vault, queueCandidates, layout) : 0;

    await appendLogEntry(
      context.vault,
      { kind: 'entity:dedupe', message: `${candidates.length} scanned → ${merged} auto-merged, ${added} newly queued` },
      layout,
    );

    log.info('Entity dupe detection complete', {
      detected: candidates.length,
      autoMerged: merged,
      newlyQueued: added,
    });
  },
};
