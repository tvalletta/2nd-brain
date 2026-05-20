import type { VaultAdapter } from '../../vault/adapter.js';
import { parseNote, serializeNote } from '../../vault/frontmatter.js';
import { SynthesisSkillSchema, type SynthesisSkill, type SkillMatch } from './types.js';
import { BUILTIN_SKILLS } from './builtin.js';
import { nowISO } from '../../shared/date-utils.js';
import { createLogger } from '../../shared/logger.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../../vault/paths.js';

const log = createLogger('skills');

/** Layout-aware skills directory. Defaults to legacy `wiki/_system/skills`. */
function skillsDir(layout: VaultLayout = DEFAULT_LAYOUT): string {
  return `${layout.system}/skills`;
}

/**
 * Load all synthesis skills from the vault.
 * Returns only approved or unreviewed skills (not rejected).
 */
export async function loadSkills(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<SynthesisSkill[]> {
  const dir = skillsDir(layout);
  let files: string[];
  try {
    files = await vault.listMarkdownFiles(dir);
  } catch {
    return [];
  }

  const skills: SynthesisSkill[] = [];

  for (const path of files) {
    try {
      const content = await vault.read(path);
      const { data } = parseNote(content);
      const result = SynthesisSkillSchema.safeParse(data);
      if (result.success) {
        // Skip rejected skills
        if (result.data.review_state !== 'rejected') {
          skills.push(result.data);
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return skills;
}

/**
 * Write a synthesis skill to the vault.
 */
export async function writeSkill(
  vault: VaultAdapter,
  skill: SynthesisSkill,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<string> {
  const dir = skillsDir(layout);
  await vault.ensureFolder(dir);
  const path = `${dir}/${skill.id}.md`;

  const frontmatter: Record<string, unknown> = { ...skill };

  const body = `
# ${skill.name}

## Description
${skill.description}

## When to Apply
This skill applies when the conversation content matches these patterns: ${skill.patterns.join(', ')}

## Strategy
${skill.strategy}
`;

  const content = serializeNote(frontmatter, body);
  await vault.atomicWrite(path, content);

  log.info('Skill written', { id: skill.id, path });
  return path;
}

/**
 * Seed built-in skills into the vault if they don't already exist.
 * Called on first agent run or via CLI.
 */
export async function seedBuiltinSkills(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<number> {
  const dir = skillsDir(layout);
  await vault.ensureFolder(dir);
  let seeded = 0;

  for (const skill of BUILTIN_SKILLS) {
    const path = `${dir}/${skill.id}.md`;
    if (await vault.exists(path)) continue;

    await writeSkill(vault, skill, layout);
    seeded++;
  }

  if (seeded > 0) {
    log.info('Seeded built-in skills', { count: seeded });
  }

  return seeded;
}

/**
 * Match skills against content. Returns the best matching skill, or null.
 *
 * Matching logic:
 * 1. For each skill, count how many of its patterns appear in the content
 * 2. Compute a score: matchCount / totalPatterns
 * 3. Return the skill with the highest score, if it exceeds a minimum threshold
 */
export function matchSkill(
  content: string,
  skills: SynthesisSkill[],
  minScore: number = 0.2,
): SkillMatch | null {
  const lower = content.toLowerCase();
  let bestMatch: SkillMatch | null = null;

  for (const skill of skills) {
    let matchCount = 0;
    for (const pattern of skill.patterns) {
      if (lower.includes(pattern.toLowerCase())) {
        matchCount++;
      }
    }

    if (matchCount === 0) continue;

    const score = matchCount / skill.patterns.length;
    if (score < minScore) continue;

    if (!bestMatch || score > bestMatch.score || (score === bestMatch.score && matchCount > bestMatch.matchCount)) {
      bestMatch = { skill, matchCount, score };
    }
  }

  return bestMatch;
}

/**
 * Increment usage count for a skill.
 */
export async function recordSkillUsage(
  vault: VaultAdapter,
  skillId: string,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<void> {
  const path = `${skillsDir(layout)}/${skillId}.md`;
  if (!(await vault.exists(path))) return;

  try {
    const content = await vault.read(path);
    const { data, body } = parseNote(content);
    data.usage_count = ((data.usage_count as number) ?? 0) + 1;
    data.updated_at = nowISO();
    const updated = serializeNote(data, body);
    await vault.atomicWrite(path, updated);
  } catch {
    // Non-critical — skip silently
  }
}
