import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mockConfig, mockWorkItem } from '../helpers.ts';
import { processItem } from '../../src/services/processor.ts';
import type { ProcessorDeps } from '../../src/services/processor.ts';
import { StateStore } from '../../src/state/state-store.ts';

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'processor-'));
  store = new StateStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('processItem', () => {
  test('delegates to the pipeline job runner with the store', async () => {
    const runJob = mock(() =>
      Promise.resolve({ itemId: 42, processed: true, phase: 'done' as const }),
    );
    const deps: ProcessorDeps = { runJob };
    const config = mockConfig();
    const item = mockWorkItem();

    const result = await processItem(config, item, store, deps);

    expect(result).toEqual({ itemId: 42, processed: true, phase: 'done' });
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runJob.mock.calls[0] as unknown[]).toEqual([config, item, store]);
  });

  test('passes a failure result through unchanged', async () => {
    const deps: ProcessorDeps = {
      runJob: mock(() =>
        Promise.resolve({
          itemId: 42,
          processed: false,
          phase: 'failed' as const,
          error: 'nope',
        }),
      ),
    };

    const result = await processItem(mockConfig(), mockWorkItem(), store, deps);

    expect(result.processed).toBe(false);
    expect(result.error).toBe('nope');
  });
});
