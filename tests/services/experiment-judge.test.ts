import { describe, test, expect } from 'bun:test';
import { buildJudgePrompt, parseJudgeOutput } from '../../src/services/experiment-judge.ts';

const scores = (n: number) => ({
  coverage: n,
  correctness: n,
  patternFit: n,
  taskActionability: n,
  questionQuality: n,
});

const raw = {
  A: { scores: scores(5), gapSeverity: 'none', gaps: [] },
  B: {
    scores: scores(3),
    gapSeverity: 'major',
    gaps: [{ item: 'No refresh-token rotation', section: 'Authentication' }],
  },
  better: 'A',
  summary: 'A covers token rotation; B does not.',
};

describe('parseJudgeOutput', () => {
  test('maps plan B back to the variant when the variant was B', () => {
    const r = parseJudgeOutput(raw, false, 'haiku', 0.4);
    expect(r).toEqual({
      variant: 'haiku',
      costUsd: 0.4,
      scores: scores(3),
      verdict: 'major-gaps',
      gaps: [{ item: 'No refresh-token rotation', section: 'Authentication' }],
      summary: 'A covers token rotation; B does not.',
    });
  });

  test('reports better when the variant was A and the judge preferred A', () => {
    expect(parseJudgeOutput(raw, true, 'sonnet-high', 0.4).verdict).toBe('better');
  });

  test('maps gap severity when the plans are equal', () => {
    const equal = {
      ...raw,
      better: 'equivalent',
      B: { scores: scores(4), gapSeverity: 'minor', gaps: [] },
    };
    expect(parseJudgeOutput(equal, false, 'v', 0).verdict).toBe('minor-gaps');
  });

  test('returns an error result for a missing file', () => {
    expect(parseJudgeOutput(undefined, true, 'v', 0.2)).toEqual({
      variant: 'v',
      costUsd: 0.2,
      gaps: [],
      error: 'judge wrote no judge.json',
    });
  });

  test('returns an error result for the wrong shape', () => {
    const r = parseJudgeOutput({ A: {}, better: 'maybe' }, true, 'v', 0);
    expect(r.error).toStartWith('judge.json has the wrong shape');
    expect(r.verdict).toBeUndefined();
  });
});

describe('buildJudgePrompt', () => {
  test('never mentions baselines or variants', () => {
    const prompt = buildJudgePrompt();
    expect(prompt).toContain('A/');
    expect(prompt).toContain('judge.json');
    expect(prompt.toLowerCase()).not.toContain('baseline');
    expect(prompt.toLowerCase()).not.toContain('variant');
  });
});
