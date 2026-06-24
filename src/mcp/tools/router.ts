import type { MCPContext } from '../context.js';
import { handle as getHotCache } from './get-hot-cache.js';
import { handle as searchVault } from './search-vault.js';
import { handle as getNote } from './get-note.js';
import { handle as getRecentSessions } from './get-recent-sessions.js';
import { handle as getEntity } from './get-entity.js';
import { handle as searchEntities } from './search-entities.js';
import { handle as getDecisions } from './get-decisions.js';
import { handle as getReviewQueue } from './get-review-queue.js';
import { handle as logSessionSummary } from './log-session-summary.js';
import { handle as logInsight } from './log-insight.js';
import { handle as ingestContent } from './ingest-content.js';
import { handle as runMaintenance } from './run-maintenance.js';
import { handle as updateNote } from './update-note.js';
import { handle as getBacklinks } from './get-backlinks.js';
import { handle as lintVault } from './lint-vault.js';
import { handle as batchGetNotes } from './batch-get-notes.js';
import { handle as vaultStatus } from './vault-status.js';
import { handle as searchByTags } from './search-by-tags.js';
import { handle as getRelated } from './get-related.js';
import { handle as approveResearch } from './approve-research.js';
import { handle as reconcileEntities } from './reconcile-entities.js';
import { handle as reEnrichNote } from './re-enrich-note.js';
import { handle as search } from './search.js';
import { createLogger } from '../../shared/logger.js';
import { appendUsageEntry, sanitizeArgs, parseResultCount } from '../usage-log.js';

const log = createLogger('mcp-router');

type ToolHandler = (args: Record<string, unknown>, ctx: MCPContext) => Promise<{ content: { type: 'text'; text: string }[] }>;

const handlers: Record<string, ToolHandler> = {
  get_hot_cache: getHotCache,
  search: search,
  search_vault: searchVault,
  get_note: getNote,
  get_recent_sessions: getRecentSessions,
  get_entity: getEntity,
  search_entities: searchEntities,
  get_decisions: getDecisions,
  get_review_queue: getReviewQueue,
  log_session_summary: logSessionSummary,
  log_insight: logInsight,
  ingest_content: ingestContent,
  run_maintenance: runMaintenance,
  update_note: updateNote,
  get_backlinks: getBacklinks,
  lint_vault: lintVault,
  batch_get_notes: batchGetNotes,
  vault_status: vaultStatus,
  search_by_tags: searchByTags,
  get_related: getRelated,
  approve_research: approveResearch,
  reconcile_entities: reconcileEntities,
  re_enrich_note: reEnrichNote,
};

export async function handleToolCall(
  params: { name: string; arguments?: Record<string, unknown> },
  ctx: MCPContext,
) {
  const handler = handlers[params.name];
  const args = params.arguments ?? {};
  const start = Date.now();

  if (!handler) {
    const duration_ms = Date.now() - start;
    await appendUsageEntry(ctx.usageLogPath, {
      ts: new Date().toISOString(),
      tool: params.name,
      args: sanitizeArgs(args),
      duration_ms,
      success: false,
      result_chars: 0,
      error: 'unknown tool',
    });
    return {
      content: [{ type: 'text' as const, text: `Unknown tool: ${params.name}` }],
      isError: true,
    };
  }

  try {
    const result = await handler(args, ctx);
    const duration_ms = Date.now() - start;
    const resultText = result.content.map((c) => c.text).join('');
    await appendUsageEntry(ctx.usageLogPath, {
      ts: new Date().toISOString(),
      tool: params.name,
      args: sanitizeArgs(args),
      duration_ms,
      success: !(result as { isError?: boolean }).isError,
      result_count: parseResultCount(resultText),
      result_chars: resultText.length,
    });
    return result;
  } catch (err) {
    const duration_ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    log.error('Tool call failed', { tool: params.name, error: message });
    await appendUsageEntry(ctx.usageLogPath, {
      ts: new Date().toISOString(),
      tool: params.name,
      args: sanitizeArgs(args),
      duration_ms,
      success: false,
      result_chars: 0,
      error: message,
    });
    return {
      content: [{ type: 'text' as const, text: `Error in ${params.name}: ${message}` }],
      isError: true,
    };
  }
}
