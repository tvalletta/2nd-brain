import { nanoid } from 'nanoid';
import type { JobHandler, Job, JobContext } from '../types.js';
import { loadSkills, matchSkill, writeSkill } from '../../agent/skills/registry.js';
import type { SynthesisSkill } from '../../agent/skills/types.js';
import { nowISO } from '../../shared/date-utils.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('handler:generate-synthesis-skills');

/**
 * Maintenance job that analyzes unmatched conversations and proposes new skills.
 *
 * Workflow:
 * 1. List conversations in _general/ and _discovery/ directories
 * 2. For each conversation, check if any existing skill matches
 * 3. Collect unmatched conversations
 * 4. Use LLM to identify recurring patterns among unmatched conversations
 * 5. Propose new skills as drafts (review_state: unreviewed)
 */
export const generateSynthesisSkillsHandler: JobHandler = {
  async execute(_job: Job, context: JobContext): Promise<void> {
    const { vault, llm } = context;
    const layout = context.config.layout;

    // Load existing skills
    const skills = await loadSkills(vault, layout);
    log.info('Loaded existing skills', { count: skills.length });

    // Find unmatched conversations in _general and _discovery (layout-aware)
    const ai = context.config.layout.aiConversations;
    const searchDirs = [
      `${ai}/claude/_general`,
      `${ai}/claude/_discovery`,
      `${ai}/cursor/_general`,
      `${ai}/cursor/_discovery`,
    ];

    const unmatchedSnippets: string[] = [];

    for (const dir of searchDirs) {
      let files: string[];
      try {
        files = await vault.listMarkdownFiles(dir);
      } catch {
        continue;
      }

      for (const path of files) {
        try {
          const content = await vault.read(path);
          const match = matchSkill(content, skills);
          if (!match) {
            // Take first 500 chars as a representative snippet
            const snippet = content.slice(0, 500);
            unmatchedSnippets.push(`[${path}]\n${snippet}`);
          }
        } catch {
          // Skip unreadable files
        }
      }
    }

    if (unmatchedSnippets.length === 0) {
      log.info('No unmatched conversations found');
      return;
    }

    log.info('Found unmatched conversations', { count: unmatchedSnippets.length });

    // Use LLM to propose new skills from unmatched conversations
    const sampleSnippets = unmatchedSnippets.slice(0, 10).join('\n\n---\n\n');

    const prompt = `You are analyzing conversation snippets that don't match any existing processing pattern.

Existing skills: ${skills.map((s) => `${s.name} (patterns: ${s.patterns.join(', ')})`).join('; ')}

Unmatched conversation snippets:
${sampleSnippets}

Based on these unmatched conversations, propose 1-3 new synthesis skills. For each skill, provide:
- name: A short descriptive name
- description: One sentence explaining what conversations this covers
- patterns: 5-8 keywords/phrases that identify this type of conversation
- strategy: 3-5 step strategy for how the agent should process these conversations

Respond in JSON format:
\`\`\`json
[
  {
    "name": "...",
    "description": "...",
    "patterns": ["...", "..."],
    "strategy": "1. ...\\n2. ...\\n3. ..."
  }
]
\`\`\``;

    try {
      const response = await llm.complete(prompt, { maxTokens: 2048, temperature: 0.5 });

      // Parse JSON from response
      const jsonMatch = response.match(/```json\s*([\s\S]*?)```/) ?? response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        log.warn('Could not parse LLM response for skill generation');
        return;
      }

      const jsonStr = jsonMatch[1] ?? jsonMatch[0];
      const proposals = JSON.parse(jsonStr) as Array<{
        name: string;
        description: string;
        patterns: string[];
        strategy: string;
      }>;

      const now = nowISO();
      let created = 0;

      for (const proposal of proposals) {
        const id = `generated-${nanoid(8)}`;
        const skill: SynthesisSkill = {
          id,
          type: 'synthesis_skill',
          name: proposal.name,
          description: proposal.description,
          patterns: proposal.patterns,
          strategy: proposal.strategy,
          confidence: 'low',
          review_state: 'unreviewed',
          usage_count: 0,
          created_at: now,
          updated_at: now,
        };

        await writeSkill(vault, skill, layout);
        created++;
        log.info('Proposed new skill', { id, name: proposal.name });
      }

      log.info('Skill generation complete', {
        unmatched: unmatchedSnippets.length,
        proposed: created,
      });
    } catch (err) {
      log.error('Failed to generate skills', { error: (err as Error).message });
    }
  },
};
