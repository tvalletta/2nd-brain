/**
 * Phase 0 — Dataset assembly (spec §9.3).
 *
 * Combines mined log queries + session queries + known-failure signals into a
 * balanced DRAFT eval set: dataset/queries.json. Applies:
 *   - a tight vault-retrieval filter to session prompts (the mining regex is
 *     intentionally loose; this narrows to knowledge-base questions),
 *   - dedup by normalized-token Jaccard >= 0.7,
 *   - heuristic category + subtype tagging (Tom / the Phase-2 judge refine),
 *   - balanced sampling to per-category targets,
 *   - an author-provided absent slice (spec §7.5) kept as a stub for Tom to fill.
 *
 * Category/subtype tags are DRAFT heuristics; final ground-truth relevance comes
 * from the pooling + LLM-judge + calibration gate in Phase 2. Items are emitted
 * with `needs_review: true` so the human pass is explicit.
 *
 * Run (after parse-usage-log + parse-sessions): npx tsx eval/mine/build-dataset.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DS = join(REPO_ROOT, 'eval', 'dataset');

type Category = 'plaud-ai-session' | 'entities' | 'hot-topics' | 'decisions';
type Subtype = 'lookup' | 'synthesis' | 'relationship' | 'absent';

interface EvalItem {
  id: string;
  query: string;
  category: Category;
  subtype: Subtype;
  source: 'log' | 'session' | 'synthetic';
  source_ref: string;
  intent: string;
  is_regression: boolean;
  query_truncated: boolean;
  needs_review: boolean;
}

// ---- helpers --------------------------------------------------------------
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 2));
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

// tight vault-retrieval filter for session prompts
const VAULT_RETRIEVAL = /\b(vault|obsidian|plaud|voiceink|recording|transcript|meeting|1:1|standup|architecture council|session|my notes|decision|decided|who is|what did|what do we|find|look up|recall|remember|curat|entity|entities)\b/i;

function classify(q: string): { category: Category; subtype: Subtype } {
  const s = q.toLowerCase();
  // category
  let category: Category = 'decisions';
  if (/\b(recording|plaud|voiceink|transcript|meeting|1:1|standup|session|architecture council|conversation)\b/.test(s)) category = 'plaud-ai-session';
  else if (/\b(who|person|people|architect|engineer|team member|entity|entities|works? (with|on)|reports? to)\b/.test(s)) category = 'entities';
  else if (/\b(hot|important|recent|latest|current|this week|what am i working on|what'?s going on|trending|top)\b/.test(s)) category = 'hot-topics';
  else if (/\b(decid|decision|approv|calibrat|chose|choice|why did (we|i)|agreed)\b/.test(s)) category = 'decisions';
  // subtype
  let subtype: Subtype = 'lookup';
  if (/\b(related|connection|relationship|who (works|worked)|how does .* relate|linked)\b/.test(s)) subtype = 'relationship';
  else if (/\b(summar|across|overall|trend|all (the|my)|what have (i|we)|synthesi|roll ?up|everything (about|on))\b/.test(s)) subtype = 'synthesis';
  return { category, subtype };
}

function main() {
  const logQ: any[] = JSON.parse(readFileSync(join(DS, 'mined-log-queries.json'), 'utf8'));
  const sessQ: any[] = existsSync(join(DS, 'mined-session-queries.json'))
    ? JSON.parse(readFileSync(join(DS, 'mined-session-queries.json'), 'utf8'))
    : [];
  const routing = JSON.parse(readFileSync(join(REPO_ROOT, 'eval', 'results', 'routing-analysis.json'), 'utf8'));

  const candidates: Omit<EvalItem, 'id'>[] = [];

  // sets for in-place tagging (these queries ARE in the log, so don't re-append)
  const zeroHitSet = new Set<string>((routing.zero_hits ?? []).filter((z: any) => z.query).map((z: any) => norm(z.query)));
  const errorSet = new Set<string>((routing.errors ?? []).filter((e: any) => e.args?.query).map((e: any) => norm(e.args.query)));

  // enough meaningful tokens to be answerable (drop single-word/ambiguous queries)
  const meaningful = (q: string) => tokens(q).size >= 2;

  // 1. log queries (real searches; retrieval by construction) — tag zero-hit/regression in place
  for (const q of logQ) {
    if (!meaningful(q.query)) continue; // e.g. "meeting", "Spectre" alone
    const n = norm(q.query);
    const isErr = errorSet.has(n);
    const isZero = zeroHitSet.has(n);
    let { category, subtype } = classify(q.query);
    if (isZero && category === 'decisions') category = 'entities'; // zero-hits skew people
    candidates.push({
      query: q.query,
      category,
      subtype,
      source: 'log',
      source_ref: isErr ? `error:log` : isZero ? `zerohit:log` : `log:${q.ts}`,
      intent: isErr
        ? 'regression: previously crashed search_vault (localeCompare bug)'
        : isZero
          ? 'known zero-hit in production; expected to be findable (recall test)'
          : '',
      is_regression: isErr,
      query_truncated: false,
      needs_review: true,
    });
  }

  // 2. session queries passing the tight vault-retrieval filter (natural-language questions)
  const sessSeen = new Set<string>();
  for (const q of sessQ) {
    if (!VAULT_RETRIEVAL.test(q.query)) continue;
    const one = q.query.replace(/\n+/g, ' ').trim();
    if (one.length < 15 || one.length > 400 || !meaningful(one)) continue;
    const key = norm(one).slice(0, 120);
    if (sessSeen.has(key)) continue;
    sessSeen.add(key);
    const { category, subtype } = classify(one);
    candidates.push({
      query: one,
      category,
      subtype,
      source: 'session',
      source_ref: `session:${q.session_hex}`,
      intent: '',
      is_regression: false,
      query_truncated: !!q.truncated,
      needs_review: true,
    });
  }

  // 3. synthetic hot-topics backfill (grounded in real recent projects/themes seen
  //    in the vault; nobody TYPES "what's hot", so this category must be authored).
  const hotTopics: string[] = [
    'what are the hottest topics I have been working on recently',
    'summarize what I have been focused on this week',
    'what is the current state of the Workfront MCP gateway project',
    'what recent decisions have I made about MCP server architecture',
    'what is the latest on the discovery service consolidation',
    'what have I been doing with the AI engineering curriculum',
    'what are the active projects in my vault right now',
    'what did I work on most in the last two weeks',
  ];
  for (const q of hotTopics) {
    candidates.push({
      query: q,
      category: 'hot-topics',
      subtype: 'synthesis',
      source: 'synthetic',
      source_ref: 'author:hot-topics',
      intent: 'exercises the hot-cache / digest layer (spec G3); grounded in real recent themes',
      is_regression: false,
      query_truncated: false,
      needs_review: true,
    });
  }

  // dedup across all candidates by Jaccard >= 0.7
  const kept: Omit<EvalItem, 'id'>[] = [];
  const keptTokens: Set<string>[] = [];
  for (const c of candidates) {
    const t = tokens(c.query);
    if (t.size === 0) continue;
    let dup = false;
    for (const kt of keptTokens) if (jaccard(t, kt) >= 0.7) { dup = true; break; }
    if (dup) continue;
    kept.push(c);
    keptTokens.push(t);
  }

  // balanced sampling to targets
  const TARGET: Record<Category, number> = {
    'plaud-ai-session': 25,
    entities: 20,
    'hot-topics': 18,
    decisions: 20,
  };
  const byCat = new Map<Category, Omit<EvalItem, 'id'>[]>();
  for (const c of kept) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category)!.push(c);
  }
  // prefer: regression > zero-hit > natural-language question > synthetic hot-topic
  // > multi-word log query > other session. Natural-language questions make the
  // best eval items (unambiguous intent); terse log keywords rank lower.
  const rank = (c: Omit<EvalItem, 'id'>) => {
    if (c.is_regression) return 0;
    if (c.source_ref.startsWith('zerohit')) return 1;
    if (/\?/.test(c.query) || c.source === 'session') return 2;
    if (c.source === 'synthetic') return 3;
    return 4;
  };
  const selected: Omit<EvalItem, 'id'>[] = [];
  for (const [cat, target] of Object.entries(TARGET) as [Category, number][]) {
    const pool = (byCat.get(cat) ?? []).sort((a, b) => rank(a) - rank(b) || b.query.length - a.query.length);
    selected.push(...pool.slice(0, target));
  }

  // absent slice stubs (spec §7.5) — Tom fills real absent topics; kept minimal
  const absentStubs: Omit<EvalItem, 'id'>[] = [
    { query: '<ABSENT-STUB: author a query about a topic verified NOT in the vault>', category: 'decisions', subtype: 'absent', source: 'synthetic', source_ref: 'author', intent: 'robustness: system should return nothing / low-confidence', is_regression: false, query_truncated: false, needs_review: true },
  ];
  selected.push(...absentStubs);

  // assign ids
  const counters = new Map<string, number>();
  const items: EvalItem[] = selected.map((c) => {
    const n = (counters.get(c.category) ?? 0) + 1;
    counters.set(c.category, n);
    return { id: `${c.category}-${String(n).padStart(3, '0')}`, ...c };
  });

  // report
  const dist = new Map<string, number>();
  for (const it of items) {
    dist.set(it.category, (dist.get(it.category) ?? 0) + 1);
    dist.set(`${it.category}:${it.subtype}`, (dist.get(`${it.category}:${it.subtype}`) ?? 0) + 1);
  }
  console.log('\n=== DRAFT EVAL SET ASSEMBLED ===');
  console.log(`candidates: ${candidates.length}  ->  deduped: ${kept.length}  ->  selected: ${items.length}`);
  console.log('by category:');
  for (const cat of ['plaud-ai-session', 'entities', 'hot-topics', 'decisions'] as Category[]) {
    console.log(`  ${cat.padEnd(18)} ${dist.get(cat) ?? 0}`);
  }
  console.log('by source:', ['log', 'session', 'synthetic'].map((s) => `${s}=${items.filter((i) => i.source === s).length}`).join('  '));
  console.log(`regression items: ${items.filter((i) => i.is_regression).length}  |  zero-hit items: ${items.filter((i) => i.source_ref.startsWith('zerohit')).length}  |  truncated queries: ${items.filter((i) => i.query_truncated).length}`);
  console.log('\n--- sample items ---');
  for (const it of items.slice(0, 10)) console.log(`  ${it.id} [${it.subtype}] ${it.query.replace(/\n/g, ' ').slice(0, 90)}`);

  writeFileSync(join(DS, 'queries.json'), JSON.stringify(items, null, 2));
  console.log(`\nWrote eval/dataset/queries.json (${items.length} items) — needs_review=true on all; Tom + Phase-2 judge refine categories/intent.`);
}

main();
