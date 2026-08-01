const HONORIFIC_RE = /^(dr|mr|mrs|ms|miss|prof|sir|rev)\.?\s+|\s+(jr|sr|phd|md|esq)\.?$/gi;

export function stripHonorifics(name: string): string {
  return name.replace(HONORIFIC_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Equivalence classes of common English first-name nicknames/spelling variants.
 * Deliberately small and curated — false equivalences are worse than missed ones,
 * since this feeds a matching tier that can auto-resolve a single candidate.
 * Seeded with the spelling-variant risk directly visible on this vault's own
 * "Matt Newman" page (Matt/Matthew) and the "Bryan"/"Brian" confusion class
 * that made the Bryan-Pino merge non-trivial in the first place.
 */
export const NICKNAME_GROUPS: string[][] = [
  ['matthew', 'matt', 'matty'],
  ['robert', 'rob', 'bob', 'bobby'],
  ['william', 'will', 'bill', 'billy'],
  ['richard', 'rick', 'dick', 'ricky'],
  ['michael', 'mike', 'mikey'],
  ['elizabeth', 'liz', 'beth', 'eliza', 'betty'],
  ['katherine', 'kate', 'katie', 'kathy', 'kat'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['john', 'jack', 'johnny'],
  ['joseph', 'joe', 'joey'],
  ['margaret', 'maggie', 'meg', 'peggy'],
  ['christopher', 'chris'],
  ['daniel', 'dan', 'danny'],
  ['bryan', 'brian'], // spelling variant, not a true nickname — same confusion class
  ['thomas', 'tom', 'tommy'],
  ['anthony', 'tony'],
  ['edward', 'ed', 'eddie', 'ted'],
  ['steven', 'steve', 'stephen'],
];

const NICKNAME_INDEX: Map<string, number> = new Map();
NICKNAME_GROUPS.forEach((group, i) => group.forEach((n) => NICKNAME_INDEX.set(n, i)));

export function firstNamesEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const ga = NICKNAME_INDEX.get(a);
  const gb = NICKNAME_INDEX.get(b);
  return ga !== undefined && ga === gb;
}

/** True if `shortToken` is a single-letter initial matching `longToken`'s first letter. */
export function initialsMatch(shortToken: string, longToken: string): boolean {
  const s = shortToken.replace(/\.$/, '');
  return s.length === 1 && longToken.length > 1 && longToken[0] === s;
}

/**
 * True if `name` is shaped like a bare first name or a raw handle rather than a
 * "First Last" full name — i.e. exactly one whitespace-delimited token. Used to
 * decide whether a newly-created person page deserves an immediate name-variant
 * candidate check and the `identity_uncertain` frontmatter flag.
 */
export function looksLikeBareHandleOrFirstName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return trimmed.split(/\s+/).length === 1;
}
