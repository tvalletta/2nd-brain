import type { AgentToolDef } from '../tool-registry.js';
import { parseNote, serializeNote } from '../../vault/frontmatter.js';
import {
  updateProtectedRegion,
  getProtectedRegion,
  PINNED_MARKER,
} from '../../vault/protected-regions.js';
import { nowISO } from '../../shared/date-utils.js';

export const updateProtectedRegionTool: AgentToolDef = {
  name: 'update_protected_region',
  description:
    'Update a specific protected region in a wiki page. Respects pinned content — if the region contains "%% pinned %%", the update will be rejected.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Vault-relative path to the file',
      },
      region_id: {
        type: 'string',
        description: 'The protected region ID, e.g. "overview", "content", "definition"',
      },
      content: {
        type: 'string',
        description: 'New content for the protected region (markdown)',
      },
    },
    required: ['path', 'region_id', 'content'],
  },
  async execute(input, context) {
    const path = input.path as string;
    const regionId = input.region_id as string;
    const newContent = input.content as string;

    if (!(await context.vault.exists(path))) {
      return `File not found: ${path}`;
    }

    const fileContent = await context.vault.read(path);
    const { data, body } = parseNote(fileContent);

    // Check for pinned content
    const existing = getProtectedRegion(body, regionId);
    if (existing === null) {
      return `Region "${regionId}" not found in ${path}`;
    }
    if (existing.includes(PINNED_MARKER) || existing.includes('<!-- PINNED: true -->')) {
      return `Region "${regionId}" in ${path} is pinned and cannot be modified.`;
    }

    const updatedBody = updateProtectedRegion(body, regionId, newContent);
    data.updated_at = nowISO();

    const result = serializeNote(data, updatedBody);
    await context.vault.atomicWrite(path, result);

    return `Updated region "${regionId}" in ${path}`;
  },
};
