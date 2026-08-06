import type { JobPhase, JobRecord } from '../types/index.ts';

/** Which phase artifacts exist on disk right now. */
export interface PhaseInputs {
  /** plan/tasklist.json */
  taskList: boolean;
  /** implement/summary.json */
  implementSummary: boolean;
  /** verify/result.json */
  verifyResult: boolean;
}

export interface EntryDecision {
  phase: JobPhase;
  reason: string;
  cleanWorkspace: boolean;
}

/** Phases the pipeline can be entered at, in run order. */
const ORDER: JobPhase[] = ['planning', 'implementing', 'verifying', 'publishing'];

/** What each entry point needs, and what to say when it is missing. */
const REQUIRES: Partial<Record<JobPhase, Array<[keyof PhaseInputs, string]>>> = {
  implementing: [['taskList', 'plan/tasklist.json']],
  verifying: [['implementSummary', 'implement/summary.json']],
  publishing: [
    ['implementSummary', 'implement/summary.json'],
    ['verifyResult', 'verify/result.json'],
  ],
};

function decide(phase: JobPhase, reason: string): EntryDecision {
  return { phase, reason, cleanWorkspace: phase === 'planning' };
}

/**
 * Decide where to enter the pipeline.
 *
 * Pure by design: availability is computed by the caller (stat calls on
 * artifact paths) and passed in via `inputs`, so the whole dispatch table is
 * testable without touching a filesystem or reading config.
 */
export function resolveEntryPhase(
  job: Pick<JobRecord, 'phase' | 'failedAtPhase'>,
  inputs: PhaseInputs,
  hasNewComments: boolean,
): EntryDecision {
  // A job waiting on the human always re-plans in the existing worktree,
  // never a wiped one: it never reached implement, so there is no stale
  // build to discard, and wiping would delete plan/questions.json — the
  // input runPlanningPhase reads to build the "this is a follow-up round"
  // block. `hasNewComments` alone would get this wrong: the ordinary path
  // through the clarify loop is "human answered the questions, then
  // re-triggered", which *is* a new unmarked comment, so this has to be
  // checked before the comment precondition below or the exception is dead
  // in exactly the case it exists for.
  if (job.phase === 'awaiting-answers') {
    return {
      phase: 'planning',
      reason: 'resuming the clarify loop — re-plans in place, no build to discard',
      cleanWorkspace: false,
    };
  }

  // A human answered something since we planned, so the plan is stale
  // regardless of how far the job had got.
  if (hasNewComments) {
    return decide('planning', 'a new comment arrived since the plan was made');
  }

  let wanted: JobPhase;
  switch (job.phase) {
    case 'implementing':
    case 'verifying':
    case 'publishing':
      wanted = job.phase;
      break;
    case 'failed':
      wanted = job.failedAtPhase ?? 'planning';
      break;
    default:
      // new, planning, done (awaiting-answers is handled above)
      wanted = 'planning';
  }

  // `failedAtPhase` is typed as the full JobPhase union, not narrowed to the
  // four resumable phases, so a job that failed while its recorded phase was
  // itself non-resumable (e.g. it threw while still 'new' or
  // 'awaiting-answers') can leave `wanted` outside `ORDER`. Treat that the
  // same as having nothing useful to resume: plan from scratch, with the
  // workspace wipe `cleanWorkspace` implies — resuming without wiping here
  // would silently inherit a worktree from whatever phase actually ran.
  if (!ORDER.includes(wanted)) {
    return decide(
      'planning',
      `recorded phase '${wanted}' is not resumable — planning from scratch`,
    );
  }

  // Walk backwards from the wanted phase to the first phase whose required
  // inputs are all present. `planning` requires nothing, so this always
  // terminates. The reason from the most recent downgrade is carried
  // forward — it names the artifact that actually blocked us, not just the
  // phase we landed on.
  let phase = wanted;
  let reason = `resuming at ${phase}`;
  let index = ORDER.indexOf(phase);
  while (index > 0) {
    const missing = (REQUIRES[phase] ?? []).find(([key]) => !inputs[key]);
    if (!missing) {
      break;
    }
    reason = `cannot enter ${phase}: ${missing[1]} is missing — falling back`;
    index -= 1;
    phase = ORDER[index]!;
  }

  return decide(phase, reason);
}
