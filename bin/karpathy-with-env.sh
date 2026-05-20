#!/bin/bash
# Wrapper used by launchd: sources AWS Bedrock credentials from ~/.claude/settings.json
# (so the bearer token isn't duplicated to a plist on disk) and then invokes
# the karpathy CLI.
#
# Usage: karpathy-with-env.sh <args...>
#   e.g. karpathy-with-env.sh intel tick

set -euo pipefail

# Resolve project root from this script's location.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETTINGS="$HOME/.claude/settings.json"

# Extract AWS env from settings (if present). We use python because jq is not
# guaranteed to be installed; python3 ships with macOS.
#
# We accept both the canonical key (e.g. AWS_BEARER_TOKEN_BEDROCK) and the
# `_DISABLED_` prefixed variant. The user prefixes a key with `_DISABLED_` to
# hide it from Claude Code's own env without deleting the value. karpathy
# needs Bedrock to actually function, so we read either form here and export
# the canonical name into our subprocess only.
if [ -f "$SETTINGS" ]; then
  eval "$(python3 -c '
import json, sys, shlex
try:
  with open(sys.argv[1]) as f: j=json.load(f)
except Exception:
  sys.exit(0)
env = (j.get("env") or {})
for k in ("AWS_BEARER_TOKEN_BEDROCK","AWS_REGION","AWS_PROFILE","CLAUDE_CODE_USE_BEDROCK","ANTHROPIC_MODEL"):
  v = env.get(k) or env.get("_DISABLED_" + k)
  if v:
    print(f"export {k}={shlex.quote(v)}")
' "$SETTINGS")"
fi

# Find node — launchd's PATH is minimal, so we explicitly check common locations
# including nvm and homebrew.
NODE_BIN=""
for candidate in \
  "$HOME/.nvm/versions/node/v22.18.0/bin/node" \
  "$HOME/.nvm/versions/node/$(readlink "$HOME/.nvm/alias/default" 2>/dev/null)/bin/node" \
  "/opt/homebrew/bin/node" \
  "/usr/local/bin/node" \
  "$(command -v node 2>/dev/null)" \
; do
  if [ -x "$candidate" ]; then
    NODE_BIN="$candidate"
    break
  fi
done
if [ -z "$NODE_BIN" ]; then
  echo "karpathy-with-env: node binary not found" >&2
  exit 127
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$(dirname "$NODE_BIN"):${PATH:-}"

exec "$NODE_BIN" "$ROOT/dist/bin/karpathy.js" "$@"
