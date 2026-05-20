import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFsAdapter } from '../../src/vault/fs-adapter.js';
import { createNoopClient } from '../../src/enrichment/llm-client.js';
import type { Job, JobCreateInput, JobContext } from '../../src/jobs/types.js';
import { KarpathyConfigSchema, type KarpathyConfig } from '../../src/config/schema.js';
import { ingestRawFileHandler } from '../../src/jobs/handlers/ingest-raw-file.js';
import { nanoid } from 'nanoid';

function makeConfig(vaultPath: string, agentEnabled: boolean): KarpathyConfig {
  // KarpathyConfigSchema fills every default (incl. `layout`) so test config
  // matches what production builds at runtime.
  return KarpathyConfigSchema.parse({
    vaultPath,
    agent: { enabled: agentEnabled },
  });
}

/** Sample AI conversation content with the structural markers the router expects */
const AI_CONVERSATION = `# Claude Code Session

**Session ID:** abc-123
**Date:** 2026-04-14
**Working directory:** \`/Users/dev/my-project\`
**Source:** Claude Code

## Conversation

### Turn 1 — User

Build the auth module.

### Turn 2 — Assistant

I'll create the auth module with OAuth 2.0.

### Turn 3 — Tool

\`\`\`
Created src/auth/index.ts
\`\`\`
`;

const PLAIN_DOCUMENT = `# Meeting Notes

## Attendees
- Alice
- Bob

## Agenda
1. Review Q3 progress
2. Plan Q4 roadmap
`;

describe('ingest-flow routing', () => {
  let tempDir: string;
  let vaultDir: string;
  let vault: ReturnType<typeof createFsAdapter>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'karpathy-ingest-flow-'));
    vaultDir = join(tempDir, 'vault');
    vault = createFsAdapter(vaultDir);
    await vault.ensureFolder('raw');
    await vault.ensureFolder('outputs/source-summaries');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createContext(agentEnabled: boolean): { context: JobContext; enqueuedJobs: JobCreateInput[] } {
    const enqueuedJobs: JobCreateInput[] = [];
    const config = makeConfig(vaultDir, agentEnabled);

    const context: JobContext = {
      vaultPath: vaultDir,
      projectRoot: tempDir,
      enqueue: async (partial) => {
        enqueuedJobs.push(partial);
        return { id: nanoid(), status: 'pending', createdAt: new Date().toISOString(), ...partial } as Job;
      },
      llm: createNoopClient(),
      vault,
      config,
    };

    return { context, enqueuedJobs };
  }

  function createJob(filePath: string): Job {
    return {
      id: nanoid(),
      type: 'ingest-raw-file',
      status: 'running',
      priority: 20,
      targetPath: undefined,
      payload: { filePath },
      trigger: 'hook',
      createdAt: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
      debounceMs: 0,
    };
  }

  it('routes AI conversation to agent-ingest when agent.enabled=true', async () => {
    // Write AI conversation to a file the handler can read
    const filePath = join(tempDir, 'session.md');
    await writeFile(filePath, AI_CONVERSATION, 'utf-8');

    const { context, enqueuedJobs } = createContext(true);
    const job = createJob(filePath);

    await ingestRawFileHandler.execute(job, context);

    // Should have enqueued agent-ingest, NOT classify-source
    const agentJob = enqueuedJobs.find((j) => j.type === 'agent-ingest');
    const classifyJob = enqueuedJobs.find((j) => j.type === 'classify-source');

    expect(agentJob).toBeTruthy();
    expect(classifyJob).toBeUndefined();
    expect(agentJob!.payload!.contentCategory).toBe('ai-conversation-claude');
    expect(agentJob!.payload!.projectSlug).toBe('my-project');
  });

  it('routes AI conversation to classify-source when agent.enabled=false', async () => {
    const filePath = join(tempDir, 'session.md');
    await writeFile(filePath, AI_CONVERSATION, 'utf-8');

    const { context, enqueuedJobs } = createContext(false);
    const job = createJob(filePath);

    await ingestRawFileHandler.execute(job, context);

    // Should have enqueued classify-source, NOT agent-ingest
    const agentJob = enqueuedJobs.find((j) => j.type === 'agent-ingest');
    const classifyJob = enqueuedJobs.find((j) => j.type === 'classify-source');

    expect(classifyJob).toBeTruthy();
    expect(agentJob).toBeUndefined();
  });

  it('routes non-AI content to classify-source even when agent.enabled=true', async () => {
    const filePath = join(tempDir, 'meeting.md');
    await writeFile(filePath, PLAIN_DOCUMENT, 'utf-8');

    const { context, enqueuedJobs } = createContext(true);
    const job = createJob(filePath);

    await ingestRawFileHandler.execute(job, context);

    // Non-AI content always goes through classify-source
    const agentJob = enqueuedJobs.find((j) => j.type === 'agent-ingest');
    const classifyJob = enqueuedJobs.find((j) => j.type === 'classify-source');

    expect(classifyJob).toBeTruthy();
    expect(agentJob).toBeUndefined();
  });

  it('stores content_category in source summary', async () => {
    const filePath = join(tempDir, 'session.md');
    await writeFile(filePath, AI_CONVERSATION, 'utf-8');

    const { context } = createContext(true);
    const job = createJob(filePath);

    await ingestRawFileHandler.execute(job, context);

    // Find the source summary that was created
    const summaries = await vault.listMarkdownFiles('outputs/source-summaries');
    expect(summaries.length).toBe(1);

    const content = await vault.read(summaries[0]);
    expect(content).toContain('content_category: ai-conversation-claude');
  });
});
