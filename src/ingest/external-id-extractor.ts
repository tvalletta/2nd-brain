const SLACK_LINK_RE = /\[@([\w.-]+)\]\(https?:\/\/[\w.-]+\.slack\.com\/team\/([A-Z0-9]{6,})\)/g;

/**
 * Deterministically scans raw source text for Slack profile-link markdown
 * (`[@handle](https://workspace.slack.com/team/USERID)`) and returns a map of
 * lowercased handle -> "slack:<ID>". No LLM call — runs in the deterministic
 * lane (spec §7.1), same cost class as chunking.
 */
export function extractSlackHandleIds(rawText: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of rawText.matchAll(SLACK_LINK_RE)) {
    const handle = match[1].toLowerCase();
    const slackId = match[2];
    if (!map.has(handle)) map.set(handle, `slack:${slackId}`);
  }
  return map;
}
