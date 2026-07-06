/**
 * Phase 0 — Ingestion & index coverage funnel (spec §6.1).
 *
 * doc_id === vault-relative path (spec F9), so the funnel is a disk walk vs.
 * direct SQL against the live DB. Answers G2: is Plaud / AI-session content
 * actually reaching the FTS index and the embedding layer?
 *
 * Read-only. Never mutates the index.
 *
 * Run: npx tsx eval/score/coverage.ts
 */
import Database from 'better-sqlite3';
import { readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadConfig } from '../../src/config/loader.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** Prefixes to profile (vault-relative, matching doc_id). */
const PREFIXES = [
  'Plaud/',
  'AI Conversations/',
  'AI Conversations/_summaries/',
  'AI Conversations/claude/',
  'Curated/wiki/',
  'Curated/sources/',
  'Curated/wiki/meetings/',
  'Curated/wiki/decisions/',
  'Curated/wiki/entities/',
  'Curated/wiki/digests/',
];

/** Recursively count *.md files under an absolute dir (0 if missing). */
function countMarkdownOnDisk(absDir: string): number {
  let n = 0;
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = join(absDir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) n += countMarkdownOnDisk(full);
    else if (e.toLowerCase().endsWith('.md')) n += 1;
  }
  return n;
}

interface FunnelRow {
  prefix: string;
  on_disk: number;
  in_fts: number;
  in_embeddings: number;
  drop_disk_to_fts: number;
  drop_fts_to_emb: number;
  pct_fts: number; // on_disk -> fts
  pct_emb: number; // fts -> emb
}

async function main() {
  const config = await loadConfig(REPO_ROOT);
  const vaultPath = config.vaultPath;
  const dbPath = join(REPO_ROOT, config.stateDir, 'embeddings.sqlite');
  const db = new Database(dbPath, { readonly: true });

  // Provider id used by the embeddings table (spec: ollama-nomic-embed-text-768).
  const providerRow = db
    .prepare('SELECT provider_id, COUNT(DISTINCT doc_id) c FROM embeddings GROUP BY provider_id ORDER BY c DESC LIMIT 1')
    .get() as { provider_id: string; c: number } | undefined;
  const providerId = providerRow?.provider_id ?? '(none)';

  const ftsStmt = db.prepare(
    "SELECT COUNT(*) c FROM fts_meta WHERE doc_id LIKE ? ESCAPE '\\'",
  );
  const embStmt = db.prepare(
    "SELECT COUNT(DISTINCT doc_id) c FROM embeddings WHERE provider_id = ? AND doc_id LIKE ? ESCAPE '\\'",
  );

  const rows: FunnelRow[] = [];
  for (const prefix of PREFIXES) {
    const like = prefix.replace(/[%_\\]/g, '\\$&') + '%';
    const on_disk = countMarkdownOnDisk(join(vaultPath, prefix));
    const in_fts = (ftsStmt.get(like) as { c: number }).c;
    const in_embeddings = (embStmt.get(providerId, like) as { c: number }).c;
    rows.push({
      prefix,
      on_disk,
      in_fts,
      in_embeddings,
      drop_disk_to_fts: on_disk - in_fts,
      drop_fts_to_emb: in_fts - in_embeddings,
      pct_fts: on_disk ? +(100 * in_fts / on_disk).toFixed(1) : 0,
      pct_emb: in_fts ? +(100 * in_embeddings / in_fts).toFixed(1) : 0,
    });
  }

  const totals = {
    fts_total: (db.prepare('SELECT COUNT(*) c FROM fts_meta').get() as { c: number }).c,
    emb_total: (db.prepare('SELECT COUNT(DISTINCT doc_id) c FROM embeddings').get() as { c: number }).c,
    newest_indexed_at: (db.prepare('SELECT MAX(indexed_at) m FROM fts_meta').get() as { m: string }).m,
    provider_id: providerId,
  };
  db.close();

  // Report
  const pad = (s: string | number, n: number) => String(s).padStart(n);
  const padr = (s: string, n: number) => s.padEnd(n);
  console.log('\n=== INGESTION & INDEX COVERAGE FUNNEL ===');
  console.log(`vault: ${vaultPath}`);
  console.log(`db:    ${dbPath}`);
  console.log(`provider_id: ${totals.provider_id}  |  newest indexed_at: ${totals.newest_indexed_at}`);
  console.log(`FTS total: ${totals.fts_total}   Embedded (distinct docs): ${totals.emb_total}  (${(100*totals.emb_total/totals.fts_total).toFixed(1)}% of FTS)`);
  console.log('');
  console.log(`${padr('prefix', 34)} ${pad('disk', 7)} ${pad('fts', 7)} ${pad('emb', 7)} ${pad('disk→fts%', 10)} ${pad('fts→emb%', 9)}`);
  console.log('-'.repeat(80));
  for (const r of rows) {
    console.log(
      `${padr(r.prefix, 34)} ${pad(r.on_disk, 7)} ${pad(r.in_fts, 7)} ${pad(r.in_embeddings, 7)} ${pad(r.pct_fts + '%', 10)} ${pad(r.pct_emb + '%', 9)}`,
    );
  }

  const outDir = join(REPO_ROOT, 'eval', 'results');
  mkdirSync(outDir, { recursive: true });
  const out = { generated_at: new Date().toISOString(), totals, funnel: rows };
  writeFileSync(join(outDir, 'coverage-funnel.json'), JSON.stringify(out, null, 2));
  console.log(`\nWrote ${relative(REPO_ROOT, join(outDir, 'coverage-funnel.json'))}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
