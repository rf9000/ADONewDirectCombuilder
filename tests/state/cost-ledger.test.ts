import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mockConfig, mockWorkItem } from '../helpers.ts';
import { loadConfig } from '../../src/config/index.ts';
import { StateStore } from '../../src/state/state-store.ts';
import {
  costLedgerFor,
  costRecordFor,
  createCostLedger,
  createRunCostLedger,
  type CostRecord,
} from '../../src/state/cost-ledger.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cost-ledger-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function line(overrides: Partial<CostRecord> = {}): CostRecord {
  return { at: '2026-10-07T10:00:00.000Z', workItemId: 42, outcome: 'completed', costUsd: 1.5, ...overrides };
}

function readLines(path: string): CostRecord[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as CostRecord);
}

describe('createCostLedger', () => {
  test('creates the directory and appends one JSON object per line', () => {
    const path = join(dir, 'nested', 'deeper', 'cost-ledger.jsonl');
    const ledger = createCostLedger({ path });

    ledger.record(line({ prId: 100, title: 'Acme' }));
    ledger.record(line({ workItemId: 7, outcome: 'failed', costUsd: 0.25 }));

    expect(readLines(path)).toEqual([
      line({ prId: 100, title: 'Acme' }),
      line({ workItemId: 7, outcome: 'failed', costUsd: 0.25 }),
    ]);
  });

  test('never throws on a write failure, and warns only once', () => {
    // A regular file where the parent directory should be makes mkdir fail.
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const warn = mock((_message: string) => undefined);
    const ledger = createCostLedger({ path: join(blocker, 'cost-ledger.jsonl'), warn });

    expect(() => ledger.record(line())).not.toThrow();
    expect(() => ledger.record(line())).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('cost ledger: could not append');
  });
});

describe('createRunCostLedger', () => {
  test('a run records at most once', () => {
    const lines: CostRecord[] = [];
    const ledger = createRunCostLedger({ record: (e) => lines.push(e) });

    const record = ledger.beginRun(42);
    record(line({ outcome: 'completed' }));
    record(line({ outcome: 'failed' }));

    expect(lines.map((l) => l.outcome)).toEqual(['completed']);
  });

  test('an abandoned run is recorded once by the abandoner, and its late write is dropped', () => {
    const lines: CostRecord[] = [];
    const ledger = createRunCostLedger({ record: (e) => lines.push(e) });

    const stale = ledger.beginRun(42);
    ledger.recordAbandoned(line({ outcome: 'failed', costUsd: 2 }));
    stale(line({ outcome: 'completed', costUsd: 3 }));

    expect(lines).toEqual([line({ outcome: 'failed', costUsd: 2 })]);
  });

  test('a retry after an abandoned run records normally; other items are unaffected', () => {
    const lines: CostRecord[] = [];
    const ledger = createRunCostLedger({ record: (e) => lines.push(e) });

    const other = ledger.beginRun(7);
    ledger.beginRun(42);
    ledger.recordAbandoned(line({ outcome: 'failed' }));
    ledger.beginRun(42)(line({ outcome: 'paused' }));
    other(line({ workItemId: 7, outcome: 'completed' }));

    expect(lines.map((l) => `${l.workItemId}:${l.outcome}`)).toEqual([
      '42:failed',
      '42:paused',
      '7:completed',
    ]);
  });
});

describe('costRecordFor', () => {
  test('takes cumulative spend from the job and the title from the item', () => {
    const store = new StateStore(dir);
    store.update(42, { spentUsd: 9.75 });

    const record = costRecordFor(store, mockWorkItem(), 'completed', 100);

    expect(record).toMatchObject({
      workItemId: 42,
      outcome: 'completed',
      costUsd: 9.75,
      title: 'Add Acme Bank communication',
      prId: 100,
    });
    expect(Number.isNaN(Date.parse(record.at))).toBe(false);
  });

  test('defaults spend to 0 and omits absent optional fields', () => {
    const store = new StateStore(dir);
    const record = costRecordFor(store, mockWorkItem({ id: 5, fields: {} }), 'failed');

    expect(record.costUsd).toBe(0);
    expect('title' in record).toBe(false);
    expect('prId' in record).toBe(false);
  });
});

describe('cost ledger path', () => {
  const base = {
    AZURE_DEVOPS_PAT: 'p',
    AZURE_DEVOPS_ORG: 'o',
    AZURE_DEVOPS_PROJECT: 'pr',
    ANTHROPIC_API_KEY: 'k',
    CONTINIA_API_TOKEN: 't',
    BANKING_REPO_ID: 'b',
    SETUP_FILES_REPO_ID: 's',
  };

  test('defaults to cost-ledger.jsonl under STATE_DIR', () => {
    expect(loadConfig({ ...base, STATE_DIR: '/data/state' }).costLogPath).toBe(
      '/data/state/cost-ledger.jsonl',
    );
  });

  test('COST_LOG_PATH overrides it', () => {
    expect(loadConfig({ ...base, COST_LOG_PATH: '/var/log/cost.jsonl' }).costLogPath).toBe(
      '/var/log/cost.jsonl',
    );
  });

  test('costLedgerFor shares one instance per path, so pipeline and watcher see the same runs', () => {
    const cfg = mockConfig({ costLogPath: join(dir, 'shared.jsonl') });
    expect(costLedgerFor(cfg)).toBe(costLedgerFor({ ...cfg }));

    const stale = costLedgerFor(cfg).beginRun(42);
    costLedgerFor(cfg).recordAbandoned(line({ outcome: 'failed' }));
    stale(line({ outcome: 'completed' }));

    expect(readLines(cfg.costLogPath).map((l) => l.outcome)).toEqual(['failed']);
  });
});
