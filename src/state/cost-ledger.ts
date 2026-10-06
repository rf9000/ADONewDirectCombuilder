import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { AppConfig, WorkItemResponse } from '../types/index.ts';
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
  /** The job's cumulative `spentUsd` at that moment — across every run of this work item. */
  costUsd: number;
  title?: string;
  /** First draft PR id, when one was opened. */
  prId?: number;
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

/** Build a ledger line from the job's current state; `costUsd` is the cumulative `spentUsd`. */
export function costRecordFor(
  store: StateStore,
  item: WorkItemResponse,
  outcome: CostRecord['outcome'],
  prId?: number,
): CostRecord {
  const title = item.fields['System.Title'];
  return {
    at: new Date().toISOString(),
    workItemId: item.id,
    outcome,
    costUsd: store.get(item.id)?.spentUsd ?? 0,
    ...(typeof title === 'string' && title !== '' ? { title } : {}),
    ...(prId !== undefined ? { prId } : {}),
  };
}
