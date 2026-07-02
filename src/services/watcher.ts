import type {
  AppConfig,
  WorkItemResponse,
  ItemProcessResult,
} from '../types/index.ts';
import { StateStore } from '../state/state-store.ts';
import * as sdk from '../sdk/azure-devops-client.ts';
import * as proc from './processor.ts';

export interface WatcherDeps {
  fetchItems: (
    config: AppConfig,
  ) => Promise<WorkItemResponse[]>;

  processItem: (
    config: AppConfig,
    item: WorkItemResponse,
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

export async function runPollCycle(
  config: AppConfig,
  stateStore: StateStore,
  deps: WatcherDeps = defaultDeps,
): Promise<{ processed: number; errors: number }> {
  let totalProcessed = 0;
  let totalErrors = 0;

  log('Polling for items...');

  const items = await deps.fetchItems(config);
  const newItems = items.filter(item => !stateStore.isProcessed(item.id));

  log(`  Found ${items.length} items, ${newItems.length} unprocessed`);

  for (const item of newItems) {
    try {
      const result = await deps.processItem(config, item);

      if (result.processed) {
        stateStore.markProcessed(item.id);
        totalProcessed++;
      } else {
        totalErrors++;
      }
    } catch (err) {
      log(`  Item #${item.id}: Fatal error — ${err}`);
      totalErrors++;
    }
  }

  stateStore.save();
  return { processed: totalProcessed, errors: totalErrors };
}

function sleep(ms: number, signal: { aborted: boolean }): Promise<void> {
  return new Promise(resolve => {
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
    log('Shutting down...');
    signal.aborted = true;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log(`Starting watcher — polling every ${config.pollIntervalMinutes} minutes`);
  log(`${stateStore.processedCount} items already processed`);

  while (!signal.aborted) {
    try {
      const result = await runPollCycle(config, stateStore);
      log(`Cycle complete: ${result.processed} processed, ${result.errors} errors`);
    } catch (err) {
      log(`Cycle failed: ${err}`);
    }

    if (!signal.aborted) {
      log(`Sleeping ${config.pollIntervalMinutes} minutes...`);
      await sleep(config.pollIntervalMinutes * 60 * 1000, signal);
    }
  }

  log('Watcher stopped');
}
