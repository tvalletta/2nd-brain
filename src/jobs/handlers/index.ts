import { JobType, type JobHandler } from '../types.js';
import { updateBacklinksHandler } from './update-backlinks.js';
import { rebuildIndexHandler } from './rebuild-index.js';
import { flushHotCacheHandler } from './flush-hot-cache.js';
import { ingestRawFileHandler } from './ingest-raw-file.js';
import { classifySourceHandler } from './classify-source.js';
import { summarizeSourceHandler } from './summarize-source.js';
import { summarizeMeetingHandler } from './summarize-meeting.js';
import { extractEntitiesHandler, extractEntitiesRichHandler } from './extract-entities.js';
import { linkConceptsHandler } from './link-concepts.js';
import { compileEntitiesHandler } from './compile-entities.js';
import { crossLinkPagesHandler } from './cross-link-pages.js';
import { lintWikiHandler } from './lint-wiki.js';
import { rebuildIndexesHandler } from './rebuild-indexes.js';
import { detectContradictionsHandler } from './detect-contradictions.js';
import { detectDuplicatesHandler } from './detect-duplicates.js';
import { finalizeSessionHandler } from './finalize-session.js';
import { agentIngestHandler } from './agent-ingest.js';
import { generateSynthesisSkillsHandler } from './generate-synthesis-skills.js';
import { agentSynthesizeProjectHandler } from './agent-synthesize-project.js';
import { checkConfidenceDecayHandler } from './check-confidence-decay.js';
import { detectCrossProjectPatternsHandler } from './detect-cross-project-patterns.js';
import { embeddingIndexHandler } from './embedding-index.js';
import { tldrUpdateHandler } from './tldr-update.js';
import { rebuildVaultArtifactsHandler } from './rebuild-vault-artifacts.js';
import { digestWeeklyHandler } from './digest-weekly.js';
import { topicRefreshHandler } from './topic-refresh.js';
import { decayScanHandler } from './decay-scan.js';
import { rotScanHandler } from './rot-scan.js';
import { researchProposeHandler } from './research-propose.js';
import { researchExecuteHandler } from './research-execute.js';
import { evaluateRefreshCandidatesHandler } from './evaluate-refresh-candidates.js';
import { detectEntityDupesHandler } from './detect-entity-dupes.js';
import { reEnrichNoteHandler } from './re-enrich-note.js';
import { syncFtsIndexHandler } from './sync-fts-index.js';

export function createHandlerRegistry(): Map<JobType, JobHandler> {
  const map = new Map<JobType, JobHandler>();
  map.set('update-backlinks', updateBacklinksHandler);
  map.set('rebuild-index', rebuildIndexHandler);
  map.set('rebuild-indexes', rebuildIndexesHandler);
  map.set('flush-hot-cache', flushHotCacheHandler);
  map.set('ingest-raw-file', ingestRawFileHandler);
  map.set('classify-source', classifySourceHandler);
  map.set('summarize-source', summarizeSourceHandler);
  map.set('summarize-meeting', summarizeMeetingHandler);
  map.set('extract-entities', extractEntitiesHandler);
  map.set('extract-entities-rich', extractEntitiesRichHandler);
  map.set('link-concepts', linkConceptsHandler);
  map.set('compile-entities', compileEntitiesHandler);
  map.set('cross-link-pages', crossLinkPagesHandler);
  map.set('lint-wiki', lintWikiHandler);
  map.set('detect-contradictions', detectContradictionsHandler);
  map.set('detect-duplicates', detectDuplicatesHandler);
  map.set('finalize-session', finalizeSessionHandler);
  map.set('agent-ingest', agentIngestHandler);
  map.set('generate-synthesis-skills', generateSynthesisSkillsHandler);
  map.set('agent-synthesize-project', agentSynthesizeProjectHandler);
  map.set('check-confidence-decay', checkConfidenceDecayHandler);
  map.set('detect-cross-project-patterns', detectCrossProjectPatternsHandler);
  map.set('embedding-index', embeddingIndexHandler);
  map.set('tldr-update', tldrUpdateHandler);
  map.set('rebuild-vault-artifacts', rebuildVaultArtifactsHandler);
  map.set('digest-weekly', digestWeeklyHandler);
  map.set('topic-refresh', topicRefreshHandler);
  map.set('decay-scan', decayScanHandler);
  map.set('rot-scan', rotScanHandler);
  map.set('research-propose', researchProposeHandler);
  map.set('research-execute', researchExecuteHandler);
  map.set('evaluate-refresh-candidates', evaluateRefreshCandidatesHandler);
  map.set('detect-entity-dupes', detectEntityDupesHandler);
  map.set('re-enrich-note', reEnrichNoteHandler);
  map.set('sync-fts-index', syncFtsIndexHandler);

  // Verify every job type has a registered handler
  for (const jobType of JobType.options) {
    if (!map.has(jobType)) {
      throw new Error(`Missing handler for job type: ${jobType}. Register it in handlers/index.ts.`);
    }
  }

  return map;
}
