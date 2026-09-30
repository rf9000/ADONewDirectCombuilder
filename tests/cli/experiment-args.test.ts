import { describe, test, expect } from 'bun:test';
import { DEFAULT_VARIANTS_FILE, parseExperimentArgs } from '../../src/cli/experiment-args.ts';

describe('parseExperimentArgs', () => {
  test('defaults to the baseline variant file and subscription auth', () => {
    expect(parseExperimentArgs(['plan', '83634'])).toEqual({
      workItemId: 83634,
      variantsFile: DEFAULT_VARIANTS_FILE,
      auth: 'subscription',
    });
  });

  test('reads every flag', () => {
    expect(
      parseExperimentArgs([
        'plan', '83634',
        '--variants', 'v.json',
        '--only', 'opus-high, haiku',
        '--answers', 'a.md',
        '--questions', 'q.json',
        '--auth', 'api-key',
      ]),
    ).toEqual({
      workItemId: 83634,
      variantsFile: 'v.json',
      only: ['opus-high', 'haiku'],
      answersFile: 'a.md',
      questionsFile: 'q.json',
      auth: 'api-key',
    });
  });

  test('rejects anything but the plan phase', () => {
    expect(() => parseExperimentArgs(['implement', '1'])).toThrow('Usage:');
  });

  test('rejects a missing or non-numeric id', () => {
    expect(() => parseExperimentArgs(['plan'])).toThrow('Usage:');
    expect(() => parseExperimentArgs(['plan', 'abc'])).toThrow('Usage:');
  });

  test('rejects an unknown flag, a flag without a value, and a bad auth mode', () => {
    expect(() => parseExperimentArgs(['plan', '1', '--repeat', '2'])).toThrow("unknown option '--repeat'");
    expect(() => parseExperimentArgs(['plan', '1', '--only'])).toThrow("'--only' needs a value");
    expect(() => parseExperimentArgs(['plan', '1', '--auth', 'oauth'])).toThrow("--auth must be 'subscription' or 'api-key'");
  });
});
