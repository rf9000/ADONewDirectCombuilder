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
      // new, planning, awaiting-answers, done
      wanted = 'planning';
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
