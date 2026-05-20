import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { createSessionLogManager } from '../../src/session/session-log.js';
import { createHotCacheManager } from '../../src/session/hot-cache.js';
import { serializeNote } from '../../src/vault/frontmatter.js';
import type { MCPContext } from '../../src/mcp/context.js';
import { KarpathyConfigSchema } from '../../src/config/schema.js';

import { handle as handleGetHotCache } from '../../src/mcp/tools/get-hot-cache.js';
import { handle as handleSearchVault } from '../../src/mcp/tools/search-vault.js';
import { handle as handleGetNote } from '../../src/mcp/tools/get-note.js';
import { handle as handleGetRecentSessions } from '../../src/mcp/tools/get-recent-sessions.js';
import { handle as handleGetEntity } from '../../src/mcp/tools/get-entity.js';
import { handle as handleSearchEntities } from '../../src/mcp/tools/search-entities.js';
import { handle as handleGetDecisions } from '../../src/mcp/tools/get-decisions.js';
import { handle as handleGetReviewQueue } from '../../src/mcp/tools/get-review-queue.js';
import { handle as handleLogSessionSummary } from '../../src/mcp/tools/log-session-summary.js';
import { handle as handleLogInsight } from '../../src/mcp/tools/log-insight.js';
import { handle as handleRunMaintenance } from '../../src/mcp/tools/run-maintenance.js';
import { handle as handleUpdateNote } from '../../src/mcp/tools/update-note.js';
import { handle as handleGetBacklinks } from '../../src/mcp/tools/get-backlinks.js';
import { handle as handleLintVault } from '../../src/mcp/tools/lint-vault.js';
import { handle as handleBatchGetNotes } from '../../src/mcp/tools/batch-get-notes.js';
import { handle as handleVaultStatus } from '../../src/mcp/tools/vault-status.js';
import { handle as handleSearchByTags } from '../../src/mcp/tools/search-by-tags.js';

const SAMPLE_CLAUDE_MD = `# Karpathy Second Memory

## Active Context
%% begin:active-context %%
Working on MCP server.
%% end:active-context %%

## Recent Sessions
%% begin:recent-sessions %%
- 2026-04-10: Built job queue ([[session-2026-04-10-001]])
%% end:recent-sessions %%

## Key Entities
%% begin:key-entities %%
[[wiki/entities/alice-chen]] — Senior engineer
%% end:key-entities %%

## Quick Links
%% begin:quick-links %%
%% end:quick-links %%
`;

function makeCtx(tempDir: string): MCPContext {
  const vault = createFsAdapter(tempDir);
  // KarpathyConfigSchema fills in all defaults (including `layout`) so tests
  // exercise the same code path production does.
  const config = KarpathyConfigSchema.parse({
    vaultPath: tempDir,
    projectRoot: tempDir,
  });
  return {
    config,
    vault,
    sessionLog: createSessionLogManager(vault, config.layout),
    hotCache: createHotCacheManager(join(tempDir, 'CLAUDE.md')),
    usageLogPath: join(tempDir, '.karpathy', 'logs', 'mcp-usage.jsonl'),
    runDeterministicJobs: async () => 0,
  };
}

describe('MCP Tool Handlers', () => {
  let tempDir: string;
  let ctx: MCPContext;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-mcp-'));
    ctx = makeCtx(tempDir);

    // Set up vault structure
    for (const dir of [
      'wiki/entities', 'wiki/projects', 'wiki/decisions', 'wiki/concepts',
      'wiki/notes', 'outputs/session-summaries', 'outputs/source-summaries',
      'review', 'raw',
    ]) {
      await mkdir(join(tempDir, dir), { recursive: true });
    }
    await writeFile(join(tempDir, 'CLAUDE.md'), SAMPLE_CLAUDE_MD, 'utf-8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // --- get_hot_cache ---

  it('get_hot_cache returns CLAUDE.md content', async () => {
    const result = await handleGetHotCache({}, ctx);
    expect(result.content[0].text).toContain('Karpathy Second Memory');
    expect(result.content[0].text).toContain('Built job queue');
  });

  // --- search_vault ---

  it('search_vault finds matching notes', async () => {
    const note = serializeNote(
      { id: 'n1', type: 'entity', title: 'Alice Chen', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Alice Chen\nSenior engineer on the platform team.',
    );
    await writeFile(join(tempDir, 'wiki/entities/alice-chen.md'), note, 'utf-8');

    const result = await handleSearchVault({ query: 'platform team' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('Alice Chen');
  });

  it('search_vault returns empty for no match', async () => {
    const result = await handleSearchVault({ query: 'nonexistent-xyz' }, ctx);
    expect(result.content[0].text).toContain('No results found');
  });

  // --- get_note ---

  it('get_note reads by path', async () => {
    const note = serializeNote(
      { id: 'n2', type: 'concept', title: 'Zero Trust', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Zero Trust\nNever trust, always verify.',
    );
    await writeFile(join(tempDir, 'wiki/concepts/zero-trust.md'), note, 'utf-8');

    const result = await handleGetNote({ path: 'wiki/concepts/zero-trust.md' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.frontmatter.title).toBe('Zero Trust');
    expect(parsed.body).toContain('Never trust');
  });

  it('get_note searches by title', async () => {
    const note = serializeNote(
      { id: 'n3', type: 'entity', title: 'Bob Martinez', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Bob Martinez\nBackend engineer.',
    );
    await writeFile(join(tempDir, 'wiki/entities/bob-martinez.md'), note, 'utf-8');

    const result = await handleGetNote({ title: 'Bob Martinez' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.frontmatter.title).toBe('Bob Martinez');
  });

  // --- get_recent_sessions ---

  it('get_recent_sessions lists sessions sorted by date', async () => {
    for (const [id, date] of [['s1', '2026-04-09'], ['s2', '2026-04-10'], ['s3', '2026-04-11']]) {
      const note = serializeNote(
        { id, type: 'session_summary', title: `Session ${date}`, status: 'active', created_at: `${date}T12:00:00Z`, updated_at: `${date}T12:00:00Z`, session_id: id, prompt_summary: '', outcome_summary: `Work on ${date}`, files_changed: [], source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'hook_capture', protected_regions: [] },
        `# Session ${date}`,
      );
      await writeFile(join(tempDir, `outputs/session-summaries/session-${date}.md`), note, 'utf-8');
    }

    const result = await handleGetRecentSessions({ count: 2 }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].created_at).toContain('2026-04-11');
    expect(parsed[1].created_at).toContain('2026-04-10');
  });

  // --- get_entity ---

  it('get_entity finds by name', async () => {
    const note = serializeNote(
      { id: 'e1', type: 'entity', title: 'Alice Chen', status: 'active', entity_kind: 'person', canonical_name: 'Alice Chen', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Alice Chen\nSenior engineer.',
    );
    await writeFile(join(tempDir, 'wiki/entities/alice-chen.md'), note, 'utf-8');

    const result = await handleGetEntity({ name: 'Alice Chen' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.frontmatter.entity_kind).toBe('person');
  });

  // --- search_entities ---

  it('search_entities filters by kind', async () => {
    const person = serializeNote(
      { id: 'p1', type: 'entity', title: 'Alice', status: 'active', entity_kind: 'person', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Alice',
    );
    const tool = serializeNote(
      { id: 't1', type: 'entity', title: 'Docker', status: 'active', entity_kind: 'tool', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Docker',
    );
    await writeFile(join(tempDir, 'wiki/entities/alice.md'), person, 'utf-8');
    await writeFile(join(tempDir, 'wiki/entities/docker.md'), tool, 'utf-8');

    const result = await handleSearchEntities({ kind: 'person' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('Alice');
  });

  // --- get_decisions ---

  it('get_decisions lists decisions', async () => {
    const dec = serializeNote(
      { id: 'd1', type: 'decision', title: 'Use MCP', status: 'active', decision_status: 'accepted', decision_date: '2026-04-10', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Use MCP\nChose MCP over REST.',
    );
    await writeFile(join(tempDir, 'wiki/decisions/use-mcp.md'), dec, 'utf-8');

    const result = await handleGetDecisions({}, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('Use MCP');
  });

  // --- get_review_queue ---

  it('get_review_queue returns empty when no reviews', async () => {
    const result = await handleGetReviewQueue({}, ctx);
    expect(result.content[0].text).toContain('empty');
  });

  // --- log_session_summary ---

  it('log_session_summary creates session note and updates hot cache', async () => {
    const result = await handleLogSessionSummary({
      summary: 'Added MCP server to Karpathy',
      files_changed: ['src/mcp/server.ts'],
      decisions: ['Used stdio transport'],
      cwd: '/tmp/dev',
      source: 'cursor',
    }, ctx);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.message).toContain('logged');

    // Verify note was created
    const files = await ctx.vault.listMarkdownFiles('outputs/session-summaries');
    expect(files.length).toBe(1);
    const content = await ctx.vault.read(files[0]);
    expect(content).toContain('Added MCP server');
    expect(content).toContain('src/mcp/server.ts');
    expect(content).toContain('Used stdio transport');

    // Verify hot cache was updated
    const hotCache = await ctx.hotCache.toContext();
    expect(hotCache).toContain('Added MCP server');
  });

  // --- log_insight ---

  it('log_insight creates entity note', async () => {
    const result = await handleLogInsight({
      title: 'Alex Rivera',
      content: 'Frontend architect working on AI tooling.',
      type: 'entity',
      entity_kind: 'person',
    }, ctx);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.path).toContain('wiki/entities');

    const content = await ctx.vault.read(parsed.path);
    expect(content).toContain('Alex Rivera');
    expect(content).toContain('Frontend architect');
  });

  it('log_insight creates decision note', async () => {
    const result = await handleLogInsight({
      title: 'Adopt MCP for vault access',
      content: 'MCP provides bidirectional context for both Cursor and Claude Code.',
      type: 'decision',
    }, ctx);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.path).toContain('wiki/decisions');
  });

  // --- run_maintenance ---

  it('run_maintenance returns job count', async () => {
    const result = await handleRunMaintenance({}, ctx);
    expect(result.content[0].text).toContain('Maintenance complete');
  });

  // --- update_note ---

  it('update_note merges frontmatter and preserves protected regions', async () => {
    const note = serializeNote(
      { id: 'u1', type: 'entity', title: 'Alice Chen', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: ['backlinks'] },
      '\n# Alice Chen\n\nSenior engineer.\n\n## Backlinks\n%% begin:backlinks %%\n- [[Bob Martinez]]\n%% end:backlinks %%\n',
    );
    await writeFile(join(tempDir, 'wiki/entities/alice-chen.md'), note, 'utf-8');

    const result = await handleUpdateNote({
      path: 'wiki/entities/alice-chen.md',
      frontmatter_updates: { status: 'archived' },
      content: 'Alice Chen is a principal engineer on platform.',
    }, ctx);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.message).toBe('Note updated.');

    const updated = await ctx.vault.read('wiki/entities/alice-chen.md');
    expect(updated).toContain('status: archived');
    expect(updated).toContain('principal engineer');
    // Protected region preserved
    expect(updated).toContain('[[Bob Martinez]]');
    expect(updated).toContain('%% begin:backlinks %%');
  });

  it('update_note appends content when append=true', async () => {
    const note = serializeNote(
      { id: 'u2', type: 'concept', title: 'Zero Trust', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '\n# Zero Trust\n\nNever trust, always verify.\n',
    );
    await writeFile(join(tempDir, 'wiki/concepts/zero-trust.md'), note, 'utf-8');

    await handleUpdateNote({
      path: 'wiki/concepts/zero-trust.md',
      content: '## Implementation Notes\n\nUse mTLS between all services.',
      append: true,
    }, ctx);

    const updated = await ctx.vault.read('wiki/concepts/zero-trust.md');
    expect(updated).toContain('Never trust, always verify');
    expect(updated).toContain('Use mTLS between all services');
  });

  it('update_note rejects overwriting id or created_at', async () => {
    const note = serializeNote(
      { id: 'u3', type: 'concept', title: 'Test', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '\n# Test\n',
    );
    await writeFile(join(tempDir, 'wiki/concepts/test.md'), note, 'utf-8');

    await handleUpdateNote({
      path: 'wiki/concepts/test.md',
      frontmatter_updates: { id: 'overwritten', created_at: '1999-01-01' },
    }, ctx);

    const updated = await ctx.vault.read('wiki/concepts/test.md');
    expect(updated).toContain('id: u3');
    expect(updated).toContain("created_at: '2026-04-10'");
  });

  // --- get_backlinks ---

  it('get_backlinks finds notes that link to target', async () => {
    const alice = serializeNote(
      { id: 'bl1', type: 'entity', title: 'Alice Chen', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Alice Chen\nSenior engineer.',
    );
    const bob = serializeNote(
      { id: 'bl2', type: 'entity', title: 'Bob Martinez', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Bob Martinez\nWorks with [[alice-chen]] on platform.',
    );
    await writeFile(join(tempDir, 'wiki/entities/alice-chen.md'), alice, 'utf-8');
    await writeFile(join(tempDir, 'wiki/entities/bob-martinez.md'), bob, 'utf-8');

    const result = await handleGetBacklinks({ title: 'Alice Chen' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('Bob Martinez');
  });

  it('get_backlinks returns empty for unlinked note', async () => {
    const orphan = serializeNote(
      { id: 'bl3', type: 'entity', title: 'Orphan', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Orphan\nNo one links to me.',
    );
    await writeFile(join(tempDir, 'wiki/entities/orphan.md'), orphan, 'utf-8');

    const result = await handleGetBacklinks({ title: 'Orphan' }, ctx);
    expect(result.content[0].text).toContain('No backlinks found');
  });

  // --- lint_vault ---

  it('lint_vault finds broken links', async () => {
    const note = serializeNote(
      { id: 'lv1', type: 'entity', title: 'Alice', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Alice\nShe works with [[nonexistent-person]] on [[ghost-project]].',
    );
    await writeFile(join(tempDir, 'wiki/entities/alice.md'), note, 'utf-8');

    const result = await handleLintVault({ checks: ['broken_links'] }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.length).toBeGreaterThanOrEqual(1);
    expect(parsed.findings[0].check).toBe('broken_links');
    expect(parsed.findings[0].message).toContain('nonexistent-person');
  });

  it('lint_vault finds empty notes', async () => {
    const note = serializeNote(
      { id: 'lv2', type: 'concept', title: 'Empty', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: ['backlinks'] },
      '\n# Empty\n\n## Backlinks\n%% begin:backlinks %%\n%% end:backlinks %%\n',
    );
    await writeFile(join(tempDir, 'wiki/concepts/empty.md'), note, 'utf-8');

    const result = await handleLintVault({ checks: ['empty_notes'] }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.length).toBeGreaterThanOrEqual(1);
    expect(parsed.findings[0].check).toBe('empty_notes');
  });

  it('lint_vault reports clean vault', async () => {
    // No notes in wiki folders = no issues
    const result = await handleLintVault({}, ctx);
    expect(result.content[0].text).toContain('no issues found');
  });

  // --- batch_get_notes ---

  it('batch_get_notes reads multiple notes with summary detail', async () => {
    const alice = serializeNote(
      { id: 'bg1', type: 'entity', title: 'Alice', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Alice\nSenior engineer on platform team.',
    );
    const bob = serializeNote(
      { id: 'bg2', type: 'entity', title: 'Bob', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Bob\nBackend engineer.',
    );
    await writeFile(join(tempDir, 'wiki/entities/alice.md'), alice, 'utf-8');
    await writeFile(join(tempDir, 'wiki/entities/bob.md'), bob, 'utf-8');

    const result = await handleBatchGetNotes({
      paths: ['wiki/entities/alice.md', 'wiki/entities/bob.md'],
      detail: 'summary',
    }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].excerpt).toContain('Senior engineer');
    expect(parsed[0].body).toBeUndefined();
    expect(parsed[1].excerpt).toContain('Backend engineer');
  });

  it('batch_get_notes returns metadata only when requested', async () => {
    const note = serializeNote(
      { id: 'bg3', type: 'concept', title: 'Test', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Test\nLong body content here.',
    );
    await writeFile(join(tempDir, 'wiki/concepts/test.md'), note, 'utf-8');

    const result = await handleBatchGetNotes({
      paths: ['wiki/concepts/test.md'],
      detail: 'metadata',
    }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed[0].frontmatter.title).toBe('Test');
    expect(parsed[0].body).toBeUndefined();
    expect(parsed[0].excerpt).toBeUndefined();
  });

  it('batch_get_notes handles missing files gracefully', async () => {
    const result = await handleBatchGetNotes({
      paths: ['wiki/entities/nonexistent.md'],
    }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed[0].error).toBeDefined();
  });

  // --- vault_status ---

  it('vault_status returns aggregate counts', async () => {
    const entity = serializeNote(
      { id: 'vs1', type: 'entity', title: 'Alice', status: 'active', created_at: '2026-04-10', updated_at: new Date().toISOString(), source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Alice',
    );
    const decision = serializeNote(
      { id: 'vs2', type: 'decision', title: 'Use MCP', status: 'active', decision_status: 'accepted', created_at: '2026-04-10', updated_at: new Date().toISOString(), source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Use MCP',
    );
    await writeFile(join(tempDir, 'wiki/entities/alice.md'), entity, 'utf-8');
    await writeFile(join(tempDir, 'wiki/decisions/use-mcp.md'), decision, 'utf-8');

    const result = await handleVaultStatus({}, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_notes).toBe(2);
    expect(parsed.by_type.entity).toBe(1);
    expect(parsed.by_type.decision).toBe(1);
    expect(parsed.by_status.active).toBe(2);
    expect(parsed.recent_activity.last_24h).toBe(2);
  });

  // --- search_by_tags ---

  it('search_by_tags finds notes by aliases', async () => {
    const note = serializeNote(
      { id: 'st1', type: 'entity', title: 'Alice Chen', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: ['AC', 'alice'], links: [], change_origin: 'human', protected_regions: [] },
      '# Alice Chen',
    );
    await writeFile(join(tempDir, 'wiki/entities/alice-chen.md'), note, 'utf-8');

    const result = await handleSearchByTags({ tags: ['alice'] }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('Alice Chen');
    expect(parsed[0].matched_tags).toContain('alice');
  });

  it('search_by_tags returns empty for unmatched tags', async () => {
    const result = await handleSearchByTags({ tags: ['nonexistent-tag-xyz'] }, ctx);
    expect(result.content[0].text).toContain('No notes found');
  });

  // --- _index.md filtering ---

  it('search_vault excludes _index.md files', async () => {
    const indexNote = serializeNote(
      { id: 'idx1', type: 'index', title: 'Entities Index', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Entities Index\nplatform team index listing.',
    );
    const realNote = serializeNote(
      { id: 'real1', type: 'entity', title: 'Alice Chen', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Alice Chen\nplatform team member.',
    );
    await writeFile(join(tempDir, 'wiki/entities/_index.md'), indexNote, 'utf-8');
    await writeFile(join(tempDir, 'wiki/entities/alice-chen.md'), realNote, 'utf-8');

    const result = await handleSearchVault({ query: 'platform team' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    const paths = parsed.map((r: { path: string }) => r.path);
    expect(paths).not.toContain('wiki/entities/_index.md');
    expect(paths).toContain('wiki/entities/alice-chen.md');
  });

  it('search_entities excludes _index.md files', async () => {
    const indexNote = serializeNote(
      { id: 'idx2', type: 'index', title: 'Projects Index', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Projects Index',
    );
    const realNote = serializeNote(
      { id: 'proj1', type: 'entity', title: 'My Project', status: 'active', entity_kind: 'project', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# My Project\nA real project.',
    );
    await writeFile(join(tempDir, 'wiki/projects/_index.md'), indexNote, 'utf-8');
    await writeFile(join(tempDir, 'wiki/projects/my-project.md'), realNote, 'utf-8');

    const result = await handleSearchEntities({}, ctx);
    const parsed = JSON.parse(result.content[0].text);
    const paths = parsed.map((r: { path: string }) => r.path);
    expect(paths).not.toContain('wiki/projects/_index.md');
  });

  it('get_decisions excludes _index.md files', async () => {
    const indexNote = serializeNote(
      { id: 'didx', type: 'index', title: 'Decisions Index', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Decisions Index',
    );
    const realNote = serializeNote(
      { id: 'd2', type: 'decision', title: 'Use TypeScript', status: 'active', decision_status: 'accepted', decision_date: '', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Use TypeScript\nChose TS for safety.',
    );
    await writeFile(join(tempDir, 'wiki/decisions/_index.md'), indexNote, 'utf-8');
    await writeFile(join(tempDir, 'wiki/decisions/use-typescript.md'), realNote, 'utf-8');

    const result = await handleGetDecisions({}, ctx);
    const parsed = JSON.parse(result.content[0].text);
    const paths = parsed.map((r: { path: string }) => r.path);
    expect(paths).not.toContain('wiki/decisions/_index.md');
    expect(paths).toContain('wiki/decisions/use-typescript.md');
  });

  it('get_decisions uses created_at as fallback when decision_date is empty', async () => {
    const note = serializeNote(
      { id: 'd3', type: 'decision', title: 'Use Postgres', status: 'active', decision_status: 'accepted', decision_date: '', created_at: '2026-04-15T10:00:00Z', updated_at: '2026-04-15T10:00:00Z', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Use Postgres\nRelational DB choice.',
    );
    await writeFile(join(tempDir, 'wiki/decisions/use-postgres.md'), note, 'utf-8');

    const result = await handleGetDecisions({}, ctx);
    const parsed = JSON.parse(result.content[0].text);
    const dec = parsed.find((d: { title: string }) => d.title === 'Use Postgres');
    expect(dec).toBeDefined();
    expect(dec.decision_date).toBe('2026-04-15T10:00:00Z');
  });

  it('search_vault finds notes via stem matching', async () => {
    const note = serializeNote(
      { id: 'stem1', type: 'concept', title: 'RCAs', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# RCAs\nRoot cause analyses are systematic reviews of incidents.',
    );
    await writeFile(join(tempDir, 'wiki/concepts/rcas.md'), note, 'utf-8');

    // "analysis" should match "analyses" via prefix stemming
    const result = await handleSearchVault({ query: 'root cause analysis' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].title).toBe('RCAs');
  });

  it('get_recent_sessions extracts outcome from decisions region when frontmatter empty', async () => {
    const session = serializeNote(
      { id: 'rs1', type: 'session_summary', title: 'Session Decisions Test', status: 'active', created_at: '2026-04-10T12:00:00Z', updated_at: '2026-04-10T12:00:00Z', session_id: 'rs1', prompt_summary: '', outcome_summary: '', files_changed: [], source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'hook_capture', protected_regions: [] },
      `# Session Decisions Test\n\n%% begin:decisions %%\nFixed the layout bug and updated 4 handlers.\n%% end:decisions %%`,
    );
    await writeFile(join(tempDir, 'outputs/session-summaries/session-decisions-test.md'), session, 'utf-8');

    const result = await handleGetRecentSessions({ count: 1, detail: 'summary' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed[0].outcome_summary).toContain('Fixed the layout bug');
  });

  // --- search_vault with ranking ---

  it('search_vault ranks title matches above body matches', async () => {
    const titleMatch = serializeNote(
      { id: 'sr1', type: 'entity', title: 'Platform Team', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Platform Team\nA team that builds infrastructure.',
    );
    const bodyMatch = serializeNote(
      { id: 'sr2', type: 'entity', title: 'Alice Chen', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Alice Chen\nSenior engineer on the platform team.',
    );
    await writeFile(join(tempDir, 'wiki/entities/platform-team.md'), titleMatch, 'utf-8');
    await writeFile(join(tempDir, 'wiki/entities/alice-chen.md'), bodyMatch, 'utf-8');

    const result = await handleSearchVault({ query: 'platform team' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.length).toBeGreaterThanOrEqual(2);
    // Title match should rank first
    expect(parsed[0].title).toBe('Platform Team');
  });

  // --- detail levels on existing tools ---

  it('get_note returns metadata only when detail=metadata', async () => {
    const note = serializeNote(
      { id: 'dl1', type: 'concept', title: 'Detail Test', status: 'active', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Detail Test\nThis body should not appear in metadata mode.',
    );
    await writeFile(join(tempDir, 'wiki/concepts/detail-test.md'), note, 'utf-8');

    const result = await handleGetNote({ path: 'wiki/concepts/detail-test.md', detail: 'metadata' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.frontmatter.title).toBe('Detail Test');
    expect(parsed.body).toBeUndefined();
    expect(parsed.excerpt).toBeUndefined();
  });

  it('get_entity returns summary with excerpt', async () => {
    const note = serializeNote(
      { id: 'dl2', type: 'entity', title: 'Summary Test', status: 'active', entity_kind: 'person', canonical_name: 'Summary Test', created_at: '2026-04-10', updated_at: '2026-04-10', source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'human', protected_regions: [] },
      '# Summary Test\nThis is a long body that should be excerpted when detail is summary.',
    );
    await writeFile(join(tempDir, 'wiki/entities/summary-test.md'), note, 'utf-8');

    const result = await handleGetEntity({ name: 'Summary Test', detail: 'summary' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.excerpt).toBeDefined();
    expect(parsed.body).toBeUndefined();
  });

  it('get_recent_sessions returns metadata only', async () => {
    const session = serializeNote(
      { id: 'dl3', type: 'session_summary', title: 'Session Test', status: 'active', created_at: '2026-04-10T12:00:00Z', updated_at: '2026-04-10T12:00:00Z', session_id: 'test123', prompt_summary: 'Did some work', outcome_summary: 'Completed task', files_changed: ['a.ts'], source_refs: [], derived_from: [], aliases: [], links: [], change_origin: 'hook_capture', protected_regions: [] },
      '# Session Test',
    );
    await writeFile(join(tempDir, 'outputs/session-summaries/session-test.md'), session, 'utf-8');

    const result = await handleGetRecentSessions({ count: 1, detail: 'metadata' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed[0].session_id).toBe('test123');
    expect(parsed[0].prompt_summary).toBeUndefined();
    expect(parsed[0].body).toBeUndefined();
  });
});
