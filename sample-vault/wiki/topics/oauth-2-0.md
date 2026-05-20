---
id: topic-oauth-001
type: topic
title: OAuth 2.0
status: active
confidence: high
review_state: reviewed
created_at: "2026-04-09T15:00:00.000Z"
updated_at: "2026-04-11T14:00:00.000Z"
source_refs:
  - raw/2026-04-08/kickoff-meeting.md
  - raw/2026-04-10/standup-notes.md
derived_from:
  - outputs/source-summaries/kickoff-meeting.md
  - outputs/source-summaries/standup-notes.md
aliases:
  - OAuth
  - OAuth2
canonical_name: OAuth 2.0
links:
  - wiki/projects/auth-redesign.md
  - wiki/entities/alice-chen.md
  - wiki/topics/oidc.md
  - wiki/concepts/zero-trust.md
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

# OAuth 2.0

## Definition
%% begin:definition %%
OAuth 2.0 is an authorization framework that enables applications to obtain limited access to user accounts on an HTTP service. It delegates user authentication to the service hosting the user account and authorizes third-party applications to access that account. OAuth 2.0 provides authorization flows for web, desktop, and mobile applications.
%% end:definition %%

## Related Projects
%% begin:projects %%
- [[auth-redesign|Auth Redesign]] — Legacy authentication protocol being migrated from. The current OAuth-based session token storage does not meet new regulatory requirements. Will remain supported in a deprecated dual-mode during the transition to [[oidc|OIDC]].
%% end:projects %%

## Related People
%% begin:people %%
- [[alice-chen|Alice Chen]] — Raised concerns about backward compatibility with mobile clients still using OAuth tokens. Leading the migration away from OAuth to [[oidc|OIDC]].
%% end:people %%

## Connected Concepts
%% begin:concepts %%
- [[oidc|OIDC]] — Built as an extension of OAuth 2.0; the target protocol replacing legacy OAuth
- [[zero-trust|Zero Trust Architecture]] — OAuth's perimeter-based trust model is being replaced by ZTA principles requiring verification at every boundary
%% end:concepts %%

## Discussions
%% begin:discussions %%
- **2026-04-08** — At the [[auth-redesign|Auth Redesign]] kickoff, the team identified that the current OAuth-based session token storage does not meet regulatory requirements, motivating the migration to [[oidc|OIDC]]. ([[kickoff-meeting|Source]])
- **2026-04-10** — [[alice-chen|Alice Chen]] raised concerns about backward compatibility with mobile clients still using OAuth tokens. Team agreed to implement a dual-mode validation period, keeping OAuth 2.0 as a deprecated but still-supported auth method during migration. ([[standup-notes|Source]])
%% end:discussions %%

## Source References
%% begin:sources %%
- [[kickoff-meeting]] — Auth Redesign kickoff meeting (2026-04-08)
- [[standup-notes]] — Daily standup notes (2026-04-10)
%% end:sources %%

## Backlinks
%% begin:backlinks %%
### From Sources
- [[kickoff-meeting]] — "Migrating from legacy OAuth to OIDC" (source_summary, 2026-04-08)
- [[standup-notes]] — "Backward compatibility with mobile clients still using OAuth tokens" (source_summary, 2026-04-10)

### From Wiki
- [[auth-redesign]] — "Migrating from legacy [[OAuth 2.0]] to OIDC" (project, 2026-04-11)
- [[alice-chen]] — "Migration from legacy [[OAuth 2.0]]; concerned about backward compatibility" (entity, 2026-04-11)
- [[oidc]] — "Built on top of the [[OAuth 2.0]] protocol" (topic, 2026-04-11)
- [[zero-trust]] — "[[OAuth 2.0]] relied on perimeter-based trust; being replaced under ZTA principles" (concept, 2026-04-11)
%% end:backlinks %%
