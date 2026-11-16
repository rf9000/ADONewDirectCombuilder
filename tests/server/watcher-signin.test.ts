import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mockConfig, mockWorkItem } from '../helpers.ts';
import { runPollCycle, sleep } from '../../src/services/watcher.ts';
import type { WatcherDeps } from '../../src/services/watcher.ts';
import { StateStore } from '../../src/state/state-store.ts';
import { createRunCostLedger } from '../../src/state/cost-ledger.ts';
import type { DemoPortalSession } from '../../src/services/demoportal-auth.ts';

let dir: string;
let lines: string[];
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wsi-'));
  lines = [];
  logSpy = spyOn(console, 'log').mockImplementation((m: unknown) => {
    lines.push(String(m));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function setup(count: number, demoPortal?: DemoPortalSession) {
  const items = Array.from({ length: count }, (_, i) => mockWorkItem({ id: i + 1 }));
  const processItem = mock(async (_cfg: unknown, item: { id: number }) => ({
    itemId: item.id,
    processed: true,
    phase: 'done' as const,
  }));
  const ledger = createRunCostLedger({ record: () => {} });
  const deps = {
    fetchItems: async () => items,
    processItem,
    costLedger: () => ledger,
    getWorkItemUpdates: async () => [],
    ...(demoPortal ? { demoPortal } : {}),
  } as unknown as WatcherDeps;
  return { deps, processItem, store: new StateStore(dir), config: mockConfig({ stateDir: dir }) };
}

const session = (
  ensure: boolean,
  peek: () => Promise<void> = async () => {},
  ensureFn: () => Promise<boolean> = async () => ensure,
): DemoPortalSession => ({
  status: () => ({ needed: !ensure, reason: null, checkedAt: null, login: null }),
  peek,
  ensure: ensureFn,
  startLogin: async () => {
    throw new Error('unused');
  },
});

describe('runPollCycle sign-in', () => {
  test('holds work when sign-in is needed', async () => {
    const { deps, processItem, store, config } = setup(1, session(false));
    const result = await runPollCycle(config, store, deps);
    expect(processItem).not.toHaveBeenCalled();
    expect(lines.some((l) => l.endsWith(
      'DemoPortal sign-in needed; 1 work item(s) wait. Sign in from the dashboard or run continia auth login',
    ))).toBe(true);
    expect(result.processed).toBe(0);
  });

  test('counts only actionable items in the hold line', async () => {
    const { deps, processItem, store, config } = setup(3, session(false));
    store.update(1, { phase: 'done' });
    await runPollCycle(config, store, deps);
    expect(processItem).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('; 2 work item(s) wait.'))).toBe(true);
  });

  test('does not check sign-in when every fetched item is already done', async () => {
    const ensure = mock(async () => false);
    const peek = mock(async () => {});
    const { deps, processItem, store, config } = setup(2, session(false, peek, ensure));
    store.update(1, { phase: 'done' });
    store.update(2, { phase: 'done' });
    await runPollCycle(config, store, deps);
    expect(ensure).not.toHaveBeenCalled();
    expect(peek).toHaveBeenCalledTimes(1);
    expect(processItem).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('DemoPortal sign-in needed'))).toBe(false);
  });

  test('does not check sign-in when no items are fetched', async () => {
    const ensure = mock(async () => false);
    const { deps, store, config } = setup(0, session(false, async () => {}, ensure));
    await runPollCycle(config, store, deps);
    expect(ensure).not.toHaveBeenCalled();
  });

  test('runs work when signed in', async () => {
    const { deps, processItem, store, config } = setup(1, session(true));
    await runPollCycle(config, store, deps);
    expect(processItem).toHaveBeenCalledTimes(1);
  });

  test('runs work without demoPortal', async () => {
    const { deps, processItem, store, config } = setup(1);
    await runPollCycle(config, store, deps);
    expect(processItem).toHaveBeenCalledTimes(1);
  });

  test('peeks when no items are fetched, and survives a throwing peek', async () => {
    const peek = mock(async () => {
      throw new Error('boom');
    });
    const { deps, store, config } = setup(0, session(true, peek));
    const result = await runPollCycle(config, store, deps);
    expect(peek).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ processed: 0, errors: 0, skipped: 0 });
  });
});

describe('sleep', () => {
  test('returns early on wake', async () => {
    const wake = { requested: false };
    setTimeout(() => {
      wake.requested = true;
    }, 300);
    const t0 = Date.now();
    await sleep(60_000, { aborted: false }, wake);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(wake.requested).toBe(false);
  });
});
