import type { HybridStore } from '../../src/search/hybrid-store.js';

/** Static facts feeding the Track B simplicity score (bake-off spec §4.6). */
export interface VariantProfile {
  runtimeDeps: string[];            // e.g. ['ollama'] or []
  storageGbBeyondFts: number;       // GB of embeddings/index beyond plain FTS
  maintenanceJobs: string[];        // background jobs required to stay correct
  silentDegradationModes: string[]; // ways retrieval silently degrades
  codeSurface: 'low' | 'medium' | 'high';
}

export interface Variant {
  name: string;
  keywordOnly: boolean;
  topK: number;
  openStore: () => HybridStore;
  profile: VariantProfile;
}

export interface RunHit {
  path: string;   // = HybridHit.docId (vault-relative path)
  rank: number;   // 0-indexed position in the returned list
  final: number;  // HybridHit.scores.final
  excerpt: string;
  semanticSim?: number; // present if the semantic pool matched this hit
  keywordRank?: number; // present if the keyword pool matched this hit
}

export interface RunResult {
  itemId: string;
  variant: string;
  query: string;
  returned: RunHit[];
  searchMode: 'hybrid' | 'keyword-only';
  degradationNote?: string;
  latencyMs: number;       // warm median over repeated calls
  responseChars: number;
  responseTokensEst: number;
  error?: string;          // set if the search threw (item scored as a miss later)
}

export interface HarnessRun {
  generatedAt: string;
  dbSnapshot: { docCount: number; newestIndexedAt: string };
  variants: string[];
  k: number;
  itemCount: number;
  results: RunResult[];
}
