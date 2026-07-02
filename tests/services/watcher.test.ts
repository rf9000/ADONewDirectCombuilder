import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AppConfig, WorkItemResponse } from '../../src/types/index.ts';
import { runPollCycle } from '../../src/services/watcher.ts';
import type { WatcherDeps } from '../../src/services/watcher.ts';
import { StateStore } from '../../src/state/state-store.ts';

function mockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    org: 'my-org',
    orgUrl: 'https://dev.azure.com/my-org',
    project: 'my-project',
    pat: 'test-pat-token',
    wiqlQuery: "SELECT [System.Id] FROM workitems WHERE [System.State] = 'New'",
    pollIntervalMinutes: 5,
    claudeModel: 'claude-sonnet-4-6',
    promptPath: './prompt.md',
    stateDir: '.state',
    dryRun: false,
    ...overrides,
  };
}

function mockWorkItem(overrides: Partial<WorkItemResponse> = {}): WorkItemResponse {
  return {
    id: 42,
    fields: {
      'System.Title': 'Test work item',
      'System.WorkItemType': 'Bug',
      'System.Description': 'A test work item.',
      'System.State': 'New',
    },
    rev: 1,
    url: 'https://example.com/42',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<WatcherDeps> = {}): WatcherDeps {
  return {
    fetchItems: mock(() => Promise.resolve([])),
    processItem: mock(() =>
      Promise.resolve({ itemId: 0, processed: true }),
    ),
    ...overrides,
  };
}

describe('runPollCycle', () => {
  let tmpDir: string;
  let stateStore: StateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'watcher-test-'));
    stateStore = new StateStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('no items returns all zeros', async () => {
    const config = mockConfig();
    const deps = makeDeps();

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 0, errors: 0 });
    expect(deps.fetchItems).toHaveBeenCalledTimes(1);
    expect(deps.processItem).toHaveBeenCalledTimes(0);
  });

  test('new item calls processItem, marks as processed, and saves state', async () => {
    const config = mockConfig();
    const item = mockWorkItem({ id: 101 });

    const deps = makeDeps({
      fetchItems: mock(() => Promise.resolve([item])),
      processItem: mock(() =>
        Promise.resolve({ itemId: 101, processed: true }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 1, errors: 0 });
    expect(deps.processItem).toHaveBeenCalledTimes(1);
    expect(stateStore.isProcessed(101)).toBe(true);

    const reloadedStore = new StateStore(tmpDir);
    expect(reloadedStore.isProcessed(101)).toBe(true);
  });

  test('already processed item is filtered out', async () => {
    const config = mockConfig();
    const item = mockWorkItem({ id: 200 });

    stateStore.markProcessed(200);
    stateStore.save();

    const deps = makeDeps({
      fetchItems: mock(() => Promise.resolve([item])),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 0, errors: 0 });
    expect(deps.processItem).toHaveBeenCalledTimes(0);
  });

  test('processItem throws: item not marked as processed, error counted', async () => {
    const config = mockConfig();
    const item = mockWorkItem({ id: 300 });

    const deps = makeDeps({
      fetchItems: mock(() => Promise.resolve([item])),
      processItem: mock(() => Promise.reject(new Error('Fatal processing error'))),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 0, errors: 1 });
    expect(stateStore.isProcessed(300)).toBe(false);
  });

  test('processItem returns error result: item not marked as processed', async () => {
    const config = mockConfig();
    const item = mockWorkItem({ id: 400 });

    const deps = makeDeps({
      fetchItems: mock(() => Promise.resolve([item])),
      processItem: mock(() =>
        Promise.resolve({ itemId: 400, processed: false, error: 'AI failed' }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 0, errors: 1 });
    expect(stateStore.isProcessed(400)).toBe(false);
  });

  test('multiple items processes each one', async () => {
    const config = mockConfig();
    const item1 = mockWorkItem({ id: 501 });
    const item2 = mockWorkItem({ id: 502 });
    const item3 = mockWorkItem({ id: 503 });

    const deps = makeDeps({
      fetchItems: mock(() => Promise.resolve([item1, item2, item3])),
      processItem: mock((cfg: AppConfig, item: WorkItemResponse) =>
        Promise.resolve({ itemId: item.id, processed: true }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 3, errors: 0 });
    expect(deps.fetchItems).toHaveBeenCalledTimes(1);
    expect(deps.processItem).toHaveBeenCalledTimes(3);
    expect(stateStore.isProcessed(501)).toBe(true);
    expect(stateStore.isProcessed(502)).toBe(true);
    expect(stateStore.isProcessed(503)).toBe(true);
  });
});
