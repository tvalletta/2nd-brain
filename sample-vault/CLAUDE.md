# Karpathy Second Memory

## Active Context
%% begin:active-context %%
Working on the Auth Redesign project at Acme Corp. Current focus is migrating middleware from legacy OAuth 2.0 to OIDC token validation. Alice Chen is leading the project; Bob Martinez is handling API gateway integration via Kong. Zero Trust Architecture is the guiding security model. Team agreed on dual-mode validation for backward compatibility during migration. Redis proposed for distributed token cache invalidation.
%% end:active-context %%

## Recent Sessions
%% begin:recent-sessions %%
- [2026-04-10] Auth middleware refactoring — replaced legacy session check with OIDC middleware in 4 files (6 new tests)
%% end:recent-sessions %%

## Key Entities
%% begin:key-entities %%
### People
- **Alice Chen** — Senior engineer, auth team lead at Acme Corp
- **Bob Martinez** — Backend engineer, API gateway specialist at Acme Corp

### Projects
- **Auth Redesign** — Authentication system overhaul (compliance-driven, in progress)

### Concepts
- **Zero Trust Architecture** — Guiding security model for auth redesign

### Topics
- **OIDC** — Target authentication protocol
- **OAuth 2.0** — Legacy protocol being migrated from (deprecated dual-mode)

### Tools
- **Kong** — API gateway with native OIDC plugin support
- **Redis** — Proposed for distributed token cache invalidation

### Decisions
- **March Deadline** — Feature-complete by March 31, 2027 (Q2 audit)

### Organizations
- **Acme Corp** — Company running the Auth Redesign project
%% end:key-entities %%

## Quick Links
%% begin:quick-links %%
- [Wiki Index](wiki/_index.md)
- [Auth Redesign](wiki/projects/auth-redesign.md)
- [Alice Chen](wiki/entities/alice-chen.md)
- [Bob Martinez](wiki/entities/bob-martinez.md)
- [OIDC](wiki/topics/oidc.md)
- [Review Queue](review/)
%% end:quick-links %%
