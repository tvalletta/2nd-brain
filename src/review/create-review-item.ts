import { nanoid } from 'nanoid';
import type { VaultAdapter } from '../vault/adapter.js';
import { nowISO } from '../shared/date-utils.js';

export interface ReviewItemInput {
  /** Filename (without `.md`) under `review/` — caller is responsible for slugifying. */
  slug: string;
  title: string;
  claimA: string;
  claimB: string;
  sourceRefs: string[];
  links: string[];
  conflictType: string;
  /** Full markdown body, including any protected-region tags the caller wants preserved. */
  body: string;
}

/**
 * Write (or overwrite) a `type: contradiction` review note into `review/`,
 * surfaced by the `get_review_queue` MCP tool. Shared by the ambiguous-entity
 * path (link-concepts.ts) and the significance-gate uncertain-drop path
 * (compiler.ts) — both need "flag this for a human without deleting or
 * guessing," and this is the vault's one existing mechanism for that.
 */
export async function createReviewItem(vault: VaultAdapter, input: ReviewItemInput): Promise<string> {
  await vault.ensureFolder('review');
  const reviewPath = `review/${input.slug}.md`;

  const frontmatter = {
    id: nanoid(),
    type: 'contradiction',
    title: input.title,
    status: 'draft',
    confidence: 'low',
    review_state: 'unreviewed',
    created_at: nowISO(),
    updated_at: nowISO(),
    conflict_type: input.conflictType,
    claim_a: input.claimA,
    claim_b: input.claimB,
    resolution_state: 'open',
    source_refs: input.sourceRefs,
    derived_from: [],
    aliases: [],
    links: input.links,
    change_origin: 'heuristic_review',
    protected_regions: ['analysis'],
  };

  const content = `---\n${Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')}\n---\n${input.body}`;

  if (await vault.exists(reviewPath)) {
    await vault.write(reviewPath, content);
  } else {
    await vault.create(reviewPath, content);
  }
  return reviewPath;
}
