/** Application configuration loaded from environment variables. */
export interface AppConfig {
  org: string;
  orgUrl: string;
  project: string;
  pat: string;
  wiqlQuery: string;
  pollIntervalMinutes: number;
  claudeModel: string;
  promptPath: string;
  stateDir: string;
  dryRun: boolean;
}

/** Response shape when fetching a single work item. */
export interface WorkItemResponse {
  id: number;
  fields: Record<string, unknown>;
  rev: number;
  url: string;
}

/** Response shape from a WIQL query. */
export interface WiqlQueryResult {
  workItems: Array<{ id: number; url: string }>;
}

/** Persisted state tracking which items have already been processed. */
export interface ProcessedState {
  processedItemIds: number[];
  lastRunAt: string;
}

/** Result summary after processing a single item. */
export interface ItemProcessResult {
  itemId: number;
  processed: boolean;
  error?: string;
}
