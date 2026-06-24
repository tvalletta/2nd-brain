// Open a HybridStore from a parsed KarpathyConfig.
//
// Mirrors `openStoreFromConfig` from `src/embeddings/factory.ts`, but composes
// the FTS5 keyword index alongside the embedding store inside one SQLite file
// (`.karpathy/state/embeddings.sqlite`). The DB connection is owned by the
// HybridStore — close() releases the handle and both child stores.

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { KarpathyConfig } from '../config/schema.js';
import { createProviderFromConfig } from '../embeddings/factory.js';
import { openEmbeddingStore } from '../embeddings/store.js';
import { openFTSIndex } from './fts-index.js';
import { createHybridStore, type HybridStore } from './hybrid-store.js';

export function openHybridStoreFromConfig(
  config: KarpathyConfig,
  projectRoot: string,
): HybridStore {
  const dbPath = join(projectRoot, config.stateDir, 'embeddings.sqlite');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  const provider = createProviderFromConfig(config);
  const embeddings = openEmbeddingStore({ db, provider });
  const fts = openFTSIndex(db, { vaultRoot: config.vaultPath });

  const hybrid = createHybridStore({ config, db, fts, embeddings });

  // Ensure the SQLite handle is released when the hybrid store is closed.
  const closeWrapped = hybrid.close.bind(hybrid);
  hybrid.close = () => {
    closeWrapped();
    db.close();
  };
  return hybrid;
}
