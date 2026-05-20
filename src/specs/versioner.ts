import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';

const log = createLogger('spec-versioner');

const SPEC_PATH = 'specs/specification.md';
const SUPERSEDED_DIR = 'specs/superseded';

/**
 * Archive the current specification to specs/superseded/ before updating it.
 * Returns the path to the archived version, or null if there was nothing to archive.
 */
export async function archiveCurrentSpec(
  projectRoot: string,
  description?: string,
): Promise<string | null> {
  const specAbsPath = join(projectRoot, SPEC_PATH);
  const supersededAbsDir = join(projectRoot, SUPERSEDED_DIR);

  let currentContent: string;
  try {
    currentContent = await readFile(specAbsPath, 'utf-8');
  } catch {
    log.info('No existing spec to archive');
    return null;
  }

  // Determine next version number
  await mkdir(supersededAbsDir, { recursive: true });
  const existingFiles = await readdir(supersededAbsDir).catch(() => []);
  const versionNumbers = existingFiles
    .map((f) => {
      const match = f.match(/^specification-v(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((n) => n > 0);

  const nextVersion = versionNumbers.length > 0 ? Math.max(...versionNumbers) + 1 : 1;
  const date = new Date().toISOString().slice(0, 10);
  const fileName = `specification-v${nextVersion}-${date}.md`;
  const archivePath = join(supersededAbsDir, fileName);

  // Build archive header
  const header = [
    `> **Superseded version ${nextVersion}** — Archived on ${date}`,
    description ? `> **Reason:** ${description}` : '',
    '',
    '---',
    '',
  ]
    .filter(Boolean)
    .join('\n');

  await writeFile(archivePath, header + currentContent, 'utf-8');
  log.info('Spec archived', { version: nextVersion, path: archivePath });

  return archivePath;
}

/**
 * Update the specification file with new content, archiving the current version first.
 */
export async function updateSpec(
  projectRoot: string,
  newContent: string,
  description?: string,
): Promise<{ archivedPath: string | null; specPath: string }> {
  const archivedPath = await archiveCurrentSpec(projectRoot, description);

  const specAbsPath = join(projectRoot, SPEC_PATH);
  await mkdir(dirname(specAbsPath), { recursive: true });
  await writeFile(specAbsPath, newContent, 'utf-8');

  log.info('Spec updated', { specPath: specAbsPath });
  return { archivedPath, specPath: specAbsPath };
}

/**
 * List all superseded spec versions.
 */
export async function listSupersededVersions(
  projectRoot: string,
): Promise<Array<{ version: number; date: string; fileName: string }>> {
  const supersededAbsDir = join(projectRoot, SUPERSEDED_DIR);

  let files: string[];
  try {
    files = await readdir(supersededAbsDir);
  } catch {
    return [];
  }

  return files
    .map((fileName) => {
      const match = fileName.match(/^specification-v(\d+)-(\d{4}-\d{2}-\d{2})\.md$/);
      if (!match) return null;
      return {
        version: parseInt(match[1], 10),
        date: match[2],
        fileName,
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null)
    .sort((a, b) => a.version - b.version);
}
