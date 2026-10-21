import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import type { AppConfig, JobPhase, WorkItemResponse } from '../types/index.ts';
import type { StateStore } from './state-store.ts';

/**
 * One line of the ledger. Serialised as JSON, one record per line (JSONL).
 *
 * The shape is a contract shared with the sibling agents (DevOpsCoder et al.),
 * so the dashboard can total spend across all of them with one reader. Do not
 * add required fields or rename these without changing every writer.
 */
export interface CostRecord {
  /** ISO timestamp of when the outcome was recorded. */
  at: string;
  workItemId: number;
  outcome: 'completed' | 'failed' | 'paused';
  /**
   * The job's lifetime spend at that moment (`lifetimeSpentUsd`), across every
   * run of this work item. No reset lowers it, so the monitor can count each
   * line as what the total grew by.
   */
  costUsd: number;
  title?: string;
  /** First draft PR id, when one was opened. */
  prId?: number;
  /** Lowercased email of who added the trigger tag, or 'automatic' / 'unknown'. Absent on older lines. */
  triggeredBy?: string;
}

export interface CostLedger {
  record(entry: CostRecord): void;
}

/**
 * Append-only spend log, one JSON object per line.
 *
 * Every write is best-effort. A ledger failure must never turn a completed run
 * into a failed one — the pipeline's job is the PR, not the bookkeeping.
 */
export function createCostLedger(deps: {
  path: string;
  warn?: (message: string) => void;
}): CostLedger {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  let warned = false;

  return {
    record(entry: CostRecord): void {
      try {
        mkdirSync(dirname(deps.path), { recursive: true });
        appendFileSync(deps.path, `${JSON.stringify(entry)}\n`, 'utf-8');
      } catch (err) {
        // Warn once per ledger: a broken path would otherwise log on every item.
        if (!warned) {
          warned = true;
          warn(
            `cost ledger: could not append to ${deps.path} :: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },
  };
}

/**
 * The ledger as the pipeline and the watcher see it: a run-aware wrapper that
 * guarantees one record per run.
 *
 * The watcher races each job against a wall-clock timeout and records the
 * failure itself when the timeout wins — but the timed-out `runJob` is not
 * cancelled, and when it eventually finishes it would record its own outcome
 * for the same run. `beginRun` hands each run a recorder bound to a
 * generation number; `recordAbandoned` bumps the generation, so the stale
 * run's later write is dropped while a fresh retry (which calls `beginRun`
 * again) records normally.
 */
export interface RunCostLedger {
  /** Start a run of this work item; the returned recorder writes at most once, and only while the run is current. */
  beginRun(workItemId: number): (entry: CostRecord) => void;
  /** Record an outcome from outside the run (watcher timeout/fatal) and invalidate the in-flight run. */
  recordAbandoned(entry: CostRecord): void;
  /** Invalidate the in-flight run without writing, so a caller can await before `recordAbandoned` without a late duplicate. */
  invalidate(workItemId: number): void;
}

export function createRunCostLedger(ledger: CostLedger): RunCostLedger {
  const generations = new Map<number, number>();
  const bump = (id: number) => {
    const next = (generations.get(id) ?? 0) + 1;
    generations.set(id, next);
    return next;
  };

  return {
    beginRun(workItemId) {
      const gen = bump(workItemId);
      let written = false;
      return (entry) => {
        if (written || generations.get(workItemId) !== gen) return;
        written = true;
        ledger.record(entry);
      };
    },
    invalidate(workItemId) {
      bump(workItemId);
    },
    recordAbandoned(entry) {
      bump(entry.workItemId);
      ledger.record(entry);
    },
  };
}

const ledgersByPath = new Map<string, RunCostLedger>();

/**
 * The production ledger for a config, one per path per process, so the
 * pipeline and the watcher share the same run generations.
 */
export function costLedgerFor(config: AppConfig): RunCostLedger {
  let ledger = ledgersByPath.get(config.costLogPath);
  if (!ledger) {
    ledger = createRunCostLedger(createCostLedger({ path: config.costLogPath }));
    ledgersByPath.set(config.costLogPath, ledger);
  }
  return ledger;
}

/**
 * Build a ledger line from the job's current state. `costUsd` is the lifetime
 * spend, which no reset lowers; a job that has not charged anything since it
 * gained the field falls back to `spentUsd`.
 */
export function costRecordFor(
  store: StateStore,
  item: WorkItemResponse,
  outcome: CostRecord['outcome'],
  prId?: number,
  triggeredBy?: string,
): CostRecord {
  const title = item.fields['System.Title'];
  const job = store.get(item.id);
  return {
    at: new Date().toISOString(),
    workItemId: item.id,
    outcome,
    costUsd: job?.lifetimeSpentUsd ?? job?.spentUsd ?? 0,
    ...(typeof title === 'string' && title !== '' ? { title } : {}),
    ...(prId !== undefined ? { prId } : {}),
    ...(triggeredBy !== undefined ? { triggeredBy } : {}),
  };
}

/** Every well-formed line of the ledger, in file order; a missing or unreadable file gives none. */
export function readCostLedger(path: string): CostRecord[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const records: CostRecord[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const parsed = JSON.parse(raw) as Partial<CostRecord>;
      if (typeof parsed.workItemId === 'number' && typeof parsed.costUsd === 'number') {
        records.push(parsed as CostRecord);
      }
    } catch {
      // A torn last line from a crash mid-append; skip it.
    }
  }
  return records;
}

/**
 * The work item's lifetime spend before the next charge.
 *
 * A job that has `lifetimeSpentUsd` uses it. Otherwise (a job from before the
 * field existed, or one cleared by `reset-item`) it starts from the higher of
 * `spentUsd` and the highest total the ledger already holds for the item, so
 * the monitor, which counts how far each line's total grew, sees the new
 * spend instead of a total that dropped below what it saw before.
 */
export function lifetimeSpentUsd(store: StateStore, itemId: number, ledgerPath: string): number {
  const job = store.get(itemId);
  if (job?.lifetimeSpentUsd !== undefined) return job.lifetimeSpentUsd;
  const recorded = readCostLedger(ledgerPath)
    .filter((r) => r.workItemId === itemId)
    .reduce((max, r) => Math.max(max, r.costUsd), 0);
  return Math.max(job?.spentUsd ?? 0, recorded);
}

const BACKFILL_OUTCOMES: Partial<Record<JobPhase, CostRecord['outcome']>> = {
  done: 'completed',
  failed: 'failed',
  'awaiting-answers': 'paused',
};

/**
 * Ledger lines for jobs that finished before the ledger existed: one per job
 * that is done, failed or awaiting answers and has no line yet, stamped with
 * the job's `updatedAt`. Jobs still in flight are left to record themselves.
 * The state file holds no title, so these lines have none.
 */
export function backfillRecords(store: StateStore, ledgerPath: string): CostRecord[] {
  const recorded = new Set(readCostLedger(ledgerPath).map((r) => r.workItemId));
  return store
    .all()
    .filter((job) => !recorded.has(job.itemId) && BACKFILL_OUTCOMES[job.phase] !== undefined)
    .map((job): CostRecord => {
      const prId = job.prs[0]?.pullRequestId;
      return {
        at: job.updatedAt,
        workItemId: job.itemId,
        outcome: BACKFILL_OUTCOMES[job.phase]!,
        costUsd: job.lifetimeSpentUsd ?? job.spentUsd ?? 0,
        ...(prId !== undefined ? { prId } : {}),
      };
    })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
