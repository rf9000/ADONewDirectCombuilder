import { describe, test, expect } from 'bun:test';
import { resolveEntryPhase } from '../../src/services/entry-phase.ts';
import type { PhaseInputs } from '../../src/services/entry-phase.ts';

const all: PhaseInputs = {
  taskList: true,
  implementSummary: true,
  verifyResult: true,
};
const none: PhaseInputs = {
  taskList: false,
  implementSummary: false,
  verifyResult: false,
};

describe('resolveEntryPhase', () => {
  test('a fresh job plans', () => {
    const d = resolveEntryPhase({ phase: 'new' }, none, false);
    expect(d.phase).toBe('planning');
    expect(d.cleanWorkspace).toBe(true);
  });

  test('awaiting-answers re-plans — the clarify loop is unchanged', () => {
    const d = resolveEntryPhase({ phase: 'awaiting-answers' }, all, false);
    expect(d.phase).toBe('planning');
    // It never reached implement, so there is no stale build to discard —
    // and wiping would delete plan/questions.json, the follow-up context
    // runPlanningPhase needs for round N's prompt.
    expect(d.cleanWorkspace).toBe(false);
  });

  test('the clarify-loop exception survives a new comment', () => {
    // The ordinary path through this loop *is* a new unmarked comment
    // ("human answered, then re-triggered") — the exception has to win over
    // the comment rule, or it is dead in exactly the case it exists for.
    const d = resolveEntryPhase({ phase: 'awaiting-answers' }, all, true);
    expect(d.phase).toBe('planning');
    expect(d.cleanWorkspace).toBe(false);
  });

  test('resumes forward from a mid-flight phase', () => {
    expect(resolveEntryPhase({ phase: 'implementing' }, all, false).phase).toBe(
      'implementing',
    );
    expect(resolveEntryPhase({ phase: 'verifying' }, all, false).phase).toBe('verifying');
    expect(resolveEntryPhase({ phase: 'publishing' }, all, false).phase).toBe(
      'publishing',
    );
  });

  test('resuming forward does not clean the workspace', () => {
    expect(resolveEntryPhase({ phase: 'implementing' }, all, false).cleanWorkspace).toBe(
      false,
    );
  });

  test('a failed job resumes where it failed', () => {
    const d = resolveEntryPhase(
      { phase: 'failed', failedAtPhase: 'verifying' },
      all,
      false,
    );
    expect(d.phase).toBe('verifying');
  });

  test('a failed job with no recorded phase plans', () => {
    expect(resolveEntryPhase({ phase: 'failed' }, all, false).phase).toBe('planning');
  });

  test('a failed job whose recorded phase is itself non-resumable plans and wipes the workspace', () => {
    // failedAtPhase is the full JobPhase union; a job can fail while its
    // recorded phase was still 'awaiting-answers' (e.g. posting the
    // questions comment threw). That is not one of the four resumable
    // phases, so it must not be resumed as-is.
    const d = resolveEntryPhase(
      { phase: 'failed', failedAtPhase: 'awaiting-answers' },
      all,
      false,
    );
    expect(d.phase).toBe('planning');
    expect(d.cleanWorkspace).toBe(true);
  });

  test('new unmarked comments force a re-plan over any recorded phase', () => {
    const d = resolveEntryPhase({ phase: 'publishing' }, all, true);
    expect(d.phase).toBe('planning');
    expect(d.cleanWorkspace).toBe(true);
    expect(d.reason).toContain('comment');
  });

  test('falls back to the first phase whose inputs exist', () => {
    // Recorded at publishing, but the volume was pruned.
    const d = resolveEntryPhase({ phase: 'publishing' }, none, false);
    expect(d.phase).toBe('planning');
    expect(d.reason).toContain('tasklist.json');
  });

  test('falls back only as far as needed', () => {
    const d = resolveEntryPhase(
      { phase: 'publishing' },
      { taskList: true, implementSummary: true, verifyResult: false },
      false,
    );
    expect(d.phase).toBe('verifying');
    expect(d.reason).toContain('result.json');
  });
});
