/**
 * Best-effort redaction of likely secret material from note excerpts before
 * they're persisted to a committed data artifact. NOT a guarantee — this is
 * defense-in-depth for an eval pipeline, not a security product. Catches:
 * common KEY=value / KEY="value" assignment patterns where the key name
 * suggests a secret, and long high-entropy-looking token strings after a
 * colon or equals sign.
 */
export function redactSecrets(text: string): string {
  // Pattern 1: ENV_VAR-style assignments where the variable name suggests a secret
  // e.g. CONFLUENCE_PERSONAL_TOKEN="abc123", API_KEY=xyz, BEDROCK_BEARER_TOKEN: "..."
  let redacted = text.replace(
    /([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|BEARER)[A-Za-z0-9_]*)\s*[:=]\s*"?([A-Za-z0-9+/=_.\-:]{8,})"?/gi,
    '$1=[REDACTED]',
  );
  // Pattern 2: standalone long base64/hex-like tokens (20+ chars, no spaces) that
  // often appear after a colon (e.g. "user-AWS1812-DEV-at-593299485344:cfftBJ1t...").
  // Kept at a high threshold deliberately — short `word:value` runs are common,
  // benign structural syntax elsewhere (e.g. this vault's Obsidian fold-comment
  // markers `%% begin:<id> %%` / `%% end:<id> %%`), so a low threshold here
  // causes real false-positive corruption of ordinary notes.
  redacted = redacted.replace(
    /(:)(?!\/\/)([A-Za-z0-9+/=_\-]{20,})/g,
    '$1[REDACTED]',
  );
  // Pattern 3: a short/partial token (6+ chars) after a colon, but ONLY when the
  // identifier immediately before the colon itself looks credential-shaped —
  // long (15+ chars) AND containing both a hyphen and a digit, e.g.
  // "user-AWS1812-DEV-at-593299485344" or "bedrock-api-user-...-at-<acct id>".
  // This exists because a leaked fragment may already be partial/truncated at
  // the source (trailing off as "..."), so even a short visible remainder is
  // real secret material — but restricting to a credential-shaped prefix (long,
  // hyphenated, with digits) keeps it from matching short plain-English
  // `word:value` markers like the fold-comment syntax above.
  redacted = redacted.replace(
    /\b([A-Za-z0-9-]{15,}):(?!\/\/)([A-Za-z0-9+/=_\-]{6,})/g,
    (match, id: string) => (/-/.test(id) && /\d/.test(id) ? `${id}:[REDACTED]` : match),
  );
  return redacted;
}
