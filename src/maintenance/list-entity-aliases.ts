import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';

export interface EntityAliasEntry {
  path: string;
  canonicalName: string;
  currentAliases: string[];
}

/** Lists every real entity note (skips auto-generated _index.md files) with
 * its canonical name and current aliases, for a human to review in one
 * sitting — the vault has zero alias-revealing text in note bodies to mine
 * automatically (confirmed by direct grep across all entity notes), so
 * this is deliberately a listing tool for human input, not an AI-guess tool. */
export async function listEntitiesNeedingAliases(
  vault: VaultAdapter,
  entitiesDir: string,
): Promise<EntityAliasEntry[]> {
  const files = await vault.listMarkdownFiles(entitiesDir);
  const entries: EntityAliasEntry[] = [];
  for (const path of files) {
    if (path.endsWith('/_index.md') || path.endsWith('_index.md')) continue;
    const raw = await vault.read(path);
    const { data } = parseNote(raw);
    const canonicalName = typeof data.canonical_name === 'string' ? data.canonical_name : String(data.title ?? path);
    const currentAliases = Array.isArray(data.aliases) ? (data.aliases as string[]) : [];
    entries.push({ path, canonicalName, currentAliases });
  }
  return entries;
}

/** Writes a new aliases array into one entity note's frontmatter, preserving
 * every other field and the full body untouched. */
export async function writeAliases(vault: VaultAdapter, path: string, aliases: string[]): Promise<void> {
  const raw = await vault.read(path);
  const { data, body } = parseNote(raw);
  const updated = { ...data, aliases };
  await vault.atomicWrite(path, serializeNote(updated, body));
}
