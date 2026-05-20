# Karpathy health check

Two equivalent surfaces for an external control center:

## 1. CLI (one-shot)

```bash
/Users/valletta/dev/2nd-brain/bin/karpathy-with-env.sh intel health --json
```

Exit codes:
- `0` — all checks pass
- `1` — at least one **critical** check failed
- `2` — only **warn**-level issues

Both stdout (the JSON report) and the exit code are stable. Either is sufficient
for an at-a-glance status.

## 2. HTTP (long-running, polled)

```bash
# Optional: start an HTTP server alongside launchd's tick job.
/Users/valletta/dev/2nd-brain/bin/karpathy-with-env.sh intel serve --port 9123 &
curl http://127.0.0.1:9123/health
```

HTTP status codes mirror the exit codes:
- `200` — healthy
- `207` — warn (multi-status, partial)
- `503` — critical

## JSON contract

The same shape comes back from both surfaces. Top-level keys you can rely on:

```jsonc
{
  "projectName": "karpathy",
  "projectRoot": "/Users/valletta/dev/2nd-brain",
  "vaultPath": "/Users/valletta/Library/CloudStorage/OneDrive-Adobe/Apps/Test Vault",
  "generatedAt": "2026-05-12T14:57:43.984Z",
  "overall": "ok" | "warn" | "critical",
  "checks": [
    {
      "id": "build" | "config" | "claude-hooks" | "claude-mcp" | "launchd"
          | "bedrock-creds" | "job-queue" | "vault-activity"
          | "embedding-store" | "research-queue" | "scheduler",
      "level": "ok" | "warn" | "critical" | "info",
      "message": "...",
      "detail": { /* optional, varies per check */ }
    }
  ],
  "metrics": {
    "queuePending": 0,
    "queueFailed": 0,
    "queueRetrying": 0,
    "embeddingChunks": 0,
    "researchPending": 0,
    "researchApproved": 0,
    "researchCompleted": 0,
    "rawFilesLast24h": 0,
    "rawFilesLast7d": 4,
    "lastRawIngest": "2026-05-06T14:31:25.755Z" | null,
    "lastSchedulerTick": "2026-05-12T14:54:59.691Z" | null,
    "lastQueueRun": "2026-05-12T14:55:24.224Z" | null
  }
}
```

## Check IDs (control-center display hints)

| `id`              | When it fails (critical) | When it warns                                     |
|-------------------|--------------------------|---------------------------------------------------|
| `build`           | `dist/bin/karpathy.js` missing — needs `pnpm build` | — |
| `config`          | No `~/.karpathy/config.json` or vaultPath missing | — |
| `claude-hooks`    | Hooks missing or pointing at stale binary | Subset of events installed |
| `claude-mcp`      | —                        | MCP server registered but stale path or missing |
| `launchd`         | —                        | `~/Library/LaunchAgents/com.karpathy.tick.plist` missing |
| `bedrock-creds`   | No AWS creds visible AND llm.provider=bedrock | — |
| `job-queue`       | —                        | Any failed jobs OR > 100 pending |
| `vault-activity`  | —                        | No raw/ activity OR no files in last 7 days |
| `embedding-store` | —                        | Store empty (needs `intel reindex`) |
| `research-queue`  | —                        | (never warns by itself; counts go into metrics) |
| `scheduler`       | —                        | Never ran, OR last run > 26h ago (launchd stalled) |

## What the control center should do

1. **Poll** `intel health --json` at whatever cadence makes sense (every 1-5 min is fine — it's cheap).
2. **Surface** the `overall` field as the headline indicator.
3. **List** any check with `level: "critical"` or `level: "warn"` so you can click in.
4. **Show** the metrics block for at-a-glance trends (queue depth, last tick age, etc.).

## Verifying after an upgrade

```bash
cd /Users/valletta/dev/2nd-brain
pnpm build                       # → dist/
launchctl unload ~/Library/LaunchAgents/com.karpathy.tick.plist
launchctl load   ~/Library/LaunchAgents/com.karpathy.tick.plist
./bin/karpathy-with-env.sh intel health
```
