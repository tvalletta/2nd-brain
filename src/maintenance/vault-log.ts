// A4: Append-only chronological ledger at vault root (`log.md`).
//
// Every ingest, digest, refresh, decay scan, and research run writes one line.
// The file is also the agent's coarse history view — the protected region wraps
// the entries so human edits above/below survive.

import type { VaultAdapter } from '../vault/adapter.js';
import { OPEN_TAG, CLOSE_TAG } from '../vault/protected-regions.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';

/** Legacy default-layout path. Prefer `vaultLogPath(layout)`. */
export const VAULT_LOG_PATH = DEFAULT_LAYOUT.vaultLog;
/** Layout-aware path to `log.md`. */
export function vaultLogPath(layout: VaultLayout = DEFAULT_LAYOUT): string {
  return layout.vaultLog;
}
const REGION_ID = 'log-entries';
const MAX_ENTRIES = 1000; // trim oldest when exceeded; archive policy can come later

const HEADER = `---
type: log
title: Vault log
---

# Vault log

Append-only ledger of every system action. Most recent entries first.

`;

export interface LogEntry {
  /** When the action occurred. Defaults to `now`. */
  at?: string;
  /** Short verb-phrase, e.g. `ingest`, `digest:weekly`, `topic:refresh`. */
  kind: string;
  /** Free-form human-readable detail. */
  message: string;
}

export async function appendLogEntry(
  vault: VaultAdapter,
  entry: LogEntry,
  layout: VaultLayout = DEFAULT_LAYOUT,
): Promise<void> {
  const at = entry.at ?? new Date().toISOString();
  const line = `- \`${at}\` **${entry.kind}** — ${entry.message}`;
  const path = vaultLogPath(layout);
  // Ensure parent dir exists (e.g. `Curated/`).
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  if (dir && !(await vault.exists(dir))) await vault.ensureFolder(dir);
  const existing = (await vault.exists(path)) ? await vault.read(path) : '';
  const next = upsertLogRegion(existing, line);
  await vault.atomicWrite(path, next);
}

function upsertLogRegion(existing: string, newLine: string): string {
  const open = OPEN_TAG(REGION_ID);
  const close = CLOSE_TAG(REGION_ID);

  if (!existing) {
    return `${HEADER}${open}\n${newLine}\n${close}\n`;
  }

  const openIdx = existing.indexOf(open);
  const closeIdx = openIdx >= 0 ? existing.indexOf(close, openIdx + open.length) : -1;
  if (openIdx === -1 || closeIdx === -1) {
    // Region missing — append a fresh one preserving any pre-existing user content.
    return `${existing.trimEnd()}\n\n${open}\n${newLine}\n${close}\n`;
  }

  const before = existing.slice(0, openIdx + open.length);
  const after = existing.slice(closeIdx);
  const inner = existing.slice(openIdx + open.length, closeIdx).trim();
  const lines = inner ? inner.split('\n') : [];
  lines.unshift(newLine);
  // Trim oldest when over cap.
  const trimmed = lines.slice(0, MAX_ENTRIES);
  return `${before}\n${trimmed.join('\n')}\n${after}`;
}
