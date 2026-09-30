import { describe, test, expect } from 'bun:test';
import { parseVariantSet, selectVariants } from '../../src/config/experiment.ts';

const valid = {
  phase: 'planning',
  baseline: 'opus-high',
  judgeModel: 'claude-sonnet-5-5',
  maxUsd: 200,
  variants: [
    { name: 'opus-high', model: 'claude-opus-5-5', effort: 'high' },
    { name: 'opus-haiku-subs', model: 'claude-opus-5-5', effort: 'high', subagentModel: 'claude-haiku-4-5-20251001' },
    { name: 'haiku', model: 'claude-haiku-4-5-20251001' },
  ],
};

describe('parseVariantSet', () => {
  test('accepts the starter set without warnings', () => {
    const { set, warnings } = parseVariantSet(valid);
    expect(set.variants).toHaveLength(3);
    expect(warnings).toEqual([]);
  });

  test('rejects a baseline that is not a variant', () => {
    expect(() => parseVariantSet({ ...valid, baseline: 'nope' })).toThrow("baseline 'nope'");
  });

  test('rejects duplicate variant names', () => {
    expect(() =>
      parseVariantSet({ ...valid, variants: [...valid.variants, { name: 'haiku' }] }),
    ).toThrow("duplicate variant name 'haiku'");
  });

  test('rejects a variant name unsafe for paths', () => {
    expect(() =>
      parseVariantSet({ ...valid, variants: [...valid.variants, { name: 'a/b' }] }),
    ).toThrow('letters, digits and hyphens');
  });

  test('rejects an unknown effort level', () => {
    expect(() =>
      parseVariantSet({ ...valid, variants: [{ name: 'opus-high', effort: 'extreme' }] }),
    ).toThrow('Invalid variant file');
  });

  test('warns when effort is set on a Haiku model', () => {
    const { warnings } = parseVariantSet({
      ...valid,
      variants: [...valid.variants, { name: 'haiku-high', model: 'claude-haiku-4-5-20251001', effort: 'high' }],
    });
    expect(warnings).toEqual([
      "variant 'haiku-high': Haiku models do not support effort — 'high' will be ignored by the SDK",
    ]);
  });
});

describe('selectVariants', () => {
  const { set } = parseVariantSet(valid);

  test('returns every variant without a filter', () => {
    expect(selectVariants(set).map((v) => v.name)).toEqual(['opus-high', 'opus-haiku-subs', 'haiku']);
  });

  test('keeps file order for --only', () => {
    expect(selectVariants(set, ['haiku', 'opus-high']).map((v) => v.name)).toEqual(['opus-high', 'haiku']);
  });

  test('rejects an unknown --only name', () => {
    expect(() => selectVariants(set, ['nope'])).toThrow("unknown variant 'nope'");
  });
});
