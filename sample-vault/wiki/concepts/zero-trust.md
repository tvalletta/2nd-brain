---
id: con-zt-001
type: concept
title: Zero Trust Architecture
status: active
confidence: high
review_state: reviewed
created_at: "2026-04-09T15:00:00.000Z"
updated_at: "2026-04-11T14:00:00.000Z"
source_refs:
  - raw/2026-04-08/kickoff-meeting.md
derived_from:
  - outputs/source-summaries/kickoff-meeting.md
aliases:
  - Zero Trust
  - ZTA
links:
  - wiki/projects/auth-redesign.md
  - wiki/entities/alice-chen.md
  - wiki/topics/oidc.md
  - wiki/topics/oauth-2-0.md
change_origin: extraction
protected_regions:
  - definition
  - projects
  - people
  - concepts
  - discussions
  - sources
  - backlinks
---

# Zero Trust Architecture

## Definition
%% begin:definition %%
Security model that requires strict identity verification for every person and device attempting to access resources, regardless of whether they are inside or outside the network perimeter. Core principles include: never trust, always verify; least privilege access; assume breach; verify explicitly at every boundary.
%% end:definition %%

## Related Projects
%% begin:projects %%
- [[auth-redesign|Auth Redesign]] — Applying zero trust by requiring [[oidc|OIDC]] token validation at every service boundary, replacing the previous perimeter-based trust model
%% end:projects %%

## Related People
%% begin:people %%
- [[alice-chen|Alice Chen]] — Domain expertise in ZTA; guiding the [[auth-redesign|Auth Redesign]] with zero trust principles
%% end:people %%

## Connected Concepts
%% begin:concepts %%
- [[oidc|OIDC]] — The authentication protocol implementing zero trust token validation at service boundaries
- [[oauth-2-0|OAuth 2.0]] — Legacy protocol that relied on perimeter-based trust; being replaced under ZTA principles
%% end:concepts %%

## Discussions
%% begin:discussions %%
- **2026-04-08** — At the [[auth-redesign|Auth Redesign]] kickoff meeting, the team agreed that zero trust architecture would be the guiding principle for the redesign. ([[kickoff-meeting|Source]])
- **2026-04-10** — [[alice-chen|Alice Chen]] planning to draft the zero trust boundary verification spec as next step. ([[standup-notes|Source]])
%% end:discussions %%

## Source References
%% begin:sources %%
- [[kickoff-meeting]] — Auth Redesign kickoff meeting (2026-04-08)
- [[standup-notes]] — Daily standup notes (2026-04-10)
%% end:sources %%

## Backlinks
%% begin:backlinks %%
### From Sources
- [[kickoff-meeting]] — "Zero trust architecture will be the guiding principle" (source_summary, 2026-04-08)

### From Wiki
- [[auth-redesign]] — "Moving from legacy OAuth 2.0 to OIDC with [[Zero Trust Architecture]] principles" (project, 2026-04-11)
- [[alice-chen]] — "Expert in [[Zero Trust Architecture]] and OIDC protocols" (entity, 2026-04-11)
- [[oidc]] — "Implements [[Zero Trust Architecture]] at every service boundary" (topic, 2026-04-11)
%% end:backlinks %%
