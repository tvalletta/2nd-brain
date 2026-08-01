import { describe, it, expect } from 'vitest';
import {
  stripHonorifics,
  NICKNAME_GROUPS,
  firstNamesEquivalent,
  initialsMatch,
  looksLikeBareHandleOrFirstName,
} from '../../src/ingest/name-variants.js';

describe('name-variants', () => {
  describe('stripHonorifics', () => {
    it('strips a leading honorific with a period', () => {
      expect(stripHonorifics('Dr. Sarah Chen')).toBe('Sarah Chen');
    });

    it('strips a leading honorific case-insensitively and without a period', () => {
      expect(stripHonorifics('mr John Smith')).toBe('John Smith');
    });

    it('strips every documented trailing suffix form', () => {
      expect(stripHonorifics('Sarah Chen Jr.')).toBe('Sarah Chen');
      expect(stripHonorifics('Sarah Chen Sr.')).toBe('Sarah Chen');
      expect(stripHonorifics('Sarah Chen PhD')).toBe('Sarah Chen');
      expect(stripHonorifics('Sarah Chen MD')).toBe('Sarah Chen');
      expect(stripHonorifics('Sarah Chen Esq.')).toBe('Sarah Chen');
    });

    it('strips every documented leading prefix form', () => {
      expect(stripHonorifics('Mrs. Jane Doe')).toBe('Jane Doe');
      expect(stripHonorifics('Ms. Jane Doe')).toBe('Jane Doe');
      expect(stripHonorifics('Miss Jane Doe')).toBe('Jane Doe');
      expect(stripHonorifics('Prof. Jane Doe')).toBe('Jane Doe');
      expect(stripHonorifics('Sir Jane Doe')).toBe('Jane Doe');
      expect(stripHonorifics('Rev. Jane Doe')).toBe('Jane Doe');
    });

    it('is a no-op for a name with no honorific', () => {
      expect(stripHonorifics('Bryan Pino')).toBe('Bryan Pino');
    });
  });

  describe('firstNamesEquivalent', () => {
    it('is true for exact matches', () => {
      expect(firstNamesEquivalent('matt', 'matt')).toBe(true);
    });

    it('is true for documented nickname/spelling-variant group pairs', () => {
      expect(firstNamesEquivalent('matt', 'matthew')).toBe(true);
      expect(firstNamesEquivalent('bryan', 'brian')).toBe(true);
      expect(firstNamesEquivalent('bob', 'robert')).toBe(true);
      expect(firstNamesEquivalent('liz', 'elizabeth')).toBe(true);
    });

    it('is false for names in different groups', () => {
      expect(firstNamesEquivalent('matt', 'mike')).toBe(false);
      expect(firstNamesEquivalent('grig', 'gagik')).toBe(false);
    });

    it('is false for a name not in any group', () => {
      expect(firstNamesEquivalent('zephyr', 'matt')).toBe(false);
    });
  });

  describe('initialsMatch', () => {
    it('matches a bare initial (with or without a trailing period) against the first letter of a longer token', () => {
      expect(initialsMatch('J', 'John')).toBe(true);
      expect(initialsMatch('J.', 'John')).toBe(true);
    });

    it('is false when the letters differ', () => {
      expect(initialsMatch('K', 'John')).toBe(false);
    });

    it('is false for an empty short token', () => {
      expect(initialsMatch('', 'John')).toBe(false);
    });

    it('is false when the "short" token is itself more than one letter', () => {
      expect(initialsMatch('Jo', 'John')).toBe(false);
    });
  });

  describe('looksLikeBareHandleOrFirstName', () => {
    it('is true for a single token (bare first name or handle)', () => {
      expect(looksLikeBareHandleOrFirstName('Bryan')).toBe(true);
      expect(looksLikeBareHandleOrFirstName('pvaughn')).toBe(true);
    });

    it('is false for a multi-token "First Last" name', () => {
      expect(looksLikeBareHandleOrFirstName('Bryan Pino')).toBe(false);
    });

    it('is false for an empty or whitespace-only string', () => {
      expect(looksLikeBareHandleOrFirstName('')).toBe(false);
      expect(looksLikeBareHandleOrFirstName('   ')).toBe(false);
    });
  });

  it('NICKNAME_GROUPS is exported for config-driven extension (enrichment.personResolution.extraNicknameGroups)', () => {
    expect(NICKNAME_GROUPS.some((g) => g.includes('bryan') && g.includes('brian'))).toBe(true);
  });
});
