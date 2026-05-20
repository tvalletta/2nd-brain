---
id: org-acme-001
type: organization
title: Acme Corp
status: active
confidence: high
review_state: reviewed
created_at: "2026-04-09T10:00:00.000Z"
updated_at: "2026-04-11T14:00:00.000Z"
source_refs:
  - raw/2026-04-08/kickoff-meeting.md
derived_from:
  - outputs/source-summaries/kickoff-meeting.md
aliases:
  - Acme
  - Acme Corporation
canonical_name: Acme Corp
links:
  - wiki/entities/alice-chen.md
  - wiki/entities/bob-martinez.md
  - wiki/projects/auth-redesign.md
change_origin: extraction
protected_regions:
  - summary
  - people
  - projects
  - sources
  - backlinks
---

# Acme Corp

## Summary
%% begin:summary %%
Technology company where [[alice-chen|Alice Chen]] and [[bob-martinez|Bob Martinez]] work. Currently undergoing an authentication system overhaul driven by legal/compliance requirements. The organization's session token storage does not meet new regulatory standards, prompting the [[auth-redesign|Auth Redesign]] project.
%% end:summary %%

## People
%% begin:people %%
- [[alice-chen|Alice Chen]] — Senior engineer and tech lead; 8 years of experience with identity systems
- [[bob-martinez|Bob Martinez]] — Backend engineer; API design and gateway configuration specialist
%% end:people %%

## Projects
%% begin:projects %%
- [[auth-redesign|Auth Redesign]] — Authentication system overhaul migrating from legacy [[oauth-2-0|OAuth 2.0]] to [[oidc|OIDC]] with [[zero-trust|Zero Trust Architecture]] principles
%% end:projects %%

## Source References
%% begin:sources %%
- [[kickoff-meeting]] — Auth Redesign kickoff meeting at Acme Corp (2026-04-08)
- [[standup-notes]] — Daily standup notes (2026-04-10)
%% end:sources %%

## Backlinks
%% begin:backlinks %%
### From Wiki
- [[alice-chen]] — "Senior engineer and tech lead at [[Acme Corp]]" (entity, 2026-04-11)
- [[bob-martinez]] — "Backend engineer at [[Acme Corp]]" (entity, 2026-04-11)
- [[auth-redesign]] — "Complete overhaul of [[Acme Corp]]'s authentication system" (project, 2026-04-11)
- [[march-deadline]] — "Session token storage at [[Acme Corp]] does not meet regulatory requirements" (decision, 2026-04-11)
%% end:backlinks %%
