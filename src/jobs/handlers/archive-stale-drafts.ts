// Sub-project C, G2: auto-archive source_summary notes that have sat at
// status: draft past a configurable age. Fully deterministic, no review —
// nothing is deleted, the raw evidence in raw/ and the summary note's body
// are untouched, and the transition is fully reversible (manual edit, or
// automatically the moment the source is actually processed — see
// link-concepts.ts/compile-entities.ts/agent-ingest.ts's G0/G7 guard).

import type { JobHandler } from '../types.js';
import { parseNote, serializeNote } from '../../vault/frontmatter.js';
import { layoutFromConfig } from '../../vault/paths.js';
import { nowISO } from '../../shared/date-utils.js';
import { appendLogEntry } from '../../maintenance/vault-log.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:archive-stale-drafts');

export const archiveStaleDraftsHandler: JobHandler = {
  async execute(_job, ctx) {
    const layout = layoutFromConfig(ctx.config);
    const cfg = ctx.config.intelligence.lifecycle;
    if (!cfg.enabled || !cfg.staleDraftArchiveEnabled) return;
    if (!(await ctx.vault.exists(layout.sources))) return;

    const nowMs = Date.now();
    const files = await ctx.vault.listMarkdownFiles(layout.sources);
    let archived = 0;

    for (const path of files) {
      if (path.endsWith('/_index.md')) continue;
      const raw = await ctx.vault.read(path);
      const { data, body } = parseNote(raw);
      if (data.type !== 'source_summary' || data.status !== 'draft') continue;

      const createdAt = typeof data.created_at === 'string' ? data.created_at : undefined;
      const ageDays = createdAt ? (nowMs - new Date(createdAt).getTime()) / 86_400_000 : Infinity;
      if (ageDays < cfg.staleDraftArchiveDays) continue;

      data.status = 'archived';
      data.archived_at = new Date(nowMs).toISOString();
      data.archived_reason = `stale-draft (${Math.round(ageDays)}d at ingest_status: ${data.ingest_status ?? 'unknown'})`;
      data.updated_at = nowISO();
      await ctx.vault.atomicWrite(path, serializeNote(data, body));
      archived++;
    }

    if (archived > 0) {
      await appendLogEntry(
        ctx.vault,
        { kind: 'lifecycle:archive-stale-drafts', message: `${archived} stale draft source(s) archived (>${cfg.staleDraftArchiveDays}d)` },
        layout,
      );
    }
    log.info('Stale-draft archival complete', { archived, thresholdDays: cfg.staleDraftArchiveDays });
  },
};
