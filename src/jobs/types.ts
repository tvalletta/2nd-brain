import { z } from 'zod';

export const JobStatus = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobType = z.enum([
  'update-backlinks',
  'rebuild-index',
  'rebuild-indexes',
  'ingest-raw-file',
  'classify-source',
  'summarize-source',
  'summarize-meeting',
  'extract-entities',
  'extract-entities-rich',
  'link-concepts',
  'compile-entities',
  'cross-link-pages',
  'lint-wiki',
  'detect-contradictions',
  'detect-duplicates',
  'flush-hot-cache',
  'finalize-session',
  'agent-ingest',
  'agent-synthesize-project',
  'check-confidence-decay',
  'detect-cross-project-patterns',
  'generate-synthesis-skills',
  // Intelligence-plan additions ---------------------------------------------
  'embedding-index',
  'tldr-update',
  'digest-weekly',
  'topic-refresh',
  'decay-scan',
  'rot-scan',
  'research-propose',
  'research-execute',
  'rebuild-vault-artifacts',
  // Phase 1 (cascading curation) -------------------------------------------
  'evaluate-refresh-candidates',
  // Curator reconciliation (§22) -------------------------------------------
  'detect-entity-dupes',
  're-enrich-note',
  // Hybrid search ----------------------------------------------------------
  'sync-fts-index',
]);
export type JobType = z.infer<typeof JobType>;

export const JobTrigger = z.enum(['file-watcher', 'hook', 'timer', 'cli', 'cascade']);
export type JobTrigger = z.infer<typeof JobTrigger>;

export const JobSchema = z.object({
  id: z.string(),
  type: JobType,
  status: JobStatus,
  priority: z.number().int().min(0).max(100).default(50),
  targetPath: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
  trigger: JobTrigger.default('cli'),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  retryCount: z.number().int().default(0),
  maxRetries: z.number().int().default(3),
  retryAfter: z.number().int().optional(),
  timeoutMs: z.number().int().optional(),
  dedupeKey: z.string().optional(),
  debounceMs: z.number().int().default(0),
});
export type Job = z.infer<typeof JobSchema>;

export const DEFAULT_PRIORITIES: Record<string, number> = {
  'flush-hot-cache': 5,
  'finalize-session': 5,
  'update-backlinks': 10,
  'rebuild-index': 10,
  'rebuild-indexes': 15,
  'ingest-raw-file': 20,
  'classify-source': 30,
  'summarize-source': 40,
  'summarize-meeting': 40,
  'extract-entities': 50,
  'extract-entities-rich': 50,
  'link-concepts': 60,
  'compile-entities': 60,
  'cross-link-pages': 70,
  'detect-contradictions': 80,
  'detect-duplicates': 80,
  'lint-wiki': 90,
  'agent-ingest': 25,
  'agent-synthesize-project': 35,
  'check-confidence-decay': 85,
  'detect-cross-project-patterns': 85,
  'generate-synthesis-skills': 90,
  'embedding-index': 45,
  'tldr-update': 65,
  'digest-weekly': 90,
  'topic-refresh': 75,
  'decay-scan': 95,
  'rot-scan': 95,
  'research-propose': 90,
  'research-execute': 80,
  'rebuild-vault-artifacts': 92,
  'evaluate-refresh-candidates': 50,
  'detect-entity-dupes': 80,
  're-enrich-note': 55,
  'sync-fts-index': 100,
};

export interface JobHandler {
  execute(job: Job, context: JobContext): Promise<void>;
}

export interface JobContext {
  vaultPath: string;
  projectRoot: string;
  enqueue: (partial: JobCreateInput) => Promise<Job>;
  llm: import('../enrichment/llm-client.js').LLMClient;
  vault: import('../vault/adapter.js').VaultAdapter;
  config: import('../config/schema.js').KarpathyConfig;
}

export type JobCreateInput = Pick<Job, 'type'> &
  Partial<Omit<Job, 'id' | 'status' | 'createdAt' | 'retryCount'>>;

// ---------------------------------------------------------------------------
// Typed payload schemas — warn-only validation for forward compatibility
// ---------------------------------------------------------------------------

const IngestRawFilePayload = z.object({
  filePath: z.string().optional(),
  vaultRawPath: z.string().optional(),
});

const ClassifySourcePayload = z.object({
  rawPath: z.string().optional(),
  sourceHash: z.string().optional(),
});

const ExtractEntitiesRichPayload = z.object({
  rawPath: z.string(),
  sourceHash: z.string().optional(),
});

const CompileEntitiesPayload = z.object({
  entities: z.record(z.unknown()),
  sourceSummaryPath: z.string(),
});

const AgentIngestPayload = z.object({
  rawPath: z.string(),
  sourceSummaryPath: z.string().optional(),
  contentCategory: z.string().optional(),
  projectSlug: z.string().optional(),
});

const EvaluateRefreshCandidatesPayload = z.object({
  /** Optional reason — appears in logs and structured outputs. */
  reason: z.string().optional(),
});

const ReEnrichNotePayload = z.object({
  /** Vault-relative path to the wiki note to re-enrich. */
  notePath: z.string(),
});

/** Maps job types to their payload schemas. Used for warn-only validation. */
export const PAYLOAD_SCHEMAS: Partial<Record<JobType, z.ZodTypeAny>> = {
  'ingest-raw-file': IngestRawFilePayload,
  'classify-source': ClassifySourcePayload,
  'extract-entities-rich': ExtractEntitiesRichPayload,
  'compile-entities': CompileEntitiesPayload,
  'agent-ingest': AgentIngestPayload,
  'evaluate-refresh-candidates': EvaluateRefreshCandidatesPayload,
  're-enrich-note': ReEnrichNotePayload,
};
