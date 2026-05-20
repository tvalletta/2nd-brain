import { nanoid } from 'nanoid';
import type { VaultAdapter } from '../vault/adapter.js';
import { serializeNote } from '../vault/frontmatter.js';
import { updateProtectedRegion, getProtectedRegion, OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { todayStamp, nowISO } from '../shared/date-utils.js';
import { slugify, DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('session-log');

export interface SessionLogManager {
  getOrCreateSessionNote(sessionId: string, cwd: string): Promise<string>;
  appendPrompt(sessionId: string, prompt: string): Promise<void>;
  appendToolUse(sessionId: string, toolName: string, summary: string): Promise<void>;
  appendCompactSummary(sessionId: string, summary: string): Promise<void>;
  finalize(sessionId: string, lastMessage?: string): Promise<void>;
}

export function createSessionLogManager(
  vault: VaultAdapter,
  layout: VaultLayout = DEFAULT_LAYOUT,
): SessionLogManager {
  const SESSION_DIR = layout.aiSummaries;
  const sessionPaths = new Map<string, string>();
  const promptCounts = new Map<string, number>();
  const toolCounts = new Map<string, number>();

  async function ensureNote(sessionId: string, cwd: string): Promise<string> {
    const existing = sessionPaths.get(sessionId);
    if (existing) return existing;

    await vault.ensureFolder(SESSION_DIR);

    const date = todayStamp();
    const slug = slugify(`session-${date}-${sessionId.slice(0, 8)}`);
    const path = `${SESSION_DIR}/${slug}.md`;

    const frontmatter = {
      id: nanoid(),
      type: 'session_summary',
      title: `Session ${date} (${sessionId.slice(0, 8)})`,
      status: 'active',
      review_state: 'unreviewed',
      created_at: nowISO(),
      updated_at: nowISO(),
      session_id: sessionId,
      prompt_summary: '',
      outcome_summary: '',
      files_changed: [],
      source_refs: [],
      derived_from: [],
      aliases: [],
      links: [],
      change_origin: 'hook_capture',
      protected_regions: ['prompts', 'tool-activity', 'decisions'],
    };

    const body = `
# Session ${date}

**Working directory:** \`${cwd}\`

## Prompts
${OPEN_TAG('prompts')}
${CLOSE_TAG('prompts')}

## Tool Activity
${OPEN_TAG('tool-activity')}
${CLOSE_TAG('tool-activity')}

## Decisions & Insights
${OPEN_TAG('decisions')}
${CLOSE_TAG('decisions')}
`;

    const content = serializeNote(frontmatter, body);

    if (await vault.exists(path)) {
      sessionPaths.set(sessionId, path);
    } else {
      await vault.create(path, content);
      sessionPaths.set(sessionId, path);
      log.info('Created session note', { path, sessionId });
    }

    promptCounts.set(sessionId, 0);
    toolCounts.set(sessionId, 0);
    return path;
  }

  return {
    getOrCreateSessionNote: ensureNote,

    async appendPrompt(sessionId, prompt) {
      const path = sessionPaths.get(sessionId);
      if (!path) return;

      const count = (promptCounts.get(sessionId) ?? 0) + 1;
      promptCounts.set(sessionId, count);

      const content = await vault.read(path);
      const timestamp = new Date().toLocaleTimeString();
      const entry = `### Prompt ${count} (${timestamp})\n${prompt.slice(0, 500)}${prompt.length > 500 ? '...' : ''}\n`;
      const updated = updateProtectedRegion(
        content,
        'prompts',
        ((getProtectedRegion(content, 'prompts') ?? '') + '\n' + entry).trim(),
      );
      await vault.write(path, updated);
    },

    async appendToolUse(sessionId, toolName, summary) {
      const path = sessionPaths.get(sessionId);
      if (!path) return;

      const count = (toolCounts.get(sessionId) ?? 0) + 1;
      toolCounts.set(sessionId, count);

      const content = await vault.read(path);
      const entry = `- **${toolName}**: ${summary.slice(0, 200)}`;
      const updated = updateProtectedRegion(
        content,
        'tool-activity',
        ((getProtectedRegion(content, 'tool-activity') ?? '') + '\n' + entry).trim(),
      );
      await vault.write(path, updated);
    },

    async appendCompactSummary(sessionId, summary) {
      const path = sessionPaths.get(sessionId);
      if (!path) return;

      const content = await vault.read(path);
      const entry = `\n---\n**Compact summary:** ${summary.slice(0, 1000)}\n`;
      const updated = updateProtectedRegion(
        content,
        'decisions',
        ((getProtectedRegion(content, 'decisions') ?? '') + entry).trim(),
      );
      await vault.write(path, updated);
    },

    async finalize(sessionId, lastMessage) {
      const path = sessionPaths.get(sessionId);
      if (!path) return;

      const content = await vault.read(path);

      // Add last message summary if present
      let updated = content;
      if (lastMessage) {
        const summary = lastMessage.slice(0, 500);
        updated = updateProtectedRegion(
          updated,
          'decisions',
          ((getProtectedRegion(updated, 'decisions') ?? '') + `\n\n**Final output:** ${summary}`).trim(),
        );
      }

      // Update frontmatter with counts
      updated = updated.replace(
        /updated_at: ".*?"/,
        `updated_at: "${nowISO()}"`,
      );

      await vault.write(path, updated);
      log.info('Session finalized', {
        sessionId,
        prompts: promptCounts.get(sessionId),
        tools: toolCounts.get(sessionId),
      });
    },
  };
}
