import { definition as getHotCache } from './get-hot-cache.js';
import { definition as searchVault } from './search-vault.js';
import { definition as getNote } from './get-note.js';
import { definition as getRecentSessions } from './get-recent-sessions.js';
import { definition as getEntity } from './get-entity.js';
import { definition as searchEntities } from './search-entities.js';
import { definition as getDecisions } from './get-decisions.js';
import { definition as getReviewQueue } from './get-review-queue.js';
import { definition as logSessionSummary } from './log-session-summary.js';
import { definition as logInsight } from './log-insight.js';
import { definition as ingestContent } from './ingest-content.js';
import { definition as runMaintenance } from './run-maintenance.js';
import { definition as updateNote } from './update-note.js';
import { definition as getBacklinks } from './get-backlinks.js';
import { definition as lintVault } from './lint-vault.js';
import { definition as batchGetNotes } from './batch-get-notes.js';
import { definition as vaultStatus } from './vault-status.js';
import { definition as searchByTags } from './search-by-tags.js';
import { definition as getRelated } from './get-related.js';
import { definition as approveResearch } from './approve-research.js';
import { definition as reconcileEntities } from './reconcile-entities.js';
import { definition as reEnrichNote } from './re-enrich-note.js';

export const TOOL_DEFINITIONS = [
  getHotCache,
  searchVault,
  getNote,
  getRecentSessions,
  getEntity,
  searchEntities,
  getDecisions,
  getReviewQueue,
  getBacklinks,
  logSessionSummary,
  logInsight,
  updateNote,
  ingestContent,
  runMaintenance,
  lintVault,
  batchGetNotes,
  vaultStatus,
  searchByTags,
  getRelated,
  approveResearch,
  reconcileEntities,
  reEnrichNote,
];
