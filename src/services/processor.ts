import type {
  AppConfig,
  ItemProcessResult,
  WorkItemResponse,
} from '../types/index.ts';
import type { StateStore } from '../state/state-store.ts';
import * as pipeline from './pipeline.ts';

export interface ProcessorDeps {
  runJob: (
    config: AppConfig,
    item: WorkItemResponse,
    store: StateStore,
  ) => Promise<ItemProcessResult>;
}

const defaultDeps: ProcessorDeps = {
  runJob: (config, item, store) => pipeline.runJob(config, item, store),
};

/**
 * Process one tagged work item through the pipeline.
 *
 * The pipeline itself is a phase machine (plan → clarify → implement → verify →
 * publish → clean up) and owns all state transitions; this stays a thin seam so
 * the watcher can be tested with a fake job runner.
 */
export async function processItem(
  config: AppConfig,
  item: WorkItemResponse,
  store: StateStore,
  deps: ProcessorDeps = defaultDeps,
): Promise<ItemProcessResult> {
  return deps.runJob(config, item, store);
}
