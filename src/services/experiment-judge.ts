import { z } from 'zod';

export const JUDGE_OUTPUT = 'judge.json';

/** Read-only apart from writing its own verdict file. */
export const JUDGE_TOOLS = ['Read', 'Glob', 'Grep', 'Write'];

export type JudgeVerdict = 'equivalent' | 'minor-gaps' | 'major-gaps' | 'better';

export interface JudgeScores {
  coverage: number;
  correctness: number;
  patternFit: number;
  taskActionability: number;
  questionQuality: number;
}

export interface JudgeResult {
  variant: string;
  costUsd: number;
  scores?: JudgeScores;
  verdict?: JudgeVerdict;
  gaps: Array<{ item: string; section?: string }>;
  summary?: string;
  error?: string;
}

const score = z.number().int().min(1).max(5);

const assessmentSchema = z.object({
  scores: z.object({
    coverage: score,
    correctness: score,
    patternFit: score,
    taskActionability: score,
    questionQuality: score,
  }),
  gapSeverity: z.enum(['none', 'minor', 'major']),
  gaps: z.array(z.object({ item: z.string(), section: z.string().optional() })),
});

const judgeOutputSchema = z.object({
  A: assessmentSchema,
  B: assessmentSchema,
  better: z.enum(['A', 'B', 'equivalent']),
  summary: z.string(),
});

/**
 * The prompt names plans only as A and B. Which one is the reference is the
 * orchestrator's secret, so the judge cannot favour it.
 */
export function buildJudgePrompt(): string {
  return `You are reviewing two independent plans for the same new bank communication in
Continia Banking (Business Central / AL). Neither plan is known to be correct.

Files in your working directory:

- \`work-item.md\` — the work item, its comment thread, and the requirement. Where it refers
  to \`.agent/input-docs/<file>\`, that file is in \`docs/<file>\` here.
- \`A/\` and \`B/\` — one plan each: \`design-doc.md\`, \`tasklist.json\`, \`questions.json\`,
  \`artifacts.json\`. Some files may be missing; a missing design doc is itself a finding.

Read both plans fully and check them against the work item and the API docs.

Score each plan from 1 (poor) to 5 (excellent):

- \`coverage\` — authentication, export, import and assisted setup are all planned where the
  work item asks for them.
- \`correctness\` — endpoints, fields, call order and auth handling match the work item and API
  docs; nothing is invented.
- \`patternFit\` — reuses the reference bank's patterns; no AL object is planned for something
  that is setup-JSON configuration.
- \`taskActionability\` — a developer could execute each task without guessing.
- \`questionQuality\` — blocking questions are real gaps, not things the work item already
  answers. Score 5 when there are no questions and none were needed.

For each plan also give \`gapSeverity\`: \`none\`; \`minor\` (a developer would still build
working code); or \`major\` (a developer would build wrong or incomplete code). Then list
\`gaps\`: concrete things this plan misses or gets wrong that the work item or the other plan
gets right, each with the design-doc section heading it concerns.

Write \`${JUDGE_OUTPUT}\` in your working directory with exactly this shape:

\`\`\`json
{
  "A": { "scores": { "coverage": 1, "correctness": 1, "patternFit": 1, "taskActionability": 1, "questionQuality": 1 },
         "gapSeverity": "none", "gaps": [{ "item": "...", "section": "..." }] },
  "B": { "scores": { "coverage": 1, "correctness": 1, "patternFit": 1, "taskActionability": 1, "questionQuality": 1 },
         "gapSeverity": "none", "gaps": [] },
  "better": "A | B | equivalent",
  "summary": "two or three sentences"
}
\`\`\`

Do not modify any other file.`;
}

/** Map the judge's A/B view back onto the variant being evaluated. */
export function parseJudgeOutput(
  raw: unknown,
  variantIsA: boolean,
  variant: string,
  costUsd: number,
): JudgeResult {
  if (raw === undefined) {
    return { variant, costUsd, gaps: [], error: `judge wrote no ${JUDGE_OUTPUT}` };
  }

  const parsed = judgeOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    return { variant, costUsd, gaps: [], error: `${JUDGE_OUTPUT} has the wrong shape: ${issues}` };
  }

  const out = parsed.data;
  const side = variantIsA ? 'A' : 'B';
  const mine = out[side];
  const verdict: JudgeVerdict =
    out.better === side
      ? 'better'
      : mine.gapSeverity === 'none'
        ? 'equivalent'
        : mine.gapSeverity === 'minor'
          ? 'minor-gaps'
          : 'major-gaps';

  return {
    variant,
    costUsd,
    scores: mine.scores,
    verdict,
    gaps: mine.gaps,
    summary: out.summary,
  };
}
