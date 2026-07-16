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

/** Filters items to those whose `id` starts with any of the given
 * comma-separated prefixes, or returns all items unchanged when no filter
 * is given. Used by `--only` to scope pooling/judging to just-added items
 * without re-spending real cost re-processing already-settled ones. */
export function filterItemsByIdPrefix<T extends { id: string }>(items: T[], prefixFilter: string | undefined): T[] {
  if (!prefixFilter) return items;
  const prefixes = prefixFilter.split(',').map((p) => p.trim()).filter(Boolean);
  return items.filter((it) => prefixes.some((p) => it.id.startsWith(p)));
}

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
    const { hits: ftsHits } = sweepStore.fts.query(item.query, poolK);
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
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyPrefix = onlyArg?.slice('--only='.length);

  const { loadConfig } = await import('../../src/config/loader.js');
  const { buildVariants } = await import('../run/variants.js');
  const config = await loadConfig(REPO_ROOT);
  const dbPath = join(REPO_ROOT, config.stateDir, 'embeddings.sqlite');
  const variants = buildVariants(config, REPO_ROOT, 20);

  const allItems: { id: string; query: string }[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval/dataset/queries.json'), 'utf8'),
  );
  const items = filterItemsByIdPrefix(allItems, onlyPrefix);
  console.log(onlyPrefix ? `Scoped to ${items.length}/${allItems.length} items matching "${onlyPrefix}"` : `Processing all ${items.length} items`);

  const behavioral: BehavioralEntry[] = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval/dataset/behavioral-signal.json'), 'utf8'),
  );

  const db = new Database(dbPath, { readonly: true });
  const newPools: ItemPool[] = [];
  try {
    for (const item of items) {
      if (item.query.startsWith('<ABSENT-STUB')) continue;
      newPools.push(await buildPoolForItem(item, variants, db, behavioral, 20));
    }
  } finally {
    db.close();
  }

  // Merge with existing pool.json when scoped — otherwise a --only run
  // would silently discard every already-pooled item's data.
  let finalPools = newPools;
  if (onlyPrefix) {
    let existingPools: ItemPool[] = [];
    try {
      existingPools = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/dataset/pool.json'), 'utf8'));
    } catch {
      /* no existing pool.json yet — fine, finalPools stays as newPools */
    }
    const newIds = new Set(newPools.map((p) => p.item_id));
    finalPools = [...existingPools.filter((p) => !newIds.has(p.item_id)), ...newPools];
  }

  writeFileSync(join(REPO_ROOT, 'eval/dataset/pool.json'), JSON.stringify(finalPools, null, 2));
  const totalCandidates = finalPools.reduce((sum, p) => sum + p.candidates.length, 0);
  console.log(`Wrote eval/dataset/pool.json: ${finalPools.length} items, ${totalCandidates} total candidates`);
}

if (process.argv[1]?.endsWith('build-pool.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
