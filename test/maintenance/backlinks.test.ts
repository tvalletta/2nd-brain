import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import {
  extractOutlinks,
  extractLinkContext,
  updateBacklinksForFile,
  rebuildAllBacklinks,
} from '../../src/maintenance/backlinks.js';

describe('extractOutlinks', () => {
  it('extracts wikilinks from markdown', () => {
    const body = 'This links to [[Alice]] and [[Project Alpha|Alpha Project]].';
    expect(extractOutlinks(body)).toEqual(['Alice', 'Project Alpha']);
  });

  it('deduplicates links', () => {
    const body = '[[Alice]] is mentioned twice: [[Alice]].';
    expect(extractOutlinks(body)).toEqual(['Alice']);
  });

  it('returns empty for no links', () => {
    expect(extractOutlinks('No links here.')).toEqual([]);
  });
});

describe('extractLinkContext', () => {
  it('extracts surrounding sentence for a link', () => {
    const body = 'The project was started by [[alice-chen]]. She leads the team.';
    const context = extractLinkContext(body, 'alice-chen');
    expect(context).toContain('alice-chen');
    expect(context).not.toContain('[[');
    expect(context).not.toContain(']]');
  });

  it('strips wikilink syntax from context', () => {
    const body = '[[alice-chen]] is the tech lead for [[project-alpha]].';
    const context = extractLinkContext(body, 'alice-chen');
    expect(context).not.toContain('[[');
    expect(context).toContain('alice-chen');
    expect(context).toContain('project-alpha');
  });

  it('returns empty string when link is not found', () => {
    const body = 'No link here at all.';
    expect(extractLinkContext(body, 'missing')).toBe('');
  });

  it('returns empty for heading lines', () => {
    const body = '## About [[alice-chen]]\n\nSome content here.';
    expect(extractLinkContext(body, 'alice-chen')).toBe('');
  });

  it('trims long context to roughly 100 chars', () => {
    const longSentence =
      'This is a very long sentence that contains [[alice-chen]] and goes on and on with additional information that should be trimmed to keep the context concise and readable.';
    const context = extractLinkContext(longSentence, 'alice-chen');
    expect(context.length).toBeLessThanOrEqual(110);
  });

  it('handles aliased wikilinks in context', () => {
    const body = 'Discussed with [[alice-chen|Alice Chen]] about the project.';
    const context = extractLinkContext(body, 'alice-chen');
    expect(context).toContain('Alice Chen');
    expect(context).not.toContain('[[');
  });
});

describe('backlinks integration', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-bl-'));
    vault = createFsAdapter(tempDir);
    await vault.ensureFolder('wiki/entities');
    await vault.ensureFolder('wiki/sessions');
    await vault.ensureFolder('wiki/sources');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('adds backlink to linked page with context', async () => {
    await vault.create(
      'wiki/entities/alice.md',
      '---\ntitle: Alice\ntype: entity\nupdated_at: "2026-04-10"\n---\n# Alice\n\nWorks on [[project-alpha]] daily.\n\n## Backlinks\n%% begin:backlinks %%\n%% end:backlinks %%\n',
    );
    await vault.create(
      'wiki/entities/project-alpha.md',
      '---\ntitle: Project Alpha\ntype: project\nupdated_at: "2026-04-10"\n---\n# Project Alpha\n\n## Backlinks\n%% begin:backlinks %%\n%% end:backlinks %%\n',
    );

    const allPaths = await vault.listMarkdownFiles('wiki');
    await updateBacklinksForFile(vault, 'wiki/entities/alice.md', allPaths);

    const updatedContent = await vault.read('wiki/entities/project-alpha.md');
    expect(updatedContent).toContain('[[alice]]');
    expect(updatedContent).toContain('Works on project-alpha daily.');
    expect(updatedContent).toContain('entity');
    expect(updatedContent).toContain('2026-04-10');
    expect(updatedContent).toContain('### From Wiki');
  });

  it('groups backlinks by source type', async () => {
    await vault.create(
      'wiki/entities/alice.md',
      '---\ntitle: Alice\ntype: entity\nupdated_at: "2026-04-10"\n---\n# Alice\n\n## Backlinks\n%% begin:backlinks %%\n%% end:backlinks %%\n',
    );
    await vault.create(
      'wiki/sources/meeting.md',
      '---\ntitle: Meeting Notes\ntype: source_summary\nupdated_at: "2026-04-08"\n---\n# Meeting Notes\n\nDiscussed requirements with [[alice]].\n\n## Backlinks\n%% begin:backlinks %%\n%% end:backlinks %%\n',
    );
    await vault.create(
      'wiki/sessions/session-1.md',
      '---\ntitle: Session 1\ntype: session_summary\nupdated_at: "2026-04-09"\n---\n# Session 1\n\nRefactored auth per [[alice]] design.\n\n## Backlinks\n%% begin:backlinks %%\n%% end:backlinks %%\n',
    );
    await vault.create(
      'wiki/entities/project-alpha.md',
      '---\ntitle: Project Alpha\ntype: project\nupdated_at: "2026-04-10"\n---\n# Project Alpha\n\n[[alice]] is the tech lead.\n\n## Backlinks\n%% begin:backlinks %%\n%% end:backlinks %%\n',
    );

    await rebuildAllBacklinks(vault);

    const aliceContent = await vault.read('wiki/entities/alice.md');
    expect(aliceContent).toContain('### From Sources');
    expect(aliceContent).toContain('### From Sessions');
    expect(aliceContent).toContain('### From Wiki');
    expect(aliceContent).toContain('[[meeting]]');
    expect(aliceContent).toContain('[[session-1]]');
    expect(aliceContent).toContain('[[project-alpha]]');
  });

  it('rebuildAllBacklinks is idempotent', async () => {
    await vault.create(
      'wiki/entities/a.md',
      '---\ntitle: A\ntype: entity\nupdated_at: "2026-04-10"\n---\n# A\n\nLinks to [[b]].\n\n## Backlinks\n%% begin:backlinks %%\n%% end:backlinks %%\n',
    );
    await vault.create(
      'wiki/entities/b.md',
      '---\ntitle: B\ntype: entity\nupdated_at: "2026-04-10"\n---\n# B\n\n## Backlinks\n%% begin:backlinks %%\n%% end:backlinks %%\n',
    );

    const result1 = await rebuildAllBacklinks(vault);
    const content1 = await vault.read('wiki/entities/b.md');

    const result2 = await rebuildAllBacklinks(vault);
    const content2 = await vault.read('wiki/entities/b.md');

    expect(content1).toBe(content2);
    expect(result1.scanned).toBe(result2.scanned);
  });

  it('includes context in backlink entries', async () => {
    await vault.create(
      'wiki/entities/a.md',
      '---\ntitle: A\ntype: entity\nupdated_at: "2026-04-10"\n---\n# A\n\nLinks to [[b]].\n\n## Backlinks\n%% begin:backlinks %%\n%% end:backlinks %%\n',
    );
    await vault.create(
      'wiki/entities/b.md',
      '---\ntitle: B\ntype: entity\nupdated_at: "2026-04-10"\n---\n# B\n\n## Backlinks\n%% begin:backlinks %%\n%% end:backlinks %%\n',
    );

    await rebuildAllBacklinks(vault);

    const bContent = await vault.read('wiki/entities/b.md');
    // Should have contextual entry with quote
    expect(bContent).toContain('[[a]]');
    expect(bContent).toContain('Links to b.');
    expect(bContent).toContain('entity');
    expect(bContent).toContain('2026-04-10');
  });

  it('handles notes without type gracefully', async () => {
    await vault.create(
      'wiki/entities/a.md',
      '---\ntitle: A\n---\n# A\n\nLinks to [[b]].\n\n## Backlinks\n%% begin:backlinks %%\n%% end:backlinks %%\n',
    );
    await vault.create(
      'wiki/entities/b.md',
      '---\ntitle: B\n---\n# B\n\n## Backlinks\n%% begin:backlinks %%\n%% end:backlinks %%\n',
    );

    await rebuildAllBacklinks(vault);

    const bContent = await vault.read('wiki/entities/b.md');
    expect(bContent).toContain('[[a]]');
    // Should default to entity type and Wiki category
    expect(bContent).toContain('### From Wiki');
  });
});
