import { describe, it, expect } from 'vitest';
import {
  slugify,
  buildNoteFilename,
  resolveAvailablePath,
  joinPath,
  normalizeFolder,
  kindToFolder,
  wikiContentFolders,
  layoutFromConfig,
  DEFAULT_LAYOUT,
  KIND_TO_FOLDER,
} from '../../src/vault/paths.js';
import { KarpathyConfigSchema, LayoutConfigSchema } from '../../src/config/schema.js';

describe('slugify', () => {
  it('lowercases and replaces non-alphanumeric chars', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
  });

  it('collapses multiple hyphens', () => {
    expect(slugify('foo---bar')).toBe('foo-bar');
  });

  it('strips leading/trailing hyphens', () => {
    expect(slugify('--hello--')).toBe('hello');
  });

  it('returns "untitled" for empty input', () => {
    expect(slugify('')).toBe('untitled');
    expect(slugify('   ')).toBe('untitled');
    expect(slugify('!!!')).toBe('untitled');
  });

  it('handles unicode characters', () => {
    expect(slugify('café résumé')).toBe('caf-r-sum');
  });
});

describe('buildNoteFilename', () => {
  it('creates a .md filename from title', () => {
    expect(buildNoteFilename('My Great Note')).toBe('my-great-note.md');
  });

  it('handles special characters', () => {
    expect(buildNoteFilename('Session 2026-04-11 #1')).toBe('session-2026-04-11-1.md');
  });
});

describe('resolveAvailablePath', () => {
  it('returns the initial path when no collision', () => {
    const existing = new Set<string>();
    expect(resolveAvailablePath('wiki/entities', 'alice.md', existing)).toBe(
      'wiki/entities/alice.md',
    );
  });

  it('adds suffix on collision', () => {
    const existing = new Set(['wiki/entities/alice.md']);
    expect(resolveAvailablePath('wiki/entities', 'alice.md', existing)).toBe(
      'wiki/entities/alice-2.md',
    );
  });

  it('increments suffix until unique', () => {
    const existing = new Set([
      'wiki/entities/alice.md',
      'wiki/entities/alice-2.md',
      'wiki/entities/alice-3.md',
    ]);
    expect(resolveAvailablePath('wiki/entities', 'alice.md', existing)).toBe(
      'wiki/entities/alice-4.md',
    );
  });
});

describe('joinPath', () => {
  it('joins folder and filename', () => {
    expect(joinPath('wiki/entities', 'test.md')).toBe('wiki/entities/test.md');
  });
});

describe('normalizeFolder', () => {
  it('strips trailing slashes', () => {
    expect(normalizeFolder('wiki/entities/')).toBe('wiki/entities');
  });

  it('trims whitespace', () => {
    expect(normalizeFolder('  wiki/entities  ')).toBe('wiki/entities');
  });
});

describe('layout (vault layout config)', () => {
  it('DEFAULT_LAYOUT preserves the historical folder names (backwards compat)', () => {
    expect(DEFAULT_LAYOUT.aiConversations).toBe('raw/ai-conversations');
    expect(DEFAULT_LAYOUT.aiSummaries).toBe('outputs/session-summaries');
    expect(DEFAULT_LAYOUT.aiLegacy).toBe('raw/legacy-sessions');
    expect(DEFAULT_LAYOUT.wiki).toBe('wiki');
    expect(DEFAULT_LAYOUT.sources).toBe('outputs/source-summaries');
    expect(DEFAULT_LAYOUT.review).toBe('review');
    expect(DEFAULT_LAYOUT.system).toBe('wiki/_system');
    expect(DEFAULT_LAYOUT.digests).toBe('wiki/digests');
  });

  it('LayoutConfigSchema parses an empty object into defaults', () => {
    const layout = LayoutConfigSchema.parse({});
    expect(layout).toEqual(DEFAULT_LAYOUT);
  });

  it('layoutFromConfig returns the config.layout block verbatim', () => {
    const config = KarpathyConfigSchema.parse({ vaultPath: '/tmp/test' });
    const layout = layoutFromConfig(config);
    expect(layout).toEqual(DEFAULT_LAYOUT);
  });

  it('respects user overrides for a single field', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/test',
      layout: { wiki: 'Curated/wiki' },
    });
    const layout = layoutFromConfig(config);
    expect(layout.wiki).toBe('Curated/wiki');
    // Other fields stay at their defaults
    expect(layout.review).toBe('review');
    expect(layout.aiConversations).toBe('raw/ai-conversations');
  });

  it('respects the full curated/AI-Conversations override (matches user spec)', () => {
    const config = KarpathyConfigSchema.parse({
      vaultPath: '/tmp/test',
      layout: {
        aiConversations: 'AI Conversations',
        aiSummaries: 'AI Conversations/_summaries',
        aiLegacy: 'AI Conversations/_legacy',
        wiki: 'Curated/wiki',
        sources: 'Curated/sources',
        review: 'Curated/review',
        system: 'Curated/_system',
        digests: 'Curated/wiki/digests',
      },
    });
    const layout = layoutFromConfig(config);
    expect(layout.aiConversations).toBe('AI Conversations');
    expect(layout.aiSummaries).toBe('AI Conversations/_summaries');
    expect(layout.wiki).toBe('Curated/wiki');
    expect(layout.sources).toBe('Curated/sources');
    expect(layout.review).toBe('Curated/review');
    expect(layout.system).toBe('Curated/_system');
  });
});

describe('kindToFolder', () => {
  it('returns layout-aware folder for each EntityKind under default layout', () => {
    expect(kindToFolder(DEFAULT_LAYOUT, 'person')).toBe('wiki/entities');
    expect(kindToFolder(DEFAULT_LAYOUT, 'project')).toBe('wiki/projects');
    expect(kindToFolder(DEFAULT_LAYOUT, 'concept')).toBe('wiki/concepts');
    expect(kindToFolder(DEFAULT_LAYOUT, 'decision')).toBe('wiki/decisions');
    expect(kindToFolder(DEFAULT_LAYOUT, 'tool')).toBe('wiki/tools');
    expect(kindToFolder(DEFAULT_LAYOUT, 'topic')).toBe('wiki/topics');
    expect(kindToFolder(DEFAULT_LAYOUT, 'organization')).toBe('wiki/organizations');
  });

  it('reflects a custom wiki prefix', () => {
    const layout = { ...DEFAULT_LAYOUT, wiki: 'Curated/wiki' };
    expect(kindToFolder(layout, 'person')).toBe('Curated/wiki/entities');
    expect(kindToFolder(layout, 'concept')).toBe('Curated/wiki/concepts');
  });
});

describe('KIND_TO_FOLDER (legacy export)', () => {
  it('preserves the historical mapping for backwards compat', () => {
    expect(KIND_TO_FOLDER.person).toBe('wiki/entities');
    expect(KIND_TO_FOLDER.project).toBe('wiki/projects');
    expect(KIND_TO_FOLDER.organization).toBe('wiki/organizations');
  });
});

describe('wikiContentFolders', () => {
  it('returns all linkable wiki folders for default layout', () => {
    const folders = wikiContentFolders(DEFAULT_LAYOUT);
    expect(folders).toContain('wiki/entities');
    expect(folders).toContain('wiki/concepts');
    expect(folders).toContain('outputs/source-summaries');
  });

  it('reflects a custom layout', () => {
    const layout = {
      ...DEFAULT_LAYOUT,
      wiki: 'Curated/wiki',
      sources: 'Curated/sources',
    };
    const folders = wikiContentFolders(layout);
    expect(folders).toContain('Curated/wiki/entities');
    expect(folders).toContain('Curated/wiki/concepts');
    expect(folders).toContain('Curated/sources');
    expect(folders).not.toContain('wiki/entities');
    expect(folders).not.toContain('outputs/source-summaries');
  });
});
