import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StateStore } from '../../src/state/state-store.ts';
import type { JobPhase, JobState } from '../../src/types/index.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'state-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readState(): JobState {
  return JSON.parse(readFileSync(join(dir, 'jobs.json'), 'utf-8')) as JobState;
}

describe('StateStore', () => {
  test('starts empty when no file exists', () => {
    const store = new StateStore(dir);
    expect(store.jobCount).toBe(0);
    expect(store.all()).toEqual([]);
  });

  test('ensure creates a fresh job in the "new" phase', () => {
    const store = new StateStore(dir);
    const job = store.ensure(42);

    expect(job.itemId).toBe(42);
    expect(job.phase).toBe('new');
    expect(job.clarifyRounds).toBe(0);
    expect(job.prs).toEqual([]);
    expect(job.worktrees).toEqual({});
    expect(job.updatedAt).toBeString();
  });

  test('ensure is idempotent and returns the existing record', () => {
    const store = new StateStore(dir);
    store.update(42, { phase: 'planning', clarifyRounds: 2 });

    const job = store.ensure(42);
    expect(job.phase).toBe('planning');
    expect(job.clarifyRounds).toBe(2);
    expect(store.jobCount).toBe(1);
  });

  test('update merges a patch and refreshes updatedAt', () => {
    const store = new StateStore(dir);
    const first = store.update(42, { branch: 'b1' });
    const second = store.update(42, { phase: 'implementing' });

    expect(second.branch).toBe('b1');
    expect(second.phase).toBe('implementing');
    expect(second.updatedAt >= first.updatedAt).toBe(true);
  });

  test('update cannot change the item id', () => {
    const store = new StateStore(dir);
    const job = store.update(42, { phase: 'planning' } as never);
    expect(job.itemId).toBe(42);
  });

  test('persists jobs across instances', () => {
    const store = new StateStore(dir);
    store.update(42, { phase: 'awaiting-answers', clarifyRounds: 1, branch: 'x' });
    store.save();

    const reloaded = new StateStore(dir);
    const job = reloaded.get(42);
    expect(job?.phase).toBe('awaiting-answers');
    expect(job?.clarifyRounds).toBe(1);
    expect(job?.branch).toBe('x');
  });

  test('save records lastRunAt', () => {
    const store = new StateStore(dir);
    store.ensure(1);
    store.save();
    expect(readState().lastRunAt).not.toBe('');
  });

  test('starts fresh on corrupted state rather than throwing', () => {
    writeFileSync(join(dir, 'jobs.json'), '{ not json', 'utf-8');
    const store = new StateStore(dir);
    expect(store.jobCount).toBe(0);
  });

  test('starts fresh when the state file has the wrong shape', () => {
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify({ nope: true }), 'utf-8');
    expect(new StateStore(dir).jobCount).toBe(0);
  });

  test('creates the state directory when missing', () => {
    const nested = join(dir, 'a', 'b');
    const store = new StateStore(nested);
    store.ensure(1);
    store.save();
    expect(new StateStore(nested).jobCount).toBe(1);
  });

  test('reset clears everything and persists', () => {
    const store = new StateStore(dir);
    store.update(1, { phase: 'done' });
    store.save();

    store.reset();
    expect(store.jobCount).toBe(0);
    expect(new StateStore(dir).jobCount).toBe(0);
  });

  test('remove drops a single job', () => {
    const store = new StateStore(dir);
    store.ensure(1);
    store.ensure(2);
    store.remove(1);
    expect(store.get(1)).toBeUndefined();
    expect(store.get(2)).toBeDefined();
  });

  test('countByPhase groups jobs', () => {
    const store = new StateStore(dir);
    store.update(1, { phase: 'done' });
    store.update(2, { phase: 'done' });
    store.update(3, { phase: 'awaiting-answers' });

    expect(store.countByPhase()).toEqual({ done: 2, 'awaiting-answers': 1 });
  });

  describe('shouldProcess', () => {
    test('picks up an item it has never seen', () => {
      expect(new StateStore(dir).shouldProcess(42)).toBe(true);
    });

    // Items are only ever offered when the trigger tag is present, so an
    // awaiting-answers job means the human answered and re-tagged it.
    test.each<[JobPhase, boolean]>([
      ['new', true],
      ['failed', true],
      ['awaiting-answers', true],
      ['planning', true],
      ['implementing', true],
      ['verifying', true],
      ['publishing', true],
      ['done', false],
    ])('phase %s -> %p', (phase, expected) => {
      const store = new StateStore(dir);
      store.update(42, { phase });
      expect(store.shouldProcess(42)).toBe(expected);
    });

    test('a done job becomes actionable again after reset-item', () => {
      const store = new StateStore(dir);
      store.update(42, { phase: 'done' });
      expect(store.shouldProcess(42)).toBe(false);

      store.remove(42);
      expect(store.shouldProcess(42)).toBe(true);
    });
  });

  test('reads a state file written by a previous run verbatim', () => {
    mkdirSync(dir, { recursive: true });
    const state: JobState = {
      lastRunAt: '2026-07-30T00:00:00.000Z',
      jobs: [
        {
          itemId: 7,
          phase: 'awaiting-answers',
          clarifyRounds: 2,
          lastSeenCommentId: 15,
          plannerSessionId: 'sess-1',
          worktrees: { banking: '/data/worktrees/7/banking' },
          branch: 'Userstory/agent/7-acme',
          prs: [],
          updatedAt: '2026-07-30T00:00:00.000Z',
        },
      ],
    };
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify(state), 'utf-8');

    const job = new StateStore(dir).get(7);
    expect(job?.plannerSessionId).toBe('sess-1');
    expect(job?.lastSeenCommentId).toBe(15);
    expect(job?.worktrees.banking).toBe('/data/worktrees/7/banking');
  });

  test('persists failedAtPhase across a reload', () => {
    const store = new StateStore(dir);
    store.ensure(42);
    store.update(42, { phase: 'failed', failedAtPhase: 'implementing' });
    store.save();

    const reloaded = new StateStore(dir);
    expect(reloaded.get(42)?.failedAtPhase).toBe('implementing');
  });
});
