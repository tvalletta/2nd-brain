/** Discriminated union for enrichment function results.
 *  Allows callers to distinguish "no data found" from "extraction failed". */
export type EnrichmentResult<T> =
  | { status: 'success'; data: T }
  | { status: 'error'; error: string };
