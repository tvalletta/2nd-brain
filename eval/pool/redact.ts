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
  // often appear after a colon (e.g. "user-AWS1812-DEV-at-593299485344:cfftBJ1t...")
  redacted = redacted.replace(
    /(:)([A-Za-z0-9+/=_\-]{20,})(?=\s|$|["'\)\]])/g,
    '$1[REDACTED]',
  );
  return redacted;
}
