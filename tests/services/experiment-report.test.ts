import { describe, test, expect } from 'bun:test';
import {
  cheapestGoodEnough,
  classifyStatus,
  countTasks,
  renderReport,
  type ExperimentResults,
  type VariantUsage,
} from '../../src/services/experiment-report.ts';
import type { JudgeResult } from '../../src/services/experiment-judge.ts';

const scores = (n: number) => ({
  coverage: n,
  correctness: n,
  patternFit: n,
  taskActionability: n,
  questionQuality: n,
});

function usage(variant: string, costUsd: number, extra: Partial<VariantUsage> = {}): VariantUsage {
  return {
    variant,
    model: 'claude-opus-5-5',
    status: 'ok',
    costUsd,
    modelUsage: {
      'claude-opus-5-5': { inputTokens: 1_000_000, outputTokens: 20_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd },
    },
    numTurns: 30,
    durationMs: 600_000,
    blocking: 0,
    ambiguities: 2,
    taskCount: 12,
    designDoc: true,
    ...extra,
  };
}

function judge(variant: string, verdict: JudgeResult['verdict'], n: number): JudgeResult {
  return { variant, costUsd: 0.5, scores: scores(n), verdict, gaps: [], summary: 's' };
}

function results(extra: Partial<ExperimentResults> = {}): ExperimentResults {
  return {
    workItemId: 83634,
    title: 'Implement ponto',
    runId: '20260930-101500',
    auth: 'subscription',
    judgeModel: 'claude-sonnet-5-5',
    baseline: 'opus-high',
    shas: { banking: 'aaa', setupFiles: 'bbb' },
    docs: [],
    variants: [usage('opus-high', 40), usage('sonnet-high', 10), usage('haiku', 2)],
    judges: [judge('sonnet-high', 'equivalent', 4), judge('haiku', 'equivalent', 3)],
    notes: [],
    totalUsd: 53,
    ...extra,
  };
}

describe('classifyStatus', () => {
  const ok = { text: '', success: true, costUsd: 1, numTurns: 1 };
  test('ok on success', () => expect(classifyStatus(ok, undefined)).toBe('ok'));
  test('failed without a result', () => expect(classifyStatus(undefined, 'git broke')).toBe('failed'));
  test('rate-limited on a rejection', () =>
    expect(classifyStatus({ ...ok, success: false, rateLimit: { status: 'rejected' } }, 'x')).toBe('rate-limited'));
  test('rate-limited on the assistant error', () =>
    expect(classifyStatus({ ...ok, success: false, assistantError: 'rate_limit' }, 'x')).toBe('rate-limited'));
  // A rejection event can arrive while the last subagent is finishing; the
  // run still completed, so its plan must be judged, not discarded.
  test('ok when the run succeeded despite a rate-limit event', () =>
    expect(classifyStatus({ ...ok, rateLimit: { status: 'rejected' } }, undefined)).toBe('ok'));
  test('budget-stopped on the budget subtype', () =>
    expect(classifyStatus({ ...ok, success: false, subtype: 'error_max_budget_usd' }, 'x')).toBe('budget-stopped'));
  test('context-overflow on a too-long prompt', () =>
    expect(classifyStatus({ ...ok, success: false, text: 'Prompt is too long' }, 'x')).toBe('context-overflow'));
  test('failed when the phase threw after a successful agent run', () =>
    expect(classifyStatus(ok, 'artifact missing')).toBe('failed'));
});

describe('countTasks', () => {
  test('counts an array', () => expect(countTasks([1, 2])).toBe(2));
  test('counts a tasks property', () => expect(countTasks({ tasks: [1, 2, 3] })).toBe(3));
  test('counts tasks across waves', () =>
    expect(countTasks({ waves: [{ tasks: [1] }, { tasks: [2, 3] }] })).toBe(3));
  test('undefined for anything else', () => expect(countTasks(undefined)).toBeUndefined());
});

describe('cheapestGoodEnough', () => {
  test('skips a variant with any score below 4', () => {
    expect(cheapestGoodEnough(results())).toBe('sonnet-high');
  });

  test('falls back to the baseline when nothing cheaper qualifies', () => {
    expect(cheapestGoodEnough(results({ judges: [judge('sonnet-high', 'major-gaps', 5)] }))).toBe('opus-high');
  });

  test('undefined when the baseline did not succeed and nothing qualifies', () => {
    expect(
      cheapestGoodEnough(
        results({ variants: [usage('opus-high', 40, { status: 'failed' })], judges: [] }),
      ),
    ).toBeUndefined();
  });
});

describe('renderReport', () => {
  test('sorts the summary by cost and shows % of baseline', () => {
    const md = renderReport(results());
    const rows = md.split('\n').filter((l) => l.startsWith('| haiku') || l.startsWith('| sonnet-high') || l.startsWith('| opus-high'));
    expect(rows.map((r) => r.split('|')[1]!.trim())).toEqual(['haiku', 'sonnet-high', 'opus-high']);
    expect(rows[1]).toContain('25%');
    expect(md).toContain('API-equivalent USD');
    expect(md).toContain('**Cheapest good-enough:** `sonnet-high`');
  });

  test('flags a partial report and a questions-only variant', () => {
    const md = renderReport(
      results({
        stoppedReason: "rate limit five_hour rejected during 'haiku'",
        variants: [usage('opus-high', 40), usage('haiku', 2, { designDoc: false, blocking: 3 })],
        judges: [],
      }),
    );
    expect(md).toContain("> **Partial report.** rate limit five_hour rejected during 'haiku'");
    expect(md).toContain("`haiku` stopped at questions (3 blocking) without a design doc");
  });

  test('shows a failed judge', () => {
    const md = renderReport(
      results({ judges: [{ variant: 'sonnet-high', costUsd: 0.1, gaps: [], error: 'judge wrote no judge.json' }] }),
    );
    expect(md).toContain('judge failed: judge wrote no judge.json');
  });
});
