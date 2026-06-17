# Hybrid Search Design

**Date:** 2026-06-17
**Status:** Approved — ready for implementation planning
**Author:** Tom Valletta (via superpowers:brainstorming)

---

## 1. Problem Statement

The Karpathy MCP has a hard time finding things in the Obsidian vault. The root cause is two-fold:

**Coverage gap:** Only 737 of 22,173 vault files (3.3%) are embedded in the semantic search store. The `get_related` tool can only "see" 3 in every 100 notes.

**Siloed tools:** `search_vault` (keyword) and `get_related` (semantic) are completely independent systems. Claude must choose between them upfront. When AWS credentials expire, semantic search fails entirely. When a transcript uses different words than the query, keyword search returns nothing. Neither incorporates the other's signal.

**Goal:** A single unified `search` MCP tool that combines BM25 full-text search (covering 100% of the vault from day one) with Ollama semantic embeddings (fully local, always-on) via Reciprocal Rank Fusion — with a four-layer sync strategy to keep the index current as files arrive from Obsidian, Plaud, VoiceInk, and OneDrive.

---

## 2. Decisions

| Question | Decision | Rationale |
|---|---|---|
| Unify vs. add a tool | **Single unified `search` tool** — deprecate both `search_vault` and `get_related` | Eliminates cognitive overhead; Claude picks the right tool 100% of the time |
| Embedding provider | **Ollama (local)** — `nomic-embed-text` | Always-on, no credential expiry, no API cost; eliminates the AWS failure mode |
| Architectural approach | **New `src/search/` module** — `HybridStore` encapsulating FTS5 + embeddings + RRF | Clean abstraction; `sqlite-vec` HNSW is a two-file swap later if needed |
| Query interface | **Both text `query` and note `path` as query anchor** | Preserves `get_related`'s path-anchor workflow; path resolves to `title + tldr + body[:800]` |
| Ollama-down behavior | **Keyword-only fallback** — not an error | `search_mode: "keyword-only"` + `degradation_note` in response; FTS5 still returns full results |
| FTS5 scope | **All 22,173 vault files** — scanned directly from disk | FTS5 is cheap (no API calls); full coverage on day 1 regardless of embedding state |
| Embedding scope | **Ingest pipeline only** — not all vault files | Ollama embedding is ~8ms/file × 22k = 18 min; too expensive to do on every sync |
| Sync interval | **5 minutes** for FTS sync | Stat walk of 22k files = **56ms** measured; 5-min interval matches OneDrive/VoiceInk latency |

---

## 3. Architecture

### 3.1 Module structure

```
src/search/                         ← new module
  fts-index.ts                      FTSIndex class — FTS5 virtual table, BM25, upsert/delete/sync
  rrf.ts                            Reciprocal Rank Fusion utility
  hybrid-store.ts                   HybridStore — composes FTSIndex + EmbeddingStore + recency
  factory.ts                        openHybridStoreFromConfig() — parallel to openStoreFromConfig
  index.ts                          barrel exports

src/embeddings/ollama.ts            ← new — OllamaProvider implementing EmbeddingProvider
src/embeddings/factory.ts           ← updated — adds 'ollama' case to createProviderFromConfig
src/mcp/tools/search.ts             ← new — unified search tool
src/mcp/tools/search-vault.ts       ← deprecated (description updated, impl unchanged)
src/mcp/tools/get-related.ts        ← deprecated (description updated, impl unchanged)
src/jobs/handlers/sync-fts-index.ts ← new job handler
src/hooks/stop.ts                   ← updated — enqueues sync-fts-index at session end
src/intelligence/scheduler.ts       ← updated — adds sync-fts-index at 5-min interval
```

### 3.2 Storage — one file, two tables

Both live in `.karpathy/state/embeddings.sqlite`. No new database file.

```sql
-- Existing table — unchanged
CREATE TABLE IF NOT EXISTS embeddings (
  provider_id  TEXT NOT NULL,
  doc_id       TEXT NOT NULL,
  chunk_index  INTEGER NOT NULL,
  chunk_hash   TEXT NOT NULL,
  text         TEXT NOT NULL,
  vector       BLOB NOT NULL,
  metadata     TEXT NOT NULL DEFAULT '{}',
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (provider_id, doc_id, chunk_index)
);

-- New: FTS5 virtual table for keyword search
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  doc_id UNINDEXED,
  title,
  body,
  content=''                -- contentless: no stored text, index only
);

-- New: companion table for mtime-based change detection
CREATE TABLE IF NOT EXISTS fts_meta (
  doc_id      TEXT    PRIMARY KEY,   -- vault-relative path
  file_mtime  INTEGER NOT NULL,      -- Unix ms from fs.stat().mtimeMs
  indexed_at  TEXT    NOT NULL       -- ISO timestamp of last FTS5 upsert
);
```

### 3.3 Search pipeline

```
query text
  │
  ├─ Stage 1a: FTS5 BM25 keyword pool ─────────── poolK candidates
  │   (notes_fts virtual table, all 22k files)
  │
  ├─ Stage 1b: Ollama cosine semantic pool ──────── poolK candidates
  │   (embeddings table, ingested files only)
  │   [skipped if Ollama unavailable → keyword-only mode]
  │
  ├─ Stage 2: Reciprocal Rank Fusion ────────────── unified ranked list
  │   score_i = Σ 1 / (60 + rank_j)   [k=60, standard]
  │   dedupe by doc_id — keep best-scoring chunk per document
  │
  └─ Stage 3: Recency fusion ────────────────────── final ranked list
      final = α · rrfScore + β · exp(−days / 30)
      β per content type via config.intelligence.recencyWeight
      (existing logic, extracted as pure function)
```

### 3.4 Key interfaces

```typescript
// src/search/fts-index.ts
export interface FTSHit {
  docId: string;
  bm25Rank: number;   // raw BM25 rank (negative, lower = better)
  snippet: string;    // FTS5 snippet() around the match
}

export interface SyncStats {
  added: number; updated: number; removed: number; unchanged: number;
}

export class FTSIndex {
  upsert(docId: string, title: string, body: string): void;
  delete(docId: string): void;
  query(text: string, limit: number): FTSHit[];
  sync(vaultDirs: string[]): Promise<SyncStats>;  // mtime-based incremental scan
  close(): void;
}

// src/search/rrf.ts
export interface RRFInput { docId: string; rank: number; }
export interface RRFResult { docId: string; score: number; }
export function rrf(lists: RRFInput[][], k?: number): RRFResult[];

// src/search/hybrid-store.ts
export interface HybridHit {
  docId: string;
  chunkIndex: number;
  text: string;
  metadata: Record<string, unknown>;
  updated_at: string;
  scores: {
    keywordRank?: number;
    semanticSim?: number;
    rrf: number;
    recency: number;
    final: number;
  };
  excerpt?: string;   // FTS5 snippet if keyword matched, else chunk text
}

export interface HybridSearchOptions {
  topK?: number;           // default 10
  poolK?: number;          // default max(50, topK * 5)
  filter?: (hit: HybridHit) => boolean;
  scope?: 'vault' | 'this-week' | 'project';
  projectSlug?: string;
  noteType?: string;
}

export interface HybridStore {
  search(query: string, options?: HybridSearchOptions): Promise<{
    hits: HybridHit[];
    searchMode: 'hybrid' | 'keyword-only';
    degradationNote?: string;
  }>;
  upsertDoc(docId: string, title: string, body: string, chunks: UpsertInput[]): Promise<void>;
  deleteDoc(docId: string): Promise<void>;
  syncFTS(vaultDirs: string[]): Promise<SyncStats>;
  close(): void;
}

// src/embeddings/ollama.ts
export interface OllamaProviderOptions {
  baseUrl: string;           // default: 'http://localhost:11434'
  model: string;             // e.g. 'nomic-embed-text'
  dimensions?: number;       // default: 768
  timeoutMs?: number;        // default: 5000
}

export function createOllamaProvider(opts: OllamaProviderOptions): EmbeddingProvider;
export async function isOllamaAvailable(baseUrl: string, timeoutMs?: number): Promise<boolean>;
```

---

## 4. Data Flow

### 4.1 Text query path

```
search({ query: "why did we pick Bedrock?" })
  → validate: query present
  → isOllamaAvailable() → true/false
  → Stage 1a: ftsIndex.query(query, poolK)     → FTSHit[]
  → Stage 1b (if Ollama up): store.search(query, {topK: poolK}) → SearchHit[]
  → rrf([keyword_pool, semantic_pool])          → RRFResult[] (deduped by docId)
  → recency fusion                              → HybridHit[] sorted by finalScore
  → slice to topK
  → apply note_type + scope filters
  → fetch metadata for detail='full'/'metadata'
  → return { searchMode, degradationNote?, results }
```

### 4.2 Path anchor path

```
search({ path: "wiki/projects/karpathy.md" })
  → validate: path present
  → vault.read(path)
  → parse frontmatter: title, tldr, body[:800]
  → queryText = [title, tldr, body[:800]].join('\n')
  → continue identical to text query path
  → filter: remove anchor doc from hits before returning
```

### 4.3 Ollama-down degradation

```
isOllamaAvailable() → false (connection refused or timeout > 5s)
  → skip Stage 1b entirely
  → rrf([keyword_pool_only]) → keyword-ranked results
  → response: { searchMode: 'keyword-only', degradationNote: 'Ollama not running — keyword results only', results }
  → NOT an error — results still returned
```

---

## 5. MCP Tool Interface

### 5.1 Unified search tool

**Name:** `search`

**Description:**
> Hybrid keyword + semantic search across all vault notes. Combines SQLite FTS5 BM25 full-text search (covers all 22k+ notes) with Ollama semantic embeddings for conceptual matches — degrades gracefully to keyword-only when Ollama is not running. Accepts a text query or a vault note path (finds notes similar to the anchor note). Replaces search_vault and get_related.

**Input schema:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | conditional | — | Free-text query. Required if `path` not provided. If both given, `query` takes precedence. |
| `path` | string | conditional | — | Vault-relative note path as query anchor. Finds notes similar to this note. |
| `note_type` | enum | optional | — | Filter by note type: `source_summary`, `session_summary`, `entity`, `project`, `decision`, `concept`, `contradiction`, `index` |
| `scope` | enum | optional | `"vault"` | `"vault"` (all), `"this-week"` (updated last 7d), `"project"` (requires `projectSlug`) |
| `projectSlug` | string | conditional | — | Required when `scope = "project"` |
| `limit` | number | optional | `10` | Max results. Maximum 50. |
| `detail` | enum | optional | `"summary"` | `"metadata"` (frontmatter only), `"summary"` (excerpt included), `"full"` (full body + frontmatter) |

**Error cases:**

| Trigger | Behavior |
|---|---|
| Neither `query` nor `path` | `isError: true` — "Provide either query or path." |
| `path` not found in vault | `isError: true` — "Note not found: {path}" |
| `scope = "project"` without `projectSlug` | `isError: true` — "projectSlug required when scope = project." |
| Ollama not running | Not an error. `search_mode: "keyword-only"` + `degradation_note` in response. |
| Zero results | Not an error. `results: []` + suggestion to broaden the query. |
| FTS5 index not yet populated | Falls back to embedding-only. Response notes FTS index needs `karpathy maintenance --populate-fts`. |

**Response shape:**

```typescript
{
  search_mode: 'hybrid' | 'keyword-only';
  degradation_note?: string;
  results: Array<{
    path: string;          // vault-relative doc_id
    title: string;         // from frontmatter
    type: string;          // note type
    excerpt: string;       // FTS5 snippet if keyword match, else chunk text
    updated_at: string;    // ISO date
    scores: { rrf: number; recency: number; final: number };
    body?: string;         // when detail = 'full'
    frontmatter?: Record<string, unknown>;  // when detail = 'metadata' | 'full'
  }>;
}
```

### 5.2 Legacy tool deprecation

Both tools keep their implementations unchanged — no regression risk.

**`search_vault`** description updated to:
> *Deprecated — use `search` instead. Will be removed in the next major version.*

**`get_related`** description updated to:
> *Deprecated — use `search` with a `path` param instead. Will be removed in the next major version.*

---

## 6. Vault Sync

### 6.1 The sync problem

The existing chokidar watcher has three gaps:
- Only handles `add` events (not `change` or `unlink`)
- `ignoreInitial: true` — misses files created while the process was down
- Only runs while the karpathy process is alive

Files from Obsidian, OneDrive, Plaud, and VoiceInk arrive outside the ingest pipeline and must be indexed regardless.

### 6.2 Four-layer sync design

**Layer 1 — Scheduled sync (primary): `sync-fts-index` every 5 minutes**

New job in `defaultSchedule()`:
```typescript
{
  type: 'sync-fts-index',
  cadence: 'every-5-min',
  intervalSec: 300,
  priority: 100,        // highest — always cheap
  dedupeKey: 'sync-fts-index',
}
```

Algorithm (`FTSIndex.sync(vaultDirs)`):
1. Walk all vault markdown directories, collect `{path, mtime}` for each file — **measured at 56ms for 22,195 files**
2. `SELECT doc_id, file_mtime FROM fts_meta` — one query, current indexed state
3. Diff:
   - New / mtime changed → read file, parse, upsert `notes_fts` + update `fts_meta`
   - In fts_meta but not on disk → `DELETE FROM notes_fts WHERE doc_id = ?` + remove from `fts_meta`
   - Unchanged → skip
4. Return `SyncStats { added, updated, removed, unchanged }`

Requires intel tick cron to run at 5-minute intervals (was 15–60 min). The tick is trivially cheap when expensive jobs aren't due — it just reads `intel-scheduler.json` and exits.

**Measured steady-state runtime (5-min interval, ~10 files changed):** ~150ms total.

**Layer 2 — Stop hook:**
`src/hooks/stop.ts` enqueues `sync-fts-index` (with `dedupeKey: 'sync-fts-index'`) at end of every Claude session. Ensures session-created content (session summaries, entity pages) is indexed before the next session starts. Zero latency during the session.

**Layer 3 — Ingest pipeline:**
`hybridStore.upsertDoc(docId, title, body, chunks)` is called from the ingest pipeline and re-enrich jobs. Updates both `notes_fts` (FTS5) and `embeddings` (Ollama vectors) in a single transaction. Zero lag for actively-enriched content.

**Layer 4 — Watcher enhancement:**
Add `change` and `unlink` event handlers to `src/ingest/watcher.ts` alongside the existing `add` handler. Each enqueues a single-file FTS upsert or delete. Real-time supplement when the process is running; not a replacement for the scheduled scan.

### 6.3 Intentional asymmetry

| Index | Scope | Frequency | Cost |
|---|---|---|---|
| FTS5 (`notes_fts`) | All 22,173+ vault files | Every 5 min | 56ms stat walk + ~8ms per changed file |
| Ollama embeddings | Ingest pipeline only | Per ingest/re-enrich | ~8ms per file (Ollama HTTP call) |

FTS5 provides full coverage from day 1. Semantic quality grows as ingest coverage expands. Embedding all 22k files automatically is not done — it would take ~18 minutes per run and is unnecessary given the FTS coverage.

---

## 7. Migration Steps

Run these in order once implementation is complete.

**Step 1 — Install Ollama and pull model**
```bash
brew install ollama
ollama pull nomic-embed-text
# Ollama auto-starts as a macOS launchd service after install
```

**Step 2 — Update `~/.karpathy/config.json`**
```json
"embeddings": {
  "provider": "ollama",
  "model": "nomic-embed-text",
  "baseUrl": "http://localhost:11434",
  "dimensions": 768
}
```
Add `baseUrl` field to the Zod config schema with default `"http://localhost:11434"`.

**Step 3 — Initial FTS5 population**
```bash
karpathy maintenance --populate-fts
```
New maintenance job that scans all vault markdown files and populates `notes_fts`. One-time run, ~4 minutes. Subsequent sync happens automatically via Layer 1–4.

**Step 4 — Eager re-embed existing 737 docs with Ollama**
```bash
karpathy maintenance --re-embed
karpathy maintenance --prune-provider titan-v2-1024
```
Re-embeds the 737 existing Bedrock Titan docs with Ollama (~60 seconds). Removes old Titan rows after. Without this step, the 737 docs are FTS5-searchable but not semantically searchable until they cycle through ingest.

**Step 5 — Update intel tick cron to 5 minutes**
```
# launchd plist: StartInterval 300 (was 900)
# or crontab: */5 * * * * karpathy intel tick
```

---

## 8. Test Plan

### Unit tests

**`test/search/fts-index.test.ts`**
- upsert + query returns ranked results
- title match scores higher than body match (BM25 property)
- multi-word query — all terms must be present in results
- delete removes doc from query results
- `snippet()` extracts text around the match position
- contentless FTS5 table — no stored body text returned (only index)
- `sync()` with mtime comparison: detects new/changed/deleted/unchanged files

**`test/search/rrf.test.ts`**
- single input list → passthrough (scores normalised by k)
- doc appearing in both lists outranks doc in one list
- k=60 produces stable rankings across varying list sizes
- empty list input → empty output
- deduplication: same docId from both pools → one RRFResult

**`test/search/hybrid-store.test.ts`**
- hybrid mode: both FTS5 and embedding pools contribute to final ranking
- keyword-only mode: Ollama mock unavailable → FTS5-only results with `search_mode: 'keyword-only'`
- path anchor: reads note, excludes anchor doc from results
- `scope: 'this-week'` filter applied correctly
- `scope: 'project'` filter applied correctly
- `note_type` filter applied correctly
- zero results returns `{ hits: [], searchMode: 'hybrid' }` (no throw)
- recency fusion: recently updated note ranks above stale same-relevance match
- deduplication: multiple chunks per doc → one HybridHit per doc

**`test/embeddings/ollama.test.ts`**
- happy path: mock HTTP server verifies POST `/api/embeddings` request body shape
- `isOllamaAvailable()` → `false` on connection refused
- `isOllamaAvailable()` → `false` on timeout (> `timeoutMs`)
- batch: N texts → N vectors, aligned 1:1 with input order
- Ollama error response → throws with readable message

**`test/mcp/tools/search.test.ts`**
- full pipeline with temp vault + temp SQLite DB
- text query: returns results in expected response shape with `search_mode`
- path anchor: related notes returned, anchor doc excluded
- Ollama mock down → `keyword-only` mode + `degradation_note` in response
- neither `query` nor `path` → `isError: true`
- `path` not found → `isError: true`
- `scope = 'project'` with no `projectSlug` → `isError: true`
- `detail: 'full'` → body and frontmatter included in results

**`test/jobs/handlers/sync-fts-index.test.ts`**
- new files detected via mtime scan → upserted into notes_fts
- modified files (mtime changed) → re-indexed
- deleted files → removed from notes_fts and fts_meta
- unchanged files → skipped (unchanged count incremented)
- returns correct SyncStats

### Regression tests

- All existing `test/mcp/tools/search-vault.test.ts` tests pass unchanged
- All existing `test/mcp/tools/get-related.test.ts` tests pass unchanged
- Deprecated tool descriptions verified in their definition exports

---

## 9. Implementation Estimate

| Work item | Days |
|---|---|
| `OllamaProvider` + `isOllamaAvailable()` + `factory.ts` update + Zod config field | 0.5 |
| `FTSIndex` — FTS5 virtual table, `fts_meta`, BM25 query, snippet, upsert/delete, `sync()` | 0.75 |
| `rrf.ts` — RRF utility, deduplication logic | 0.25 |
| `HybridStore` — compose FTSIndex + EmbeddingStore, recency fusion, factory fn, DB schema migration | 1.0 |
| Unified `search` MCP tool — schema, handler, all error cases, path anchor, legacy deprecation | 0.5 |
| `sync-fts-index` job handler + `stop.ts` hook + `watcher.ts` change/unlink handlers | 0.5 |
| `scheduler.ts` — add sync-fts-index entry, document 5-min tick requirement | 0.25 |
| Tests — all seven test files | 1.5 |
| Migration maintenance commands (`--populate-fts`, `--re-embed`, `--prune-provider`) | 0.5 |
| **Total** | **~5.75 days** |

---

## 10. Future Upgrade Path

The `HybridStore.search()` method currently uses brute-force cosine scan (O(n) over all chunks). At full vault coverage (~66,000 chunks, ~192MB of Float32 vectors), estimated query latency is 100–300ms — acceptable for a local single-user tool.

If query latency exceeds ~500ms at full coverage, the upgrade path is:
- Add `sqlite-vec` extension to the embeddings SQLite connection
- Replace brute-force cosine scan with HNSW ANN search via `sqlite-vec`
- This is a two-file change: `store.ts` (search method) + `factory.ts` (DB setup)
- The `HybridStore` interface is unchanged; callers are unaffected
