import type { AuthMode } from '../types/index.ts';

export const DEFAULT_VARIANTS_FILE = 'experiments/variants/planning-baseline.json';

export const EXPERIMENT_USAGE =
  'Usage: bun run experiment plan <work-item-id> [--variants <file>] [--only a,b] ' +
  '[--answers <file>] [--questions <file>] [--from-plan <runId>/<variant>] ' +
  '[--auth subscription|api-key] [--resume <runId>]';

export interface ExperimentArgs {
  workItemId: number;
  variantsFile: string;
  only?: string[];
  answersFile?: string;
  questionsFile?: string;
  auth: AuthMode;
  resumeRunId?: string;
  /** Plan folder of an earlier variant to revise, e.g. experiments/runs/<id>/<runId>/<variant>/plan. */
  fromPlan?: string;
}

const FLAGS = new Set(['--variants', '--only', '--answers', '--questions', '--auth', '--resume', '--from-plan']);

export function parseExperimentArgs(argv: string[]): ExperimentArgs {
  const [phase, id, ...rest] = argv;
  if (phase !== 'plan' || !id || !/^\d+$/.test(id)) throw new Error(EXPERIMENT_USAGE);

  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    if (!FLAGS.has(flag)) throw new Error(`unknown option '${flag}'\n${EXPERIMENT_USAGE}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`'${flag}' needs a value`);
    values.set(flag, value);
  }

  const auth = values.get('--auth') ?? 'subscription';
  if (auth !== 'subscription' && auth !== 'api-key') {
    throw new Error("--auth must be 'subscription' or 'api-key'");
  }

  const args: ExperimentArgs = {
    workItemId: Number(id),
    variantsFile: values.get('--variants') ?? DEFAULT_VARIANTS_FILE,
    auth,
  };
  const only = values.get('--only');
  if (only) args.only = only.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const answers = values.get('--answers');
  if (answers) args.answersFile = answers;
  const questions = values.get('--questions');
  if (questions) args.questionsFile = questions;
  const resume = values.get('--resume');
  if (resume) args.resumeRunId = resume;
  const fromPlan = values.get('--from-plan');
  if (fromPlan) {
    if (!/^[^/\\]+\/[^/\\]+$/.test(fromPlan)) throw new Error('--from-plan takes <runId>/<variant>');
    args.fromPlan = `experiments/runs/${id}/${fromPlan}/plan`;
  }
  return args;
}
