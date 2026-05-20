---
id: proj-auth-001
type: project
title: Auth Redesign
status: active
confidence: high
review_state: reviewed
created_at: "2026-04-08T09:00:00.000Z"
updated_at: "2026-04-11T14:00:00.000Z"
project_status: in_progress
source_refs:
  - raw/2026-04-08/kickoff-meeting.md
  - raw/2026-04-10/standup-notes.md
derived_from:
  - outputs/source-summaries/kickoff-meeting.md
  - outputs/source-summaries/standup-notes.md
aliases:
  - Auth System Overhaul
  - Authentication Redesign
links:
  - wiki/entities/alice-chen.md
  - wiki/entities/bob-martinez.md
  - wiki/decisions/march-deadline.md
  - wiki/concepts/zero-trust.md
  - wiki/topics/oidc.md
  - wiki/topics/oauth-2-0.md
  - wiki/tools/kong.md
  - wiki/tools/redis.md
  - wiki/organizations/acme-corp.md
change_origin: extraction
protected_regions:
  - overview
  - people
  - decisions
  - concepts
  - sessions
  - sources
  - backlinks
---

# Auth Redesign

## Overview
%% begin:overview %%
Complete overhaul of [[acme-corp|Acme Corp]]'s authentication system. Driven by legal/compliance requirements around session token storage that do not meet new regulatory standards. The project migrates from legacy [[oauth-2-0|OAuth 2.0]] to [[oidc|OIDC]] with [[zero-trust|Zero Trust Architecture]] principles applied at every service boundary. The goal is to pass the Q2 compliance audit.
%% end:overview %%

## Key People
%% begin:people %%
- **Lead:** [[alice-chen|Alice Chen]] — Project lead, driving OIDC middleware implementation
- **API Gateway:** [[bob-martinez|Bob Martinez]] — Handling [[kong|Kong]] OIDC plugin configuration and gateway-level token refresh
%% end:people %%

## Decisions
%% begin:decisions %%
- [[march-deadline|March Deadline]] — Feature-complete by March 31, 2027 to align with Q2 compliance audit window
- Dual-mode validation period for backward compatibility with mobile clients still using [[oauth-2-0|OAuth 2.0]] tokens
- [[redis|Redis]] for distributed token cache invalidation across [[kong|Kong]] gateway instances
%% end:decisions %%

## Related Concepts
%% begin:concepts %%
- [[zero-trust|Zero Trust Architecture]] — Guiding security principle; requires OIDC token validation at every service boundary
- [[oidc|OIDC]] — Target authentication protocol replacing legacy OAuth
- [[oauth-2-0|OAuth 2.0]] — Legacy protocol being migrated from; will remain supported in deprecated dual-mode during transition
%% end:concepts %%

## Sessions
%% begin:sessions %%
- [[session-2026-04-10-auth-refact]] — Auth middleware refactoring: replaced legacy session check with OIDC middleware in 4 files, added 6 tests (2026-04-10)
%% end:sessions %%

## Source References
%% begin:sources %%
- [[kickoff-meeting]] — Auth Redesign kickoff meeting (2026-04-08)
- [[standup-notes]] — Daily standup notes with progress updates (2026-04-10)
%% end:sources %%

## Backlinks
%% begin:backlinks %%
### From Sources
- [[kickoff-meeting]] — "Kickoff meeting for the authentication system redesign" (source_summary, 2026-04-08)
- [[standup-notes]] — "Completed the OIDC middleware refactoring" and "API gateway OIDC integration spike is complete" (source_summary, 2026-04-10)

### From Sessions
- [[session-2026-04-10-auth-refact]] — "Replaced legacy session check with OIDC middleware in 4 files" (session_summary, 2026-04-10)

### From Wiki
- [[alice-chen]] — "Currently leading the [[Auth Redesign]] project" (entity, 2026-04-11)
- [[bob-martinez]] — "Working under Alice Chen on the [[Auth Redesign]] project" (entity, 2026-04-11)
- [[march-deadline]] — "The [[Auth Redesign]] must be feature-complete by March 31, 2027" (decision, 2026-04-11)
- [[zero-trust]] — "The [[Auth Redesign]] project applies zero trust principles" (concept, 2026-04-11)
- [[oidc]] — "Target protocol for the [[Auth Redesign]] migration" (topic, 2026-04-11)
- [[oauth-2-0]] — "Legacy protocol being replaced in [[Auth Redesign]]" (topic, 2026-04-11)
- [[kong]] — "Used in [[Auth Redesign]] for API gateway OIDC integration" (tool, 2026-04-11)
- [[redis]] — "Suggested for [[Auth Redesign]] token cache invalidation" (tool, 2026-04-11)
- [[acme-corp]] — "Running the [[Auth Redesign]] project" (organization, 2026-04-11)
%% end:backlinks %%
