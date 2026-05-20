import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { classifyCwd } from '../../src/ingest/cwd-classifier.js';

const HOME = homedir();

describe('classifyCwd', () => {
  describe('general paths', () => {
    it('classifies home directory as general', () => {
      const result = classifyCwd(HOME);
      expect(result.category).toBe('general');
      expect(result.slug).toBe('_general');
    });

    it('classifies Desktop as general', () => {
      const result = classifyCwd(`${HOME}/Desktop`);
      expect(result.category).toBe('general');
      expect(result.slug).toBe('_general');
    });

    it('classifies Documents as general', () => {
      const result = classifyCwd(`${HOME}/Documents`);
      expect(result.category).toBe('general');
      expect(result.slug).toBe('_general');
    });

    it('classifies Downloads as general', () => {
      const result = classifyCwd(`${HOME}/Downloads`);
      expect(result.category).toBe('general');
      expect(result.slug).toBe('_general');
    });

    it('strips trailing slashes', () => {
      const result = classifyCwd(`${HOME}/Desktop/`);
      expect(result.category).toBe('general');
    });
  });

  describe('discovery paths', () => {
    it('classifies paths with tmp segment as discovery', () => {
      const result = classifyCwd('/tmp/experiment-1');
      expect(result.category).toBe('discovery');
      expect(result.slug).toBe('_discovery');
    });

    it('classifies paths with test segment as discovery', () => {
      const result = classifyCwd(`${HOME}/dev/test`);
      expect(result.category).toBe('discovery');
      expect(result.slug).toBe('_discovery');
    });

    it('classifies paths with playground segment as discovery', () => {
      const result = classifyCwd(`${HOME}/dev/playground/react-test`);
      expect(result.category).toBe('discovery');
      expect(result.slug).toBe('_discovery');
    });

    it('classifies paths with scratch segment as discovery', () => {
      const result = classifyCwd(`${HOME}/scratch/quick-idea`);
      expect(result.category).toBe('discovery');
      expect(result.slug).toBe('_discovery');
    });

    it('classifies paths with sandbox segment as discovery', () => {
      const result = classifyCwd(`${HOME}/sandbox/prototype`);
      expect(result.category).toBe('discovery');
      expect(result.slug).toBe('_discovery');
    });

    it('is case-insensitive for discovery segments', () => {
      const result = classifyCwd(`${HOME}/dev/TMP/something`);
      expect(result.category).toBe('discovery');
    });
  });

  describe('project paths', () => {
    it('classifies dev directories as projects', () => {
      const result = classifyCwd(`${HOME}/dev/auth-redesign`);
      expect(result.category).toBe('project');
      expect(result.slug).toBe('auth-redesign');
      expect(result.name).toBe('auth-redesign');
    });

    it('uses basename as project name', () => {
      const result = classifyCwd('/Users/alice/projects/my-cool-app');
      expect(result.category).toBe('project');
      expect(result.slug).toBe('my-cool-app');
      expect(result.name).toBe('my-cool-app');
    });

    it('slugifies project names', () => {
      const result = classifyCwd('/Users/alice/My Cool Project');
      expect(result.category).toBe('project');
      expect(result.slug).toBe('my-cool-project');
    });

    it('handles deeply nested project paths', () => {
      const result = classifyCwd(`${HOME}/dev/work/adobe/karpathy`);
      expect(result.category).toBe('project');
      expect(result.slug).toBe('karpathy');
    });

    it('classifies this project correctly', () => {
      const result = classifyCwd(`${HOME}/dev/2nd-brain`);
      expect(result.category).toBe('project');
      expect(result.slug).toBe('2nd-brain');
    });
  });

  describe('edge cases', () => {
    it('handles empty cwd', () => {
      const result = classifyCwd('');
      expect(result).toBeDefined();
      expect(result.slug).toBeDefined();
    });

    it('handles root path', () => {
      const result = classifyCwd('/');
      expect(result).toBeDefined();
    });
  });
});
