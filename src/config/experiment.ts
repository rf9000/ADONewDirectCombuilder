import { readFileSync } from 'fs';
import { z } from 'zod';

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const variantSchema = z.object({
  // Used in directory and branch names.
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/i, 'variant name must be letters, digits and hyphens'),
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  subagentModel: z.string().min(1).optional(),
});

const variantSetSchema = z
  .object({
    phase: z.literal('planning'),
    baseline: z.string().min(1),
    judgeModel: z.string().min(1),
    maxUsd: z.number().positive(),
    variants: z.array(variantSchema).min(1),
  })
  .superRefine((set, ctx) => {
    const names = set.variants.map((v) => v.name);
    if (!names.includes(set.baseline)) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseline'],
        message: `baseline '${set.baseline}' is not one of the variants`,
      });
    }
    const duplicate = names.find((name, i) => names.indexOf(name) !== i);
    if (duplicate) {
      ctx.addIssue({
        code: 'custom',
        path: ['variants'],
        message: `duplicate variant name '${duplicate}'`,
      });
    }
  });

export type Variant = z.infer<typeof variantSchema>;
export type VariantSet = z.infer<typeof variantSetSchema>;

export function parseVariantSet(raw: unknown): { set: VariantSet; warnings: string[] } {
  const result = variantSetSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid variant file:\n${messages}`);
  }

  // Haiku 4.5 has no effort parameter and the SDK drops it silently, so a
  // report would otherwise imply an effect that never happened.
  const warnings = result.data.variants
    .filter((v) => v.effort !== undefined && /haiku/i.test(v.model ?? ''))
    .map(
      (v) =>
        `variant '${v.name}': Haiku models do not support effort — '${v.effort}' will be ignored by the SDK`,
    );

  return { set: result.data, warnings };
}

export function loadVariantSet(path: string): { set: VariantSet; warnings: string[] } {
  return parseVariantSet(JSON.parse(readFileSync(path, 'utf-8')));
}

/** Variants to run, in file order; `only` filters by name. */
export function selectVariants(set: VariantSet, only?: string[]): Variant[] {
  if (!only || only.length === 0) return set.variants;
  const known = new Set(set.variants.map((v) => v.name));
  for (const name of only) {
    if (!known.has(name)) throw new Error(`unknown variant '${name}' in --only`);
  }
  return set.variants.filter((v) => only.includes(v.name));
}
