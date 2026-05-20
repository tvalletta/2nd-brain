import { z } from 'zod';
import matter from 'gray-matter';

// --- Base schema ---

export const ChangeOrigin = z.enum([
  'human',
  'deterministic_maintenance',
  'extraction',
  'heuristic_review',
  'hook_capture',
]);
export type ChangeOrigin = z.infer<typeof ChangeOrigin>;

export const NoteStatus = z.enum(['draft', 'active', 'archived', 'rejected']);
export type NoteStatus = z.infer<typeof NoteStatus>;

export const Confidence = z.enum(['low', 'medium', 'high']);
export type Confidence = z.infer<typeof Confidence>;

export const ReviewState = z.enum(['unreviewed', 'reviewed', 'approved', 'rejected']);
export type ReviewState = z.infer<typeof ReviewState>;

export const NoteType = z.enum([
  'source_summary',
  'session_summary',
  'meeting_summary',
  'entity',
  'project',
  'project_spec',
  'decision',
  'concept',
  'topic',
  'tool',
  'organization',
  'contradiction',
  'index',
]);
export type NoteType = z.infer<typeof NoteType>;

export const ContradictionRefSchema = z.object({
  ref: z.string(),
  reason: z.string().optional(),
});
export type ContradictionRef = z.infer<typeof ContradictionRefSchema>;

/**
 * Phase 0 (cascading curation): an unresolved piece of evidence that should
 * be folded into this note on the next refresh cycle. Appended by
 * `markDirty()`; consumed and cleared by `topic-refresh`.
 */
export const PendingEvidenceSchema = z.object({
  ref: z.string(),
  reason: z.string().optional(),
  at: z.string(),
});
export type PendingEvidence = z.infer<typeof PendingEvidenceSchema>;

export const BaseFrontmatterSchema = z.object({
  id: z.string(),
  type: NoteType,
  title: z.string(),
  status: NoteStatus.default('draft'),
  confidence: Confidence.optional(),
  review_state: ReviewState.default('unreviewed'),
  created_at: z.string(),
  updated_at: z.string(),
  last_maintained_at: z.string().optional(),
  source_refs: z.array(z.string()).default([]),
  derived_from: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  links: z.array(z.string()).default([]),
  change_origin: ChangeOrigin.default('human'),
  protected_regions: z.array(z.string()).default([]),

  // --- A1: Time-aware knowledge (intelligence-plan §4) ---
  /** ISO date the claims in this note were last verified by ingest, refresh, or research. */
  last_verified: z.string().optional(),
  /** FSRS-style: days for confidence in this note's claims to halve. Default depends on domain. */
  stability: z.number().nonnegative().optional(),
  /** Domain bucket that drives default stability. e.g. "ai-research" (90d), "decisions" (365d), "people" (Infinity). */
  half_life_domain: z.string().optional(),
  /** Wiki-link IDs of newer notes that replace this one. */
  superseded_by: z.array(z.string()).default([]),
  /** Notes this one materially disagrees with — preserved as assets, not errors. */
  contradicts: z.array(ContradictionRefSchema).default([]),
  /** ≤120 char summary; mirrored into the `tldr` protected region. */
  tldr: z.string().optional(),
  /** 0..1 score from the most recent weekly digest; absent if not in last digest. */
  hot_score: z.number().min(0).max(1).optional(),

  // --- Phase 0 (cascading curation): mark-dirty + lazy refresh ---
  /** Unresolved evidence chunks awaiting integration into the protected region. */
  pending_evidence: z.array(PendingEvidenceSchema).default([]),
  /** Cached count of `pending_evidence`; threshold-gated by `evaluate-refresh-candidates`. */
  pending_evidence_count: z.number().int().nonnegative().default(0),
  /**
   * Phase 3 (cross-project bridges): absolute project paths whose chunks
   * reference this concept. Maintained by `detect-bridges`.
   */
  also_relevant_to: z.array(z.string()).default([]),
});
export type BaseFrontmatter = z.infer<typeof BaseFrontmatterSchema>;

// --- Type-specific schemas ---

export const IngestStatus = z.enum([
  'detected',
  'classified',
  'summarized',
  'extracted',
  'linked',
  'logged',
  'failed',
]);

export const SourceSummarySchema = BaseFrontmatterSchema.extend({
  type: z.literal('source_summary'),
  source_type: z.string(),
  source_path: z.string(),
  ingest_status: IngestStatus.default('detected'),
  source_hash: z.string().optional(),
  chunk_count: z.number().int().default(1),
  chunk_strategy: z.string().optional(),
  content_category: z.string().optional(),
  conversation_intent: z.string().optional(),
  project_slug: z.string().optional(),
});
export type SourceSummaryFrontmatter = z.infer<typeof SourceSummarySchema>;

export const SessionSummarySchema = BaseFrontmatterSchema.extend({
  type: z.literal('session_summary'),
  session_id: z.string(),
  prompt_summary: z.string().optional(),
  outcome_summary: z.string().optional(),
  files_changed: z.array(z.string()).default([]),
});
export type SessionSummaryFrontmatter = z.infer<typeof SessionSummarySchema>;

export const MeetingSummarySchema = BaseFrontmatterSchema.extend({
  type: z.literal('meeting_summary'),
  meeting_date: z.string().optional(),
  attendees: z.array(z.string()).default([]),
  source_path: z.string().optional(),
  content_category: z.string().optional(),
});
export type MeetingSummaryFrontmatter = z.infer<typeof MeetingSummarySchema>;

export const EntitySchema = BaseFrontmatterSchema.extend({
  type: z.literal('entity'),
  entity_kind: z.string(),
  canonical_name: z.string(),
});
export type EntityFrontmatter = z.infer<typeof EntitySchema>;

export const ProjectSchema = BaseFrontmatterSchema.extend({
  type: z.literal('project'),
  project_key: z.string(),
  project_status: z.string().default('active'),
});
export type ProjectFrontmatter = z.infer<typeof ProjectSchema>;

export const ProjectSpecSchema = BaseFrontmatterSchema.extend({
  type: z.literal('project_spec'),
  project_key: z.string(),
  spec_type: z.string(),
  last_reinforced: z.string().optional(),
  reinforcement_count: z.number().int().default(0),
  conversations_since_update: z.number().int().default(0),
  stale_threshold: z.number().int().default(10),
});
export type ProjectSpecFrontmatter = z.infer<typeof ProjectSpecSchema>;

export const DecisionSchema = BaseFrontmatterSchema.extend({
  type: z.literal('decision'),
  decision_status: z.string().default('proposed'),
  decision_date: z.string().optional(),
});
export type DecisionFrontmatter = z.infer<typeof DecisionSchema>;

export const ConceptSchema = BaseFrontmatterSchema.extend({
  type: z.literal('concept'),
});

export const TopicSchema = BaseFrontmatterSchema.extend({
  type: z.literal('topic'),
});

export const ToolSchema = BaseFrontmatterSchema.extend({
  type: z.literal('tool'),
  tool_category: z.string().optional(),
});

export const OrganizationSchema = BaseFrontmatterSchema.extend({
  type: z.literal('organization'),
  org_type: z.enum(['company', 'team', 'department', 'other']).default('other'),
});

export const ContradictionSchema = BaseFrontmatterSchema.extend({
  type: z.literal('contradiction'),
  conflict_type: z.string(),
  claim_a: z.string(),
  claim_b: z.string(),
  resolution_state: z.enum(['open', 'resolved', 'dismissed']).default('open'),
});
export type ContradictionFrontmatter = z.infer<typeof ContradictionSchema>;

export const IndexFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal('index'),
  index_category: z.string().optional(),
  entry_count: z.number().int().optional(),
});
export type IndexFrontmatter = z.infer<typeof IndexFrontmatterSchema>;

// --- Parse / serialize ---

export interface ParsedNote {
  data: Record<string, unknown>;
  body: string;
}

export function parseNote(content: string): ParsedNote {
  const parsed = matter(content);
  return { data: parsed.data, body: parsed.content };
}

export function serializeNote(data: Record<string, unknown>, body: string): string {
  return matter.stringify(body, data);
}

export function validateFrontmatter(data: Record<string, unknown>): z.SafeParseReturnType<unknown, BaseFrontmatter> {
  return BaseFrontmatterSchema.safeParse(data);
}
