import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote, serializeNote } from '../vault/frontmatter.js';
import { updateProtectedRegion, getProtectedRegion } from '../vault/protected-regions.js';
import { nowISO } from '../shared/date-utils.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('review-queue');

export interface ReviewItem {
  path: string;
  title: string;
  type: string;
  reviewState: string;
  createdAt: string;
}

export async function listReviewItems(vault: VaultAdapter): Promise<ReviewItem[]> {
  const paths = await vault.listMarkdownFiles('review');
  const items: ReviewItem[] = [];

  for (const path of paths) {
    const content = await vault.read(path);
    const { data } = parseNote(content);
    items.push({
      path,
      title: (data.title as string) ?? path,
      type: (data.conflict_type as string) ?? (data.type as string) ?? 'unknown',
      reviewState: (data.review_state as string) ?? 'unreviewed',
      createdAt: (data.created_at as string) ?? '',
    });
  }

  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function approveReviewItem(vault: VaultAdapter, path: string): Promise<void> {
  const content = await vault.read(path);
  const { data, body } = parseNote(content);
  const now = nowISO();

  data.review_state = 'approved';
  data.status = 'active'; // Sub-project C (G5)
  data.updated_at = now;

  const updatedBody = updateProtectedRegion(
    body,
    'analysis',
    (extractAnalysis(body) + '\n\n**Approved** at ' + now).trim(),
  );

  await vault.write(path, serializeNote(data, updatedBody));
  log.info('Review item approved', { path });
}

export async function rejectReviewItem(vault: VaultAdapter, path: string): Promise<void> {
  const content = await vault.read(path);
  const { data, body } = parseNote(content);
  const now = nowISO();

  data.review_state = 'rejected';
  data.resolution_state = 'dismissed';
  data.status = 'rejected'; // Sub-project C (G5) — NoteStatus's 4th enum value, first real producer
  data.updated_at = now;

  const updatedBody = updateProtectedRegion(
    body,
    'analysis',
    (extractAnalysis(body) + '\n\n**Rejected** at ' + now).trim(),
  );

  await vault.write(path, serializeNote(data, updatedBody));
  log.info('Review item rejected', { path });
}

function extractAnalysis(body: string): string {
  return getProtectedRegion(body, 'analysis') ?? '';
}
