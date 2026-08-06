import type {
  AppConfig,
  WorkItemResponse,
  ItemProcessResult,
} from '../types/index.ts';
import { StateStore } from '../state/state-store.ts';
import * as sdk from '../sdk/azure-devops-client.ts';
import * as proc from './processor.ts';

export interface WatcherDeps {
  fetchItems: (config: AppConfig) => Promise<WorkItemResponse[]>;

  processItem: (
    config: AppConfig,
    item: WorkItemResponse,
    store: StateStore,
  ) => Promise<ItemProcessResult>;
}

async function defaultFetchItems(config: AppConfig): Promise<WorkItemResponse[]> {
  const ids = await sdk.queryWorkItems(config, config.wiqlQuery);
  if (ids.length === 0) return [];
  return sdk.getWorkItemsBatch(config, ids);
}

const defaultDeps: WatcherDeps = {
  fetchItems: defaultFetchItems,
  processItem: proc.processItem,
};

function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

export class JobTimeoutError extends Error {
  override readonly name = 'JobTimeoutError';
}

/** Race a job against the configured wall-clock budget. */
async function withTimeout<T>(
  promise: Promise<T>,
  minutes: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new JobTimeoutError(`${label} exceeded ${minutes} minutes`)),
      minutes * 60 * 1000,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface PollCycleResult {
  processed: number;
  errors: number;
  skipped: number;
}

/**
 * One poll cycle. Jobs run strictly one at a time: they share a BC environment
 * (which cannot run concurrent test jobs), the git object cache, and the AL
 * compiler cache.
 */
export async function runPollCycle(
  config: AppConfig,
  stateStore: StateStore,
  deps: WatcherDeps = defaultDeps,
  signal: { aborted: boolean } = { aborted: false },
): Promise<PollCycleResult> {
  let processed = 0;
  let errors = 0;
  let skipped = 0;

  log(`Polling for items tagged '${config.triggerTag}'...`);

  const items = await deps.fetchItems(config);
  const actionable = items.filter((item) => stateStore.shouldProcess(item.id));
  skipped = items.length - actionable.length;

  log(`  Found ${items.length} tagged item(s), ${actionable.length} actionable`);

  for (const item of actionable) {
    if (signal.aborted) {
      log('  Shutdown requested — stopping before the next item');
      break;
    }

    try {
      const result = await withTimeout(
        deps.processItem(config, item, stateStore),
        config.jobTimeoutMinutes,
        `Job for item #${item.id}`,
      );
      if (result.processed) processed++;
      else errors++;
    } catch (err) {
      log(`  Item #${item.id}: fatal error — ${err}`);

      // `stateStore.get(item.id)?.phase` is read before this same `update`
      // call overwrites it with 'failed' — the argument is evaluated first, so
      // this captures the phase that actually threw. Splitting it into two
      // statements would silently record 'failed' as the phase that failed.
      // Without `failedAtPhase`, entry-phase.ts falls back to 'planning' with
      // `cleanWorkspace: true`, wiping a worktree that may hold a partial
      // implement — the exact loss this record exists to prevent.
      stateStore.update(item.id, {
        phase: 'failed',
        failedAtPhase: stateStore.get(item.id)?.phase,
        error: err instanceof Error ? err.message : String(err),
      });
      errors++;
    }

    stateStore.save();
  }

  stateStore.save();
  return { processed, errors, skipped };
}

function sleep(ms: number, signal: { aborted: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const checkInterval = 1000;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += checkInterval;
      if (signal.aborted || elapsed >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, checkInterval);
  });
}

export async function startWatcher(config: AppConfig): Promise<void> {
  const stateStore = new StateStore(config.stateDir);
  const signal = { aborted: false };

  const shutdown = () => {
    // The in-flight job keeps running to a phase boundary so its JobRecord stays
    // resumable; we just stop picking up new ones.
    log('Shutting down after the current item...');
    signal.aborted = true;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log(`Starting watcher — polling every ${config.pollIntervalMinutes} minute(s)`);
  log(`Trigger tag: '${config.triggerTag}' | waiting tag: '${config.waitingTag}'`);
  log(`Tracking ${stateStore.jobCount} job(s): ${JSON.stringify(stateStore.countByPhase())}`);

  while (!signal.aborted) {
    try {
      const result = await runPollCycle(config, stateStore, defaultDeps, signal);
      log(
        `Cycle complete: ${result.processed} processed, ${result.errors} errors, ${result.skipped} skipped`,
      );
    } catch (err) {
      log(`Cycle failed: ${err}`);
    }

    if (!signal.aborted) {
      log(`Sleeping ${config.pollIntervalMinutes} minute(s)...`);
      await sleep(config.pollIntervalMinutes * 60 * 1000, signal);
    }
  }

  log('Watcher stopped');
}
