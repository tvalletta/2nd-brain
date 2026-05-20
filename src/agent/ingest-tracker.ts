import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';

const log = createLogger('ingest-tracker');

/**
 * Tracks incremental ingest operations per project.
 * Used to determine when a full re-synthesis should be triggered
 * (after N incremental updates exceed the threshold).
 */
export interface ProjectIngestState {
  /** Number of incremental agent-ingest runs since last full synthesis */
  incrementalCount: number;
  /** ISO timestamp of last full synthesis */
  lastFullSynthesis: string | null;
  /** ISO timestamp of last incremental ingest */
  lastIncrementalIngest: string;
  /** Source paths processed since last full synthesis */
  sourcesSinceLastSynthesis: string[];
}

export interface IngestTrackerState {
  projects: Record<string, ProjectIngestState>;
}

/**
 * Create an ingest tracker that persists state to the .karpathy/state directory.
 */
export function createIngestTracker(stateDir: string) {
  const trackerPath = join(stateDir, 'ingest-tracker.json');

  async function load(): Promise<IngestTrackerState> {
    try {
      const content = await readFile(trackerPath, 'utf-8');
      return JSON.parse(content) as IngestTrackerState;
    } catch {
      return { projects: {} };
    }
  }

  async function save(state: IngestTrackerState): Promise<void> {
    await mkdir(dirname(trackerPath), { recursive: true });
    await writeFile(trackerPath, JSON.stringify(state, null, 2), 'utf-8');
  }

  return {
    /**
     * Record an incremental ingest for a project.
     * Returns true if the incremental threshold has been reached
     * (indicating a full re-synthesis should be triggered).
     */
    async recordIncremental(
      projectSlug: string,
      sourcePath: string,
      threshold: number,
    ): Promise<{ thresholdReached: boolean; count: number }> {
      const state = await load();
      const now = new Date().toISOString();

      if (!state.projects[projectSlug]) {
        state.projects[projectSlug] = {
          incrementalCount: 0,
          lastFullSynthesis: null,
          lastIncrementalIngest: now,
          sourcesSinceLastSynthesis: [],
        };
      }

      const project = state.projects[projectSlug];
      project.incrementalCount++;
      project.lastIncrementalIngest = now;

      if (!project.sourcesSinceLastSynthesis.includes(sourcePath)) {
        project.sourcesSinceLastSynthesis.push(sourcePath);
      }

      await save(state);

      const thresholdReached = project.incrementalCount >= threshold;
      if (thresholdReached) {
        log.info('Incremental threshold reached', {
          projectSlug,
          count: project.incrementalCount,
          threshold,
        });
      }

      return { thresholdReached, count: project.incrementalCount };
    },

    /**
     * Record that a full re-synthesis was performed for a project.
     * Resets the incremental counter.
     */
    async recordFullSynthesis(projectSlug: string): Promise<void> {
      const state = await load();
      const now = new Date().toISOString();

      if (state.projects[projectSlug]) {
        state.projects[projectSlug].incrementalCount = 0;
        state.projects[projectSlug].lastFullSynthesis = now;
        state.projects[projectSlug].sourcesSinceLastSynthesis = [];
      }

      await save(state);
      log.info('Full synthesis recorded', { projectSlug });
    },

    /**
     * Get the current state for a project.
     */
    async getProjectState(projectSlug: string): Promise<ProjectIngestState | null> {
      const state = await load();
      return state.projects[projectSlug] ?? null;
    },

    /**
     * Get all project states.
     */
    async getAll(): Promise<IngestTrackerState> {
      return load();
    },
  };
}

export type IngestTracker = ReturnType<typeof createIngestTracker>;
