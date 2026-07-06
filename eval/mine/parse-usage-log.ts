/**
 * Phase 0 — Usage-log analysis (spec §7.4 routing, §9.1 mining, F1/F2/F8/F10).
 *
 * Parses .karpathy/logs/mcp-usage.jsonl to produce:
 *   1. Tool distribution + latency (median/p95) per tool.
 *   2. Routing accuracy: fraction of free-text search calls that used the fast
 *      `search` vs. the deprecated slow `search_vault` — overall and by month.
 *   3. Zero-hit detection via the F2 rule (missing result_count + small chars).
 *   4. Behavioral relevance map: notes opened (get_note/batch_get_notes) shortly
 *      after a search, in the same working session — feeds pooling (spec §8.1.4).
 *   5. Extracted free-text queries (deduped) → candidate eval queries.
 *   6. The two F10 error queries flagged as regression items.
 *
 * Read-only. Run: npx tsx eval/mine/parse-usage-log.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const LOG = join(REPO_ROOT, '.karpathy', 'logs', 'mcp-usage.jsonl');

interface LogEntry {
  ts: string;
  tool: string;
  args: Record<string, any>;
  duration_ms: number;
  success: boolean;
  result_chars: number;
  result_count?: number;
  error?: string;
}

/** Tools that serve a free-text `query` and should route to the fast path. */
const SEARCH_CLASS = new Set(['search', 'search_vault', 'search_entities']);
/** The deprecated slow tool — every call is a routing miss (should be `search`). */
const DEPRECATED = 'search_vault';

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function main() {
  const lines = readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim());
  const entries: LogEntry[] = lines.map((l) => JSON.parse(l));

  // 1. tool distribution + latency
  const byTool = new Map<string, LogEntry[]>();
  for (const e of entries) {
    if (!byTool.has(e.tool)) byTool.set(e.tool, []);
    byTool.get(e.tool)!.push(e);
  }

  // 2. routing accuracy (search-class only): fast `search` = hit, `search_vault` = miss
  const searchCalls = entries.filter((e) => SEARCH_CLASS.has(e.tool));
  const routingCorrect = (e: LogEntry) => e.tool === 'search' || e.tool === 'search_entities';
  const overallCorrect = searchCalls.filter(routingCorrect).length;
  const byMonth = new Map<string, { correct: number; total: number }>();
  for (const e of searchCalls) {
    const m = e.ts.slice(0, 7);
    const rec = byMonth.get(m) ?? { correct: 0, total: 0 };
    rec.total += 1;
    if (routingCorrect(e)) rec.correct += 1;
    byMonth.set(m, rec);
  }

  // 3. zero-hit detection (F2): search success but no result_count and tiny chars
  const zeroHits = entries.filter(
    (e) => SEARCH_CLASS.has(e.tool) && e.success && e.result_count === undefined && e.result_chars < 120,
  );

  // 4. behavioral relevance map: for each search, the note paths opened within
  //    the next 5 minutes (proxy for same-session follow-up reads).
  const WINDOW_MS = 5 * 60 * 1000;
  const behavioral: { query: string; ts: string; opened: string[] }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.tool !== 'search' && e.tool !== 'search_vault') continue;
    const q = e.args?.query;
    if (!q) continue;
    const t0 = Date.parse(e.ts);
    const opened: string[] = [];
    for (let j = i + 1; j < entries.length; j++) {
      const f = entries[j];
      if (Date.parse(f.ts) - t0 > WINDOW_MS) break;
      if (f.tool === 'get_note' && f.args?.path) opened.push(f.args.path);
      if (f.tool === 'batch_get_notes' && Array.isArray(f.args?.paths)) opened.push(...f.args.paths);
    }
    if (opened.length) behavioral.push({ query: q, ts: e.ts, opened: [...new Set(opened)] });
  }

  // 5. extracted free-text queries (deduped, normalized)
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const seen = new Set<string>();
  const queries: { query: string; tool: string; ts: string; result_count: number | null; duration_ms: number }[] = [];
  for (const e of searchCalls) {
    const q = e.args?.query;
    if (!q) continue;
    const key = norm(q);
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push({ query: q, tool: e.tool, ts: e.ts, result_count: e.result_count ?? null, duration_ms: e.duration_ms });
  }

  // 6. F10 error queries
  const errors = entries.filter((e) => e.error).map((e) => ({ tool: e.tool, args: e.args, error: e.error, ts: e.ts }));

  // ---- report ----
  console.log('\n=== TOOL DISTRIBUTION & LATENCY ===');
  const rows = [...byTool.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [tool, es] of rows) {
    const lat = es.map((e) => e.duration_ms);
    console.log(
      `${tool.padEnd(22)} n=${String(es.length).padStart(4)}  median=${String(median(lat)).padStart(6)}ms  p95=${String(pct(lat, 95)).padStart(6)}ms  max=${String(Math.max(...lat)).padStart(6)}ms`,
    );
  }

  console.log('\n=== ROUTING ACCURACY (search-class calls; fast=hit, search_vault=miss) ===');
  console.log(`overall: ${overallCorrect}/${searchCalls.length} = ${(100 * overallCorrect / searchCalls.length).toFixed(1)}% used the fast path`);
  console.log('by month:');
  for (const [m, rec] of [...byMonth.entries()].sort()) {
    console.log(`  ${m}: ${rec.correct}/${rec.total} = ${(100 * rec.correct / rec.total).toFixed(1)}% fast`);
  }

  console.log('\n=== ZERO-HIT SEARCHES (F2 rule) ===');
  console.log(`${zeroHits.length} zero-hit search calls`);
  for (const z of zeroHits.slice(0, 12)) console.log(`  [${z.tool}] "${z.args?.query}" (chars=${z.result_chars})`);

  console.log('\n=== BEHAVIORAL RELEVANCE SIGNAL (search → notes opened ≤5min) ===');
  console.log(`${behavioral.length} searches with follow-up note opens`);

  console.log('\n=== EXTRACTED FREE-TEXT QUERIES (deduped) ===');
  console.log(`${queries.length} distinct queries`);

  console.log('\n=== LOGGED TOOL ERRORS (F10) ===');
  for (const er of errors) console.log(`  [${er.tool}] args=${JSON.stringify(er.args).slice(0, 80)} -> ${er.error}`);

  const outDir = join(REPO_ROOT, 'eval', 'dataset');
  mkdirSync(outDir, { recursive: true });
  const resDir = join(REPO_ROOT, 'eval', 'results');
  mkdirSync(resDir, { recursive: true });

  writeFileSync(
    join(resDir, 'routing-analysis.json'),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        tool_distribution: rows.map(([tool, es]) => ({
          tool,
          n: es.length,
          median_ms: median(es.map((e) => e.duration_ms)),
          p95_ms: pct(es.map((e) => e.duration_ms), 95),
        })),
        routing: {
          overall_fast_pct: +(100 * overallCorrect / searchCalls.length).toFixed(1),
          overall: { correct: overallCorrect, total: searchCalls.length },
          by_month: Object.fromEntries([...byMonth.entries()].sort()),
        },
        zero_hits: zeroHits.map((z) => ({ tool: z.tool, query: z.args?.query, chars: z.result_chars })),
        errors,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(outDir, 'mined-log-queries.json'), JSON.stringify(queries, null, 2));
  writeFileSync(join(outDir, 'behavioral-signal.json'), JSON.stringify(behavioral, null, 2));
  console.log('\nWrote eval/results/routing-analysis.json, eval/dataset/mined-log-queries.json, eval/dataset/behavioral-signal.json');
}

main();
