import type { SynthesisSkill } from './types.js';

/**
 * Built-in synthesis skills seeded on first run.
 * These provide default processing strategies for common conversation types.
 */
export const BUILTIN_SKILLS: SynthesisSkill[] = [
  {
    id: 'general-qa',
    type: 'synthesis_skill',
    name: 'General Q&A',
    description: 'Process general question-and-answer conversations',
    patterns: ['question', 'how to', 'what is', 'explain', 'why does', 'can you tell me'],
    strategy: `Group questions by topic. For each distinct topic:
1. Check if a wiki/concepts/ or wiki/topics/ page exists for this topic
2. If it exists, update the definition or add new information from this conversation
3. If it doesn't exist, create a new concept or topic page
4. Extract any Q&A pairs that provide useful definitions or explanations
5. Link the topic page to related entities (tools, people, projects mentioned)`,
    confidence: 'high',
    review_state: 'approved',
    usage_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'tool-discovery',
    type: 'synthesis_skill',
    name: 'Tool Discovery',
    description: 'Process conversations about tools, libraries, and setup',
    patterns: ['install', 'configure', 'setup', 'tool', 'library', 'package', 'dependency', 'npm', 'pip'],
    strategy: `Extract tools, libraries, and techniques discussed:
1. For each tool/library mentioned, check wiki/tools/ for an existing page
2. Create or update tool pages with: what it does, how to install/configure, which projects use it
3. If comparing multiple tools, capture the comparison rationale
4. Link tool pages to relevant project hubs that use them
5. Note any configuration gotchas or best practices mentioned`,
    confidence: 'high',
    review_state: 'approved',
    usage_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'troubleshooting',
    type: 'synthesis_skill',
    name: 'Troubleshooting',
    description: 'Process debugging and error resolution conversations',
    patterns: ['error', 'bug', 'fix', 'debug', 'broken', 'crash', 'exception', 'stack trace', 'not working'],
    strategy: `Extract problem/solution pairs:
1. Identify the specific error or problem described
2. Capture the root cause if identified
3. Document the solution or workaround applied
4. Link to the project hub where this issue occurred
5. If the problem relates to a specific tool, update the tool's wiki page with the gotcha
6. Create or update relevant concept pages if the debugging revealed architectural insights`,
    confidence: 'high',
    review_state: 'approved',
    usage_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'learning',
    type: 'synthesis_skill',
    name: 'Learning',
    description: 'Process educational and concept-learning conversations',
    patterns: ['learn', 'understand', 'concept', 'tutorial', 'study', 'teach me', 'explain how'],
    strategy: `Extract concepts and create structured notes:
1. Identify the main concepts being learned
2. For each concept, create or update a wiki/concepts/ page
3. Capture definitions, mental models, and analogies used
4. Note prerequisites or related concepts
5. If code examples were provided, include them as illustrations
6. Link concepts to any tools or projects that use them`,
    confidence: 'high',
    review_state: 'approved',
    usage_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'code-exploration',
    type: 'synthesis_skill',
    name: 'Code Exploration',
    description: 'Process conversations about understanding codebases',
    patterns: ['how does', 'what does', 'codebase', 'architecture', 'code review', 'refactor', 'pattern'],
    strategy: `Document code patterns and architectural insights:
1. Identify which project's codebase is being explored
2. Update the project's technical sub-spec with architectural insights
3. Capture any design patterns, conventions, or anti-patterns discovered
4. If specific files or modules are discussed, note their purpose
5. Create concept pages for any design patterns or techniques explained
6. Link to relevant decision pages if architectural choices are discussed`,
    confidence: 'high',
    review_state: 'approved',
    usage_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];
