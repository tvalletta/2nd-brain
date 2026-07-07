/**
 * Phase 2 — 4-source candidate pool builder (design doc §Track A Phase 2).
 *
 * For each dataset item, unions the top-K results of every Phase 1 variant
 * (grep-first, as-deployed), a raw FTS5 keyword sweep over the shared index,
 * and the behavioral signal (notes opened shortly after a matching real
 * logged search) into one deduped candidate pool. Every candidate records
 * every source that surfaced it, so the downstream judge/calibration steps
 * can see how a doc was found, not just that it was found.
 *
 * Run standalone: `npm run eval:pool` (writes eval/dataset/pool.json).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Variant } from '../run/types.js';
import { toRunHits } from '../run/normalize.js';
import { redactSecrets } from './redact.js';

export interface PoolCandidate {
  doc_id: string;
  title: string;
  excerpt: string;
  sources: string[];
}

export interface ItemPool {
  item_id: string;
  candidates: PoolCandidate[];
}

export interface BehavioralEntry {
  query: string;
  ts: string;
  opened: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function lookupTitle(db: Database.Database, docId: string): string {
  const row = db.prepare('SELECT title FROM notes_fts WHERE doc_id = ?').get(docId) as
    | { title: string }
    | undefined;
  return row?.title || docId;
}

/** Pool = union of grep-first top-K, as-deployed top-K, a raw FTS keyword
 * sweep (via the first variant's shared store.fts — same underlying index
 * for every variant), and behavioral signal (notes opened shortly after a
 * matching real logged search). Dedup by doc_id; each candidate records
 * every source that surfaced it. */
export async function buildPoolForItem(
  item: { id: string; query: string },
  variants: Variant[],
  db: Database.Database,
  behavioral: BehavioralEntry[],
  poolK = 20,
): Promise<ItemPool> {
  const byDocId = new Map<string, PoolCandidate>();
  const add = (docId: string, source: string, excerpt: string) => {
    const existing = byDocId.get(docId);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    byDocId.set(docId, { doc_id: docId, title: lookupTitle(db, docId), excerpt, sources: [source] });
  };

  for (const variant of variants) {
    const store = variant.openStore();
    try {
      const result = await store.search(item.query, { topK: poolK });
      const hits = toRunHits(result, poolK);
      for (const h of hits) add(h.path, variant.name, redactSecrets(h.excerpt));
    } finally {
      store.close();
    }
  }

  const sweepStore = variants[0].openStore();
  try {
    const ftsHits = sweepStore.fts.query(item.query, poolK);
    for (const h of ftsHits) add(h.docId, 'keyword-sweep', redactSecrets(h.snippet));
  } finally {
    sweepStore.close();
  }

  const behavioralMatch = behavioral.find((b) => norm(b.query) === norm(item.query));
  if (behavioralMatch) {
    for (const path of behavioralMatch.opened) add(path, 'behavioral', '');
  }

  return { item_id: item.id, candidates: [...byDocId.values()] };
}

const REPO_ROOT = join(import.meta.dirname, '..', '..');

async function main() {
  const { loadConfig } = await import('../../src/config/loader.js');
  const { buildVariants } = await import('../run/variants.js');
  const config = await loadConfig(REPO_ROOT);
  const dbPath = join(REPO_ROOT, config.stateDir, 'embeddings.sqlite');
  const variants = buildVariants(config, REPO_ROOT, 20);

  const items: { id: string; query: string }[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8'),
  );
  const behavioral: BehavioralEntry[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval/dataset/behavioral-signal.json'), 'utf8'),
  );

  const db = new Database(dbPath, { readonly: true });
  const pools: ItemPool[] = [];
  try {
    for (const item of items) {
      if (item.query.startsWith('<ABSENT-STUB')) continue;
      pools.push(await buildPoolForItem(item, variants, db, behavioral, 20));
    }
  } finally {
    db.close();
  }

  writeFileSync(join(REPO_ROOT, 'eval/dataset/pool.json'), JSON.stringify(pools, null, 2));
  const totalCandidates = pools.reduce((sum, p) => sum + p.candidates.length, 0);
  console.log(`Wrote eval/dataset/pool.json: ${pools.length} items, ${totalCandidates} total candidates`);
}

if (process.argv[1]?.endsWith('build-pool.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
