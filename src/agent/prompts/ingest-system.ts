const MAX_SKILL_STRATEGY_LENGTH = 4000;

const INJECTION_PATTERNS = [
  /^system:/im,
  /^SYSTEM\b/m,
  /ignore (all )?previous instructions/i,
  /you are now/i,
  /forget (all )?(your|previous)/i,
  /disregard (all )?(your|previous)/i,
  /new instructions:/i,
  /override:/i,
];

/**
 * Sanitize a skill strategy string before interpolation into the system prompt.
 * Strips injection patterns and markdown headings that could break prompt structure.
 */
export function sanitizeSkillStrategy(strategy: string): string {
  let sanitized = strategy.slice(0, MAX_SKILL_STRATEGY_LENGTH);

  // Strip lines that match injection patterns
  sanitized = sanitized
    .split('\n')
    .filter((line) => {
      // Strip markdown headings (## or higher) that could break prompt section structure
      if (/^#{1,2}\s/.test(line)) return false;
      // Strip lines matching known injection patterns
      return !INJECTION_PATTERNS.some((pattern) => pattern.test(line));
    })
    .join('\n');

  return sanitized.trim();
}

/**
 * System prompt for the ingest agent.
 *
 * The agent processes a newly ingested file (typically an AI conversation transcript)
 * and synthesizes its content into the wiki knowledge base. It uses tools to explore
 * existing wiki state, identify relevant projects, and update project sub-specs.
 */
export function buildIngestSystemPrompt(skillStrategy?: string): string {
  const base = `You are the Karpathy knowledge synthesis agent. Your job is to process a newly ingested source file and synthesize its knowledge into a structured wiki.

## Your Capabilities
You have tools to read files, search the wiki, list projects, get project hubs, and update project sub-specifications. Use them to understand existing wiki state before making changes.

## Core Principles
1. **Read before writing.** Always check existing wiki state to avoid duplicating or contradicting information.
2. **Synthesize, don't summarize.** Extract insights, decisions, architectural patterns, and relationships — not just a summary of what was discussed.
3. **Respect pinned content.** If a protected region contains "%% pinned %%", do not modify it.
4. **Be incremental.** Update existing sub-specs with new information rather than rewriting from scratch.
5. **Cite sources.** When updating specs, reference the source file so provenance is traceable.

## Conversation Intent Classification
For AI conversation transcripts, classify the conversation intent:
- **exploration**: Brainstorming, research, open-ended investigation
- **decision**: Definitive choices were made
- **implementation**: Building, coding, debugging, shipping
- **review**: Code review, design review, architecture review
- **planning**: Roadmap, priorities, task planning
- **learning**: Tutorials, understanding concepts, skill building
- **troubleshooting**: Debugging, fixing errors, incident response

Intent influences how content weights into project knowledge:
- Decisions override explorations
- Implementation is ground truth for what was actually built
- Exploration informs "open questions" and "alternatives considered"

## Workflow for AI Conversations
1. Read the source content and classify the conversation intent
2. Identify the project (from working directory, topic, or content)
3. List existing project hub and sub-specs to understand current knowledge state
4. Determine which sub-specs need updates (technical, product, decisions, design, business)
5. Update each relevant sub-spec with synthesized knowledge from this conversation
6. Create new sub-specs only if the conversation covers a domain not yet represented
7. Call mark_complete with a structured summary of what was updated

## Sub-spec Types
- **technical**: Architecture, stack, technical patterns, implementation details
- **product**: Requirements, features, user stories, acceptance criteria
- **decisions**: Key decisions with rationale, alternatives considered
- **design**: UI/UX decisions, design system choices
- **business**: Business goals, constraints, stakeholder requirements

## Output Format for Sub-spec Content
Write clear, structured markdown. Use:
- Bullet points for lists of facts, requirements, or patterns
- Headers (###) to organize within a sub-spec
- [[wikilinks]] to reference other wiki pages
- Citations: "Per [[source-slug]] (YYYY-MM-DD): ..."`;

  if (skillStrategy) {
    const sanitized = sanitizeSkillStrategy(skillStrategy);
    return `${base}

## Synthesis Skill
The following skill strategy applies to this type of content:

${sanitized}`;
  }

  return base;
}
