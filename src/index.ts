// Karpathy Second Memory - Public API

export type { VaultAdapter } from './vault/adapter.js';
export { createFsAdapter } from './vault/fs-adapter.js';
export { parseNote, serializeNote, validateFrontmatter } from './vault/frontmatter.js';
export type { BaseFrontmatter, ParsedNote, NoteType, NoteStatus, Confidence } from './vault/frontmatter.js';
export { slugify, buildNoteFilename, resolveAvailablePath } from './vault/paths.js';
export {
  extractProtectedRegions,
  getProtectedRegion,
  updateProtectedRegion,
  hasProtectedRegion,
} from './vault/protected-regions.js';
export { loadConfig, loadConfigOrNull } from './config/loader.js';
export type { KarpathyConfig, GlobalConfig, ProjectOverride } from './config/schema.js';
export { createMCPContext } from './mcp/context.js';
export type { MCPContext } from './mcp/context.js';
