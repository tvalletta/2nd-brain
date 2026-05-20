import { basename } from 'node:path';
import { homedir } from 'node:os';
import { slugify } from '../vault/paths.js';

/**
 * Working directory categories for AI conversation grouping.
 *
 * - project: A meaningful project directory (has .git, under dev folder, etc.)
 * - general: Home dir, Desktop, Documents — general-purpose conversations
 * - discovery: Temp dirs, test dirs, playgrounds — exploratory conversations
 */
export type CwdCategory = 'project' | 'general' | 'discovery';

export interface CwdClassification {
  /** The category of this working directory */
  category: CwdCategory;
  /** Slugified project name, or '_general' / '_discovery' */
  slug: string;
  /** Human-readable name (for display) */
  name: string;
}

const HOME = homedir();

/** Path segments that indicate a general/home-level directory */
const GENERAL_PATHS = new Set([
  HOME,
  `${HOME}/Desktop`,
  `${HOME}/Documents`,
  `${HOME}/Downloads`,
]);

/** Path segments that indicate a discovery/temporary directory */
const DISCOVERY_SEGMENTS = new Set([
  'tmp',
  'temp',
  'test',
  'tests',
  'playground',
  'scratch',
  'sandbox',
  'experiments',
  'throwaway',
]);

/**
 * Classify a working directory into project, general, or discovery.
 */
export function classifyCwd(cwd: string): CwdClassification {
  // Normalize: strip trailing slash
  const normalized = cwd.replace(/\/+$/, '');

  // Check for general/home-level paths
  if (isGeneralPath(normalized)) {
    return { category: 'general', slug: '_general', name: 'General' };
  }

  // Check for discovery/temporary paths
  if (isDiscoveryPath(normalized)) {
    return { category: 'discovery', slug: '_discovery', name: 'Discovery' };
  }

  // Otherwise: it's a project — extract the project name from the directory
  const projectName = extractProjectName(normalized);
  return {
    category: 'project',
    slug: slugify(projectName),
    name: projectName,
  };
}

/**
 * Check if a path is a general/home-level directory.
 */
function isGeneralPath(path: string): boolean {
  // Exact match against known general paths
  if (GENERAL_PATHS.has(path)) return true;

  // Home directory itself
  if (path === HOME) return true;

  return false;
}

/**
 * Check if a path contains segments indicating it's a temporary/discovery directory.
 */
function isDiscoveryPath(path: string): boolean {
  const segments = path.split('/');
  return segments.some((seg) => DISCOVERY_SEGMENTS.has(seg.toLowerCase()));
}

/**
 * Extract a meaningful project name from a directory path.
 * Uses the basename of the directory as the project name.
 */
function extractProjectName(path: string): string {
  const name = basename(path);
  // If the basename is empty or just a drive letter, use parent
  if (!name || name === '/' || name.length <= 1) {
    return 'unknown-project';
  }
  return name;
}
