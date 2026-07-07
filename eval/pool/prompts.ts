export interface TriageItemInput {
  id: string;
  query: string;
  category: string;
  subtype: string;
  source: string;
  intent: string;
}

export interface JudgeCandidate {
  doc_id: string;
  title: string;
  excerpt: string;
}

export function triagePrompt(items: TriageItemInput[]): string {
  const body = items
    .map(
      (it) =>
        `id: ${it.id}\nquery: ${it.query}\ncurrent_category: ${it.category}\ncurrent_subtype: ${it.subtype}\nsource: ${it.source}\nintent: ${it.intent || '(none given)'}`,
    )
    .join('\n---\n');

  return `You are a retrieval-evaluation dataset curator reviewing draft eval items for a personal knowledge-base search system.

For each item below, decide whether its category and subtype labels are correct, and whether it is genuinely a retrieval question (asking to find/recall something in a personal notes vault) rather than an unrelated task request that slipped in by mistake during automated mining.

Categories: "plaud" (meeting recordings/transcripts captured via Plaud), "ai-session" (Claude Code / Cursor AI coding session history), "entities" (people/orgs/projects/relationships), "hot-topics" (what's currently active/important), "decisions" (specific decisions or meeting outcomes).
Subtypes: "lookup" (single-fact retrieval), "synthesis" (spans many notes), "relationship" (entity graph walk), "absent" (deliberately testing that nothing relevant exists).

--- BEGIN ITEMS ---
${body}
--- END ITEMS ---

For each item, return an object with: id, proposed_category, proposed_subtype, drop (true if this is NOT a genuine retrieval question — e.g. it's a coding task request, an installation request, or an acknowledgement that slipped through), and a one-sentence reason.

Respond with only a JSON array, one object per item, wrapped in \`\`\`json code fences.`;
}

export function judgePrompt(query: string, intent: string, candidates: JudgeCandidate[]): string {
  const body = candidates
    .map((c) => `doc_id: ${c.doc_id}\ntitle: ${c.title}\nexcerpt: ${c.excerpt}`)
    .join('\n---\n');
  const intentLine = intent
    ? intent
    : '(no additional intent given — judge relevance to the query alone)';

  return `You are grading search-result relevance for a personal knowledge-base retrieval evaluation.

Query: "${query}"
Intent: ${intentLine}

For each candidate note below, grade how relevant it is to the query:
- 2 = directly answers or is the primary target of the query
- 1 = relevant supporting context, but not the primary answer
- 0 = not relevant

--- BEGIN CANDIDATES ---
${body}
--- END CANDIDATES ---

Return a JSON array with one object per candidate: { "doc_id": "...", "label": 0|1|2, "reason": "<one sentence>" }. Include every candidate exactly once, in any order.

Respond with only the JSON array, wrapped in \`\`\`json code fences.`;
}
