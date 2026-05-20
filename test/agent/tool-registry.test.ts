import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { serializeNote, parseNote } from '../../src/vault/frontmatter.js';
import { getProtectedRegion } from '../../src/vault/protected-regions.js';
import type { AgentContext } from '../../src/agent/tool-registry.js';
import { createToolExecutor, toToolDefinitions } from '../../src/agent/tool-registry.js';
import { createIngestToolRegistry } from '../../src/agent/tools/index.js';
import { createNoopClient } from '../../src/enrichment/llm-client.js';
import type { KarpathyConfig } from '../../src/config/schema.js';

function makeConfig(vaultPath: string): KarpathyConfig {
  return {
    vaultPath,
    hotCachePath: 'CLAUDE.md',
    stateDir: '.karpathy/state',
    lockDir: '.karpathy/locks',
    logDir: '.karpathy/logs',
    llm: { provider: 'bedrock' as const, region: 'us-west-2', model: 'test', maxTokens: 4096 },
    ingest: { watchEnabled: false, watchPaths: ['raw/'], debounceMs: 2000 },
    maintenance: { autoBacklinks: true, autoIndexes: true, reviewEnabled: false },
    session: { exportToRaw: true, minTurns: 2 },
    enrichment: {
      enabled: true,
      maxChunkSize: 12000,
      chunkOverlap: 1000,
      autoCreateEntities: true,
      autoMergeEntities: true,
      contradictionDetection: false,
    },
    agent: {
      enabled: true,
      maxTurns: 20,
      maxTokens: 8192,
      sonnetModel: 'us.anthropic.claude-sonnet-4-6-v1',
      opusModel: 'us.anthropic.claude-opus-4-v1',
      haikuModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      incrementalThreshold: 5,
      apiTimeoutMs: 120000,
      apiRetryAttempts: 3,
      apiRetryBaseMs: 1000,
      toolTimeoutMs: 30000,
    },
  };
}

describe('agent tool-registry', () => {
  let tempDir: string;
  let vault: ReturnType<typeof createFsAdapter>;
  let agentContext: AgentContext;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-agent-tools-'));
    vault = createFsAdapter(tempDir);
    await vault.ensureFolder('wiki/projects');
    await vault.ensureFolder('wiki/concepts');
    await vault.ensureFolder('wiki/entities');
    await vault.ensureFolder('raw/ai-conversations/claude');

    agentContext = {
      vaultPath: tempDir,
      projectRoot: tempDir,
      enqueue: async () => ({} as any),
      llm: createNoopClient(),
      vault,
      config: makeConfig(tempDir),
      sourceFilePath: 'raw/ai-conversations/claude/test/session-001.md',
      sourceContent: '# Test session',
      contentCategory: 'ai-conversation-claude',
      projectSlug: 'test-project',
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('toToolDefinitions', () => {
    it('converts tools to API format', () => {
      const tools = createIngestToolRegistry();
      const defs = toToolDefinitions(tools);

      expect(defs.length).toBeGreaterThan(0);
      for (const d of defs) {
        expect(d.name).toBeTruthy();
        expect(d.description).toBeTruthy();
        expect(d.input_schema).toBeTruthy();
        expect(d).not.toHaveProperty('execute');
      }
    });

    it('includes all expected tools', () => {
      const defs = toToolDefinitions(createIngestToolRegistry());
      const names = defs.map((d) => d.name);

      expect(names).toContain('read_file');
      expect(names).toContain('glob_files');
      expect(names).toContain('search_wiki');
      expect(names).toContain('list_projects');
      expect(names).toContain('get_project_hub');
      expect(names).toContain('get_project_conversations');
      expect(names).toContain('create_page');
      expect(names).toContain('update_protected_region');
      expect(names).toContain('create_project_spec');
      expect(names).toContain('resolve_entity');
      expect(names).toContain('create_entity');
      expect(names).toContain('classify_cwd');
      expect(names).toContain('mark_complete');
    });
  });

  describe('createToolExecutor', () => {
    it('dispatches to the correct tool', async () => {
      const tools = createIngestToolRegistry();
      const executor = createToolExecutor(tools, agentContext);

      // Create a file to read
      await vault.atomicWrite('wiki/test.md', '# Hello');

      const result = await executor('read_file', { path: 'wiki/test.md' });
      expect(result).toContain('# Hello');
    });

    it('throws for unknown tool', async () => {
      const tools = createIngestToolRegistry();
      const executor = createToolExecutor(tools, agentContext);

      await expect(executor('nonexistent_tool', {})).rejects.toThrow('Unknown tool');
    });
  });

  describe('individual tools', () => {
    let executor: ReturnType<typeof createToolExecutor>;

    beforeEach(() => {
      const tools = createIngestToolRegistry();
      executor = createToolExecutor(tools, agentContext);
    });

    it('read_file returns file content', async () => {
      await vault.atomicWrite('wiki/concepts/test-concept.md', '---\ntitle: Test\n---\n# Test');
      const result = await executor('read_file', { path: 'wiki/concepts/test-concept.md' });
      expect(result).toContain('# Test');
    });

    it('read_file returns error for missing file', async () => {
      const result = await executor('read_file', { path: 'wiki/nonexistent.md' });
      expect(result).toContain('not found');
    });

    it('glob_files lists markdown files', async () => {
      await vault.atomicWrite('wiki/concepts/a.md', 'a');
      await vault.atomicWrite('wiki/concepts/b.md', 'b');
      const result = await executor('glob_files', { directory: 'wiki/concepts' });
      expect(result).toContain('a.md');
      expect(result).toContain('b.md');
    });

    it('list_projects shows project hubs', async () => {
      await vault.ensureFolder('wiki/projects/my-proj');
      const fm: Record<string, unknown> = {
        id: 'test', type: 'project', title: 'My Project',
        project_key: 'my-proj', project_status: 'active',
        status: 'active', created_at: '2026-01-01', updated_at: '2026-01-01',
        source_refs: [], derived_from: [], aliases: [], links: [],
        change_origin: 'extraction', protected_regions: [],
      };
      await vault.atomicWrite(
        'wiki/projects/my-proj/_index.md',
        serializeNote(fm, '\n# My Project\n'),
      );

      const result = await executor('list_projects', {});
      expect(result).toContain('My Project');
      expect(result).toContain('my-proj');
    });

    it('create_project_spec creates a new spec', async () => {
      const result = await executor('create_project_spec', {
        project_slug: 'new-proj',
        project_name: 'New Project',
        spec_type: 'technical',
        title: 'New Project - Technical',
        content: 'Uses React + Node.js',
      });

      expect(result).toContain('Created new spec');
      expect(result).toContain('technical.md');

      // Verify the spec was actually created
      const specContent = await vault.read('wiki/projects/new-proj/technical.md');
      const { data } = parseNote(specContent);
      expect(data.type).toBe('project_spec');
      expect(data.spec_type).toBe('technical');
    });

    it('update_protected_region updates content', async () => {
      const fm: Record<string, unknown> = {
        id: 'test', type: 'concept', title: 'Test',
        status: 'active', created_at: '2026-01-01', updated_at: '2026-01-01',
        source_refs: [], derived_from: [], aliases: [], links: [],
        change_origin: 'extraction', protected_regions: ['definition'],
      };
      await vault.atomicWrite(
        'wiki/concepts/test.md',
        serializeNote(fm, '\n# Test\n\n%% begin:definition %%\nOld content\n%% end:definition %%\n'),
      );

      const result = await executor('update_protected_region', {
        path: 'wiki/concepts/test.md',
        region_id: 'definition',
        content: 'New definition content.',
      });

      expect(result).toContain('Updated');

      const updated = await vault.read('wiki/concepts/test.md');
      const def = getProtectedRegion(parseNote(updated).body, 'definition');
      expect(def).toContain('New definition content.');
    });

    it('update_protected_region respects pinned content', async () => {
      const fm: Record<string, unknown> = {
        id: 'test', type: 'concept', title: 'Test',
        status: 'active', created_at: '2026-01-01', updated_at: '2026-01-01',
        source_refs: [], derived_from: [], aliases: [], links: [],
        change_origin: 'extraction', protected_regions: ['definition'],
      };
      await vault.atomicWrite(
        'wiki/concepts/pinned.md',
        serializeNote(fm, '\n# Pinned\n\n%% begin:definition %%\n%% pinned %%\nDo not touch.\n%% end:definition %%\n'),
      );

      const result = await executor('update_protected_region', {
        path: 'wiki/concepts/pinned.md',
        region_id: 'definition',
        content: 'Trying to overwrite.',
      });

      expect(result).toContain('pinned');

      // Content should be unchanged
      const content = await vault.read('wiki/concepts/pinned.md');
      expect(content).toContain('Do not touch.');
    });

    it('classify_cwd classifies a working directory', async () => {
      const result = await executor('classify_cwd', { cwd: '/Users/dev/my-project' });
      const parsed = JSON.parse(result);
      expect(parsed.category).toBe('project');
      expect(parsed.slug).toBe('my-project');
    });

    it('mark_complete returns structured data', async () => {
      const result = await executor('mark_complete', {
        summary: 'Processed session',
        conversation_intent: 'implementation',
        specs_updated: ['technical'],
      });

      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('complete');
      expect(parsed.summary).toBe('Processed session');
      expect(parsed.conversation_intent).toBe('implementation');
    });
  });
});
