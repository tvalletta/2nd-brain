import Database from 'better-sqlite3';
import type { KarpathyConfig } from '../../src/config/schema.js';
import { createProviderFromConfig } from '../../src/embeddings/factory.js';
import { openEmbeddingStore } from '../../src/embeddings/store.js';
import { openFTSIndex } from '../../src/search/fts-index.js';
import { createHybridStore, type HybridStore } from '../../src/search/hybrid-store.js';

/** Open a HybridStore at an explicit db path, optionally forcing keyword-only.
 * Mirrors src/search/factory.ts but exposes the db path + provider probe so the
 * harness can run different arms against different index files. */
export function openVariantStore(
  config: KarpathyConfig,
  dbPath: string,
  opts: { keywordOnly?: boolean } = {},
): HybridStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // When keywordOnly is true, override config.embeddings.provider to 'ollama'
  // so that the hybrid-store's provider availability check is triggered.
  const effectiveConfig = opts.keywordOnly
    ? { ...config, embeddings: { ...config.embeddings, provider: 'ollama' as const } }
    : config;

  const provider = createProviderFromConfig(effectiveConfig);
  const embeddings = openEmbeddingStore({ db, provider });
  const fts = openFTSIndex(db, { vaultRoot: effectiveConfig.vaultPath });
  const isProviderAvailable = opts.keywordOnly ? async () => false : undefined;
  const store = createHybridStore({ config: effectiveConfig, db, fts, embeddings, isProviderAvailable });
  const origClose = store.close.bind(store);
  store.close = () => { origClose(); db.close(); };
  return store;
}
