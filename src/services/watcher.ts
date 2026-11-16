import type {
  AppConfig,
  WorkItemResponse,
  ItemProcessResult,
} from '../types/index.ts';
import { StateStore } from '../state/state-store.ts';
import { costLedgerFor, costRecordFor } from '../state/cost-ledger.ts';
import type { RunCostLedger } from '../state/cost-ledger.ts';
import * as sdk from '../sdk/azure-devops-client.ts';
import * as proc from './processor.ts';
import { lookupTriggeredBy } from '../utils/triggered-by.ts';
import { DemoPortalAuth, type DemoPortalSession } from './demoportal-auth.ts';
import { runProcess, type RunProcess } from './process-runner.ts';
import { buildChildEnv } from './agent-runner.ts';
import { createControlHandler, withControlServer } from '../server/control.ts';

/** Set to true to cut the watcher's sleep short (a sign-in finished). */
export interface WakeFlag {
  requested: boolean;
}

export interface WatcherDeps {
  fetchItems: (config: AppConfig) => Promise<WorkItemResponse[]>;

  processItem: (
    config: AppConfig,
    item: WorkItemResponse,
    store: StateStore,
  ) => Promise<ItemProcessResult>;

  /**
   * Spend ledger — must be the same instance the pipeline writes to, so a
   * timed-out run's late record is suppressed (see RunCostLedger).
   */
  costLedger: (config: AppConfig) => RunCostLedger;

  /** Revision history, to find who tagged an abandoned item. */
  getWorkItemUpdates: typeof sdk.getWorkItemUpdates;

  /** DemoPortal's Azure AD session; absent with an API token. Work is held while it needs a sign-in. */
  demoPortal?: DemoPortalSession;
  /** Wakes the sleeping watcher, e.g. when a sign-in finishes. */
  wake?: WakeFlag;
}

async function defaultFetchItems(config: AppConfig): Promise<WorkItemResponse[]> {
  const ids = await sdk.queryWorkItems(config, config.wiqlQuery);
  if (ids.length === 0) return [];
  return sdk.getWorkItemsBatch(config, ids);
}

const defaultDeps: WatcherDeps = {
  fetchItems: defaultFetchItems,
  processItem: proc.processItem,
  costLedger: costLedgerFor,
  getWorkItemUpdates: sdk.getWorkItemUpdates,
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

  // Pick up CLI edits to the state file made since the last cycle.
  stateStore.reload();
  log(`Polling for items tagged '${config.triggerTag}'...`);

  const items = await deps.fetchItems(config);

  const actionable = items.filter((item) => stateStore.shouldProcess(item.id));
  skipped = items.length - actionable.length;

  log(`  Found ${items.length} tagged item(s), ${actionable.length} actionable`);

  if (actionable.length === 0) {
    // Nothing to start: only keep the dashboard's sign-in card right. Never fails the cycle.
    await deps.demoPortal?.peek().catch((err) => log(`DemoPortal sign-in check failed :: ${err instanceof Error ? err.message : String(err)}`));
  } else if (deps.demoPortal && !(await signedIn(deps.demoPortal))) {
    log(`DemoPortal sign-in needed; ${actionable.length} work item(s) wait. Sign in from the dashboard or run continia auth login`);
    return { processed, errors, skipped };
  }

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
      // runJob catches its own failures and records them, so reaching here
      // means a timeout or a throw outside runJob's try — neither has written
      // a ledger line. recordAbandoned also invalidates the still-running job
      // so its eventual outcome is not recorded a second time.
      if (!config.dryRun) {
        // Invalidate first: the lookup awaits, and the still-running job must not
        // record its own line in the meantime.
        deps.costLedger(config).invalidate(item.id);
        const triggeredBy = await lookupTriggeredBy(
          () => deps.getWorkItemUpdates(config, item.id),
          [config.triggerTag],
          log,
        );
        deps.costLedger(config).recordAbandoned(
          costRecordFor(stateStore, item, 'failed', undefined, triggeredBy),
        );
      }
      errors++;
    }

    stateStore.save();
  }

  stateStore.save();
  return { processed, errors, skipped };
}

/**
 * `ensure()` throwing (the CLI could not even start) must not hold work back:
 * the job reports its own sign-in error, as when the check fails inside ensure.
 */
async function signedIn(demoPortal: DemoPortalSession): Promise<boolean> {
  try {
    return await demoPortal.ensure();
  } catch (err) {
    log(`DemoPortal sign-in check failed - ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

/**
 * The DemoPortal sign-in service and the flag it uses to wake the watcher, or
 * undefined when there is nothing to sign in to: an API token, or
 * SKIP_BUILD_TEST (no job uses the Continia CLI, so the sign-in must not hold work).
 */
export function createDemoPortal(
  config: AppConfig,
  run: RunProcess = (cmd, cwd, _env, t, onLine) => runProcess(cmd, cwd, buildChildEnv({}, config.continiaAuthMethod), t, onLine),
): { demoPortal: DemoPortalAuth; wake: WakeFlag } | undefined {
  if (config.continiaAuthMethod !== 'azure-ad' || config.skipBuildTest) return undefined;
  const wake: WakeFlag = { requested: false };
  const demoPortal = new DemoPortalAuth(config.continiaCliPath, process.cwd(), run, log);
  demoPortal.onSignedIn = () => {
    wake.requested = true;
  };
  return { demoPortal, wake };
}

export function sleep(ms: number, signal: { aborted: boolean }, wake?: WakeFlag): Promise<void> {
  return new Promise((resolve) => {
    const checkInterval = 1000;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += checkInterval;
      const woken = wake?.requested === true;
      if (woken && wake) wake.requested = false;
      if (signal.aborted || woken || elapsed >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, checkInterval);
  });
}

export async function startWatcher(config: AppConfig): Promise<void> {
  const stateStore = new StateStore(config.stateDir);
  const signal = { aborted: false };

  // DemoPortal's Azure AD session: only in azure-ad mode with the build gate on (see createDemoPortal).
  const deps: WatcherDeps = { ...defaultDeps, ...createDemoPortal(config) };
  void deps.demoPortal?.peek().catch((err) => log(`DemoPortal sign-in check failed :: ${err instanceof Error ? err.message : String(err)}`));

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

  // The control server stops once the loop ends, so SIGTERM lets the process exit.
  await withControlServer(
    config.controlPort,
    createControlHandler({ ...(deps.demoPortal ? { demoPortal: deps.demoPortal } : {}) }),
    async () => {
      while (!signal.aborted) {
        try {
          const result = await runPollCycle(config, stateStore, deps, signal);
          log(
            `Cycle complete: ${result.processed} processed, ${result.errors} errors, ${result.skipped} skipped`,
          );
        } catch (err) {
          log(`Cycle failed: ${err}`);
        }

        if (!signal.aborted) {
          log(`Sleeping ${config.pollIntervalMinutes} minute(s)...`);
          await sleep(config.pollIntervalMinutes * 60 * 1000, signal, deps.wake);
        }
      }
    },
    (port) => log(`control API on port ${port}`),
  );

  log('Watcher stopped');
}
