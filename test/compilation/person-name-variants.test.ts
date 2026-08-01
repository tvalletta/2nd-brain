import { describe, it, expect } from 'vitest';
import {
  personNameVariantScore,
  findNameVariantCandidatesForNewPage,
} from '../../src/compilation/person-name-variants.js';
import type { EntityIndex } from '../../src/ingest/entity-resolver.js';
import { DEFAULT_LAYOUT } from '../../src/vault/paths.js';

describe('personNameVariantScore', () => {
  it('scores the real Bryan/Pino case (substring tier, confidence 0.5)', () => {
    const result = personNameVariantScore('Bryan', [], 'Bryan Pino', ['pino']);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.5);
  });

  it('scores a nickname + matching surname (confidence 0.65)', () => {
    const result = personNameVariantScore('Matt Newman', [], 'Matthew Newman', []);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.65);
  });

  it('returns null for two genuinely different people (Grig vs Kevin Bement, from the real vault)', () => {
    expect(personNameVariantScore('Grig', [], 'Kevin Bement', [])).toBeNull();
  });

  it('returns null for two different bare handles (no containment, no surname to compare)', () => {
    expect(personNameVariantScore('brownf', [], 'bwhite', [])).toBeNull();
  });

  it('returns null for an exact-name match (handled upstream by resolveEntity)', () => {
    expect(personNameVariantScore('Bryan Pino', [], 'Bryan Pino', [])).toBeNull();
  });

  it('every non-null result is below AUTO_MERGE_THRESHOLD (0.85)', () => {
    const r1 = personNameVariantScore('Bryan', [], 'Bryan Pino', []);
    const r2 = personNameVariantScore('Matt Newman', [], 'Matthew Newman', []);
    expect(r1!.confidence).toBeLessThan(0.85);
    expect(r2!.confidence).toBeLessThan(0.85);
  });
});

describe('findNameVariantCandidatesForNewPage', () => {
  function makeIndex(entries: Array<{ name: string; path: string; aliases: string[] }>): EntityIndex {
    return {
      bySlug: new Map(),
      byCanonicalName: new Map(),
      byAlias: new Map(),
      byExternalId: new Map(),
      allEntries: entries.map((e) => ({ ...e, slug: e.name.toLowerCase() })),
    };
  }

  it('finds exactly one candidate against an existing fuller-named page', () => {
    const index = makeIndex([
      { name: 'Bryan Pino', path: 'wiki/entities/bryan-pino.md', aliases: ['pino'] },
    ]);

    const candidates = findNameVariantCandidatesForNewPage(index, DEFAULT_LAYOUT, {
      name: 'Bryan', path: 'wiki/entities/bryan.md', aliases: [],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourcePath).toBe('wiki/entities/bryan.md');
    expect(candidates[0].targetPath).toBe('wiki/entities/bryan-pino.md');
  });

  it('finds zero candidates when no plausible match exists', () => {
    const index = makeIndex([
      { name: 'Bryan Pino', path: 'wiki/entities/bryan-pino.md', aliases: ['pino'] },
    ]);

    const candidates = findNameVariantCandidatesForNewPage(index, DEFAULT_LAYOUT, {
      name: 'Zzyzx', path: 'wiki/entities/zzyzx.md', aliases: [],
    });

    expect(candidates).toHaveLength(0);
  });

  it('excludes the new page itself and skips non-person folders', () => {
    const index = makeIndex([
      { name: 'Bryan Pino', path: 'wiki/entities/bryan-pino.md', aliases: ['pino'] },
      { name: 'Bryan', path: 'wiki/concepts/bryan.md', aliases: [] }, // not a person page
    ]);

    const candidates = findNameVariantCandidatesForNewPage(index, DEFAULT_LAYOUT, {
      name: 'Bryan Pino', path: 'wiki/entities/bryan-pino.md', aliases: ['pino'], // itself
    });

    expect(candidates).toHaveLength(0);
  });
});
