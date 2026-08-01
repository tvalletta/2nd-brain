import { z } from 'zod';

export interface RefreshEvidence {
  title: string;
  existingPrimary: string;    // current content of the primary region (may be a placeholder)
  existingSecondary?: string; // e.g. decision's `context`, used as read-only grounding
  evidenceBlock: string;      // pre-formatted, numbered retrieval hits
}

/**
 * Shape every REFRESH_TARGETS[*].responseSchema parses to. Field names are
 * snake_case (`new_sources`) to match what the LLM is asked to emit and what
 * `refreshTopic` actually reads (`synthesis.new_sources`).
 */
export interface RefreshSynthesisResult {
  primary: string;
  secondary?: string;
  contradictions: Array<{ ref: string; reason: string }>;
  new_sources: string[];
}

export interface RefreshTarget {
  /** The one protected region this refresh pass rewrites. */
  primaryRegion: string;
  /** Optional second region this type's prompt is also allowed to touch (decision only: `context`). */
  secondaryRegion?: string;
  /** Human label used in prompts/logs. */
  label: string;
  /** Exact strings (case-insensitive, trimmed) that count as "not yet written" for this type. */
  placeholderStrings: string[];
  /** Below this many non-whitespace characters (after stripping wikilink brackets), also counts as thin. */
  minCharFloor: number;
  buildPrompt(evidence: RefreshEvidence): string;
  responseSchema: z.ZodType<RefreshSynthesisResult, z.ZodTypeDef, unknown>;
}

export function isPlaceholderContent(target: RefreshTarget, rawContent: string | null): boolean {
  const trimmed = (rawContent ?? '').trim();
  if (trimmed.length === 0) return true;
  if (target.placeholderStrings.some((p) => p.toLowerCase() === trimmed.toLowerCase())) return true;
  const stripped = trimmed.replace(/\[\[|\]\]/g, '');
  return stripped.length < target.minCharFloor;
}

function buildConceptTopicPrompt(e: RefreshEvidence): string {
  return `You are refreshing a topic note in a personal knowledge base.

Topic: ${e.title}
Current understanding (from existing note):
"""
${e.existingPrimary || '(no current understanding yet)'}
"""

New evidence (most recent retrievals):
${e.evidenceBlock}

Produce a JSON object with these fields:
{
  "primary": "≤8 paragraphs. Chain-of-density rewrite integrating the new evidence. Cite sources inline as [n]. Do NOT overwrite or hide claims that disagree with new evidence — surface them as contradictions instead.",
  "contradictions": [{ "ref": "[n]", "reason": "one-sentence why" }],
  "new_sources": ["doc_id of each piece of evidence not already in the note's sources"]
}

Output ONLY a single fenced \`\`\`json block.`;
}

function buildDecisionPrompt(e: RefreshEvidence): string {
  return `You are refreshing a decision note in a personal knowledge base.

Decision: ${e.title}
Recorded context (why this decision was made):
"""
${e.existingSecondary || '(no context recorded)'}
"""
Current outcome on file: "${e.existingPrimary || '(pending)'}"

New evidence (most recent retrievals):
${e.evidenceBlock}

Produce a JSON object with these fields:
{
  "primary": "What actually happened as a result of this decision, grounded ONLY in the evidence above. If the evidence still does not reveal an outcome, write exactly \\"(pending)\\" — never fabricate a resolution just to fill the field.",
  "secondary": "Only include this field if the new evidence meaningfully sharpens or corrects the original context — omit it otherwise.",
  "contradictions": [{ "ref": "[n]", "reason": "one-sentence why" }],
  "new_sources": ["doc_id of each piece of evidence not already in the note's sources"]
}

Output ONLY a single fenced \`\`\`json block.`;
}

function buildProjectPrompt(e: RefreshEvidence): string {
  return `You are refreshing a project overview in a personal knowledge base.

Project: ${e.title}
Current overview on file:
"""
${e.existingPrimary || 'Pending enrichment.'}
"""

New evidence (most recent retrievals across all sources mentioning this project):
${e.evidenceBlock}

Produce a JSON object with these fields:
{
  "primary": "≤3 paragraphs: what this project is, its current status, and the most important recent developments. Cite sources inline as [n]. If the evidence is too sparse to say anything concrete yet, write exactly \\"Pending enrichment.\\" — never invent scope or status you can't ground in the evidence.",
  "contradictions": [{ "ref": "[n]", "reason": "one-sentence why" }],
  "new_sources": ["doc_id of each piece of evidence not already in the note's sources"]
}

Output ONLY a single fenced \`\`\`json block.`;
}

const ConceptTopicSchema = z.object({
  primary: z.string(),
  contradictions: z.array(z.object({ ref: z.string(), reason: z.string() })).default([]),
  new_sources: z.array(z.string()).default([]),
});

const DecisionSchema = z.object({
  primary: z.string(),
  secondary: z.string().optional(),
  contradictions: z.array(z.object({ ref: z.string(), reason: z.string() })).default([]),
  new_sources: z.array(z.string()).default([]),
});

const ProjectSchema = z.object({
  primary: z.string(),
  contradictions: z.array(z.object({ ref: z.string(), reason: z.string() })).default([]),
  new_sources: z.array(z.string()).default([]),
});

export const REFRESH_TARGETS: Record<'concept' | 'topic' | 'decision' | 'project', RefreshTarget> = {
  concept: {
    primaryRegion: 'current-understanding',
    label: 'Current Understanding',
    placeholderStrings: ['(no current understanding yet)', ''],
    minCharFloor: 40,
    buildPrompt: buildConceptTopicPrompt,
    responseSchema: ConceptTopicSchema,
  },
  topic: {
    primaryRegion: 'current-understanding',
    label: 'Current Understanding',
    placeholderStrings: ['(no current understanding yet)', ''],
    minCharFloor: 40,
    buildPrompt: buildConceptTopicPrompt,
    responseSchema: ConceptTopicSchema,
  },
  decision: {
    primaryRegion: 'outcome',
    secondaryRegion: 'context',
    label: 'Outcome',
    placeholderStrings: ['', '(pending)'],
    minCharFloor: 10,
    buildPrompt: buildDecisionPrompt,
    responseSchema: DecisionSchema,
  },
  project: {
    primaryRegion: 'overview',
    label: 'Overview',
    placeholderStrings: ['', 'pending enrichment.'],
    minCharFloor: 20,
    buildPrompt: buildProjectPrompt,
    responseSchema: ProjectSchema,
  },
};
