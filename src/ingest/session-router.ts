import type { ParsedSession } from '../session/jsonl-parser.js';
import { classifyCwd, type CwdClassification } from './cwd-classifier.js';
import { todayStamp } from '../shared/date-utils.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../vault/paths.js';

/**
 * Compute the vault-relative raw path where a session export should be stored.
 *
 * Structure: `<layout.aiConversations>/{source}/{slug}/{date}-{shortId}.md`
 */
export function computeSessionRawPath(
  session: ParsedSession,
  source: 'claude' | 'cursor',
  layout: VaultLayout = DEFAULT_LAYOUT,
): { rawPath: string; cwdClassification: CwdClassification } {
  const cwdClassification = classifyCwd(session.cwd || '');
  const date = session.startedAt ? session.startedAt.slice(0, 10) : todayStamp();
  const shortId = session.sessionId.slice(0, 8);
  const slug = cwdClassification.slug;
  const rawPath = `${layout.aiConversations}/${source}/${slug}/${date}-${shortId}.md`;
  return { rawPath, cwdClassification };
}
