import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import type { JobPhase, JobRecord, JobState } from '../types/index.ts';

/** Phases that mean "nothing more to do unless the human re-tags". */
const TERMINAL_PHASES: ReadonlySet<JobPhase> = new Set<JobPhase>(['done']);

/**
 * Phases that were interrupted mid-flight (container restart, crash) and can be
 * resumed on the next cycle without human involvement.
 */
const RESUMABLE_PHASES: ReadonlySet<JobPhase> = new Set<JobPhase>([
  'planning',
  'implementing',
  'verifying',
  'publishing',
]);

export class StateStore {
  private filePath: string;
  private jobs: Map<number, JobRecord>;
  private lastRunAt: string;

  constructor(stateDir: string) {
    this.filePath = join(stateDir, 'jobs.json');
    const loaded = this.load();
    this.jobs = new Map(loaded.jobs.map((job) => [job.itemId, job]));
    this.lastRunAt = loaded.lastRunAt;
  }

  private load(): JobState {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'jobs' in parsed &&
          Array.isArray((parsed as JobState).jobs)
        ) {
          return parsed as JobState;
        }
      }
    } catch {
      // missing or corrupted state — start fresh rather than crash the watcher
    }
    return { jobs: [], lastRunAt: '' };
  }

  save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.lastRunAt = new Date().toISOString();
    const state: JobState = {
      jobs: [...this.jobs.values()],
      lastRunAt: this.lastRunAt,
    };
    writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  get(itemId: number): JobRecord | undefined {
    return this.jobs.get(itemId);
  }

  all(): JobRecord[] {
    return [...this.jobs.values()];
  }

  /** Fetch the record for an item, creating a fresh 'new' one if absent. */
  ensure(itemId: number): JobRecord {
    const existing = this.jobs.get(itemId);
    if (existing) return existing;

    const created: JobRecord = {
      itemId,
      phase: 'new',
      clarifyRounds: 0,
      lastSeenCommentId: 0,
      worktrees: {},
      prs: [],
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(itemId, created);
    return created;
  }

  /** Merge a partial update into a job record and stamp updatedAt. */
  update(itemId: number, patch: Partial<Omit<JobRecord, 'itemId'>>): JobRecord {
    const job = this.ensure(itemId);
    const next: JobRecord = {
      ...job,
      ...patch,
      itemId,
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(itemId, next);
    return next;
  }

  setPhase(itemId: number, phase: JobPhase, error?: string): JobRecord {
    return this.update(itemId, { phase, error });
  }

  /**
   * Should this cycle act on the item?
   *
   * The item is only ever passed in when the WIQL query found it, i.e. the
   * trigger tag is present. So:
   *  - never seen / failed  → start (or retry) it
   *  - awaiting-answers     → the human re-tagged, so resume the loop
   *  - mid-flight phases    → interrupted; resume
   *  - done                 → leave alone until someone resets it
   */
  shouldProcess(itemId: number): boolean {
    const job = this.jobs.get(itemId);
    if (!job) return true;
    if (TERMINAL_PHASES.has(job.phase)) return false;
    return (
      job.phase === 'new' ||
      job.phase === 'failed' ||
      job.phase === 'awaiting-answers' ||
      RESUMABLE_PHASES.has(job.phase)
    );
  }

  remove(itemId: number): void {
    this.jobs.delete(itemId);
  }

  reset(): void {
    this.jobs = new Map();
    this.save();
  }

  get jobCount(): number {
    return this.jobs.size;
  }

  countByPhase(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const job of this.jobs.values()) {
      counts[job.phase] = (counts[job.phase] ?? 0) + 1;
    }
    return counts;
  }
}
