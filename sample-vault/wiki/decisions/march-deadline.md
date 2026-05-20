---
id: dec-deadline-001
type: decision
title: March Deadline
status: active
confidence: medium
review_state: reviewed
created_at: "2026-04-08T11:00:00.000Z"
updated_at: "2026-04-11T14:00:00.000Z"
decision_status: confirmed
source_refs:
  - raw/2026-04-08/kickoff-meeting.md
derived_from:
  - outputs/source-summaries/kickoff-meeting.md
aliases: []
links:
  - wiki/projects/auth-redesign.md
  - wiki/entities/alice-chen.md
  - wiki/entities/bob-martinez.md
change_origin: extraction
protected_regions:
  - context
  - outcome
  - people
  - sources
  - backlinks
---

# March Deadline

## Context
%% begin:context %%
At the [[auth-redesign|Auth Redesign]] kickoff meeting on 2026-04-08, the team decided that the project must be feature-complete by **March 31, 2027**. This deadline is driven by the Q2 compliance audit window -- the current session token storage at [[acme-corp|Acme Corp]] does not meet new regulatory requirements, and the migration to [[oidc|OIDC]] must be complete before the audit.
%% end:context %%

## Outcome
%% begin:outcome %%
- **Decision:** Auth Redesign feature-complete by March 31, 2027
- **Rationale:** Alignment with Q2 compliance audit schedule
- **Status:** Confirmed at kickoff; no changes as of 2026-04-10
%% end:outcome %%

## Key People
%% begin:people %%
- [[alice-chen|Alice Chen]] — Accountable for delivery. Leading the [[auth-redesign|Auth Redesign]] project.
- [[bob-martinez|Bob Martinez]] — Responsible for API gateway integration deliverables within the deadline.
%% end:people %%

## Source References
%% begin:sources %%
- [[kickoff-meeting]] — Auth Redesign kickoff meeting where deadline was confirmed (2026-04-08)
%% end:sources %%

## Backlinks
%% begin:backlinks %%
### From Sources
- [[kickoff-meeting]] — "We decided the deadline must be March 31, 2027 to align with Q2 compliance audit" (source_summary, 2026-04-08)

### From Wiki
- [[auth-redesign]] — "[[March Deadline]] -- Feature-complete by March 31, 2027" (project, 2026-04-11)
- [[alice-chen]] — "[[Alice Chen]] is accountable for delivery" (entity, 2026-04-11)
%% end:backlinks %%
