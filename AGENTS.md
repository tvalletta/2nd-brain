# AGENTS.md — Working Agreement for AI Coding Agents

> **Audience:** Any AI coding agent operating in this repository (Claude Code, Cursor, Codex, etc.).
> **Status:** Authoritative. Read this file before taking any action.

---

## 0. The One Rule You Cannot Break

**The specification is the source of truth. Code and spec must never drift.**

There is never a state in which the implemented behavior and the written specification disagree. If you find yourself about to create such a state — STOP and update the spec first.

---

## 1. Read the Spec Before You Do Anything

Before responding to any request that involves code, configuration, or design:

1. **Read the relevant sections of [`specs/specification.md`](./specs/specification.md)**:

   | Sections | Topic |
   |---|---|
   | §1–5 | Goals, non-goals, system of record, storage layers |
   | §6 | Two-tier memory model (hot cache / cold storage) |
   | §7 | Architectural lanes (deterministic, extraction, heuristic) |
   | §8.1–8.5 | Job queue, idempotency, debouncing, cascade graph |
   | §9 | Functional requirements (FR-1 through FR-7) |
   | §10 | Data model and canonical identity rules |
   | §11–12 | State transitions and overwrite policy |
   | §17 | Acceptance criteria (AC-1 through AC-6) |
   | §18 | Implementation phases |
   | §19 | MCP scope (18 tools, detail levels) |
   | §21a | Intelligence layer (optional, additive) |

2. **Also check [`specs/intelligence-plan.md`](./specs/intelligence-plan.md)** for intelligence pipeline work (TL;DR, decay, topic refresh, weekly digest, research handshake, embeddings, significance gate).

3. **Cite the spec section that governs the change.** If you cannot point to a specific section that authorizes what you are about to do, you do not yet have permission to do it.

---

## 2. The Alignment Protocol

Every incoming request falls into one of three buckets. Handle each as described:

### A. Request matches the spec
- Implement it.
- Reference the spec section in your response (e.g., "Per `specs/specification.md` §8.3…").

### B. Request is silent in the spec (spec doesn't mention it)
- **Do not implement first.** Treat this as a spec gap.
- Propose the spec change to the user (or write it directly in the relevant spec file).
- Confirm the addition is correct, then implement against it.

### C. Request contradicts the spec
- **STOP. Do not silently deviate.**
- Explicitly call out the contradiction: "This contradicts `specs/specification.md` §X, which says Y."
- Update the spec **first** — in the same response or the same commit as the code change.
- Then implement.

There is no fourth bucket. There is no "I'll update the spec later". There is no "the code is the spec". The written spec is the spec.

---

## 3. Spec Maintenance Is a First-Class Deliverable

- Treat every file in `specs/` as a production artifact, not documentation debt.
- Spec edits ship in the **same** commit as the code they describe.
- After making changes, do a final pass: read the spec section you touched, then read the code you wrote, and confirm they describe the same system.
- Update `CLAUDE.md` if the change affects build commands, directory layout, architecture rules, or common task recipes.
- Treat doc drift the same as a failing build.

---

## 4. Operating Checklist (Apply to Every Task)

Before responding:
- [ ] Read the relevant spec file(s).
- [ ] Identify which bucket the request falls into (A / B / C above).

While working:
- [ ] State which spec sections govern the work.
- [ ] If in bucket B or C, edit the spec in the same change set.
- [ ] If anything is ambiguous, ask the user — do not invent behavior.

Before finishing:
- [ ] Re-read the spec section you touched.
- [ ] Confirm code and spec describe the same system.
- [ ] Confirm no orphaned spec sections remain (sections describing behavior that no longer exists).
- [ ] `pnpm build && pnpm test && pnpm lint` all pass.

---

## 5. Simplicity First (Non-Negotiable)

**Default to the simplest thing that satisfies the spec.** Complexity must be earned, not assumed.

For every change, prefer in order:

1. **Don't add it** — can the existing code already do this?
2. **Extend the simplest existing primitive** — a function, a file, an existing module.
3. **Add the smallest new piece** — one function, one file, one dependency.
4. **Only then** consider new layers, abstractions, frameworks, services, or patterns. If you reach step 4, justify it explicitly, citing either the spec or concrete evidence.

### Heuristics that must be true before adding complexity

- **Rule of three:** extract an abstraction only after the third usage, not the second.
- **Spec demands it:** if the spec doesn't call for a layer/queue/cache/service, don't add one.
- **Smaller diff wins:** between two correct solutions, pick the one with fewer lines, fewer files, fewer concepts.
- **Boring wins:** prefer well-known patterns over clever ones.

### Reject these anti-patterns

- Speculative interfaces / "we might need it later" abstractions.
- New design patterns introduced for a single use site.
- Wrapper layers that just forward calls.
- Premature generalization without a real second use case.
- Restructuring or renaming beyond the scope of the requested change.

---

## 6. Repo-Wide Norms

- **Package manager:** `pnpm`. Never use `npm` or `yarn`.
- **Build / test / lint:** `pnpm build && pnpm test && pnpm lint` — all must pass before committing.
- **Module system:** ESM only — `"type": "module"` in `package.json`. All imports use `.js` extensions.
- **Vault I/O:** All filesystem access to the vault goes through `VaultAdapter` (`src/vault/adapter.ts`). Never use `fs` directly for vault operations.
- **Atomic writes:** Use `vault.atomicWrite()` or `atomicWrite()` from `src/shared/fs-utils.ts` for any write that could corrupt on partial failure.
- **Protected regions:** Machine-managed content goes in `%% begin:id %% / %% end:id %%` blocks. Import `OPEN_TAG`/`CLOSE_TAG` from `src/vault/protected-regions.ts` — never hardcode the marker strings.
- **Layout-aware paths:** Use `layoutFromConfig(config)` and `kindToFolder(layout, kind)` from `src/vault/paths.ts`. Never hardcode `wiki/` — it may be `Curated/wiki/` in production.
- **Job dedup:** Use `dedupeKey` when enqueuing jobs to prevent duplicate work from rapid hook triggers.
- **Secrets:** Never commit secrets. `.env` is gitignored.

---

## 7. Quick Reference

- North-star spec: [`specs/specification.md`](./specs/specification.md)
- Intelligence plan: [`specs/intelligence-plan.md`](./specs/intelligence-plan.md)
- Operational quick-reference: [`CLAUDE.md`](./CLAUDE.md)
- Claude Code rules: [`.claude/rules/specifications.md`](./.claude/rules/specifications.md)
- Cursor rules: [`.cursor/rules/specifications.md`](./.cursor/rules/specifications.md)

---

**Bottom line:** If you ever catch yourself writing code without first grounding it in the spec — stop and re-read this file.
