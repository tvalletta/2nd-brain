// Greedy cosine clustering.
//
// Trades the precision of HDBSCAN for zero dependencies. At our scale (a few
// thousand chunks per week) the difference is invisible: BERTopic-style
// clustering would only matter if we had millions of points. Single pass:
// for each chunk, attach to the most-similar existing centroid above
// `joinThreshold`, else seed a new cluster. Centroids are running averages.

import { cosineSimilarity } from '../embeddings/provider.js';

export interface Clusterable {
  id: string;
  vector: Float32Array;
}

export interface Cluster<T extends Clusterable = Clusterable> {
  id: number;
  centroid: Float32Array;
  members: T[];
}

export interface ClusterOptions {
  /** Minimum cosine similarity to attach to an existing centroid. Default 0.55. */
  joinThreshold?: number;
  /** Drop clusters smaller than this from the result. Default 3. */
  minSize?: number;
  /** Cap output cluster count (largest first). Default unlimited. */
  maxClusters?: number;
}

export function clusterByCosine<T extends Clusterable>(
  items: T[],
  options: ClusterOptions = {},
): Cluster<T>[] {
  const joinThreshold = options.joinThreshold ?? 0.55;
  const clusters: Cluster<T>[] = [];

  for (const item of items) {
    let bestIdx = -1;
    let bestSim = -Infinity;
    for (let i = 0; i < clusters.length; i++) {
      const sim = cosineSimilarity(item.vector, clusters[i].centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestSim >= joinThreshold) {
      const cluster = clusters[bestIdx];
      cluster.members.push(item);
      // Update centroid as running mean.
      const n = cluster.members.length;
      const c = cluster.centroid;
      for (let i = 0; i < c.length; i++) {
        c[i] = c[i] + (item.vector[i] - c[i]) / n;
      }
    } else {
      clusters.push({
        id: clusters.length,
        centroid: new Float32Array(item.vector),
        members: [item],
      });
    }
  }

  let filtered = clusters
    .filter((c) => c.members.length >= (options.minSize ?? 3))
    .sort((a, b) => b.members.length - a.members.length);
  if (options.maxClusters !== undefined) {
    filtered = filtered.slice(0, options.maxClusters);
  }
  // Renumber for stable cluster ids.
  return filtered.map((c, i) => ({ ...c, id: i }));
}

/** Returns members sorted by similarity to centroid (most representative first). */
export function representativeMembers<T extends Clusterable>(cluster: Cluster<T>, n = 5): T[] {
  return [...cluster.members]
    .map((m) => ({ m, s: cosineSimilarity(m.vector, cluster.centroid) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.m);
}
