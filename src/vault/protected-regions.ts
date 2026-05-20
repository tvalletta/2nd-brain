// --- Marker format: Obsidian %% comments ---

export const OPEN_TAG = (id: string) => `%% begin:${id} %%`;
export const CLOSE_TAG = (id: string) => `%% end:${id} %%`;
export const REGION_BLOCK = (id: string) => `${OPEN_TAG(id)}\n${CLOSE_TAG(id)}`;
export const PINNED_MARKER = '%% pinned %%';

// Legacy HTML comment markers (read-only, for backward compat)
const LEGACY_OPEN_TAG = (id: string) => `<!-- PROTECTED:${id} -->`;
const LEGACY_CLOSE_TAG = (id: string) => `<!-- /PROTECTED:${id} -->`;

export interface ProtectedRegion {
  id: string;
  content: string;
  startIndex: number;
  endIndex: number;
}

// Matches both new (%% begin:id %%) and legacy (<!-- PROTECTED:id -->) formats
const OPEN_PATTERN = /(?:%% begin:(\S+) %%|<!-- PROTECTED:(\S+) -->)/g;

export function extractProtectedRegions(content: string): ProtectedRegion[] {
  const regions: ProtectedRegion[] = [];
  const openPattern = new RegExp(OPEN_PATTERN.source, 'g');

  let match;
  while ((match = openPattern.exec(content)) !== null) {
    const id = match[1] ?? match[2]; // group 1 = new format, group 2 = legacy
    const closeTag = CLOSE_TAG(id);
    const legacyCloseTag = LEGACY_CLOSE_TAG(id);

    // Find whichever close tag comes first after the open tag
    const searchFrom = match.index + match[0].length;
    const newClose = content.indexOf(closeTag, searchFrom);
    const legacyClose = content.indexOf(legacyCloseTag, searchFrom);

    let closeIndex: number;
    let closeLen: number;
    if (newClose !== -1 && (legacyClose === -1 || newClose <= legacyClose)) {
      closeIndex = newClose;
      closeLen = closeTag.length;
    } else if (legacyClose !== -1) {
      closeIndex = legacyClose;
      closeLen = legacyCloseTag.length;
    } else {
      continue;
    }

    const regionContent = content.slice(searchFrom, closeIndex);

    regions.push({
      id,
      content: regionContent.replace(/^\n/, '').replace(/\n$/, ''),
      startIndex: match.index,
      endIndex: closeIndex + closeLen,
    });
  }

  return regions;
}

export function getProtectedRegion(content: string, regionId: string): string | null {
  const regions = extractProtectedRegions(content);
  const region = regions.find((r) => r.id === regionId);
  return region?.content ?? null;
}

export function updateProtectedRegion(
  content: string,
  regionId: string,
  newContent: string,
): string {
  const openTag = OPEN_TAG(regionId);
  const closeTag = CLOSE_TAG(regionId);
  const legacyOpenTag = LEGACY_OPEN_TAG(regionId);
  const legacyCloseTag = LEGACY_CLOSE_TAG(regionId);

  // Find the open tag — try new format first, then legacy
  let openIndex = content.indexOf(openTag);
  let actualOpenTag = openTag;
  if (openIndex === -1) {
    openIndex = content.indexOf(legacyOpenTag);
    actualOpenTag = legacyOpenTag;
  }

  if (openIndex === -1) {
    // Region doesn't exist — append it (always in new format)
    return `${content.trimEnd()}\n\n${openTag}\n${newContent}\n${closeTag}\n`;
  }

  // Find the close tag — try new format first, then legacy
  const searchFrom = openIndex + actualOpenTag.length;
  let closeIndex = content.indexOf(closeTag, searchFrom);
  let actualCloseTag = closeTag;
  if (closeIndex === -1) {
    closeIndex = content.indexOf(legacyCloseTag, searchFrom);
    actualCloseTag = legacyCloseTag;
  }

  if (closeIndex === -1) {
    // Malformed — replace from open tag to end, emit new format
    return `${content.slice(0, openIndex)}${openTag}\n${newContent}\n${closeTag}`;
  }

  // Replace content between tags, always emit new format
  const before = content.slice(0, openIndex);
  const after = content.slice(closeIndex + actualCloseTag.length);

  return `${before}${openTag}\n${newContent}\n${closeTag}${after}`;
}

export function hasProtectedRegion(content: string, regionId: string): boolean {
  return content.includes(OPEN_TAG(regionId)) || content.includes(LEGACY_OPEN_TAG(regionId));
}
