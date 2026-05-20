// A1: Default stability (days for confidence to halve) per domain bucket.
// Used when a note is created or backfilled and no stability is set.

export type HalfLifeDomain =
  | 'ai-research'
  | 'tech-stack'
  | 'project'
  | 'decision'
  | 'people'
  | 'organization'
  | 'concept'
  | 'topic'
  | 'session'
  | 'default';

const HALF_LIFE_DAYS: Record<HalfLifeDomain, number> = {
  'ai-research': 90,
  'tech-stack': 180,
  project: 180,
  decision: 365,
  people: 3650,
  organization: 3650,
  concept: 180,
  topic: 60,
  session: 30,
  default: 60,
};

export function defaultStability(domain: HalfLifeDomain | string | undefined): number {
  if (!domain) return HALF_LIFE_DAYS.default;
  return HALF_LIFE_DAYS[domain as HalfLifeDomain] ?? HALF_LIFE_DAYS.default;
}

export function inferDomain(noteType: string): HalfLifeDomain {
  switch (noteType) {
    case 'concept':
      return 'concept';
    case 'topic':
      return 'topic';
    case 'project':
    case 'project_spec':
      return 'project';
    case 'decision':
      return 'decision';
    case 'entity':
      return 'people';
    case 'organization':
      return 'organization';
    case 'tool':
      return 'tech-stack';
    case 'session_summary':
    case 'source_summary':
      return 'session';
    default:
      return 'default';
  }
}

/**
 * Retrievability under FSRS-style exponential decay.
 *
 * `R = exp(-Δt / S)` where Δt is days since last_verified and S is stability.
 * Returns 1 when not yet decayed; 0..1 thereafter.
 */
export function retrievability(args: {
  lastVerifiedISO: string | undefined;
  stabilityDays: number | undefined;
  nowMs?: number;
}): number {
  const stability = args.stabilityDays ?? HALF_LIFE_DAYS.default;
  if (!args.lastVerifiedISO || stability <= 0) return 0;
  const now = args.nowMs ?? Date.now();
  const last = new Date(args.lastVerifiedISO).getTime();
  if (Number.isNaN(last)) return 0;
  const days = Math.max(0, (now - last) / (1000 * 60 * 60 * 24));
  return Math.exp(-days / stability);
}
