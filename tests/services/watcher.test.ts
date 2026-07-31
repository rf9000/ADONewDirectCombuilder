import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mockConfig, mockWorkItem } from '../helpers.ts';
import type { AppConfig, ItemProcessResult } from '../../src/types/index.ts';
import { runPollCycle, JobTimeoutError } from '../../src/services/watcher.ts';
import type { WatcherDeps } from '../../src/services/watcher.ts';
import { StateStore } from '../../src/state/state-store.ts';

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-'));
  store = new StateStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return mockConfig({ stateDir: dir, ...overrides });
}

function ok(itemId: number): ItemProcessResult {
  return { itemId, processed: true, phase: 'done' };
}

function makeDeps(overrides: Partial<WatcherDeps> = {}): WatcherDeps {
  return {
    fetchItems: mock(() => Promise.resolve([])),
    processItem: mock((_cfg, item) => Promise.resolve(ok(item.id))),
    ...overrides,
  };
}

describe('runPollCycle', () => {
  test('does nothing when no items are tagged', async () => {
    const deps = makeDeps();
    const result = await runPollCycle(config(), store, deps);

    expect(result).toEqual({ processed: 0, errors: 0, skipped: 0 });
    expect(deps.processItem).not.toHaveBeenCalled();
  });

  test('processes every actionable item', async () => {
    const items = [mockWorkItem({ id: 1 }), mockWorkItem({ id: 2 })];
    const deps = makeDeps({ fetchItems: mock(() => Promise.resolve(items)) });

    const result = await runPollCycle(config(), store, deps);

    expect(result.processed).toBe(2);
    expect((deps.processItem as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
  });

  test('skips items that are already done', async () => {
    store.update(1, { phase: 'done' });
    const items = [mockWorkItem({ id: 1 }), mockWorkItem({ id: 2 })];
    const deps = makeDeps({ fetchItems: mock(() => Promise.resolve(items)) });

    const result = await runPollCycle(config(), store, deps);

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    const processedIds = (deps.processItem as ReturnType<typeof mock>).mock.calls.map(
      (call) => (call[1] as { id: number }).id,
    );
    expect(processedIds).toEqual([2]);
  });

  test('re-processes an item that is waiting on answers', async () => {
    store.update(1, { phase: 'awaiting-answers', clarifyRounds: 1 });
    const deps = makeDeps({
      fetchItems: mock(() => Promise.resolve([mockWorkItem({ id: 1 })])),
    });

    const result = await runPollCycle(config(), store, deps);

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);
  });

  test('counts an unprocessed result as an error', async () => {
    const deps = makeDeps({
      fetchItems: mock(() => Promise.resolve([mockWorkItem({ id: 1 })])),
      processItem: mock(() =>
        Promise.resolve<ItemProcessResult>({
          itemId: 1,
          processed: false,
          phase: 'failed',
          error: 'boom',
        }),
      ),
    });

    const result = await runPollCycle(config(), store, deps);
    expect(result).toMatchObject({ processed: 0, errors: 1 });
  });

  test('a thrown error fails only that item and marks it failed', async () => {
    const items = [mockWorkItem({ id: 1 }), mockWorkItem({ id: 2 })];
    const deps = makeDeps({
      fetchItems: mock(() => Promise.resolve(items)),
      processItem: mock((_cfg, item) =>
        item.id === 1
          ? Promise.reject(new Error('kaboom'))
          : Promise.resolve(ok(item.id)),
      ),
    });

    const result = await runPollCycle(config(), store, deps);

    expect(result).toMatchObject({ processed: 1, errors: 1 });
    expect(store.get(1)?.phase).toBe('failed');
    expect(store.get(1)?.error).toContain('kaboom');
  });

  test('runs items one at a time', async () => {
    let active = 0;
    let maxActive = 0;

    const deps = makeDeps({
      fetchItems: mock(() =>
        Promise.resolve([1, 2, 3].map((id) => mockWorkItem({ id }))),
      ),
      processItem: mock(async (_cfg, item) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return ok(item.id);
      }),
    });

    await runPollCycle(config(), store, deps);
    expect(maxActive).toBe(1);
  });

  test('times a job out instead of hanging forever', async () => {
    const deps = makeDeps({
      fetchItems: mock(() => Promise.resolve([mockWorkItem({ id: 1 })])),
      processItem: mock(() => new Promise<ItemProcessResult>(() => undefined)),
    });

    // 1/60 of a minute = one second.
    const result = await runPollCycle(config({ jobTimeoutMinutes: 1 / 60 }), store, deps);

    expect(result.errors).toBe(1);
    expect(store.get(1)?.phase).toBe('failed');
    expect(store.get(1)?.error).toContain('exceeded');
  });

  test('stops picking up new items once shutdown is requested', async () => {
    const items = [1, 2, 3].map((id) => mockWorkItem({ id }));
    const signal = { aborted: false };

    const deps = makeDeps({
      fetchItems: mock(() => Promise.resolve(items)),
      processItem: mock((_cfg, item) => {
        // Ask for shutdown while the first item is in flight.
        signal.aborted = true;
        return Promise.resolve(ok(item.id));
      }),
    });

    const result = await runPollCycle(config(), store, deps, signal);

    expect(result.processed).toBe(1);
    expect((deps.processItem as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });

  test('persists state after the cycle', async () => {
    const deps = makeDeps({
      fetchItems: mock(() => Promise.resolve([mockWorkItem({ id: 1 })])),
      processItem: mock((_cfg, item, itemStore) => {
        itemStore.update(item.id, { phase: 'done' });
        return Promise.resolve(ok(item.id));
      }),
    });

    await runPollCycle(config(), store, deps);

    expect(new StateStore(dir).get(1)?.phase).toBe('done');
  });

  test('propagates a fetch failure to the caller', async () => {
    const deps = makeDeps({
      fetchItems: mock(() => Promise.reject(new Error('WIQL exploded'))),
    });

    await expect(runPollCycle(config(), store, deps)).rejects.toThrow('WIQL exploded');
  });
});

describe('JobTimeoutError', () => {
  test('is identifiable by name', () => {
    expect(new JobTimeoutError('x').name).toBe('JobTimeoutError');
  });
});
