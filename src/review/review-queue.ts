import type { VaultAdapter } from '../vault/adapter.js';
import { parseNote } from '../vault/frontmatter.js';
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
  let updated = content
    .replace(/review_state: \w+/, 'review_state: approved')
    .replace(/updated_at: ".*?"/, `updated_at: "${nowISO()}"`);

  updated = updateProtectedRegion(
    updated,
    'analysis',
    (extractAnalysis(updated) + '\n\n**Approved** at ' + nowISO()).trim(),
  );

  await vault.write(path, updated);
  log.info('Review item approved', { path });
}

export async function rejectReviewItem(vault: VaultAdapter, path: string): Promise<void> {
  const content = await vault.read(path);
  let updated = content
    .replace(/review_state: \w+/, 'review_state: rejected')
    .replace(/resolution_state: \w+/, 'resolution_state: dismissed')
    .replace(/updated_at: ".*?"/, `updated_at: "${nowISO()}"`);

  updated = updateProtectedRegion(
    updated,
    'analysis',
    (extractAnalysis(updated) + '\n\n**Rejected** at ' + nowISO()).trim(),
  );

  await vault.write(path, updated);
  log.info('Review item rejected', { path });
}

function extractAnalysis(content: string): string {
  return getProtectedRegion(content, 'analysis') ?? '';
}
