---
id: tool-kong-001
type: tool
title: Kong
status: active
confidence: high
review_state: reviewed
created_at: "2026-04-10T10:00:00.000Z"
updated_at: "2026-04-11T14:00:00.000Z"
source_refs:
  - raw/2026-04-10/standup-notes.md
derived_from:
  - outputs/source-summaries/standup-notes.md
aliases:
  - Kong Gateway
canonical_name: Kong
links:
  - wiki/projects/auth-redesign.md
  - wiki/entities/bob-martinez.md
  - wiki/topics/oidc.md
change_origin: extraction
protected_regions:
  - summary
  - projects
  - concepts
  - sources
  - backlinks
---

# Kong

## Summary
%% begin:summary %%
Cloud-native API gateway used by the team at [[acme-corp|Acme Corp]] for managing API traffic. [[bob-martinez|Bob Martinez]] completed a spike confirming that Kong supports [[oidc|OIDC]] natively via plugin, making it the gateway solution for the [[auth-redesign|Auth Redesign]] project. Token refresh will be handled at the gateway level.
%% end:summary %%

## Used In Projects
%% begin:projects %%
- [[auth-redesign|Auth Redesign]] — API gateway for OIDC integration. [[bob-martinez|Bob Martinez]] is implementing the Kong OIDC plugin configuration. Will work alongside [[redis|Redis]] for distributed token cache invalidation across gateway instances.
%% end:projects %%

## Related Concepts
%% begin:concepts %%
- [[oidc|OIDC]] — Kong supports OIDC natively via plugin, enabling token validation at the gateway layer
%% end:concepts %%

## Source References
%% begin:sources %%
- [[standup-notes]] — Daily standup notes where Kong OIDC support was confirmed (2026-04-10)
%% end:sources %%

## Backlinks
%% begin:backlinks %%
### From Sources
- [[standup-notes]] — "Kong supports OIDC natively via plugin" (source_summary, 2026-04-10)

### From Wiki
- [[auth-redesign]] — "[[Kong]] OIDC plugin configuration" (project, 2026-04-11)
- [[bob-martinez]] — "Completed spike confirming [[Kong]] supports OIDC natively" (entity, 2026-04-11)
- [[oidc]] — "API gateway layer via [[Kong]] plugin" (topic, 2026-04-11)
%% end:backlinks %%
