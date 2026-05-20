# Karpathy Intelligence Plan

**Status:** Draft proposal — research + plan, not yet specced into `specification.md`.
**Date:** 2026-05-06
**Goal:** Make Karpathy materially smarter at surfacing what matters *this week*, keeping topic notes thorough and current, auto-researching unfamiliar AI concepts, and applying recency-aware scoring so stale knowledge fades instead of accumulating.

---

## 1. Problem statement

Today Karpathy is feature-complete for the *plumbing*: ingest, classification, entity extraction, project hubs, deterministic backlinks/indexes, and basic review. The gaps are all in **semantic judgment** and **adaptive behavior**:

- No cross-session topic clustering or weekly rollup.
- No recency / decay / TTL — facts written in February look identical to facts written yesterday.
- No auto-research on unfamiliar AI/ML concepts; the web enricher exists but isn't triggered by curiosity signals.
- Entity extraction is greedy (audit 14 noted ~51 entities from one session, mostly noise).
- Contradiction and duplicate detection are word-overlap heuristics, not semantic.
- Skill matching is substring search.
- Topic notes are static — once written they don't get refreshed as new evidence arrives.

The user's concrete asks, in priority order:

1. **Hot topics of the week** — curated, linked, kept current, drawn primarily from meeting recordings (Claude desktop notes) plus dev sessions (Claude Code, Cursor).
2. **Thorough, living topic notes** — not just summaries; details kept fresh as related material flows in.
3. **Auto-research for unclear AI/ML concepts** — when something appears that the vault doesn't already explain, go find out.
4. **Recency / TTL scoring** — stale information loses weight; decay is visible in retrieval and review.

---

## 2. Baseline: what already exists

From the internal capability map (audit 14, src/agent/, src/maintenance/, src/review/):

| Area | State |
|------|-------|
| Ingest + classification + content router | Done |
| Entity extraction & resolver | Done; **noisy** — no significance filter |
| Project hubs (`wiki/projects/{slug}/_index.md`) | Done; mechanical |
| Backlinks & indexes | Done; full-rebuild default |
| Synthesis skills | Registered, but matched by substring |
| Web enricher (`src/enrichment/web-enricher.ts`) | Utility; not auto-triggered |
| Decay job | Stubbed in cascade diagram only — no handler |
| Topic clustering / weekly rollup | Not implemented |
| Contradiction / duplicate | Heuristic (word overlap, Jaccard) |
| MCP read/write tools | 18 implemented; no auth layer |

The architecture (protected regions, atomic writes, job queue with dedupe, Zod-validated frontmatter) is the right foundation. The plan below adds *intelligence layers on top of it* — it does not require re-architecting.

---

## 3. Patterns to borrow from prior art

Distilled from research across Karpathy's LLM wiki, Khoj, Reor, Basic Memory, Smart Connections, Mem.ai, Cole Medin's agentic-RAG, BERTopic/BERTrend, RAPTOR, GraphRAG, Chain of Density, FSRS, and LangMem. Full citations in §10.

The eight patterns that map directly onto our system:

1. **Karpathy v2 frontmatter** — `last_verified`, `confidence`, `superseded_by`, `contradicts`, `stability`. Adds the ground truth we need for decay and contradiction-as-asset.
2. **Top-of-page TL;DR via Chain of Density** — every concept/topic note opens with a ≤50-char protected summary, rewritten on update. Makes the agent's scans dramatically cheaper.
3. **`log.md` + `index.md` at vault root** — append-only chronological ledger + lightweight catalog the agent re-projects rather than mutates.
4. **BERTopic + BERTrend for hot topics** — embed last-N-days chunks, HDBSCAN over UMAP, label with LLM, classify clusters as weak/strong signal by week-over-week growth.
5. **RAPTOR-style hierarchy** — leaf chunks → cluster summaries → digest summaries → project overview. Always-current at every zoom level.
6. **FSRS-style decay** — every fact has `stability` (days from 100%→90% confidence) and `last_verified`. Retrievability = `exp(-Δt / stability)`. Decay flips low-stability low-retrievability notes into the review queue and the auto-research queue.
7. **Auto-research loop (Karpathy autoresearch / autoresearch-skill)** — when a concept is missing or stale: 5 framing-different queries → coverage check → bounded iteration (≤3 rounds) → write into protected region with sources and bumped `last_verified`.
8. **Two-stage retrieval with recency fusion** — bi-encoder top-K → cross-encoder rerank → recency boost. β tunable per content type (high for transcripts, low for stable concept notes).

Patterns we deliberately *skip* for v1: full GraphRAG community detection (overkill at our corpus size), Anki-style spaced-repetition UX (we want decay for relevance, not for human recall), heavy KG (we already have a decent graph via backlinks + entities).

---

## 4. The plan — ten changes, prioritized

Each change is sized as: **S** (≤2 days), **M** (≤1 week), **L** (>1 week). Phases are stacked so each phase shrinks the next.

### Phase A — Foundations (must land first)

#### A1. Extend frontmatter for time-aware knowledge **(S)**

Add to base schema in `src/vault/frontmatter.ts`:

```ts
last_verified: string | null     // ISO date; bumped on auto-research or explicit re-confirm
stability: number                // FSRS-ish: days for confidence to halve. Default 30.
half_life_domain: string         // e.g. "ai-research" → 90d, "decisions" → 365d, "people" → ∞
superseded_by: string[]          // wiki-link IDs of newer notes that replace this one
contradicts: { ref: string; reason: string }[]
tldr: string                     // <=120 char summary, also mirrored in protected region
hot_score: number                // 0..1, computed by digest job; empty if not in last digest
```

Migrate by writing a one-shot job that backfills `last_verified = updated_at`, `stability = 30`, `tldr = first sentence`. Existing notes pass without fail.

#### A2. Embedding store **(M)**

Add a content-addressable embedding store (`.karpathy/embeddings/`) keyed by `(file_path, chunk_hash)`. Use a small local model first (e.g. `bge-small-en-v1.5` via [fastembed-js](https://github.com/Anush008/fastembed-js)) so we don't need network for the hot path. Bedrock Titan as the cloud fallback for higher quality.

Required for: A3 (TL;DR enforcement on update), B1 (clustering), B3 (related-notes), B4 (rerank-with-recency).

#### A3. TL;DR protected region + Chain-of-Density updater **(S after A1, A2)**

Every concept/topic/project-hub note gets a `%% begin:tldr %%`/`%% end:tldr %%` region. On every write to the note, an enrichment job runs CoD (3 passes) over the full note + new evidence and updates the TL;DR in place. CoD prompt is a single template; no skill required.

#### A4. `log.md` and `index.md` at vault root **(S)**

- `log.md` — append-only. Every ingest, every digest, every auto-research run gets a one-line entry: `2026-05-06T14:32 ingest raw/ai-conversations/cursor/foo/2026-05-06.md → 3 entities, 2 backlinks, +concept:bertrend`.
- `index.md` — projection rebuilt by maintenance: list of every concept/topic/project with TL;DR and `last_verified`. Sorted by recency, then by `hot_score`.

These are the agent's scan surface. Karpathy's six-month retro is unambiguous that this pays off.

---

### Phase B — Hot topics & living digests (the headline feature)

#### B1. Weekly hot-topics digest job **(M)**

New job type `digest:weekly`. Cron-triggered Sunday 22:00 (configurable):

1. Pull all chunks from `raw/` and from `wiki/sessions/` ingested in last 7 days.
2. Embed (A2), UMAP-reduce, HDBSCAN cluster.
3. For each cluster: generate label + 2-sentence summary via Bedrock; classify trend as **weak** / **strong** / **noise** by comparing chunk count vs. prior 4 weeks (BERTrend pattern).
4. Write `wiki/digests/{ISO-week}.md` with sections per cluster, each linking out to source chunks and to the canonical concept/topic/project pages they reference.
5. For each strong-signal cluster: enqueue `topic:refresh` (B2) for the canonical topic page.
6. Append a line to `log.md` and update `wiki/digests/_index.md`.

Output is the answer to "what mattered this week."

#### B2. Topic-page refresh job **(M)**

`topic:refresh {slug}` is the worker that keeps a single topic note thorough and current:

1. Load topic note + its protected `# Current understanding` and `# Open questions` regions.
2. Retrieve top-K supporting chunks from corpus (B4 retrieval).
3. Run CoD rewrite of `# Current understanding`. Track new claims vs. existing claims; for any conflict, mark with `contradicts:` rather than overwriting (Karpathy v2 rule).
4. Append unseen sources to `## Sources` with date.
5. Bump `last_verified`. Recompute `stability` (more sources + no contradictions = longer half-life).
6. Append a line to `log.md`.

Triggered by: B1 (strong signal), C1 (decay scan), or a manual MCP call.

#### B3. "Related now" — always-on context **(S)**

When a session references an entity or concept, the MCP `get-note` and `search-vault` tools return semantically-related notes ranked by `cross_enc * recency` (B4). Surfaced in CLAUDE.md hot cache so the active Claude session sees relevant priors *during* the conversation, not just on query.

This is the Reor / Smart Connections pattern.

#### B4. Two-stage retrieval with recency boost **(M)**

Replace today's text-search `search-vault` with:

1. Bi-encoder top-K (50) from embedding store.
2. Cross-encoder rerank to top-10 via Bedrock (or `bge-reranker` locally).
3. Recency fusion: `final = α · cross + β · exp(-days_since_modified / 30)` with α/β configurable per content type. Default β=0.3 for transcripts, 0.1 for concept notes.
4. Apply hot-cache pinning: if a doc is in this week's digest, +0.05.

---

### Phase C — Decay, freshness, and self-healing

#### C1. Decay scanner job **(S after A1)**

Daily cron `decay:scan`:

- For every note: `retrievability = exp(-(today - last_verified) / stability)`.
- If `retrievability < 0.5` AND content type is in `{concept, topic, decision}`: enqueue `topic:refresh` (B2) or surface as a research candidate via `research:propose` (D1) — never auto-launch heavy research.
- If `retrievability < 0.2` AND no inbound links: enqueue review-queue item "consider archiving."
- Update `hot_score` decay term so old notes naturally drop out of the index ranking.

This is the substrate that makes everything else feel "alive."

#### C2. Vault-rot diagnostic **(S)**

Weekly `maintenance:rot-scan`:

- Orphans (no inbound links) + stale (`updated_at` > 180d) + low confidence → flag for review.
- Outputs `wiki/_system/vault-health.md` with current hotspots.

(Direct lift from the Vault Physician pattern.)

#### C3. Stability tuning **(S)**

Each successful auto-research or topic-refresh that finds *no contradictions* increases `stability` (multiplicative bump, capped). A contradiction or supersession resets it. This is the FSRS feedback loop adapted to facts instead of flashcards.

---

### Phase D — Human-in-the-loop research

**Design principle:** Karpathy never runs unattended web research. It identifies and ranks gaps, then asks the user — over Slack — which to pursue and at what depth. Research only fires after explicit approval, scoped to the depth the user picked.

#### D1. Gap detection + ranking job **(M)**

New job `research:propose`. Runs daily and at the end of B1 (weekly digest).

**Candidate sources:**
- A session mentions a term not present in `wiki/concepts/`.
- C1 flags a low-retrievability concept (stale).
- An entity-extractor pass yields a `concept` with `confidence < 0.5`.
- B1 surfaces a strong-signal cluster whose canonical concept page is thin (<N claims) or stale.
- A topic note has open questions in its `# Open questions` protected region with no recent answer.

**Scoring (stack rank).** Each candidate gets a single composite `gap_score` from these signals (weights configurable):

| Signal | Weight | Source |
|---|---|---|
| Recency of mentions (more recent = higher) | 0.30 | session/transcript timestamps |
| Frequency of mentions (last 14d) | 0.20 | embedding-store hits |
| Relevance to active projects | 0.15 | overlap with project-hub embeddings |
| Confidence gap (`1 - confidence`) | 0.15 | frontmatter |
| Staleness (`1 - retrievability`) | 0.10 | C1 decay |
| Domain heat (AI/ML topics get a small bump) | 0.10 | tag/domain |

Output: `wiki/_system/research-queue.md` — a stack-ranked list with one row per candidate: title, slug, score breakdown, why it's flagged, suggested depth (light/medium/heavy), and a one-line "what we'd try to learn."

#### D2. Slack notification + approval handshake **(M)**

Once the queue is rebuilt, send a single Slack DM (via the existing Slack webhook in config; add `notifications.slack.webhookUrl`):

```
Karpathy research queue — 7 new candidates this week.
Top 5 by score:
  1. BERTrend (0.84) — mentioned 6× in last week's sessions, no concept page yet.
  2. RAPTOR retrieval (0.71) — concept page is 90d stale; 3 contradicting claims.
  3. FSRS scheduling (0.65) — referenced in 2 active projects, confidence 0.4.
  4. Graphiti vs Neo4j (0.58) — open question on project:second-brain unresolved.
  5. Tavily vs Firecrawl (0.52) — relevant to 2 concepts; light coverage.

Reply with picks: e.g. `1 heavy, 2 medium, 3 light, skip 4 5`
Or open the queue → wiki/_system/research-queue.md
```

**Approval channels (any of):**
- Slack reply parsed by a webhook receiver (`carpathi hook slack-reply`).
- Edit `wiki/_system/research-queue.md` directly — set `decision: light|medium|heavy|skip` on each row; the next maintenance pass picks them up.
- MCP tool `approve-research({slug, depth})` from a Claude session.

The queue is the source of truth; Slack is just a fast-path nudge.

#### D3. Tiered research executor **(M)**

`research:execute {slug, depth}` — only runs after explicit approval. Depth controls budget and shape:

| Depth | Query rounds | Queries/round | Sources fetched | Synthesis pass | Approx cost |
|---|---|---|---|---|---|
| **light** | 1 | 3 (definition, recent, applied example) | top 3 | single CoD pass on TL;DR + claims | ~$0.05 |
| **medium** | 2 | 5 (adds comparison + contrarian) | top 8, cross-encoder rerank | full coverage check, 1 gap-fill round | ~$0.25 |
| **heavy** | 3 | 7 (adds historical + benchmarks + community-discussion) | top 15, rerank + dedupe | full RAPTOR-style summary, claims w/ source-by-source confidence, contradictions surfaced | ~$1.00 |

All depths:
1. Fetch via the configured `WebSearch` provider (see §D5 below).
2. Write/update `wiki/concepts/{slug}.md` with TL;DR (CoD), claims, sources, `last_verified: today`, `stability` set to domain half-life.
3. Append to `log.md`.
4. Mark the research-queue row `status: completed` with depth and date.

##### D3a. Pluggable search adapters

Search is fully pluggable behind the `WebSearch` interface in `src/intelligence/research-execute.ts`. Three implementations ship; the executor never assumes which one is in use.

| Adapter | Where | When to use | Setup |
|---------|-------|-------------|-------|
| `createMcpSearch(opts)` | `src/intelligence/web-search.ts` | **Primary** path. Spawns any MCP server that exposes a search tool (e.g. `@modelcontextprotocol/server-brave-search` with a free Brave key, `@oevortex/ddg_search`, `mcp-server-searxng`, `exa-mcp-server`, or any custom one). | `intelligence.research.search.mcp = { command, args, toolName, query/topK arg names }` |
| `createDuckDuckGoSearch()` | same | **Free fallback** with no key. Uses DuckDuckGo's Instant Answer API (`api.duckduckgo.com`). Lower quality + recall than Brave/Tavily but adequate for short, well-known concepts. | none |
| `createNoopSearch()` | same | Default when nothing is configured. Returns `[]`; the LLM falls back to its own knowledge for synthesis. | none |

Selection precedence (in `createWebSearchFromConfig(config)`):

1. `intelligence.research.search.provider === 'mcp'` AND `mcp.command` set → MCP server.
2. `intelligence.research.search.provider === 'duckduckgo'` → DDG.
3. else → noop.

A Tavily adapter is intentionally NOT shipped — keys are non-trivial to acquire for personal use. The MCP path subsumes Tavily anyway: if a user later wants Tavily, they install `tavily-mcp` and point us at it via the same `WebSearch` interface.

After execution, the row stays in the queue (struck through) for one week so the user sees what was done.

#### D4. Significance gate on entity extraction **(S)**

Before writing a new entity page, an LLM gate: "Is this worth its own page given the existing wiki?" Inputs: extracted entity + 3 most-similar existing entities. Outputs: keep / merge-into-{ref} / drop. Reduces the "51 entities, mostly noise" problem.

---

### Phase E — Skills & MCP refinements

#### E1. Embedding-based skill matching **(S)**

Replace substring match in `src/agent/skills/registry.ts` with embedding similarity over skill descriptions. Keeps the existing review-gating.

#### E2. MCP write authorization layer **(S)**

Currently any client can write via MCP. Add a per-tool allowlist + a confirmation prompt for `update-note` / `ingest-content` when called from clients other than the host Claude Code session. (Spec §19 flagged this as TBD.)

#### E3. Slash-command scoping in MCP queries **(S)**

`search-vault({query, scope: "vault"|"web"|"this-week"|"project:slug"})`. Borrowed from Khoj. Lets the agent narrow its own retrieval cheaply.

---

## 5. New job types summary

| Job | Trigger | Phase |
|-----|---------|-------|
| `digest:weekly` | cron Sun 22:00 | B1 |
| `topic:refresh {slug}` | digest, decay, manual | B2 |
| `research:propose` | cron daily, end of B1 | D1 |
| `research:execute {slug, depth}` | **user approval only** (Slack reply, queue edit, or MCP) | D3 |
| `decay:scan` | cron daily | C1 |
| `maintenance:rot-scan` | cron weekly | C2 |
| `embedding:index {path}` | post-ingest | A2 |

All use existing `dedupeKey` + lock infrastructure. None require new lanes; all fit the existing job runner.

---

## 6. Data-model additions summary

In `src/vault/frontmatter.ts` base schema (Phase A1):

```ts
last_verified, stability, half_life_domain,
superseded_by, contradicts, tldr, hot_score
```

New folders:

```
wiki/digests/{YYYY-Www}.md          # B1
wiki/digests/_index.md
wiki/_system/vault-health.md        # C2
wiki/_system/research-queue.md      # D1 — stack-ranked gaps awaiting user approval
.karpathy/embeddings/               # A2 (state, not in vault)
```

New protected region IDs: `tldr`, `current-understanding`, `open-questions`, `sources`, `contradictions`.

---

## 7. Suggested implementation order (concrete sprints)

**Sprint 1 (1 week)** — A1, A2, A4. Foundations land. Nothing user-visible yet but everything else unblocks.

**Sprint 2 (1 week)** — A3, B4, B3. TL;DR enforcement + recency-boosted retrieval + always-on related notes. Immediate quality lift in every Claude session that touches the vault.

**Sprint 3 (1.5 weeks)** — B1, B2. Weekly digests + topic refresh. The headline feature ships.

**Sprint 4 (1 week)** — C1, C2, C3. Decay loop. The vault starts self-healing.

**Sprint 5 (1.5 weeks)** — D1, D2, D3, D4. Gap detection + ranking, Slack handshake, tiered research executor (light/medium/heavy), significance gate. Curiosity stays human-in-the-loop.

**Sprint 6 (3 days)** — E1, E2, E3. Polish.

Total: ~6 weeks of focused work to land all ten changes. Phase A alone (1 week) makes the system noticeably smarter; Phase B closes the user's #1 ask.

---

## 8. Risks & mitigations

- **Cost** — weekly digests run frequently; research only runs on user approval, but heavy depth is non-trivial. Mitigations: cap per-run budget per depth tier in config; cache retrieval results 24h; default to local embeddings + Bedrock only for synthesis. Slack notification batches gaps so the user is not nagged per-event.
- **Approval friction** — if the user ignores Slack pings the queue grows unbounded. Mitigations: hard-cap queue at 50 entries; auto-expire entries with `gap_score < 0.3` after 14d; weekly Slack digest summarizes queue state, not just new entries.
- **TL;DR thrash** — CoD rewrites on every update could destabilize summaries. Mitigation: only rewrite when ≥3 chunks of new evidence accumulated, or stability decay below 0.7.
- **Cluster instability week-over-week** — BERTopic clusters drift. Mitigation: BERTrend's online-learning variant tracks identity by anchor terms across windows.
- **Embedding-store growth** — bounded by chunk count; plan for SQLite + vec extension or LanceDB if it gets big.
- **Contradiction noise** — small wording diffs flagged as contradictions. Mitigation: NLI threshold ≥0.7 plus require disagreement on at least one extracted claim, not just text difference.

---

## 9. Open questions for the user

1. **Local vs cloud embeddings** — okay to add a small local embedding model (~50MB) as a dependency, or stay 100% Bedrock?
2. **Digest cadence** — weekly only, or also daily mini-digests for very active weeks?
3. **Research budget per depth tier** — proposed defaults are ~$0.05 / $0.25 / $1.00 for light/medium/heavy. Cap per week as well?
4. **Slack channel/DM target + reply parsing** — DM to the user, or a private channel? Are we okay running a small webhook receiver to parse approval replies (`1 heavy, 2 skip`), or should approval be queue-edit / MCP-only?
5. **Web search provider** — Resolved: pluggable via the `WebSearch` interface. Default is `noop` (LLM-only), preferred is MCP-based (any search MCP — Brave free tier, DuckDuckGo MCP, SearxNG, etc.), with a no-key DuckDuckGo Instant Answer fallback shipped in-process. Tavily is NOT a built-in adapter; users who want it install `tavily-mcp` and configure it via the MCP path.
6. **Meeting transcripts** — confirm they're flowing into `raw/ai-conversations/claude/` already, or do they need their own ingest path?

---

## 10. Sources

Karpathy + LLM-wiki canon:
- [karpathy/442a6bf555914893e9891c11519de94f (gist)](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [LLM Wiki v2 by Rohit](https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2)
- [Karpathy LLM Wiki, six months in](https://www.openaitoolshub.org/en/blog/karpathy-llm-wiki)
- [MindStudio: Karpathy LLM Wiki pattern](https://www.mindstudio.ai/blog/karpathy-llm-wiki-knowledge-base-pattern)
- [obsidian-llm-wiki-local](https://github.com/kytmanov/obsidian-llm-wiki-local)
- [Obsidian Starter Kit: LLM Wiki System (Dubois)](https://www.dsebastien.net/obsidian-starter-kit-system-llm-wiki-system/)

Open-source peers:
- [Khoj](https://github.com/khoj-ai/khoj) · [Reor](https://github.com/reorproject/reor) · [Basic Memory](https://github.com/basicmachines-co/basic-memory) · [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) · [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer) · [Copilot for Obsidian](https://www.obsidianstats.com/plugins/copilot) · [Cole Medin ottomator-agents](https://github.com/coleam00/ottomator-agents/tree/main/agentic-rag-knowledge-graph) · [Karpathy autoresearch](https://github.com/karpathy/autoresearch) · [autoresearch-skill](https://github.com/wjgoarxiv/autoresearch-skill) · [Tencent WeKnora](https://github.com/Tencent/WeKnora) · [Vault Physician](https://tejnaren07.medium.com/my-obsidian-vault-was-rotting-so-i-wrote-a-plugin-to-diagnose-it-a1343830fbbb)

Techniques:
- [BERTopic + LLM representations](https://maartengr.github.io/BERTopic/getting_started/representation/llm.html)
- [BERTrend (online trend detection)](https://arxiv.org/html/2411.05930v1)
- [RAPTOR (hierarchical summarization)](https://arxiv.org/abs/2401.18059)
- [Microsoft GraphRAG](https://microsoft.github.io/graphrag/)
- [Chain of Density](https://arxiv.org/abs/2309.04269)
- [Anki FSRS](https://faqs.ankiweb.net/what-spaced-repetition-algorithm)
- [Pinecone re-rankers primer](https://www.pinecone.io/learn/series/rag/rerankers/)
- [Ragie recency-bias docs](https://docs.ragie.ai/docs/retrievals-recency-bias)
- [Solving freshness in RAG (recency prior, 2509.19376)](https://arxiv.org/html/2509.19376)
- [LangMem long-term memory guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- [Episodic memory position paper (2502.06975)](https://arxiv.org/pdf/2502.06975)
- [Memory systems in AI agents (Analytics Vidhya)](https://www.analyticsvidhya.com/blog/2026/04/memory-systems-in-ai-agents/)
- [How agentic search actually works](https://dev.to/tokozen/how-agentic-search-actually-works-the-research-loop-link-fetching-agents-miss-6ln)
- [Firecrawl web-agent](https://www.firecrawl.dev/blog/firecrawl-agent-open-source)
