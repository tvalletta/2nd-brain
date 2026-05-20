import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../../src/vault/fs-adapter.js';
import {
  loadSkills,
  writeSkill,
  seedBuiltinSkills,
  matchSkill,
  recordSkillUsage,
} from '../../../src/agent/skills/registry.js';
import { BUILTIN_SKILLS } from '../../../src/agent/skills/builtin.js';
import type { SynthesisSkill } from '../../../src/agent/skills/types.js';
import { parseNote } from '../../../src/vault/frontmatter.js';

describe('skills registry', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-skills-'));
    vault = createFsAdapter(tempDir);
    await vault.ensureFolder('wiki/_system/skills');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('writeSkill / loadSkills', () => {
    it('writes and reads back a skill', async () => {
      const skill: SynthesisSkill = {
        id: 'test-skill',
        type: 'synthesis_skill',
        name: 'Test Skill',
        description: 'A test skill',
        patterns: ['test', 'demo'],
        strategy: '1. Do stuff\n2. More stuff',
        confidence: 'medium',
        review_state: 'approved',
        usage_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };

      const path = await writeSkill(vault, skill);
      expect(path).toBe('wiki/_system/skills/test-skill.md');

      const skills = await loadSkills(vault);
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('Test Skill');
      expect(skills[0].patterns).toEqual(['test', 'demo']);
    });

    it('skips rejected skills when loading', async () => {
      const approved: SynthesisSkill = {
        id: 'good',
        type: 'synthesis_skill',
        name: 'Good Skill',
        description: 'Approved',
        patterns: ['good'],
        strategy: 'Do good things',
        confidence: 'high',
        review_state: 'approved',
        usage_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };

      const rejected: SynthesisSkill = {
        id: 'bad',
        type: 'synthesis_skill',
        name: 'Bad Skill',
        description: 'Rejected',
        patterns: ['bad'],
        strategy: 'Do bad things',
        confidence: 'low',
        review_state: 'rejected',
        usage_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };

      await writeSkill(vault, approved);
      await writeSkill(vault, rejected);

      const skills = await loadSkills(vault);
      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('good');
    });

    it('returns empty array when no skills directory exists', async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), 'karpathy-empty-'));
      const emptyVault = createFsAdapter(emptyDir);

      const skills = await loadSkills(emptyVault);
      expect(skills).toHaveLength(0);

      await rm(emptyDir, { recursive: true, force: true });
    });
  });

  describe('seedBuiltinSkills', () => {
    it('seeds all built-in skills', async () => {
      const count = await seedBuiltinSkills(vault);
      expect(count).toBe(BUILTIN_SKILLS.length);

      const skills = await loadSkills(vault);
      expect(skills.length).toBe(BUILTIN_SKILLS.length);

      const names = skills.map((s) => s.name).sort();
      const expected = BUILTIN_SKILLS.map((s) => s.name).sort();
      expect(names).toEqual(expected);
    });

    it('does not re-seed existing skills', async () => {
      await seedBuiltinSkills(vault);
      const count = await seedBuiltinSkills(vault);
      expect(count).toBe(0);
    });
  });

  describe('matchSkill', () => {
    it('matches skill with highest score', () => {
      const skills = BUILTIN_SKILLS;

      // Content with many troubleshooting patterns
      const content = 'I have a bug in my code. There is an error when I try to debug the fix.';
      const match = matchSkill(content, skills);

      expect(match).not.toBeNull();
      expect(match!.skill.id).toBe('troubleshooting');
      expect(match!.matchCount).toBeGreaterThanOrEqual(3);
    });

    it('matches learning skill', () => {
      const skills = BUILTIN_SKILLS;
      const content = 'I want to learn about this concept. Can you explain how it works? I want to understand the tutorial.';
      const match = matchSkill(content, skills);

      expect(match).not.toBeNull();
      expect(match!.skill.id).toBe('learning');
    });

    it('matches tool discovery skill', () => {
      const skills = BUILTIN_SKILLS;
      const content = 'How do I install this package? I need to configure the tool and set up the dependency.';
      const match = matchSkill(content, skills);

      expect(match).not.toBeNull();
      expect(match!.skill.id).toBe('tool-discovery');
    });

    it('returns null when no patterns match', () => {
      const skills = BUILTIN_SKILLS;
      const content = 'The weather is nice today.';
      const match = matchSkill(content, skills);

      expect(match).toBeNull();
    });

    it('returns null when score is below threshold', () => {
      const skills = BUILTIN_SKILLS;
      // Only one pattern match out of many — may be below threshold
      const content = 'Something about a question.';
      const match = matchSkill(content, skills, 0.9);

      expect(match).toBeNull();
    });

    it('handles empty skills array', () => {
      const match = matchSkill('any content', []);
      expect(match).toBeNull();
    });
  });

  describe('recordSkillUsage', () => {
    it('increments usage count', async () => {
      await seedBuiltinSkills(vault);

      await recordSkillUsage(vault, 'general-qa');
      await recordSkillUsage(vault, 'general-qa');

      const skills = await loadSkills(vault);
      const qa = skills.find((s) => s.id === 'general-qa');
      expect(qa!.usage_count).toBe(2);
    });

    it('silently skips nonexistent skill', async () => {
      // Should not throw
      await recordSkillUsage(vault, 'nonexistent');
    });
  });
});
