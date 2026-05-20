export function summarizeSourcePrompt(title: string, text: string): string {
  return `You are a knowledge curator. Summarize the following source material in 2-4 concise paragraphs.
Focus on key facts, decisions, and insights. Preserve specifics (names, dates, numbers).

Source title: ${title}

--- BEGIN SOURCE ---
${text}
--- END SOURCE ---

Write the summary directly, no preamble.`;
}

export function synthesizeSummariesPrompt(
  title: string,
  chunkSummaries: Array<{ chunkId: string; summary: string }>,
): string {
  const summaryList = chunkSummaries
    .map((cs) => `[Chunk ${cs.chunkId}]:\n${cs.summary}`)
    .join('\n\n');

  return `You are a knowledge curator. Below are summaries of individual sections from a large source document.
Synthesize them into a single unified summary of 2-5 paragraphs.
Preserve specifics (names, dates, numbers). When referencing information from a specific section, include the chunk reference like [chunk abc123def456].

Source title: ${title}

--- BEGIN SECTION SUMMARIES ---
${summaryList}
--- END SECTION SUMMARIES ---

Write the unified summary directly, no preamble.`;
}

export function meetingSummarizePrompt(title: string, text: string): string {
  return `You are a knowledge curator processing a meeting transcript.
Extract a structured meeting brief from the transcript below.

Source title: ${title}

--- BEGIN TRANSCRIPT ---
${text}
--- END TRANSCRIPT ---

Output exactly these sections:

MEETING: (one-line: date if mentioned, topic/title, location or call type if mentioned)
ATTENDEES: (bulleted list of names and roles/context)
KEY DECISIONS: (bulleted list of concrete decisions made, each with owner if identifiable)
ACTION ITEMS: (bulleted list, each formatted as: [owner] — [task] — [due date or "no date"])
OPEN QUESTIONS: (unresolved questions or items needing follow-up)
KEY THEMES: (2-3 sentence narrative of what was discussed and why it matters)

Write directly, no preamble. If a section has no content, write "(none)".`;
}

export function synthesizeMeetingSummariesPrompt(
  title: string,
  chunkBriefs: Array<{ chunkId: string; brief: string }>,
): string {
  const briefList = chunkBriefs.map((b) => `[Chunk ${b.chunkId}]:\n${b.brief}`).join('\n\n');

  return `You are a knowledge curator. Below are structured meeting briefs from individual sections of a long transcript.
Merge them into a single unified meeting brief, deduplicating attendees and combining action items across chunks.

Source title: ${title}

--- BEGIN SECTION BRIEFS ---
${briefList}
--- END SECTION BRIEFS ---

Output exactly these sections:

MEETING: (one-line: date if mentioned, topic/title, location or call type if mentioned)
ATTENDEES: (deduplicated bulleted list of names and roles/context)
KEY DECISIONS: (combined bulleted list of concrete decisions, each with owner if identifiable)
ACTION ITEMS: (combined bulleted list, each formatted as: [owner] — [task] — [due date or "no date"])
OPEN QUESTIONS: (combined unresolved questions or items needing follow-up)
KEY THEMES: (2-3 sentence narrative synthesizing what was discussed and why it matters)

Write directly, no preamble. If a section has no content, write "(none)".`;
}

export function extractEntitiesPrompt(text: string): string {
  return `You are a knowledge graph curator. Extract structured entities from the following text.

Return a JSON object with these arrays:
- "people": [{name, role, context, confidence}]
- "projects": [{name, status, context, confidence}]
- "concepts": [{name, definition, confidence}]
- "decisions": [{title, status, date, context, confidence}]
- "action_items": [{task, owner, due_date, status, confidence}]
- "open_questions": [{question, context, confidence}]

Each entity must include a "confidence" field (0.0 to 1.0) indicating how clearly the entity is identified in the text:
- 1.0: explicitly named, well-described
- 0.7-0.9: clearly referenced but limited detail
- 0.3-0.6: inferred or ambiguous
- below 0.3: speculative

Only include entities that are at least somewhat identifiable. "action_items" may be empty for non-meeting content.

--- BEGIN TEXT ---
${text}
--- END TEXT ---

Respond with only the JSON object, wrapped in \`\`\`json code fences.`;
}

export function extractEntitiesChunkPrompt(
  text: string,
  chunkId: string,
  chunkContext: string,
): string {
  const contextLine = chunkContext ? `Section context: ${chunkContext}\n` : '';
  return `You are a knowledge graph curator. Extract structured entities from the following text chunk.
${contextLine}Chunk ID: ${chunkId}

Return a JSON object with these arrays:
- "people": [{name, role, context, confidence}]
- "projects": [{name, status, context, confidence}]
- "concepts": [{name, definition, confidence}]
- "decisions": [{title, status, date, context, confidence}]
- "action_items": [{task, owner, due_date, status, confidence}]
- "open_questions": [{question, context, confidence}]

Each entity must include a "confidence" field (0.0 to 1.0) indicating how clearly the entity is identified in the text:
- 1.0: explicitly named, well-described
- 0.7-0.9: clearly referenced but limited detail
- 0.3-0.6: inferred or ambiguous
- below 0.3: speculative

Only include entities that are at least somewhat identifiable.

--- BEGIN TEXT ---
${text}
--- END TEXT ---

Respond with only the JSON object, wrapped in \`\`\`json code fences.`;
}

export function linkConceptsPrompt(pageTitle: string, pageBody: string, knownConcepts: string[]): string {
  return `You are a wiki link assistant. Given a wiki page and a list of known concepts, identify which concepts should be wikilinked in the page body.

Page title: ${pageTitle}

Known concepts:
${knownConcepts.map((c) => `- ${c}`).join('\n')}

--- BEGIN PAGE ---
${pageBody}
--- END PAGE ---

Return a JSON array of concept names that should be linked. Only include concepts that are genuinely referenced or relevant.

Respond with only the JSON array, wrapped in \`\`\`json code fences.`;
}

export function extractEntitiesRichPrompt(text: string): string {
  return `You are a knowledge graph curator. Extract structured entities AND their relationships from the following text.

Return a JSON object with these arrays:
- "people": [{name, role, context, confidence, relationships: [{target, targetKind, relationship}]}]
- "projects": [{name, status, context, confidence, relationships: [{target, targetKind, relationship}]}]
- "concepts": [{name, definition, confidence, relationships: [{target, targetKind, relationship}]}]
- "topics": [{name, definition, confidence, relationships: [{target, targetKind, relationship}]}]
- "decisions": [{title, status, date, context, confidence, relationships: [{target, targetKind, relationship}]}]
- "tools": [{name, context, confidence, relationships: [{target, targetKind, relationship}]}]
- "organizations": [{name, context, confidence, relationships: [{target, targetKind, relationship}]}]
- "action_items": [{task, owner, due_date, status, confidence}]
- "open_questions": [{question, context, confidence}]

Each entity must include a "confidence" field (0.0 to 1.0) indicating how clearly the entity is identified in the text:
- 1.0: explicitly named, well-described
- 0.7-0.9: clearly referenced but limited detail
- 0.3-0.6: inferred or ambiguous
- below 0.3: speculative

Each "relationships" array captures how that entity relates to other entities.
For example, if the text says "Alice works on Project X using React", Alice would have:
  relationships: [
    {target: "Project X", targetKind: "project", relationship: "works on"},
    {target: "React", targetKind: "tool", relationship: "uses"}
  ]

targetKind must be one of: person, project, concept, topic, decision, tool, organization.

Only include entities that are at least somewhat identifiable.

--- BEGIN TEXT ---
${text}
--- END TEXT ---

Respond with only the JSON object, wrapped in \`\`\`json code fences.`;
}

export function extractEntitiesRichChunkPrompt(
  text: string,
  chunkId: string,
  chunkContext: string,
): string {
  const contextLine = chunkContext ? `Section context: ${chunkContext}\n` : '';
  return `You are a knowledge graph curator. Extract structured entities AND their relationships from the following text chunk.
${contextLine}Chunk ID: ${chunkId}

Return a JSON object with these arrays:
- "people": [{name, role, context, confidence, relationships: [{target, targetKind, relationship}]}]
- "projects": [{name, status, context, confidence, relationships: [{target, targetKind, relationship}]}]
- "concepts": [{name, definition, confidence, relationships: [{target, targetKind, relationship}]}]
- "topics": [{name, definition, confidence, relationships: [{target, targetKind, relationship}]}]
- "decisions": [{title, status, date, context, confidence, relationships: [{target, targetKind, relationship}]}]
- "tools": [{name, context, confidence, relationships: [{target, targetKind, relationship}]}]
- "organizations": [{name, context, confidence, relationships: [{target, targetKind, relationship}]}]
- "action_items": [{task, owner, due_date, status, confidence}]
- "open_questions": [{question, context, confidence}]

Each entity must include a "confidence" field (0.0 to 1.0) indicating how clearly the entity is identified in the text:
- 1.0: explicitly named, well-described
- 0.7-0.9: clearly referenced but limited detail
- 0.3-0.6: inferred or ambiguous
- below 0.3: speculative

Each "relationships" array captures how that entity relates to other entities.
For example, if the text says "Alice works on Project X using React", Alice would have:
  relationships: [
    {target: "Project X", targetKind: "project", relationship: "works on"},
    {target: "React", targetKind: "tool", relationship: "uses"}
  ]

targetKind must be one of: person, project, concept, topic, decision, tool, organization.

Only include entities that are at least somewhat identifiable.

--- BEGIN TEXT ---
${text}
--- END TEXT ---

Respond with only the JSON object, wrapped in \`\`\`json code fences.`;
}

export function compileEntityPrompt(
  entityName: string,
  entityKind: string,
  existingContent: string | null,
  references: Array<{ source: string; context: string }>,
  relatedEntities: Array<{ name: string; kind: string; relationship: string }>,
): string {
  const referencesBlock = references
    .map((r, i) => `[Ref ${i + 1} — ${r.source}]:\n${r.context}`)
    .join('\n\n');

  const relatedBlock = relatedEntities
    .map((e) => `- ${e.name} (${e.kind}): ${e.relationship}`)
    .join('\n');

  const existingBlock = existingContent
    ? `\n--- EXISTING CONTENT (enrich/update, never lose information) ---\n${existingContent}\n--- END EXISTING CONTENT ---\n`
    : '';

  // Vary sections by entity kind
  let sectionInstructions: string;
  switch (entityKind) {
    case 'person':
      sectionInstructions = `Output the following sections in exactly this format:

SUMMARY:
(A comprehensive paragraph about this person — role, background, key contributions)

PROJECTS:
(Bulleted list of related projects as [[wikilinks]] with brief context)

TOPICS:
(Bulleted list of related concepts/topics as [[wikilinks]] with brief context)

TIMELINE:
(Chronological list of notable interactions, contributions, or events from the references. Use dates when available.)

SOURCES:
(Bulleted list citing every source reference by name)`;
      break;
    case 'project':
      sectionInstructions = `Output the following sections in exactly this format:

SUMMARY:
(A comprehensive paragraph about this project — purpose, status, key details)

PEOPLE:
(Bulleted list of related people as [[wikilinks]] with their role/relationship)

DECISIONS:
(Bulleted list of related decisions as [[wikilinks]] with brief context)

TOPICS:
(Bulleted list of related concepts/topics as [[wikilinks]] with brief context)

TIMELINE:
(Chronological list of notable events, milestones, or changes from the references. Use dates when available.)

SOURCES:
(Bulleted list citing every source reference by name)`;
      break;
    case 'concept':
    case 'topic':
      sectionInstructions = `Output the following sections in exactly this format:

SUMMARY:
(A comprehensive paragraph defining and explaining this ${entityKind})

PROJECTS:
(Bulleted list of related projects as [[wikilinks]] with brief context)

PEOPLE:
(Bulleted list of related people as [[wikilinks]] with brief context)

TOPICS:
(Bulleted list of related concepts/topics as [[wikilinks]] with brief context)

SOURCES:
(Bulleted list citing every source reference by name)`;
      break;
    case 'decision':
      sectionInstructions = `Output the following sections in exactly this format:

SUMMARY:
(A comprehensive paragraph about this decision — what was decided, why, and implications)

PEOPLE:
(Bulleted list of people involved as [[wikilinks]] with their role)

PROJECTS:
(Bulleted list of related projects as [[wikilinks]] with brief context)

TOPICS:
(Bulleted list of related concepts/topics as [[wikilinks]] with brief context)

SOURCES:
(Bulleted list citing every source reference by name)`;
      break;
    case 'tool':
      sectionInstructions = `Output the following sections in exactly this format:

SUMMARY:
(A comprehensive paragraph about this tool — purpose, usage, key details)

PROJECTS:
(Bulleted list of projects using this tool as [[wikilinks]] with brief context)

PEOPLE:
(Bulleted list of people associated with this tool as [[wikilinks]] with brief context)

TOPICS:
(Bulleted list of related concepts/topics as [[wikilinks]] with brief context)

SOURCES:
(Bulleted list citing every source reference by name)`;
      break;
    case 'organization':
      sectionInstructions = `Output the following sections in exactly this format:

SUMMARY:
(A comprehensive paragraph about this organization — purpose, role, key details)

PEOPLE:
(Bulleted list of related people as [[wikilinks]] with their role/relationship)

PROJECTS:
(Bulleted list of related projects as [[wikilinks]] with brief context)

TOPICS:
(Bulleted list of related concepts/topics as [[wikilinks]] with brief context)

SOURCES:
(Bulleted list citing every source reference by name)`;
      break;
    default:
      sectionInstructions = `Output the following sections in exactly this format:

SUMMARY:
(A comprehensive paragraph about this entity)

PROJECTS:
(Bulleted list of related projects as [[wikilinks]] with brief context)

PEOPLE:
(Bulleted list of related people as [[wikilinks]] with brief context)

TOPICS:
(Bulleted list of related concepts/topics as [[wikilinks]] with brief context)

TIMELINE:
(Chronological list of notable events from the references. Use dates when available.)

SOURCES:
(Bulleted list citing every source reference by name)`;
      break;
  }

  return `You are a wiki knowledge compiler. Compile a rich wiki article about the ${entityKind} "${entityName}".

Use the references and related entities below to write comprehensive, well-organized content.
Use [[wikilinks]] for all entity cross-references.
${existingContent ? 'You are UPDATING an existing article. Enrich and update it with new information but NEVER remove or lose existing information.' : 'You are creating a new article from scratch.'}
${existingBlock}
--- REFERENCES ---
${referencesBlock}
--- END REFERENCES ---

--- RELATED ENTITIES ---
${relatedBlock || '(none)'}
--- END RELATED ENTITIES ---

${sectionInstructions}

Write directly with no preamble. Each section label (e.g. SUMMARY:) must appear on its own line. If a section has no relevant content, write "(none)" for that section.`;
}

export function crossLinkPrompt(
  pageBody: string,
  knownEntities: Array<{ name: string; aliases: string[] }>,
): string {
  const entityList = knownEntities
    .map((e) => {
      const aliasPart = e.aliases.length > 0 ? ` (aliases: ${e.aliases.join(', ')})` : '';
      return `- ${e.name}${aliasPart}`;
    })
    .join('\n');

  return `You are a wiki cross-linking assistant. Given a page body and a list of known entities, identify ALL mentions of these entities in the text that should become [[wikilinks]].

Handle variations including:
- Possessives (e.g. "Alice's" → link to "Alice")
- Plurals (e.g. "microservices" → link to "Microservice")
- Abbreviations and aliases listed below
- Partial matches when unambiguous (e.g. "the Express project" → link to "Adobe Express")

Do NOT link:
- Text that is already inside [[wikilinks]]
- Text inside YAML frontmatter
- The page's own title reference in a heading

--- KNOWN ENTITIES ---
${entityList}
--- END KNOWN ENTITIES ---

--- BEGIN PAGE ---
${pageBody}
--- END PAGE ---

Return a JSON array of objects: [{original, linkTarget}]
- "original": the exact text as it appears in the page body
- "linkTarget": the canonical entity name to link to

Only include matches you are confident about. Do not fabricate entities that are not in the known list.

Respond with only the JSON array, wrapped in \`\`\`json code fences.`;
}
