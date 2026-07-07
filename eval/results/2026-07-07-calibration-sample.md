# Judge Calibration Sample

## How to review this (read this first)

**What this is.** An LLM ("the judge") graded Carpathi's search results below, but nobody has verified it's grading sensibly yet. This file is a small spot-check sample — you're the human calibration gate the whole evaluation project has been building toward.

**Why it matters.** These judgments become the "ground truth" used later to score whether search is actually good (recall, precision, and eventually the keyword-vs-hybrid architecture decision). If the judge's labels are wrong and nobody catches it here, every downstream number built on top is unreliable.

**Two sections to review, in order:**

### 1. Category/Subtype Triage Proposals (right below) — quick pass, ~10-15 min

For each of the 74 draft eval questions, the judge proposed a corrected `category` (plaud-ai-session / entities / hot-topics / decisions), `subtype` (lookup / synthesis / relationship / absent), and whether it should be **dropped** (meaning: not actually a retrieval question — e.g. a coding task request that slipped in during automated mining). Skim these looking for anything that jumps out as wrong — you're not proofreading every word, just sanity-checking the calls.

### 2. Candidate relevance judgments (further down) — spot check, not exhaustive

For 20 sample queries, the judge graded every candidate note it found against a 0/1/2 scale:

- **2** = directly answers the query / is the primary target
- **1** = relevant supporting context, but not the actual answer
- **0** = not relevant at all

Each candidate shows the judge's label plus its one-sentence reasoning. **You do not need to review every candidate for every item** — there are 20 items with many candidates each. Instead:

- Pick **5-8 items** spread across the categories (plaud-ai-session, entities, hot-topics, decisions) — don't try to do all 20.
- Within those, prioritize the **label-2 candidates** (did the judge correctly find the actual answer?) and any label-1/0 calls that surprise you. Label-0 ("not relevant") calls matter least individually — skim past most of them.
- Skip items marked `_(judging failed for this item...)_` — that's `decisions-001` and `hot-topics-005`, a known, already-logged failure with nothing for you to review there.

**How to mark your review.** Change `[ ]` to `[x]` next to "agree" if a label/category is right, or fill in "correct to: ____" with what it should have been. Don't worry about being exhaustive or perfectly formatted — if it's easier, just tell me your reactions in chat instead of editing this file (e.g. "entities-003's label-2 candidate looks wrong because...").

**What happens next.** Once you've spot-checked a reasonable sample, tell me — either by handing back this file with edits, or just describing your corrections in chat. I'll compute how often you agreed with the judge. If agreement is high (≥80%), the same judge scales up to grade the rest of the pool without further per-item review. If it's low, we fix the judge's prompt/instructions before scaling up. Either way, nothing proceeds automatically without this check.

---

## Category/Subtype Triage Proposals

- **plaud-ai-session-001** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval query seeking a specific meeting recording/transcript by date, participants, and topic keywords.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-002** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval query seeking a specific 1:1 meeting recording by participant name, date, and time.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-003** -> category: plaud-ai-session, subtype: lookup, DROP — This is a file-system/git task request (clone, compare, delete files), not a retrieval question against a personal knowledge base.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-004** -> category: plaud-ai-session, subtype: lookup, DROP — This is a how-to/configuration question about using CMUX with Claude, not a retrieval query against stored notes or session history.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-005** -> category: plaud-ai-session, subtype: synthesis — While it includes a downstream action (drafting recognition posts), the core task is synthesizing across multiple recent Plaud transcripts in the vault to identify people — a legitimate multi-note retrieval/synthesis query; subtype should be synthesis, not lookup.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-006** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval query seeking action items from a specific Architecture Council meeting recording stored in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-007** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval query seeking notes/transcript from a specific meeting with named participants on a known day.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-008** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval query seeking a specific prior AI coding session record (Workfront MCP setup in Gemini) stored in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-009** -> category: plaud-ai-session, subtype: synthesis — Genuine retrieval query seeking to extract and compile action items from an Architecture Council recording; synthesis subtype is correctly assigned.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-010** -> category: plaud-ai-session, subtype: lookup, DROP — This is a tool installation/configuration request, not a retrieval query against stored notes or session history.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-011** -> category: plaud-ai-session, subtype: lookup, DROP — This is a troubleshooting/debugging request about a GitLab MCP connection issue, not a retrieval query against stored notes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-012** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval query seeking a meeting recording or notes by participant names and meeting type keywords.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-013** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval query seeking a specific meeting recording by topic, date, and keywords.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-014** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval query seeking a meeting recording or notes by named participant and topic keywords.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-015** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval query seeking a meeting recording or notes by named participant and project/topic keywords.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-016** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval query seeking a specific Architecture Council meeting recording by name and date.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-017** -> category: plaud-ai-session, subtype: lookup — Valid (if very broad) retrieval query seeking Plaud transcript/recording files in the vault, though it may be too generic to be a useful eval item.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-018** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval query seeking a specific stakeholder meeting recording by project name and date.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-019** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval query seeking action items from Architecture Council meeting recordings stored in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-020** -> category: plaud-ai-session, subtype: lookup — Genuine (if broad) retrieval query seeking a calibration/performance meeting recording or notes in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-021** -> category: plaud-ai-session, subtype: lookup — Valid retrieval query for a weekly team meeting recording, though highly generic and may not be discriminative enough for a quality eval item.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-022** -> category: plaud-ai-session, subtype: lookup — Valid retrieval query seeking architecture or all-hands meeting recordings in the vault, though very generic.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-023** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval query seeking a meeting recording by date reference (June 3).
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-024** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval query seeking a Claude Code AI coding session log associated with the karpathy MCP setup.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **plaud-ai-session-025** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval query seeking a specific Architecture Council meeting recording by name and date, near-duplicate of plaud-ai-session-016 but still a valid retrieval item.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-001** -> category: entities, subtype: lookup — Legitimate recall test querying a named person and Kubernetes deployment context within a personal knowledge base.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-002** -> category: entities, subtype: lookup — Valid retrieval query for Workfront infrastructure entities (cluster names, AWS regions, namespaces) in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-003** -> category: entities, subtype: lookup — Legitimate lookup for a specific Workfront Kubernetes cluster and namespace configuration entity.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-004** -> category: entities, subtype: lookup — Valid recall test for a named service (wf-instance-resolver) and its deployment cluster/environment in personal notes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-005** -> category: entities, subtype: lookup — Legitimate lookup for deployment lane and Kubernetes namespace entities (hub, preview, stage, QA, Ethos) in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-006** -> category: entities, subtype: lookup — Valid retrieval query for a specific cluster name and associated Workfront/MCP deployment context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-007** -> category: entities, subtype: lookup — Legitimate lookup for a namespace entity and its cluster/platform associations within personal notes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-008** -> category: entities, subtype: lookup — Near-duplicate of entities-007 but still a valid distinct recall test for the same namespace/cluster entity; keep unless deduplication policy applies.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-009** -> category: entities, subtype: lookup, DROP — The query reads like a sentiment/behavioral description fragment rather than a retrieval question targeting a named entity, project, or fact in personal notes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-010** -> category: entities, subtype: lookup — Valid lookup for a named person (Jeff Brown) and their role/project associations (MCP consolidation, AI tools guild) in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-011** -> category: entities, subtype: lookup — Legitimate retrieval query for a named initiative (context fabric / AEP cross-product context) as an entity in personal notes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-012** -> category: entities, subtype: lookup — Valid lookup for a named technical concern (monolith scaling, cost-per-feature instrumentation) documented in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-013** -> category: entities, subtype: lookup — Legitimate lookup for a named person (Arabik/Araik) and their role/project association (architect, GenStudio, Armenia) in personal notes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-014** -> category: entities, subtype: lookup — Valid recall test for a named person (Eric Kubicki) and their project (proof viewer, Redrock replacement) in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-015** -> category: entities, subtype: lookup — Legitimate lookup for a named person (Hovhannes Babayan) and their project impact notes in personal notes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-016** -> category: entities, subtype: lookup — Valid retrieval query for a named entity (fluffyjaws) and an associated MCP pipeline error in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-017** -> category: hot-topics, subtype: lookup — Query is about prioritization/must-haves around a current theme (monolith scaling), making 'hot-topics' a more accurate category than 'entities', though it remains a genuine retrieval question.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-018** -> category: entities, subtype: lookup — Valid named-person lookup (Araik Kutunian, architect) in personal notes; near-duplicate of entities-013 but independently useful.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-019** -> category: entities, subtype: lookup — Legitimate lookup for named systems/programs (AMGOS, RCAS, governance) as entities in the personal knowledge base.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **entities-020** -> category: entities, subtype: lookup — Valid minimal named-person lookup (Araik Kutunian) serving as a bare-name recall test in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **hot-topics-001** -> category: decisions, subtype: synthesis — The query explicitly asks about decisions made, so 'decisions' is a more precise category; it still requires synthesizing across multiple notes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **hot-topics-002** -> category: hot-topics, subtype: synthesis — Asking for current project state is a genuine hot-topics synthesis retrieval question well-suited to the hot-cache layer.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **hot-topics-003** -> category: hot-topics, subtype: synthesis — Canonical hot-topics synthesis query asking for an aggregate view of recent active themes across the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **hot-topics-004** -> category: hot-topics, subtype: synthesis — Valid hot-topics synthesis query for the latest status of a specific ongoing initiative (discovery service consolidation).
  - Tom's call: [ ] agree   [ ] correct to: ____
- **hot-topics-005** -> category: hot-topics, subtype: synthesis — Legitimate hot-topics synthesis retrieval question asking for accumulated notes about an active workstream (AI engineering curriculum).
  - Tom's call: [ ] agree   [ ] correct to: ____
- **hot-topics-006** -> category: hot-topics, subtype: synthesis — Genuine retrieval question asking the system to surface currently active projects across the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **hot-topics-007** -> category: hot-topics, subtype: synthesis — Genuine retrieval question asking for a synthesized summary of recent focus areas from vault notes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **hot-topics-008** -> category: hot-topics, subtype: synthesis — Genuine retrieval question asking the system to aggregate and summarize activity over the past two weeks.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-001** -> category: decisions, subtype: lookup — Genuine lookup for a specific recorded decision or outcome regarding AI code review production readiness trust.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-002** -> category: decisions, subtype: lookup, DROP — This is an imperative task request (connect to MongoDB, pull credentials, set up environment, write instructions) not a retrieval question.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-003** -> category: decisions, subtype: lookup, DROP — This is a live task request to query external tools (Atlassian MCP, Confluence) rather than retrieve something from the personal vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-004** -> category: decisions, subtype: lookup, DROP — This is an active investigation/debugging task request about live infrastructure, not a retrieval question against vault notes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-005** -> category: decisions, subtype: lookup, DROP — This is an imperative task request to diagnose pipeline errors using external tools, not a vault retrieval question.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-006** -> category: decisions, subtype: lookup, DROP — This is a task request to actively find and configure MCP gateway connections using external tools, not a vault retrieval question.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-007** -> category: decisions, subtype: lookup, DROP — This is a task request to look up access configuration in external systems (Confluence/Wiki), not to retrieve something from the personal vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-008** -> category: decisions, subtype: lookup, DROP — This is an imperative task request to fetch credentials and configure a local application, not a retrieval question.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-009** -> category: decisions, subtype: lookup, DROP — This is an imperative task request to remove an MCP and install/build a replacement, not a vault retrieval question.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-010** -> category: decisions, subtype: lookup, DROP — This is a task request to locate a locally installed application on the filesystem, not a retrieval question against vault notes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-011** -> category: decisions, subtype: lookup, DROP — This is an imperative installation/setup task request, not a vault retrieval question.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-012** -> category: decisions, subtype: lookup, DROP — This is a build/run task request that incidentally references credential files, not a vault retrieval question.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-013** -> category: decisions, subtype: lookup, DROP — This is an imperative task request to construct an environment file using credentials, not a retrieval question.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-014** -> category: decisions, subtype: lookup, DROP — This is an imperative setup task request using external documentation sources, not a vault retrieval question.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-015** -> category: decisions, subtype: lookup, DROP — This is a coding/development task request to add a CLI feature and run tests, not a vault retrieval question.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-016** -> category: decisions, subtype: lookup, DROP — This is a troubleshooting task request about a live tool configuration, not a retrieval question against vault notes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-017** -> category: decisions, subtype: lookup, DROP — This is a task request to search external systems (Atlassian MCP, Confluence) for a repo, not a personal vault retrieval question.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-018** -> category: plaud-ai-session, subtype: lookup — This is a genuine retrieval question asking the system to find details about a named project; category should be plaud-ai-session as it references an AI coding session tool (carpathi mcp), and subtype lookup is appropriate for a single-project fact retrieval.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-019** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval question asking for a specific recorded mechanism/decision about vault ingestion; better categorized as plaud-ai-session since it concerns system architecture discussed in sessions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-020** -> category: plaud-ai-session, subtype: lookup — Genuine retrieval question asking whether Claude Code sessions are being ingested into the vault, best categorized as plaud-ai-session.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **decisions-021** -> category: decisions, subtype: absent — Intentional absent-stub placeholder for robustness testing; the stub format is valid but the query text needs to be filled in before use.
  - Tom's call: [ ] agree   [ ] correct to: ____

## decisions-001

**Query:** AI code review production readiness trust
**Intent:** regression: previously crashed search_vault (localeCompare bug)
**Category/Subtype:** decisions / lookup

_(judging failed for this item — see run logs; candidates existed but were not graded)_

## hot-topics-001

**Query:** what recent decisions have I made about MCP server architecture
**Intent:** exercises the hot-cache / digest layer (spec G3); grounded in real recent themes
**Category/Subtype:** decisions / synthesis

- **AI Conversations/_summaries/session-2026-06-24-487e1da8.md** — label 1 — Recent session summary that may contain architecture-related decisions but excerpt is too vague to confirm direct relevance to MCP server architecture.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/old/year-month-2026-04-11-11-23-47.md** — label 0 — Meeting about AI workflows and interview prep with no specific MCP server architecture decisions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-06/06-23-meeting-hal-sandbox-architecture-managed-agents-and-agent-definitions.md** — label 1 — Recent meeting about sandbox architecture and managed agents is relevant context but explicitly notes no decision was made.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Adobe WF Notes/People/Bryan Pino.md** — label 0 — Personal notes about Bryan Pino with no relevance to MCP server architecture decisions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-06/06-12-meeting-report-gtm-enablement-program-coordination-and-platform-integration.md** — label 1 — Contains a passing mention of MCP server usefulness in a GTM/platform context but is not focused on architecture decisions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-06-08/2026-06-08-c5705176.md** — label 0 — Raw note about a one-on-one meeting with no MCP server architecture content visible in excerpt.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/_discovery/2026-06-08-c5705176.md** — label 0 — Same one-on-one meeting content, no MCP server architecture relevance.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-08-c5705176.md** — label 0 — Duplicate of the same one-on-one meeting note with no MCP architecture content.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-08-c5705176-2.md** — label 0 — Another duplicate of the one-on-one meeting note with no MCP architecture content.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-05/05-21-strategic-realignment-of-the-architecture-team-towards-ai.md** — label 1 — Relevant as it covers architecture team strategic direction toward AI, providing supporting context for MCP architecture decisions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-28/05-21-strategic-realignment-of-the-architecture-team-towards-ai.md** — label 1 — Duplicate of the architecture team realignment note, relevant as supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/05-21-strategic-realignment-of-the-architecture-team-towards-ai-2.md** — label 1 — Another duplicate of the architecture team realignment, relevant as supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/05-21-strategic-realignment-of-the-architecture-team-towards-ai.md** — label 1 — Curated version of architecture team realignment note, relevant as supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-05/05-27-meeting-engineering-specs-prd-source-of-truth-and-project-delorean-governance.md** — label 0 — Covers engineering specs and PRD governance, not specifically MCP server architecture decisions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-28/05-27-meeting-engineering-specs-prd-source-of-truth-and-project-delorean-governance.md** — label 0 — Same engineering specs/PRD meeting, not focused on MCP server architecture.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/05-27-meeting-engineering-specs-prd-source-of-truth-and-project-delorean-governance.md** — label 0 — Curated version of same engineering specs meeting, not MCP architecture focused.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-05/05-26-meeting-strategic-goals-roadmap-and-q2-performance.md** — label 0 — Strategic goals and Q2 performance meeting with no specific MCP server architecture content.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-28/05-26-meeting-strategic-goals-roadmap-and-q2-performance.md** — label 0 — Same strategic goals meeting raw version, not relevant to MCP architecture decisions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/05-26-meeting-strategic-goals-roadmap-and-q2-performance.md** — label 0 — Curated version of strategic goals meeting, not focused on MCP architecture.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/05-20-weekly-meeting-ai-leadership-mcp-standardization-performance-evaluation-delorean-reset-and-data-architecture-alignment.md** — label 2 — Directly covers MCP standardization decisions in an AI leadership meeting, making it a primary source for MCP server architecture decisions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-08-bbea3ba4.md** — label 2 — Directly documents decisions about MCP server configuration including global vs project-local config structure for the personal knowledge system.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-17-9fa24b64.md** — label 2 — Documents a specific decision about adding a GitLab MCP server to the architecture, directly answering what MCP server architecture decisions were made.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-17-8e5b3a2c.md** — label 2 — Contains a direct architectural decision about McpServerFactory conditional tool registration approach, directly addressing MCP server architecture choices.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-02-b1eae27a.md** — label 1 — References MCP harness rollout as a hot priority, providing relevant context for recent MCP architecture decisions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-10-bdb456a6.md** — label 2 — Documents specific MCP server architecture decisions including Docker lifecycle control endpoints and discovery mechanisms implemented.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-05-b30a78a7.md** — label 2 — Directly discusses MCP server generation architecture and implementation decisions for the arrow-v2 project.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-05-6b9acca9.md** — label 1 — Session focused on listing connected MCP servers, relevant context but not an architectural decision session.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-05-db5368e0.md** — label 1 — Discusses browser MCP server plugins for Claude Code testing, relevant supporting context for MCP server architecture exploration.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-15-32789529.md** — label 1 — Documents MCP server configuration status across Cursor, relevant as supporting context for MCP server setup decisions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-22-f649bbe1.md** — label 1 — Session working in the dynamics-mcp-server directory, relevant by subject matter though excerpt contains no decision content.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-21-51efb89e.md** — label 1 — Documents a decision to add and configure a Dynamics MCP server to Claude Desktop, relevant supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-05-2b744728.md** — label 2 — Directly documents findings and decisions about the business-context MCP server architecture including MongoDB connectivity and tool schemas.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-03-9ace9ae9.md** — label 2 — Documents a specific architectural decision about a port coordination system implemented in the CC MCP server.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-10-59e650cd.md** — label 2 — Compact summary of a long Business Context MCP project session capturing essential architectural context and decisions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-01-61078aad.md** — label 1 — Documents MCP configuration updates (Cursor mcp.json, Atlassian tokens), relevant supporting context for MCP server setup decisions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-08-b21aed2f.md** — label 1 — Documents decision to activate GitHub MCP server, relevant supporting context for MCP server architecture choices.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-23-7dc16e69.md** — label 2 — Directly documents a recent decision to add the Snyk MCP server to the global Claude settings, a concrete MCP architecture decision.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-01-49c044fd.md** — label 1 — Session researching ATS MCP strategy and cross-referencing with personal notes, relevant context for understanding MCP architecture landscape.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-02-cd7ff619.md** — label 2 — Directly describes the Business Context MCP server architecture decisions including MongoDB Atlas backend, organizational knowledge storage, and design forks.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-d82ba152.md** — label 1 — Involves researching external MCP server availability and deployment, relevant supporting context for MCP architecture decisions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_legacy/2026-04-12/claude-session-2026-04-11-111b373a.md** — label 2 — Directly discusses Carpathi MCP server architecture design, including what MCP alone solves and what additional architecture is needed.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-04-16-04-16-weekly-meeting-ai-development-dark-factory-and-tooling-2.md** — label 1 — Meeting discussing MCP server needs in AI development context, relevant supporting context for MCP architecture decisions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-05-18-05-18-meeting-inter-team-collaboration-and-performance-calibration-4.md** — label 1 — Contains discussion of MCP server issues in a team collaboration context, relevant supporting background.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-04-02-04-02-meeting-project-unity-poc-ai-integration-and-campaign-brief-generation-2.md** — label 0 — Meeting about campaign brief generation and repository access with no MCP server architecture content.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-04-16-04-16-meeting-slack-email-catch-up-mcp-pipeline-agent-orchestration-and-validation-plan-2.md** — label 2 — Directly discusses MCP gateway architecture and pipeline decisions, a primary source for MCP server architecture decisions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-04/04-16-meeting-slack-email-catch-up-mcp-pipeline-agent-orchestration-and-validation-plan.md** — label 2 — Meeting specifically covering MCP pipeline architecture and orchestration decisions, directly answering what decisions were made about MCP server architecture.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/old/p-2026-04-16-04-16-meeting-slack-email-catch-up-mcp-pipeline-agent-orchestration-and-validation-plan.md** — label 2 — Duplicate of the MCP pipeline architecture meeting, directly covers decisions about MCP server architecture.
  - Tom's call: [ ] agree   [ ] correct to: ____

## entities-001

**Query:** Hamilton Lucas Jonathan Raymond K8s Kubernetes deployment namespace enterprise-context
**Intent:** known zero-hit in production; expected to be findable (recall test)
**Category/Subtype:** entities / lookup

- **Adobe WF Notes/Projects/enterprise-context/06-required-tools-and-mcps.md** — label 2 — Directly mentions Jonathan Raymond, k8s, enterprise-context deployment, and namespace — matching nearly all query terms as the primary target document.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Adobe WF Notes/Projects/enterprise-context/01-deployment-diary.md** — label 1 — Covers enterprise-context deployment and namespace context, providing supporting chronological ground truth for the deployment.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-d82ba152.md** — label 1 — Directly discusses K8s deployment and the enterprise-context namespace, making it relevant supporting context for the query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-22-0419a357.md** — label 1 — Working directory is enterprise-context, providing supporting session context for the project.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-23-0419a357.md** — label 1 — Working directory is enterprise-context, providing supporting session context for the project.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-23-4d1f9e67.md** — label 1 — Working directory is enterprise-context, providing supporting session context for the project.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-01-b59f86c9.md** — label 1 — Discusses enterprise-context as a key project priority involving MCP tooling and AI context injection, relevant background.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-19-91473273.md** — label 1 — Working directory is enterprise-context with active development on discovery/MCP services, relevant supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-18-8e5b3a2c.md** — label 1 — Working directory is enterprise-context and discusses deployment harness UI work, relevant supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-18-f92e2c16.md** — label 1 — Working directory is enterprise-context and discusses the discovery service architecture, relevant supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-22-a2beed44.md** — label 1 — Working directory is enterprise-context with discussion of project state and GitLab history, relevant supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-23-e54de5bf.md** — label 1 — Working directory is enterprise-context, providing supporting session context even though content is sparse.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-17-41a8629e.md** — label 1 — Working directory is enterprise-context, providing supporting session context even though content is sparse.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-16-7915b2df.md** — label 1 — Discusses merging the discovery service into the enterprise-context project, relevant background context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-a7cdf9e6.md** — label 0 — Working directory is wf-business-context (not enterprise-context) with no relevant content visible.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-46d94be3.md** — label 0 — Working directory is wf-business-context with no content matching the query terms.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-975370d7.md** — label 0 — Working directory is wf-business-context with no content matching the query terms.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-a7cdf9e6.md** — label 0 — Working directory is wf-business-context with no content matching the query terms.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-10-59e650cd.md** — label 0 — Working directory is wf-business-context with no content matching the query terms.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-a7cdf9e6.md** — label 0 — Working directory is wf-business-context with no content matching the query terms.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-03-8f0aae44.md** — label 0 — Working directory is wf-business-context with no content matching the query terms.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-05-2b744728.md** — label 0 — Working directory is wf-business-context with no content matching the query terms.
  - Tom's call: [ ] agree   [ ] correct to: ____

## entities-017

**Query:** monolith scaling must-have priorities
**Intent:** known zero-hit in production; expected to be findable (recall test)
**Category/Subtype:** hot-topics / lookup

- **raw/2026-05-22/p-2026-03-19-03-19-interview-tom-valletta-ai-enabled-content-supply-chain-sdlc-orchestration-and-okr-driven-culture-at-adobe.md** — label 0 — Mentions scaling in passing but is about AI content supply chain and OKR culture, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-03/03-19-interview-tom-valletta-ai-enabled-content-supply-chain-sdlc-orchestration-and-okr-driven-culture-at-adobe.md** — label 0 — Same interview content about AI/OKR culture with only incidental mention of scaling, not about monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-19-03-19-interview-tom-valletta-ai-enabled-content-supply-chain-sdlc-orchestration-and-okr-driven-culture-at-adobe-5.md** — label 0 — Duplicate of the Tom Valletta interview with no relevance to monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-19-03-19-interview-tom-valletta-ai-enabled-content-supply-chain-sdlc-orchestration-and-okr-driven-culture-at-adobe-6.md** — label 0 — Duplicate of the Tom Valletta interview with no relevance to monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/old/p-2026-03-19-03-19-interview-tom-valletta-ai-enabled-content-supply-chain-sdlc-orchestration-and-okr-driven-culture-at-adobe.md** — label 0 — Duplicate of the Tom Valletta interview with no relevance to monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-19-03-19-interview-tom-valletta-ai-enabled-content-supply-chain-sdlc-orchestration-and-okr-driven-culture-at-adobe-7.md** — label 0 — Duplicate of the Tom Valletta interview with no relevance to monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-19-03-19-interview-tom-valletta-ai-enabled-content-supply-chain-sdlc-orchestration-and-okr-driven-culture-at-adobe-8.md** — label 0 — Duplicate of the Tom Valletta interview with no relevance to monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-20/03-19-interview-tom-valletta-ai-enabled-content-supply-chain-sdlc-orchestration-and-okr-driven-culture-at-adobe.md** — label 0 — Duplicate of the Tom Valletta interview with no relevance to monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-20/p-2026-03-19-03-19-interview-tom-valletta-ai-enabled-content-supply-chain-sdlc-orchestration-and-okr-driven-culture-at-adobe.md** — label 0 — Duplicate of the Tom Valletta interview with no relevance to monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/03-19-interview-tom-valletta-ai-enabled-content-supply-chain-sdlc-orchestration-and-okr-driven-culture-at-adobe-2.md** — label 0 — Duplicate of the Tom Valletta interview with no relevance to monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/03-19-interview-tom-valletta-ai-enabled-content-supply-chain-sdlc-orchestration-and-okr-driven-culture-at-adobe.md** — label 0 — Duplicate of the Tom Valletta interview with no relevance to monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-19-03-19-interview-tom-valletta-ai-enabled-content-supply-chain-sdlc-orchestration-and-okr-driven-culture-at-adobe-3.md** — label 0 — Duplicate of the Tom Valletta interview with no relevance to monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-19-03-19-interview-tom-valletta-ai-enabled-content-supply-chain-sdlc-orchestration-and-okr-driven-culture-at-adobe-4.md** — label 0 — Duplicate of the Tom Valletta interview with no relevance to monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-18/p-2026-03-19-03-19-interview-tom-valletta-ai-enabled-content-supply-chain-sdlc-orchestration-and-okr-driven-culture-at-adobe.md** — label 0 — Duplicate of the Tom Valletta interview with no relevance to monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-19-03-19-interview-tom-valletta-ai-enabled-content-supply-chain-sdlc-orchestration-and-okr-driven-culture-at-adobe-2.md** — label 0 — Duplicate of the Tom Valletta interview with no relevance to monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-19-03-19-interview-tom-valletta-ai-enabled-content-supply-chain-sdlc-orchestration-and-okr-driven-culture-at-adobe.md** — label 0 — Duplicate of the Tom Valletta interview with no relevance to monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Adobe WF Notes/Architecture Strategy Workshop.md** — label 2 — Directly mentions challenges in scaling the Red Rock monolith including dependencies and spaghetti code, making it the primary target for the query about monolith scaling must-have priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-02-b1eae27a.md** — label 0 — Lists hot priorities but these are product/AI feature priorities, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-19-9804f7fc.md** — label 0 — Discusses pipeline issues and bypassing stages, not related to monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-08-c5705176.md** — label 0 — About performance calibration and leadership ratings, not monolith scaling.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-24-62bdf24f.md** — label 0 — About implementation planning for an unspecified build, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-19-88a93b74.md** — label 0 — About building a plan in phases for an unspecified project, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-29-0d74e2e6.md** — label 0 — About HUD consolidation for a game, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-24-2170db4c.md** — label 0 — About anomaly inbox filtering for a product feature, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/_discovery/2026-06-02-b1eae27a.md** — label 0 — Lists product feature hot priorities, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/arrow-v2/2026-04-14-0222721b.md** — label 0 — About meta-harness architecture and dimension weights, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/spectra/2026-05-22-4085e732.md** — label 0 — About MCP connector adapter phases, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-03-24-p-2026-03-24-03-24-meeting-ai-tooling-mongodb-scaling-and-dark-factory-concept.md** — label 1 — Discusses scaling pain and bespoke architecture for high-volume demands, providing relevant architectural scaling context though focused on MongoDB/Kafka rather than monolith priorities specifically.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/friendly-austin-43fb65/2026-05-05-b30a78a7.md** — label 0 — About discovery and requirements phases in a development process, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/_discovery/2026-06-01-49c044fd.md** — label 0 — About spec strategy and architecture council, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_legacy/2026-04-13/p-2026-04-10-04-10-proposal-for-accelerating-ai-driven-product-development.md** — label 0 — About AI-driven product development acceleration, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_legacy/2026-04-12/claude-session-2026-04-10-a6c24217.md** — label 0 — About score rebalancing and remediation planning for an AI pipeline, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-03-10-p-2026-03-10-03-10-meeting-defining-horizontals-and-stakeholder-engagement.md** — label 0 — About stakeholder engagement and horizontal coordinators, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/spectra/2026-05-29-8de56a69.md** — label 0 — About connector prioritization by ROI, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_legacy/2026-04-12/claude-session-2026-04-10-8f33595e.md** — label 0 — About agent-driven routing and evaluator hardening, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/dev/2026-05-19-e542e4ee.md** — label 0 — About dark factory and AI code trust, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/_discovery/2026-06-08-c5705176.md** — label 0 — About performance calibration and leadership impact ratings, not monolith scaling priorities.
  - Tom's call: [ ] agree   [ ] correct to: ____

## hot-topics-002

**Query:** what is the current state of the Workfront MCP gateway project
**Intent:** exercises the hot-cache / digest layer (spec G3); grounded in real recent themes
**Category/Subtype:** hot-topics / synthesis

- **raw/2026-07-06/2026-06-26-e26ca779.md** — label 2 — Directly addresses the integration of Enterprise Context MCP into the Workfront MCP Gateway, which is the core of the project state query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/enterprise-context/2026-06-26-e26ca779.md** — label 2 — Same content as the primary source about EC MCP integration into the Workfront MCP Gateway.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-26-e26ca779.md** — label 2 — Curated version of the same document directly covering the Workfront MCP Gateway project state.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-26-e26ca779-2.md** — label 2 — Another curated version of the same document directly covering the Workfront MCP Gateway project state.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-06-22/2026-06-22-a2beed44.md** — label 2 — Explicitly assesses the current state of the Workfront project by examining merge requests and related artifacts.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/enterprise-context/2026-06-22-a2beed44.md** — label 2 — Same session content directly assessing the current state of the Workfront project.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-22-a2beed44.md** — label 2 — Curated version of the session directly assessing current state of the Workfront MCP gateway project.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-22-a2beed44-2.md** — label 2 — Another curated version of the session directly assessing current state of the Workfront MCP gateway project.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-25-487e1da8.md** — label 2 — Directly asks about the current state of this project, including what is broken, making it a primary target document.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-07-06/2026-07-06-8960de59.md** — label 2 — Describes the current state where Enterprise Gateway has Enterprise Context endpoints exposed as part of the Workfront MCP.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/enterprise-context/2026-07-06-8960de59.md** — label 2 — Same content describing the current state of the Workfront MCP gateway with Enterprise Context endpoints.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-07-06-8960de59.md** — label 2 — Curated version describing the current state of the Workfront MCP gateway project.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-07-06-8960de59-2.md** — label 2 — Another curated version describing the current state of the Workfront MCP gateway project.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Adobe WF Notes/Projects/enterprise-context/01-deployment-diary.md** — label 2 — A chronological deployment diary assessing the current state of the enterprise-context/Workfront MCP gateway project.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-22-a2beed44.md** — label 2 — Session summary showing comprehensive synthesis of the project state from notes and GitLab history for the Workfront MCP gateway.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/06-25-meeting-workfront-coworker-mcp-and-enterprise-ai-workflow-integration-2.md** — label 1 — Meeting notes about Workfront MCP and enterprise AI workflow integration providing relevant supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/06-25-meeting-workfront-coworker-mcp-and-enterprise-ai-workflow-integration.md** — label 1 — Meeting notes about Workfront MCP and enterprise AI workflow integration providing relevant supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-06/06-25-meeting-workfront-coworker-mcp-and-enterprise-ai-workflow-integration.md** — label 1 — Meeting notes covering Workfront MCP and enterprise AI integration, relevant supporting context for the project state.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-06-26/06-25-meeting-workfront-coworker-mcp-and-enterprise-ai-workflow-integration.md** — label 1 — Meeting notes covering Workfront MCP and enterprise AI integration, relevant supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-01-9922879a.md** — label 1 — Session about connecting to the Workfront MCP gateway and connecting MCP servers, relevant background context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-02-597e522e.md** — label 1 — Session about setting up the Workfront MCP gateway, providing relevant supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-08-d6b7da17.md** — label 1 — Session discussing MCP gateway OAuth configuration, relevant supporting context for the project.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-a48f0a89.md** — label 1 — Session showing Workfront MCP connectivity and project creation, providing supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-08-bbea3ba4.md** — label 1 — Session about configuring and finding details on the Workfront MCP gateway, relevant supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-26-340f9c46.md** — label 1 — Shows the Workfront MCP connection status with tools available, relevant supporting context for project state.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-06-15/2026-06-15-46d94be3.md** — label 1 — Related to wf-business-context MCP documentation, providing peripheral supporting context for the Workfront MCP ecosystem.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/wf-business-context/2026-06-15-46d94be3.md** — label 1 — Related to wf-business-context MCP, providing supporting context for the broader Workfront MCP project.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-15-46d94be3-2.md** — label 1 — Curated version of wf-business-context MCP documentation, supporting context for the Workfront MCP ecosystem.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-15-46d94be3.md** — label 1 — Curated version of wf-business-context MCP documentation, supporting context for the Workfront MCP ecosystem.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-15-46d94be3-3.md** — label 1 — Another curated version of wf-business-context MCP documentation, supporting context for the Workfront MCP ecosystem.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-06/06-02-meeting-workfront-mcp-integration-unity-agent-and-llm-testing.md** — label 1 — Meeting about trying out the Workfront MCP, relevant supporting context for the project.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-06-04/06-02-meeting-workfront-mcp-integration-unity-agent-and-llm-testing.md** — label 1 — Meeting about Workfront MCP integration, relevant supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-a7cdf9e6.md** — label 1 — Session about Business Context MCP server for Workfront Planning, peripheral supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-05-680c55e7.md** — label 1 — Mentions Workfront MCP and WF Business Context MCP in context of project setup, relevant supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-05-d3b95106.md** — label 1 — Session about business context MCP authentication issues, relevant supporting context for Workfront MCP project.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-03-534242c7.md** — label 0 — Session about creating Confluence wiki pages for Workfront AI Engineering Enablement Series, not directly about MCP gateway project state.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-03-ea8ccaf5.md** — label 1 — Session testing if Workfront MCP works and getting Workfront Planning details, relevant supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-02-534242c7.md** — label 0 — Session about creating Confluence wiki architecture pages, not directly relevant to Workfront MCP gateway project state.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-29-680c55e7.md** — label 0 — Session about UI spec form and workstream planning, not directly relevant to Workfront MCP gateway project state.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-05-db5368e0.md** — label 0 — Session about browser MCP plugins for web testing, not relevant to Workfront MCP gateway project state.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-26-a1a45a65.md** — label 0 — Session about Workfront Planning OKR data in Workfront Hub, not directly about the MCP gateway project state.
  - Tom's call: [ ] agree   [ ] correct to: ____

## decisions-018

**Query:** using the carpathi mcp, find details about the AI Collaborators project. What does it actually do?
**Intent:** (none)
**Category/Subtype:** plaud-ai-session / lookup

- **AI Conversations/claude/_discovery/2026-06-01-1f27263e.md** — label 2 — This is the primary conversation document from the exact session where the query was made, directly containing the interaction about finding AI Collaborators project details via the Carpathi MCP.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-06-01/2026-06-01-1f27263e.md** — label 2 — This is the raw source file for the same session (1f27263e) containing the query about the AI Collaborators project using the Carpathi MCP.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-01-1f27263e-2.md** — label 2 — This is a curated source derivative of the same session (1f27263e) directly containing the AI Collaborators/Carpathi MCP query content.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-01-1f27263e.md** — label 2 — This is a curated source for the same session (1f27263e) directly containing the AI Collaborators/Carpathi MCP query content.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-01-1f27263e-3.md** — label 2 — This is another curated source derivative of the same session (1f27263e) directly containing the AI Collaborators/Carpathi MCP query content.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-01-1f27263e.md** — label 2 — This is the session summary for the exact session (1f27263e) where the AI Collaborators project query via Carpathi MCP was made, making it a primary answer document.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-04-15-a36dc1e2.md** — label 0 — This session summary covers MCP tool usage details (update_note, get_backlinks) unrelated to the AI Collaborators project query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-03-534242c7.md** — label 0 — This session is about creating Confluence pages for the Workfront AI Engineering Enablement Series, not about the AI Collaborators project.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-22-a2beed44.md** — label 1 — This session involves using the Carpathi MCP to retrieve notes and provides relevant context about how the Carpathi MCP is used to find project details.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-18-8b1c0403.md** — label 1 — This session directly discusses the effectiveness of the Carpathy MCP at finding information in the vault, providing supporting context for the query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-a48f0a89.md** — label 0 — This session is about querying Workfront project data using bash/tokens, not about the AI Collaborators project or Carpathi MCP.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-01-8b59e82b.md** — label 1 — This session from the same date uses the Carpathi MCP to review AI interactions, providing relevant supporting context about how the tool is used.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-09-59e650cd.md** — label 0 — This session is about iterative refinement of an eval set with no clear connection to AI Collaborators or Carpathi MCP.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-02-b1eae27a.md** — label 1 — This session explicitly lists 'AI Collaborators' as a hot priority item, providing direct supporting context about what the AI Collaborators project is.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-04-14-sgqouq57.md** — label 1 — This session covers Carpathi configuration setup, providing relevant supporting context about the Carpathi MCP infrastructure.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-02-534242c7.md** — label 0 — This session is about creating Confluence pages for Workfront architecture, not about the AI Collaborators project or Carpathi MCP.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-d82ba152.md** — label 1 — This session mentions Carpathi as one of several running agents and provides some context about how it's used alongside other tools.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-19-9804f7fc-11.md** — label 1 — This source shows active use of Carpathi MCP tools (get_recent_sessions) for context exploration, providing supporting context about how the MCP is used.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/topics/ai-initiatives.md** — label 1 — This wiki page covers AI initiatives broadly and may contain or link to context about the AI Collaborators project as an organizational initiative.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_legacy/2026-04-12/claude-session-2026-04-11-111b373a.md** — label 1 — This session covers the design of the Carpathi MCP server system, providing relevant background context about how the Carpathi MCP works.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/dev/2026-05-19-e542e4ee.md** — label 1 — This conversation references the dark factory work and AI projects in a way that may provide supporting context about the AI Collaborators initiative.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/projects/carpathi/_index.md** — label 1 — This is the wiki index page for the Carpathi project itself, providing direct supporting context about what the Carpathi MCP is.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/dev/2026-05-19-c2be3248.md** — label 1 — This session shows active use of the Carpathi MCP (get_note calls) to retrieve meeting content, providing supporting context for the query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/workfront-lite/2026-06-16-54195a08.md** — label 2 — This session explicitly mentions using Carpathi vault search alongside an 'AI Collaborators wiki search' as parallel research tasks, directly relating to the query about finding AI Collaborators details via Carpathi MCP.
  - Tom's call: [ ] agree   [ ] correct to: ____

## plaud-ai-session-005

**Query:** Take a look at my interactions in the last week that are captured in transcripts from Plaud and stored in my Obsidian Vault (access via carpathi MCP). Identify 5-10 people that deserve a pat on the back.  I need to send appreciation notes in AwardCo. Create a short recognition post that I can send along. Make sure that it uses my voice.
**Intent:** (none)
**Category/Subtype:** plaud-ai-session / synthesis

- **AI Conversations/_summaries/session-2026-06-12-9470d5ab.md** — label 2 — This is a summary of the exact session matching the query about identifying people deserving appreciation notes in AwardCo from Plaud transcripts.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-06-12/2026-06-12-9470d5ab.md** — label 2 — This is the raw transcript/source file for the session directly matching the query about identifying people for AwardCo recognition notes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/_discovery/2026-06-12-9470d5ab.md** — label 2 — This is the discovery file for the same session that contains the exact query about identifying people deserving appreciation notes in AwardCo.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-12-9470d5ab-2.md** — label 2 — This is another curated version of the same session directly containing the query about AwardCo appreciation notes from Plaud transcripts.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-12-9470d5ab.md** — label 2 — This is a curated source file for the session directly matching the AwardCo appreciation notes query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-12-9470d5ab-3.md** — label 2 — This is another curated variant of the same session directly containing the query about identifying people for AwardCo recognition.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-20-20224115.md** — label 1 — This session involves using Carpathi MCP to look at notes and identify architects who contributed value, which is closely related context to the appreciation/recognition query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-01-ec1e6bec.md** — label 1 — This session uses Carpathi MCP to analyze Plaud transcripts, directly relevant as supporting context for the workflow described in the query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-18-9552b24f.md** — label 1 — This session uses Carpathi MCP to review conversations, Plaud notes, and work over the past week, which is a closely related workflow to the query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-18-5f30cf3f.md** — label 1 — This session discusses identifying people leading AI efforts and compensation considerations, relevant context for recognizing people's contributions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-08-c5705176.md** — label 1 — This session involves reviewing Obsidian notes and Plaud meeting transcripts to identify topics and people, supporting context for the query workflow.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-18-8b1c0403.md** — label 1 — This session discusses making Plaud recording transcripts the centerpiece of a knowledge system, directly relevant supporting context for the query's use of Plaud transcripts.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-0ca06784.md** — label 1 — This session involves creating Plaud transcript templates for detailed meeting notes, relevant supporting context for processing Plaud transcripts as in the query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-15-5dfed046.md** — label 1 — This session is about syncing Plaud notes and transcriptions into Obsidian, which is directly relevant infrastructure context for the query's workflow.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-04-12-2b67dc80.md** — label 1 — This session references Carpathi and mentions people entities extracted from sessions, providing supporting context for the query's use of Carpathi MCP to find people.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-13-2fc0cfab.md** — label 1 — This session describes the Obsidian vault structure including the Plaud folder, providing relevant supporting context for the query's vault-access approach.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-27-2e7b6389.md** — label 0 — This session is about searching Confluence for user contributions, not directly related to Plaud transcripts, AwardCo, or the appreciation notes query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-18-5dfed046.md** — label 1 — This session involves troubleshooting the Plaud sync plugin for Obsidian, providing supporting context for the Plaud-to-Obsidian workflow used in the query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-15-8c860e5f.md** — label 0 — This session is about engineering work on AMGOS with MongoDB/dashboard context, not related to the appreciation notes or Plaud transcript query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-20-96aea468.md** — label 0 — This session is about building and testing a plugin, not related to the AwardCo appreciation notes or Plaud transcript review query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-ae3ca1d5.md** — label 0 — This session is about replacing AWS Bedrock model credentials, unrelated to the AwardCo appreciation notes query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-28-9ace9ae9.md** — label 0 — This session appears to be a task notification output file, with no apparent connection to the AwardCo appreciation notes query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-10-9ace9ae9.md** — label 0 — This session is about vault probe modules and engineering endpoints, unrelated to the AwardCo appreciation notes or Plaud transcript query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-504d8ab6.md** — label 0 — This session is about credential management refactoring, unrelated to identifying people for AwardCo appreciation notes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-10-8461a89f.md** — label 0 — This session involves vault credential UI development work, unrelated to the Plaud transcript review and AwardCo appreciation notes query.
  - Tom's call: [ ] agree   [ ] correct to: ____

## entities-002

**Query:** Workfront stage cluster OR2 OR1 US East West AWS region MCP namespace
**Intent:** known zero-hit in production; expected to be findable (recall test)
**Category/Subtype:** entities / lookup

- **AI Conversations/_summaries/session-2026-06-03-534242c7.md** — label 0 — Focuses on creating Confluence wiki pages for Workfront AI Engineering series, no mention of stage clusters, AWS regions, OR1/OR2, or US East/West.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-05-680c55e7.md** — label 0 — Discusses loading Workfront MCP and WF Business Context MCP into Spectra, but no content about stage clusters, AWS regions, or OR1/OR2 namespaces.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-26-a1a45a65.md** — label 0 — Covers Workfront Planning OKR data, not infrastructure topics like stage clusters or AWS regions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-03-ea8ccaf5.md** — label 0 — Tests whether the Workfront MCP works and retrieves Planning workspaces, no infrastructure or deployment region details.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-22-a2beed44.md** — label 0 — Focuses on reviewing Workfront tasks and GitLab merge requests for a project, not AWS regions or stage clusters.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-08-bbea3ba4.md** — label 1 — Discusses MCP configuration for Workfront and searches Adobe Wiki for related details, which could contain supporting context about deployment infrastructure.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-02-534242c7.md** — label 0 — About creating Confluence architecture pages for Workfront, no mention of stage clusters or AWS region details.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-a48f0a89.md** — label 0 — Focuses on tracking a project in Workfront, not infrastructure or deployment environments.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-a7cdf9e6.md** — label 0 — Covers Business Context MCP server updates and eval improvements, no infrastructure region or cluster content.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-03-cd7ff619.md** — label 0 — Discusses running the mapper against a staging Workfront Planning system, but no mention of OR1/OR2, AWS regions, or MCP namespaces.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-29-680c55e7.md** — label 0 — Describes UI workstream features for a new Spec form, not deployment infrastructure or stage clusters.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-04-12a30de3.md** — label 0 — Discusses whether the business context project should be an MCP and OAuth flow, not deployment regions or clusters.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-10-bdb456a6.md** — label 0 — Covers adding a control center skill to Cloud Code, no mention of stage clusters or AWS regions.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-02-b1eae27a.md** — label 0 — High-level priorities recap including MCP harness and Workfront Planning, but no infrastructure or region-specific details.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-01-b59f86c9.md** — label 0 — Recaps Enterprise Context priorities and MCP tooling strategy at a high level, no stage cluster or AWS region content.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-01-9922879a.md** — label 2 — Directly concerns connecting to the new Workfront MCP gateway and connecting MCP servers, making it the primary candidate for a query about Workfront stage clusters, AWS regions, and MCP namespaces.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-d82ba152.md** — label 2 — Directly about deploying the wf-business-context MCP with clear deployment instructions from Clint Goodman, highly relevant to stage cluster, AWS region, and MCP namespace configuration.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-26-340f9c46.md** — label 0 — Describes a UI mockup of MCP server connection statuses, not deployment infrastructure or AWS region details.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-19-cc1a3c35.md** — label 0 — Only shows Atlassian MCP configuration, no Workfront stage cluster or AWS region content.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-17-9fa24b64.md** — label 0 — Discusses GitLab MCP server options, not Workfront stage clusters or AWS deployment regions.
  - Tom's call: [ ] agree   [ ] correct to: ____

## hot-topics-003

**Query:** what are the hottest topics I have been working on recently
**Intent:** exercises the hot-cache / digest layer (spec G3); grounded in real recent themes
**Category/Subtype:** hot-topics / synthesis

- **raw/2026-05-22/p-2026-03-13-03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi.md** — label 1 — A meeting note about AI roadmap topics is relevant context but is a single meeting transcript, not a digest of recent hot topics.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-03/03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi.md** — label 1 — Same AI roadmap meeting note providing relevant context but not a summary of hottest recent topics.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/old/p-2026-03-13-03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi.md** — label 1 — Duplicate of the same AI roadmap meeting note; relevant context but not the primary answer.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-13-03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi-8.md** — label 1 — Another duplicate chunk of the AI roadmap meeting; relevant context but not a hot-topics digest.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-13-03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi-9.md** — label 1 — Another duplicate chunk of the AI roadmap meeting; relevant context but not a hot-topics digest.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-20/03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi.md** — label 1 — Duplicate AI roadmap meeting note; relevant context but not a synthesized view of recent hot topics.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-20/p-2026-03-13-03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi.md** — label 1 — Duplicate AI roadmap meeting note; relevant context but not a synthesized view of recent hot topics.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi-2.md** — label 1 — Duplicate chunk of the AI roadmap meeting; relevant context but not a hot-topics digest.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi.md** — label 1 — Duplicate chunk of the AI roadmap meeting; relevant context but not a hot-topics digest.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-13-03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi-3.md** — label 1 — Duplicate chunk of the AI roadmap meeting; relevant context but not a hot-topics digest.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-13-03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi-4.md** — label 1 — Duplicate chunk of the AI roadmap meeting; relevant context but not a hot-topics digest.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-13-03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi-5.md** — label 1 — Duplicate chunk of the AI roadmap meeting; relevant context but not a hot-topics digest.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-13-03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi-6.md** — label 1 — Duplicate chunk of the AI roadmap meeting; relevant context but not a hot-topics digest.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-18/p-2026-03-13-03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi.md** — label 1 — Duplicate AI roadmap meeting note; relevant context but not a synthesized view of recent hot topics.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-13-03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi-7.md** — label 1 — Duplicate chunk of the AI roadmap meeting; relevant context but not a hot-topics digest.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-13-03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi-2.md** — label 1 — Duplicate chunk of the AI roadmap meeting; relevant context but not a hot-topics digest.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-13-03-13-meeting-ai-roadmap-and-dev-day-planning-mongodb-cost-risk-keynote-logistics-lehi.md** — label 1 — Duplicate chunk of the AI roadmap meeting; relevant context but not a hot-topics digest.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-02-b1eae27a.md** — label 2 — Directly lists hot priorities and frequently discussed topics from recent meetings, making it a primary answer to what topics have been worked on recently.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-08-c5705176.md** — label 2 — Explicitly references 'hot topics' and frequently discussed items from POD meetings and Obsidian notes, directly addressing the query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-ad335bea.md** — label 1 — Mentions recent projects and experiments the user has been following, providing supporting context about recent work themes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/topics/_index.md** — label 1 — A topics index provides navigational context for what subjects exist in the knowledge base but doesn't directly summarize hot recent activity.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/entities/valletta.md** — label 1 — Lists the user's topics and interests including active tools and areas, providing relevant context about ongoing work.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/digests/2026-W21.md** — label 2 — This is a 'Hot topics' digest for a recent week (W21), directly designed to answer what topics were being worked on recently.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/digests/2026-W20.md** — label 2 — This is a 'Hot topics' digest for week W20, directly targeting the hot-cache/digest layer the query exercises, even though it has 0 clusters.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/digests/2026-W22.md** — label 2 — This is a 'Hot topics' digest for week W22, directly targeting the hot-cache/digest layer the query exercises.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/digests/2026-W23.md** — label 2 — This is a 'Hot topics' digest for week W23, directly targeting the hot-cache/digest layer the query exercises.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/_discovery/2026-06-02-b1eae27a.md** — label 2 — Directly enumerates hot priorities from recent meetings, making it a primary source for answering what topics have been worked on recently.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/digests/2026-W24.md** — label 2 — This is a 'Hot topics' digest for the most recent week (W24), directly targeting the hot-cache/digest layer the query exercises.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/_index.md** — label 1 — The wiki index lists active topics and projects providing supporting context but is not itself a summary of hot recent activity.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/entities/hovhannes.md** — label 0 — About a specific person's calibration review with no relevance to the user's hottest recent topics.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/entities/pvaughn.md** — label 0 — About a specific person's professional role and interests, not relevant to the user's hottest recent topics.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/_discovery/2026-06-01-49c044fd.md** — label 1 — Lists topics to raise in an architecture meeting including security defects and architecture items, providing relevant context about recent work.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/entities/arevik.md** — label 0 — About a specific person's calibration review, not relevant to the user's hottest recent topics.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/2nd-brain/2026-05-06-2fc0cfab.md** — label 1 — A session about improving the second-brain project's intelligence and synthesis, providing context about recent work on the knowledge management system.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/entities/ryan-orth.md** — label 0 — About a specific person's calibration review, not relevant to the user's hottest recent topics.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/entities/matt-newman.md** — label 0 — About a specific person's calibration review, not relevant to the user's hottest recent topics.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/entities/irek.md** — label 0 — About a specific person's calibration review, not relevant to the user's hottest recent topics.
  - Tom's call: [ ] agree   [ ] correct to: ____

## decisions-019

**Query:** What is the mechanism that triggers the curator when a new file shows up in the vault?
**Intent:** (none)
**Category/Subtype:** plaud-ai-session / lookup

- **AI Conversations/_summaries/session-2026-05-21-c2bae4b3.md** — label 2 — The excerpt contains the exact query text verbatim, indicating this session directly discusses the mechanism that triggers the curator when a new file appears in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-21/2026-05-21-c2bae4b3.md** — label 2 — This raw session file also contains the exact query text verbatim, making it a primary source for the answer.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/2nd-brain/2026-05-21-c2bae4b3.md** — label 2 — Another copy of the same session containing the exact query text, directly answering the question about the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-05-21-c2bae4b3.md** — label 2 — A curated version of the same session with the exact query text, directly relevant to the curator trigger mechanism question.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-05-21-c2bae4b3-2.md** — label 2 — Another curated version of the same session containing the exact query text about the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-13-72599d04.md** — label 1 — References a 'Spec Curator' workflow with an 'on: push' trigger, which is relevant supporting context about how a curator can be triggered by new files.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-14-2fc0cfab.md** — label 1 — Discusses scheduled jobs firing against a new vault including curator-related jobs, providing relevant context about vault automation mechanisms.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-10-e6d9777c.md** — label 0 — Content is about TypeScript typing and task review inside Vault(), with no relevance to the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-ae3ca1d5.md** — label 0 — Focuses on CLI tooling and control-center source code navigation, not related to the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-10-8461a89f.md** — label 0 — Deals with vault credentials and UI navigation, not the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-e40d0ca9.md** — label 0 — Covers Bedrock auth and TypeScript compilation, unrelated to the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-20-5bf221bd.md** — label 0 — Concerns searching for file references within the vault, not the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-20-96aea468.md** — label 0 — About Obsidian UI settings and reloading, not related to the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-08-b21aed2f.md** — label 0 — Discusses GitHub MCP server activation, unrelated to the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-10-9ace9ae9.md** — label 0 — Relates to vault UI features like mark-dead/restore, not the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-17-770a73c3.md** — label 0 — Discusses MCP search tool coverage and vault indexing gaps, not the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-19-20224115.md** — label 0 — About vault graph connections and index files, not the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-e40d0ca9.md** — label 0 — Covers UI resources structure in vault.tsx, unrelated to the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-28-9ace9ae9.md** — label 0 — Discusses credential management in a secrets vault, unrelated to the file-curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-16-c75c6080.md** — label 0 — About CLI vault commands and health checks, not the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-28-95848572.md** — label 0 — Covers evidence-fetcher and Confluence fetcher development, unrelated to the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-18-dca1a73a.md** — label 1 — Involves the specs-curator project working directory, providing potentially relevant context about curator mechanics even though the session content is empty.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-04-14-8d79ed77.md** — label 0 — Describes agentic compliance checker and hardening generator files, not related to the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-504d8ab6.md** — label 0 — Compares NVM and vault credential management patterns, unrelated to the curator trigger mechanism.
  - Tom's call: [ ] agree   [ ] correct to: ____

## plaud-ai-session-009

**Query:** Take a look at the Architecture Council recording in my files. Use the Carpathian MCP and give me a quick list of all the action items from the Architecture Council this morning.
**Intent:** (none)
**Category/Subtype:** plaud-ai-session / synthesis

- **raw/2026-05-22/p-2026-05-19-05-19-weekly-meeting-ai-initiatives-redrock-monolith-analysis.md** — label 2 — This is a recording/transcript of the Architecture Council meeting on 05-19, which is the primary target file the query asks to analyze for action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-05-19-05-19-weekly-meeting-ai-initiatives-redrock-monolith-analysis-12.md** — label 2 — A curated copy of the Architecture Council meeting transcript from 05-19, directly relevant as the source file for action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-05-19-05-19-weekly-meeting-ai-initiatives-redrock-monolith-analysis-13.md** — label 2 — Another curated segment of the Architecture Council meeting transcript from 05-19, directly relevant as the source file for action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-05-19-05-19-weekly-meeting-ai-initiatives-redrock-monolith-analysis-14.md** — label 2 — Another curated segment of the Architecture Council meeting transcript from 05-19, directly relevant as the source file for action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-19-c5e2d27e.md** — label 2 — This session summary directly contains the exact query text about the Architecture Council recording and Carpathian MCP, making it the primary conversation record.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-05/05-19-weekly-meeting-ai-initiatives-redrock-monolith-analysis.md** — label 2 — This is the Plaud recording file of the Architecture Council meeting on 05-19, which is the primary file the query asks to look at.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-05-19-05-19-weekly-meeting-ai-initiatives-redrock-monolith-analysis-15.md** — label 2 — Another curated segment of the Architecture Council meeting transcript from 05-19, directly relevant as the source file for action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-19/2026-05-19-c5e2d27e.md** — label 2 — Raw conversation file containing the exact query about the Architecture Council recording and Carpathian MCP.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-05-19-05-19-weekly-meeting-ai-initiatives-redrock-monolith-analysis-16.md** — label 2 — Another curated segment of the Architecture Council meeting transcript from 05-19, directly relevant as the source file for action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/2nd-brain/2026-05-19-c5e2d27e.md** — label 2 — Claude conversation file containing the exact query about the Architecture Council recording and Carpathian MCP.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-20/05-19-weekly-meeting-ai-initiatives-redrock-monolith-analysis.md** — label 2 — Another copy of the Architecture Council meeting transcript from 05-19, directly relevant as a source file for action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-05-19-c5e2d27e-2.md** — label 2 — Curated version of the session containing the exact query about the Architecture Council recording and Carpathian MCP.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-20/p-2026-05-19-05-19-weekly-meeting-ai-initiatives-redrock-monolith-analysis.md** — label 2 — Another copy of the Architecture Council meeting transcript from 05-19, directly relevant as a source file for action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-05-19-c5e2d27e.md** — label 2 — Curated version of the session containing the exact query about the Architecture Council recording and Carpathian MCP.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/05-19-weekly-meeting-ai-initiatives-redrock-monolith-analysis-2.md** — label 2 — Another curated copy of the Architecture Council meeting from 05-19, directly relevant as a source file for action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/old/p-2026-05-19-05-19-weekly-meeting-ai-initiatives-redrock-monolith-analysis.md** — label 2 — Old Plaud recording of the Architecture Council meeting on 05-19, directly relevant as the source file for action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/05-19-weekly-meeting-ai-initiatives-redrock-monolith-analysis.md** — label 2 — Curated version of the Architecture Council meeting from 05-19, directly relevant as a source file for action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-19/p-2026-05-19-05-19-weekly-meeting-ai-initiatives-redrock-monolith-analysis.md** — label 2 — Raw copy of the Architecture Council meeting transcript from 05-19, directly relevant as the source file for action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-05-19-05-19-weekly-meeting-ai-initiatives-redrock-monolith-analysis-10.md** — label 2 — Another curated segment of the Architecture Council meeting transcript from 05-19, directly relevant as the source file for action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-05-19-05-19-weekly-meeting-ai-initiatives-redrock-monolith-analysis-11.md** — label 2 — Another curated segment of the Architecture Council meeting transcript from 05-19, directly relevant as the source file for action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-21-2e4df679.md** — label 2 — This session explicitly asks for action items from Architecture Council on Tuesday (05-19), directly matching the intent of the query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-01-49c044fd.md** — label 1 — Relevant context as it involves using Carpathia MCP to review notes for an architecture meeting, similar workflow but not the specific 05-19 action items query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-02-fcc61278.md** — label 1 — Relevant as it references using Carpathia MCP to review the May 19th 8 AM Architecture Council meeting, which is the same meeting referenced in the query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-03-534242c7.md** — label 0 — Focuses on creating Confluence wiki pages for an AI Engineering Enablement Series, not related to extracting Architecture Council action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-19-e542e4ee.md** — label 1 — Directly involves preparing an agenda for the Architecture Council on 05-19, providing relevant context about the same meeting.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-20-20224115.md** — label 1 — Uses Carpathia MCP to review notes, relevant as supporting context for Carpathian MCP usage pattern but not specifically about Architecture Council action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-02-534242c7.md** — label 0 — Focuses on creating Confluence architecture pages under Workfront, not related to the Architecture Council recording or action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-02-b1eae27a.md** — label 1 — References the 05-18 architecture council and ongoing initiatives, providing relevant supporting context about Architecture Council topics.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-01-b36bef6a.md** — label 0 — Uses Carpathia MCP to review architect workloads, not specifically related to Architecture Council recording or action items from 05-19.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-01-8b59e82b.md** — label 0 — Uses Carpathia MCP to review AI interactions for time prioritization, not related to Architecture Council action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-19-c2be3248.md** — label 0 — Focused on a meeting about evals with specific individuals, not the Architecture Council recording or its action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-21-2c113d4a.md** — label 0 — Focused on running Spectra against well-architected index items, not related to Architecture Council action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-08-c5705176.md** — label 0 — Focused on reviewing interactions with a specific person, unrelated to Architecture Council action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-22-c7aea82e.md** — label 1 — Uses Carpathia MCP to prepare for an architecture meeting agenda, similar workflow but for a different date/meeting.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-18-8b1c0403.md** — label 1 — Discusses the effectiveness of the Carpathy MCP for finding files and answering questions, relevant supporting context for the tool usage in the query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-27-6d559e0d.md** — label 0 — Focused on reviewing a spec using MCP tools, not related to Architecture Council action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-04-2c792229.md** — label 0 — Contains planning/Workfront MCP tool listings, not related to Architecture Council recording or action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-18-5f30cf3f.md** — label 0 — Contains bash tool activity for file listing, not related to Architecture Council action items.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-06-dtje8fk.md** — label 0 — About renaming the Carpathi project, not related to Architecture Council action items.
  - Tom's call: [ ] agree   [ ] correct to: ____

## entities-003

**Query:** Workfront wfk8s a-us-common cluster kubernetes namespace deployment
**Intent:** known zero-hit in production; expected to be findable (recall test)
**Category/Subtype:** entities / lookup

- **AI Conversations/_summaries/session-2026-06-22-0419a357.md** — label 2 — Directly discusses Workfront kubectl/k8s credentials, Helm deployment failures, and pod readiness issues in what appears to be a Workfront Kubernetes cluster context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-22-a2beed44.md** — label 2 — Explicitly references 'Deployment to K8s enterprise-context namespace' task in Workfront, directly matching the query about wfk8s cluster namespace deployment.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-23-0419a357.md** — label 1 — Working directory is enterprise-context and likely continues from the session about K8s namespace deployment issues.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-23-4d1f9e67.md** — label 1 — Working directory is enterprise-context, likely related to Kubernetes namespace deployment work at Workfront.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-d82ba152.md** — label 1 — References deploying the wf-business-context MCP with instructions from Clint Goodman, which is related to the Kubernetes deployment context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-09-bc7ada0b.md** — label 1 — Mentions credential refresh related to wf-business-context project, which is contextually related to Kubernetes cluster access.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-a48f0a89.md** — label 0 — Focuses on Workfront project tracking, not Kubernetes namespace or cluster deployment.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-03-8f0aae44.md** — label 0 — Only shows working directory with no relevant content about Kubernetes or cluster deployments.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-05-2b744728.md** — label 0 — No content visible relating to Kubernetes, wfk8s, or cluster namespace deployments.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-a7cdf9e6.md** — label 0 — No relevant content about Kubernetes or cluster deployments visible in excerpt.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-a7cdf9e6.md** — label 0 — No relevant content about Kubernetes or cluster deployments visible in excerpt.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-46d94be3.md** — label 0 — No relevant content about Kubernetes or cluster deployments visible in excerpt.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-975370d7.md** — label 0 — No relevant content about Kubernetes or cluster deployments visible in excerpt.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-a7cdf9e6.md** — label 0 — No relevant content about Kubernetes or cluster deployments visible in excerpt.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-10-59e650cd.md** — label 0 — No relevant content about Kubernetes or cluster deployments visible in excerpt.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-26-a1a45a65.md** — label 0 — Focuses on Workfront Planning OKR data, unrelated to Kubernetes cluster deployments.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-29-680c55e7.md** — label 0 — Discusses UI workstreams and spec forms, not Kubernetes cluster namespace deployments.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-24-cb906636.md** — label 0 — Focuses on spectra project git worktrees and commits, unrelated to Kubernetes deployments.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-05-680c55e7.md** — label 0 — Discusses MCP loading and Workfront context mapping, not Kubernetes cluster deployments.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-08-6bbb6e90.md** — label 0 — Focuses on recreating Workfront planning test data, unrelated to Kubernetes namespace deployments.
  - Tom's call: [ ] agree   [ ] correct to: ____

## hot-topics-004

**Query:** what is the latest on the discovery service consolidation
**Intent:** exercises the hot-cache / digest layer (spec G3); grounded in real recent themes
**Category/Subtype:** hot-topics / synthesis

- **AI Conversations/_summaries/session-2026-06-19-f92e2c16.md** — label 2 — Directly describes work shipped on the 'feat/consolidate-discovery-service' branch with specific commits, making it the primary answer about the discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-19-91473273.md** — label 2 — Session context explicitly shows the branch 'feat/consolidate-discovery-service' as the active working branch, directly relevant to the discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-18-f92e2c16.md** — label 2 — Contains a decision record and implementation plan specifically about running discovery in-process for alpha, directly addressing the discovery service consolidation effort.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-08-bbea3ba4.md** — label 1 — Describes changes to the discovery agent (adding headers to WF MCP requests), relevant supporting context for the discovery service work.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Adobe WF Notes/Projects/enterprise-context/01-deployment-diary.md** — label 1 — Mentions discovery as a takeaway for the harness, providing supporting context for the discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-23-9804f7fc.md** — label 1 — Updates the deployment diary with recent phases, potentially containing follow-on context about the discovery service consolidation work.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-17-770a73c3.md** — label 1 — Describes a unified search tool consolidating legacy tools, which is related supporting context to service consolidation themes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-6d559e0d.md** — label 1 — Covers data source status and sync, tangentially related to the discovery service ecosystem but not specifically about consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-18-8e5b3a2c.md** — label 0 — Focuses on Node.js version policy and pipeline issues, not related to discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-17-7915b2df.md** — label 0 — About git credential/account issues, not related to discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-06/06-05-meeting-mcp-deployment-ai-model-strategy-and-organizational-planning.md** — label 0 — Covers MCP deployment and AI model strategy organizational planning, not specifically about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-06-05/06-05-meeting-mcp-deployment-ai-model-strategy-and-organizational-planning.md** — label 0 — Duplicate of the MCP deployment meeting note, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/06-05-meeting-mcp-deployment-ai-model-strategy-and-organizational-planning.md** — label 0 — Curated version of MCP deployment meeting, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-06/06-01-meeting-astrazeneca-adobe-project-unity-kick-off.md** — label 0 — AstraZeneca/Adobe project kick-off meeting, unrelated to discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-06-02/06-01-meeting-astrazeneca-adobe-project-unity-kick-off.md** — label 0 — Same AstraZeneca kick-off meeting raw transcript, unrelated to discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/06-01-meeting-astrazeneca-adobe-project-unity-kick-off-2.md** — label 0 — Curated AstraZeneca kick-off meeting, unrelated to discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/06-01-meeting-astrazeneca-adobe-project-unity-kick-off.md** — label 0 — Curated AstraZeneca kick-off meeting, unrelated to discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-22/year-month-04-17-strategy-meeting-mcp-public-beta-telemetry-context-architecture-and-summit-readiness.md** — label 0 — April strategy meeting about MCP public beta and GenStudio moat, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/year-month-04-17-strategy-meeting-mcp-public-beta-telemetry-context-architecture-and-summit-readiness-11.md** — label 0 — Curated portion of April strategy meeting, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/year-month-04-17-strategy-meeting-mcp-public-beta-telemetry-context-architecture-and-summit-readiness-12.md** — label 0 — Curated portion of April strategy meeting, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/year-month-04-17-strategy-meeting-mcp-public-beta-telemetry-context-architecture-and-summit-readiness-13.md** — label 0 — Curated portion of April strategy meeting, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/year-month-04-17-strategy-meeting-mcp-public-beta-telemetry-context-architecture-and-summit-readiness-14.md** — label 0 — Curated portion of April strategy meeting, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/year-month-04-17-strategy-meeting-mcp-public-beta-telemetry-context-architecture-and-summit-readiness-15.md** — label 0 — Curated portion of April strategy meeting, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/year-month-04-17-strategy-meeting-mcp-public-beta-telemetry-context-architecture-and-summit-readiness-16.md** — label 0 — Curated portion of April strategy meeting, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-04/04-17-strategy-meeting-mcp-public-beta-telemetry-context-architecture-and-summit-readiness.md** — label 0 — April strategy meeting transcript, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/old/year-month-04-17-strategy-meeting-mcp-public-beta-telemetry-context-architecture-and-summit-readiness.md** — label 0 — Old copy of April strategy meeting, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-20/04-17-strategy-meeting-mcp-public-beta-telemetry-context-architecture-and-summit-readiness.md** — label 0 — Raw April strategy meeting transcript, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-14-dca1a73a.md** — label 0 — About spec reconciliation and orphaned decision pages, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-26-95848572.md** — label 0 — About sub-specs for evidence linkage and prompt config lifecycle, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-12-72599d04.md** — label 0 — About PR merges for research source documents and specs README, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-13-72599d04.md** — label 0 — About curator PR merges and GitHub Actions, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-24-cb906636.md** — label 0 — About worktree management and spec quality work, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-6d559e0d.md** — label 0 — About GitHub connector optimization strategy, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-05-0c737259.md** — label 0 — About game engine particle/flame components and commits, unrelated to discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-29-680c55e7.md** — label 0 — About UI spec form and source cards, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-29-bbeaf18f.md** — label 0 — About branch cleanup and multiplayer skeleton deletion, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-04-15-0c3b7b30.md** — label 0 — About sub-spec phase-6 decision priority requirements, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-04-14-525ddbe7.md** — label 0 — About spec alignment verification for phase-1, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-18-94fa2560.md** — label 0 — About Spectra TypeScript platform with Bedrock and Workfront connector, not specifically about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-10-03-10-architecture-council-2.md** — label 0 — Architecture council meeting about MCP engineering guide, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-20/year-month-04-17-strategy-meeting-mcp-public-beta-telemetry-context-architecture-and-summit-readiness.md** — label 0 — Raw April strategy meeting duplicate, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/04-17-strategy-meeting-mcp-public-beta-telemetry-context-architecture-and-summit-readiness-2.md** — label 0 — Curated April strategy meeting, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/04-17-strategy-meeting-mcp-public-beta-telemetry-context-architecture-and-summit-readiness.md** — label 0 — Curated April strategy meeting, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/year-month-04-17-strategy-meeting-mcp-public-beta-telemetry-context-architecture-and-summit-readiness-10.md** — label 0 — Curated portion of April strategy meeting, not about discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Adobe WF Notes/People/Bryan Pino.md** — label 0 — Person notes about task status visualization, unrelated to discovery service consolidation.
  - Tom's call: [ ] agree   [ ] correct to: ____

## decisions-020

**Query:** What about my Claude Code sessions. Are those sessions being pulled into the vault?
**Intent:** (none)
**Category/Subtype:** plaud-ai-session / lookup

- **AI Conversations/_summaries/session-2026-04-12-2b67dc80.md** — label 2 — Contains the exact query text verbatim, making it the primary source/target of this question.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/old/year-month-2026-04-11-13-28-12.md** — label 2 — Directly addresses the topic of Claude Code sessions being captured automatically into the vault with workflow configuration details.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_legacy/2026-04-12/claude-session-2026-04-11-2b67dc80.md** — label 2 — This is the actual Claude Code session file referenced in the summary that contains the query, directly relevant as an example of a captured session.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/topics/claude-code-session.md** — label 1 — Defines what a Claude Code Session is and its relationship to the vault project, providing supporting context for the query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/2nd-brain/2026-05-19-20224115.md** — label 1 — An example of a Claude Code session stored in the vault, demonstrating that such sessions are indeed being pulled in.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/2nd-brain/2026-05-19-c5e2d27e.md** — label 1 — Another example of a Claude Code session stored in the vault, supporting evidence that sessions are captured.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/2nd-brain/2026-04-14-036e9fb3.md** — label 1 — An example of a Claude Code session stored in the vault, supporting evidence that sessions are captured.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/2nd-brain/2026-04-15-a36dc1e2.md** — label 1 — An example of a Claude Code session stored in the vault, supporting evidence that sessions are captured.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/2nd-brain/2026-05-21-c2bae4b3.md** — label 1 — An example of a Claude Code session stored in the vault, supporting evidence that sessions are captured.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/enterprise-context/2026-06-22-0419a357.md** — label 1 — An example of a Claude Code session stored in the vault, supporting evidence that sessions are captured.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/control-center/2026-06-10-8461a89f.md** — label 1 — An example of a Claude Code session stored in the vault, supporting evidence that sessions are captured.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/control-center/2026-06-11-e40d0ca9.md** — label 1 — An example of a Claude Code session stored in the vault, supporting evidence that sessions are captured.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_legacy/2026-05-14/2026-05-07-a7e9a517.md** — label 1 — An example of a Claude Code session stored in the vault, supporting evidence that sessions are captured.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/jovial-haslett-a471a9/2026-05-07-a7e9a517.md** — label 1 — An example of a Claude Code session stored in the vault, supporting evidence that sessions are captured.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/_discovery/2026-06-12-9470d5ab.md** — label 1 — An example of a Claude Code session stored in the vault, supporting evidence that sessions are captured.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/beautiful-albattani-18826e/2026-05-11-b739cb9a.md** — label 1 — An example of a Claude Code session stored in the vault, supporting evidence that sessions are captured.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/_discovery/2026-06-04-2c792229.md** — label 1 — An example of a Claude Code session stored in the vault, supporting evidence that sessions are captured.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/arrow-v2/2026-04-14-769c66d0.md** — label 1 — An example of a Claude Code session stored in the vault, supporting evidence that sessions are captured.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/arrow-v2/2026-04-14-f19cac1b.md** — label 1 — An example of a Claude Code session stored in the vault, supporting evidence that sessions are captured.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Adobe WF Notes/Projects/enterprise-context/01-deployment-diary.md** — label 0 — Mentions 'vault' and 'sessions' but in an unrelated enterprise deployment context, not about Claude Code sessions being pulled into an Obsidian vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-22/p-2026-03-12-03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-12-03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026-10.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-12-03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026-11.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-12-03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026-12.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/old/p-2026-03-12-03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-12-03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026-8.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-20/p-2026-03-12-03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-12-03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026-9.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-03/03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-20/03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-12-03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-12-03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026-3.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-12-03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026-4.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-12-03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026-5.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-05-18/p-2026-03-12-03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-12-03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026-6.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-12-03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026-7.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026.md** — label 0 — Unrelated meeting notes about usage spikes and FlexNet migration with no connection to Claude Code session vault ingestion.
  - Tom's call: [ ] agree   [ ] correct to: ____

## entities-004

**Query:** wf-instance-resolver AI Dev US experience-stage deployment cluster
**Intent:** known zero-hit in production; expected to be findable (recall test)
**Category/Subtype:** entities / lookup

- **AI Conversations/_summaries/session-2026-06-08-bc7ada0b.md** — label 2 — Directly mentions switching to 'ai-dev-us' and running setup scripts, closely matching the query's ai-dev-us, experience-stage, and deployment cluster context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-04-12a30de3.md** — label 2 — Contains 'WF_INSTANCE_DOMAIN' and wf-instance resolver-related credential/config commits, directly relevant to the wf-instance-resolver and deployment context in the query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-08-bbea3ba4.md** — label 2 — Explicitly discusses 'wf-instance-url' header routing to the right Workfront instance in the discovery agent, directly matching wf-instance-resolver in the query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-09-bc7ada0b.md** — label 1 — Related to the wf-business-context project and credential refresh flows, providing supporting context for the instance resolver and deployment setup.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-08-6bbb6e90.md** — label 1 — Discusses recreating a Workfront planning instance in a preview environment, relevant supporting context for instance/deployment cluster setup.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-08-726fe37b.md** — label 1 — Working directory is ai-dev-us-marketplace, matching the 'AI Dev US' component of the query, though content is sparse.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-726fe37b.md** — label 1 — Working directory is ai-dev-us-marketplace, matching the 'AI Dev US' component of the query, though content is sparse.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-16-726fe37b.md** — label 1 — Working directory is ai-dev-us-marketplace, matching the 'AI Dev US' component of the query, though content is sparse.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-19-726fe37b.md** — label 1 — Working directory is ai-dev-us-marketplace, matching the 'AI Dev US' component of the query, though content is sparse.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-09-59e650cd.md** — label 1 — References a green build in a related project context, providing marginal supporting context for deployment stage.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-03-534242c7.md** — label 0 — Focused on creating Confluence wiki pages for the AI Engineering Enablement Series, not related to wf-instance-resolver or deployment clusters.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-51e319e7.md** — label 0 — Extremely minimal content ('hi' prompt only), no relevance to the query topics.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-a48f0a89.md** — label 0 — Discusses Workfront portfolio/program hierarchy, not related to wf-instance-resolver or deployment clusters.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-02-b1eae27a.md** — label 0 — Covers meeting priorities and strategic initiatives, not related to wf-instance-resolver or deployment clusters.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-04-15-0c3b7b30.md** — label 0 — Focuses on sprint tasks and agentic evaluation packages, unrelated to wf-instance-resolver or ai-dev-us deployment.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-bf8a1672.md** — label 0 — Empty session content in workfront-ai-engineering directory, no relevant information.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-19-bf8a1672.md** — label 0 — Empty session content in workfront-ai-engineering directory, no relevant information.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-26-6fc0f7a8.md** — label 0 — Empty session content in workfront-ai-engineering directory, no relevant information.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-28-121c5e80.md** — label 0 — Empty session content in workfront-ai-engineering directory, no relevant information.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-28-d4c07702.md** — label 0 — Empty session content in workfront-ai-engineering directory, no relevant information.
  - Tom's call: [ ] agree   [ ] correct to: ____

## hot-topics-005

**Query:** what have I been doing with the AI engineering curriculum
**Intent:** exercises the hot-cache / digest layer (spec G3); grounded in real recent themes
**Category/Subtype:** hot-topics / synthesis

_(judging failed for this item — see run logs; candidates existed but were not graded)_

## plaud-ai-session-001

**Query:** 06-01 meeting MCP testing monthly delivery project priorities astrazeneca
**Intent:** known zero-hit in production; expected to be findable (recall test)
**Category/Subtype:** plaud-ai-session / lookup

- **AI Conversations/_summaries/session-2026-06-02-b1eae27a.md** — label 1 — References hot priorities from meetings including MCP harness rollout but is from 06-02 and doesn't specifically mention a 06-01 meeting, testing, monthly delivery, or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-18-9552b24f.md** — label 0 — Focuses on Spectra/Arrow governance pipeline development and has no connection to a 06-01 meeting, monthly delivery priorities, or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_legacy/2026-04-12/claude-session-2026-04-10-d0f356c7.md** — label 1 — Directly discusses MCP server development and project timeline tools but is from April 2026 and has no connection to the 06-01 meeting or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/_discovery/2026-06-02-b1eae27a.md** — label 1 — Contains hot priorities including MCP harness rollout from late May meetings, but does not specifically reference a 06-01 meeting or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-05-18-p-2026-05-14-05-14-weekly-meeting-sandbox-expansions-azure-deployment-inquiry-rcas-ga-readiness-and-trial-outcomes.md** — label 0 — Covers operational execution and infrastructure scaling topics from May 14; no connection to 06-01 meeting, MCP testing, monthly delivery, or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-05-13-p-2026-05-13-05-13-weekly-meeting-mcp-gateway-update-and-end-of-may-release-plan.md** — label 1 — Discusses MCP gateway release planning and project priorities but is from May 13 and does not mention AstraZeneca or a 06-01 meeting.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-05-15-p-2026-05-15-05-15-meeting-anthropic-connector-mcp-release-planning.md** — label 1 — Covers MCP release planning and testing (bug bash) but is from May 15 and has no mention of AstraZeneca or the 06-01 meeting.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-03-24-p-2026-03-24-03-24-team-meeting-mcp-strategy-alignment-ai-development-acceleration-and-scenario-prioritization.md** — label 1 — Covers MCP strategy and scenario prioritization but is from March 2026 with no connection to the 06-01 meeting or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-05-18-p-2026-03-13-03-13-weekly-meeting-mcp-strategy-agent-quality-and-platform-context-updates.md** — label 1 — Covers MCP strategy topics but is from March 2026 and does not reference the 06-01 meeting, monthly delivery, or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-03-13-p-2026-03-13-03-13-weekly-meeting-mcp-strategy-agent-quality-and-platform-context-updates.md** — label 1 — Discusses MCP strategy and agent quality but is from March 2026 with no mention of the 06-01 meeting or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_legacy/2026-04-12/claude-session-2026-04-09-0c1fd751.md** — label 0 — Discusses Workfront pain point research and reviews; not relevant to a 06-01 meeting, MCP testing, monthly delivery, or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-05-11-p-2026-05-11-05-11-project-review-meeting-mcp-setup-claude-vs-ao-comparison-and-multi-harness-strategy.md** — label 1 — Covers MCP setup and project review including multi-harness strategy but is from May 11 with no mention of AstraZeneca or the 06-01 meeting.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-05-11-p-2026-05-11-05-11-weekly-meeting-ai-first-strategy-and-mcp-release.md** — label 1 — Discusses MCP release and AI-first strategy priorities but is from May 11 and does not reference the 06-01 meeting or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/_index.md** — label 0 — Is a general wiki index listing meeting notes; not directly relevant to the specific 06-01 meeting query or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-04-13-p-2026-04-13-04-13-weekly-meeting-azure-performance-summit-freeze-and-board-mcp.md** — label 0 — Covers Azure performance and summit freeze topics from April 2026; not relevant to the 06-01 meeting, monthly delivery, or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-05-18-p-2026-05-18-05-18-meeting-mcp-gateway-configuration-authentication-link-surfacing-and-scheduling-issues.md** — label 1 — Directly discusses MCP gateway testing with named testers but is from May 18 and does not reference the 06-01 meeting or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/digests/2026-W21.md** — label 0 — Is a weekly digest covering May 14-21 topics around MCP discovery; not relevant to the 06-01 meeting or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-04-16-p-2026-04-16-04-16-weekly-meeting-three-year-strategy-mcp-release-and-data-strategy.md** — label 1 — Covers MCP release and strategic priorities from April 2026 but has no connection to the 06-01 meeting or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_legacy/2026-04-12/claude-session-2026-04-09-760d20a9.md** — label 0 — Focuses on API catalog and MCP tool mapping from April 2026 sessions; not related to the 06-01 meeting, monthly delivery, or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/wf-business-context/2026-06-15-46d94be3.md** — label 1 — Describes MCP server implementation details from June 2026 but does not specifically reference the 06-01 meeting or AstraZeneca.
  - Tom's call: [ ] agree   [ ] correct to: ____

## entities-005

**Query:** deployment lane hub preview stage QA Kubernetes namespace Ethos
**Intent:** known zero-hit in production; expected to be findable (recall test)
**Category/Subtype:** entities / lookup

- **AI Conversations/_summaries/session-2026-06-15-46d94be3.md** — label 2 — Directly contains grep patterns for all key query terms: deploy, lane, QA, hub, preview, namespace, kubernetes, ethos, stage — this is the primary target of the recall test.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-15-46d94be3.md** — label 2 — Same session ID (46d94be3) as the primary target, likely the source document containing deployment lane/hub/preview/stage/QA/Kubernetes/Ethos/namespace content.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-15-46d94be3-2.md** — label 2 — Second part of the same 46d94be3 session source, directly related to the primary query target.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-23-0419a357.md** — label 1 — Involves debugging a deploy-review CI pipeline for enterprise-context in GitLab, touching deployment and Kubernetes-related concepts.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-22-0419a357.md** — label 1 — Covers the deploy-review job, kubectl/k8s credentials, and Helm deployment issues — relevant Kubernetes/deployment supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-18-8e5b3a2c.md** — label 1 — Works on enterprise-context with Harness UI deployment configuration, relevant supporting context for deployment pipeline topics.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/06-04-weekly-meeting-platform-architecture-authentication-and-deployment.md** — label 1 — Covers platform architecture and deployment topics which may include deployment lanes, stages, or Kubernetes/Ethos infrastructure context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/05-26-weekly-meeting-ai-collaborators-rollout-mcp-harness-priorities-eu-uk-privacy-compliant-metrics-and-performance-security-remediation.md** — label 1 — Mentions Harness priorities which may relate to deployment pipeline stages (QA, preview, etc.) in the same infrastructure context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-19-91473273.md** — label 1 — Involves SRE/infrastructure topics including Docker and Kubernetes-adjacent concerns, providing supporting deployment context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/digests** — label 1 — A digest/wiki document that may aggregate references to deployment lanes, namespaces, or Ethos infrastructure topics.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-12-03-12-meeting-usage-spike-migration-off-flexnet-rate-cards-ai-resourcing-and-cross-cloud-ops-early-2026.md** — label 0 — Focuses on usage spikes, FlexNet migration, rate cards, and AI resourcing — not related to deployment lanes, Kubernetes namespaces, or Ethos.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/06-02-meeting-workfront-mcp-integration-unity-agent-and-llm-testing.md** — label 0 — Covers Workfront MCP integration, Unity agent, and LLM testing — not relevant to deployment lanes, Kubernetes, or Ethos namespaces.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-19-726fe37b.md** — label 0 — Empty session with no content related to deployment lanes, Kubernetes, or Ethos.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-c5250c1f.md** — label 0 — Focuses on wf-business-context deliverables and approval status, not deployment infrastructure.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-d433551f.md** — label 0 — Focuses on wf-business-context deliverables and approval status, not deployment infrastructure.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-10-bdb456a6.md** — label 0 — Discusses control-center skills for Cloud Code, not related to deployment lanes, Kubernetes, or Ethos.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-47cad6c8.md** — label 0 — About SilkRoot brand campaigns and deliverables, not deployment infrastructure.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-afaacf4f.md** — label 0 — About SilkRoot brand campaigns and deliverables, not deployment infrastructure.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-59169846.md** — label 0 — About agency-managed campaigns, not deployment lanes or Kubernetes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-b2b13cd0.md** — label 0 — About SilkRoot brand deliverables, not deployment infrastructure.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-609acf99.md** — label 0 — About agency-managed campaigns, not deployment lanes or Kubernetes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-c48e69b1.md** — label 0 — About agency-managed campaigns, not deployment infrastructure.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-11b46708.md** — label 0 — About agency-managed campaigns, not deployment infrastructure.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-331b0716.md** — label 0 — About agency-managed campaigns, not deployment lanes or Kubernetes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-1ada29f5.md** — label 0 — About agency-managed campaigns, not deployment infrastructure.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-2c2f3d12.md** — label 0 — About agency-managed campaigns, not deployment lanes or Kubernetes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-26-8035bc17.md** — label 0 — About a game (shop items, shields, fuel) unrelated to deployment lanes, Kubernetes, or Ethos.
  - Tom's call: [ ] agree   [ ] correct to: ____

## hot-topics-006

**Query:** what are the active projects in my vault right now
**Intent:** exercises the hot-cache / digest layer (spec G3); grounded in real recent themes
**Category/Subtype:** hot-topics / synthesis

- **Plaud/old/year-month-2026-04-11-13-28-12.md** — label 1 — Meeting transcript about Obsidian vault automation touches on vault state but doesn't enumerate active projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-07-06/2026-07-06-8960de59.md** — label 0 — Focused on a broken Datadog API/App key issue in a Control Center context, not a summary of active vault projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/enterprise-context/2026-07-06-8960de59.md** — label 0 — Duplicate of the Datadog discovery issue; not relevant to listing active projects in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-07-06-8960de59.md** — label 0 — Same Datadog/discovery content; does not address active vault projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-07-06-8960de59-2.md** — label 0 — Duplicate of the same Datadog issue note; not relevant to active projects query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Adobe WF Notes/Projects/enterprise-context/01-deployment-diary.md** — label 1 — A deployment diary provides project context and history, offering supporting background on ongoing work but not a direct active-projects overview.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-06/06-22-meeting-argo-cd-deployment-troubleshooting-and-ai-devex-automation.md** — label 1 — Meeting transcript covering an active project (Argo CD deployment and AI DevEx automation) relevant to current work themes.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Plaud/2026-06/06-22-meeting-mcp-context-delivery-workfront-light-and-coworker-alignment.md** — label 1 — Mentions the current context pieces in play, touching on active project areas like MCP and Workfront Light.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-06-12/2026-06-12-9470d5ab.md** — label 2 — Directly references reviewing vault transcripts to surface recent topics, closely matching the intent of querying active projects in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/_discovery/2026-06-12-9470d5ab.md** — label 2 — Same discovery session explicitly examining vault contents and recent themes, directly relevant to the active-projects query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-12-9470d5ab-2.md** — label 2 — Curated version of the same vault-discovery content identifying recent captured topics.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-12-9470d5ab.md** — label 2 — Curated version of the vault-discovery note surfacing recent vault themes and projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-12-9470d5ab-3.md** — label 2 — Another curated copy of the vault-discovery note directly addressing what's currently in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/control-center/2026-06-11-e40d0ca9.md** — label 1 — References projects in the /dev folder and their needs, providing supporting context on active project structure.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-11-e40d0ca9-5.md** — label 1 — Curated excerpt identifying project resource needs from /dev, relevant supporting context for active projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-a7cdf9e6.md** — label 0 — Focused on eval run results and LGM data; not about active projects in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-10-59e650cd.md** — label 0 — Deals with a 401 login/authentication issue; not relevant to listing active vault projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **raw/2026-06-01/2026-06-01-49c044fd.md** — label 1 — The user asks an AI to review their notes to find relevant topics for a meeting, implying vault-based project awareness.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/_discovery/2026-06-01-49c044fd.md** — label 1 — Discovery session scanning notes to identify current topics, supporting context for understanding active vault projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-01-49c044fd-2.md** — label 1 — Curated version of the same note-review session; supporting context for vault project awareness.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-18-8b1c0403.md** — label 1 — Session about finding the right files and answering questions from vault conversations, relevant to vault navigation.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-ae3ca1d5.md** — label 1 — Session working within control-center vault-related code, providing supporting context on active development projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-10-e6d9777c.md** — label 0 — Focused on finding vault/credential files in a code repo; not about the knowledge-base vault's active projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-10-9ace9ae9.md** — label 1 — Contains a structured overview of completed and outstanding work items across project areas, relevant supporting context for active projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-15-e40d0ca9.md** — label 0 — Focused on vault.tsx code structure in a specific app; technical implementation detail not relevant to the active-projects query.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-10-cce2b65f.md** — label 0 — Searches for vault/credential TypeScript files in a codebase; not about active vault projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-17-e40d0ca9.md** — label 0 — Investigates GitLab vault credentials; technical credential work not relevant to active knowledge-base projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-19-20224115.md** — label 2 — Directly examines the vault graph and connectivity, addressing the state of the Obsidian vault and its project connections.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-10-8461a89f.md** — label 0 — Focused on live-test TypeScript files in control-center vault source code; not relevant to active vault projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-12-72599d04.md** — label 0 — Searching .env files for Bedrock credentials; not about active projects in the vault.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-13-2fc0cfab.md** — label 1 — Session exploring Obsidian vaults and the 2nd-brain project structure, providing supporting context on vault organization.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-504d8ab6.md** — label 1 — Works across multiple dev projects including control-center and ai-dev-us-marketplace, giving supporting context on active projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-26-4b40db4c.md** — label 1 — Active work on workfront-ai-engineering project provides supporting context on one of the active vault projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-28-275f8798.md** — label 1 — Work on scorched-earth project with git history exploration gives supporting context on another active project.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-12-a48f0a89.md** — label 2 — Explicitly queries for recent/active projects in an AI program portfolio, directly matching the intent of finding active projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-13-72599d04.md** — label 0 — Focused on specs-curated curator/LLM code; not relevant to identifying active vault projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-15-cfe0cda5.md** — label 0 — Starts a pnpm dev server for control-center; technical session not relevant to listing active projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-09-8ba8fee3.md** — label 1 — Active development work on scorched-earth project provides supporting context as one of the active vault projects.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-05-14-b739cb9a.md** — label 0 — Explores control-center worktree package structure; specific technical detail not relevant to vault project overview.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-11-e40d0ca9.md** — label 2 — Lists dev projects and specs directly via bash commands, providing a direct view of active projects in the dev environment.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-01-49c044fd.md** — label 1 — Curated version of the note-review session scanning the vault for current topics; supporting context.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/2026-06-01-49c044fd-3.md** — label 1 — Another curated copy of the same vault note-review; supporting context for active project awareness.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_legacy/2026-04-12/claude-session-2026-04-11-d6ed5258.md** — label 2 — Explicitly checks what's currently in the vault to understand its state, directly matching the query intent.
  - Tom's call: [ ] agree   [ ] correct to: ____

## plaud-ai-session-002

**Query:** Brian 1:1 May 18 4pm
**Intent:** known zero-hit in production; expected to be findable (recall test)
**Category/Subtype:** plaud-ai-session / lookup

- **Adobe WF Notes/Meetings/Architecture/Architecture Meeting.md** — label 0 — Architecture meeting notes with no connection to Brian, a 1:1, May 18, or 4pm.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-03-03-03-03-meeting-conversational-ai-unity-platform-and-horizontal-initiative.md** — label 0 — Mentions Brian and 4pm but is a March 3 meeting about conversational AI, not a Brian 1:1 on May 18.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_summaries/session-2026-06-08-c5705176.md** — label 1 — Contains Brian's direct asks and context relevant to 1:1 meetings with Brian, but is from June 8 not May 18.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/topics/weekly-meeting.md** — label 0 — Generic weekly meeting topic index with no specific connection to Brian, a 1:1, or May 18.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-04-01-p-2026-04-01-04-01-weekly-meeting-check-in-deadlines.md** — label 0 — April 1 weekly meeting about check-in deadlines, not a Brian 1:1 on May 18.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-05-15-p-2026-05-15-05-15-quick-resolution-of-calendar-double-booking-prioritize-brian-reschedule-dale-to-post-lunch-slot.md** — label 1 — Directly involves Brian's calendar scheduling on May 15, 2026, closely related to finding Brian's May 18 1:1.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-05-18-p-2026-03-03-03-03-ca-ai-collaborators-unified-workflows-ai-collaborators-governance-and-summit-plan.md** — label 0 — Dated May 18 but content is about AI collaborators governance and Summit planning, not a Brian 1:1.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-03-24-p-2026-03-24-03-24-daily-standup-agentic-cse-gmo-scheduling-discovery-agent-integration-aem-brand-brain-alignment-and-compliance-ux-for-summit-demo.md** — label 0 — March 24 daily standup unrelated to a Brian 1:1 on May 18.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-04-07-p-2026-04-07-2026-04-07-07-02-48.md** — label 0 — April 7 meeting about releases and GCP migration, no connection to Brian 1:1 on May 18.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/2nd-brain/2026-04-15-5cc0820b.md** — label 0 — Claude coding session from April 2026, not related to a Brian 1:1 meeting.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/digests/2026-W22.md** — label 0 — Empty weekly digest for the week of May 21–28, not a Brian 1:1 record.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-05-13-p-2026-05-13-05-13-weekly-meeting-brad-s-departure-red-rock-project-magenta-and-ai-strategy.md** — label 0 — May 13 weekly meeting about Brad's departure and AI strategy, not a Brian 1:1 on May 18.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_legacy/2026-04-13/claude-session-2026-04-13-8e7ff9bd.md** — label 0 — Legacy Claude coding session from April 13, unrelated to a Brian 1:1 meeting.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/_legacy/2026-04-14/claude-session-2026-04-13-8e7ff9bd.md** — label 0 — Duplicate legacy Claude coding session, unrelated to a Brian 1:1 meeting.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/digests/2026-W23.md** — label 0 — Empty weekly digest for late May/early June, not a Brian 1:1 record.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-04-07-p-2026-04-07-04-07-meeting-promotion-packet-timelines-criteria-and-ai-expectations.md** — label 0 — April 7 promotion packet meeting, not a Brian 1:1 on May 18.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **AI Conversations/claude/infallible-chandrasekhar-aeb5f6/2026-05-11-72599d04.md** — label 0 — Claude coding session from May 11, not related to a Brian 1:1 meeting.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/digests/2026-W24.md** — label 0 — Empty weekly digest for June 5–12, not a Brian 1:1 record.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/digests/2026-W20.md** — label 0 — Empty weekly digest for May 7–14, not a Brian 1:1 record.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-05-18-p-2026-05-18-05-18-meeting-mcp-gateway-configuration-authentication-link-surfacing-and-scheduling-issues.md** — label 1 — Dated May 18 and is a meeting note from that day, but topic is MCP gateway configuration rather than a Brian 1:1.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/wiki/meetings/2026-05-18-p-2026-03-17-03-17-meeting-robotics-ai-infrastructure-project-leapfrog-and-architecture-updates.md** — label 1 — Features Brian prominently with action items and is filed under May 18, making it a plausible candidate for the Brian 1:1 on that date.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-05-18-05-18-meeting-inter-team-collaboration-and-performance-calibration-3.md** — label 1 — Source file dated May 18 about inter-team collaboration and performance calibration, could be related to a Brian 1:1 on that date.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-05-18-05-18-meeting-ai-leadership-calibration-mcp-tool-strategy-and-unity-alignment.md** — label 2 — Source file dated May 18 about AI leadership calibration — a leadership 1:1 topic on May 18 directly matching the query target.
  - Tom's call: [ ] agree   [ ] correct to: ____
- **Curated/sources/p-2026-05-18-05-18-manager-employee-check-in-on-project-work-and-personal-well-being.md** — label 2 — Explicitly a manager-employee check-in (1:1 format) on May 18, 2026, directly matching the 'Brian 1:1 May 18' query.
  - Tom's call: [ ] agree   [ ] correct to: ____
