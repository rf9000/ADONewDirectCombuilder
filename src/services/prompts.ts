import type {
  AppConfig,
  PlanQuestions,
  WorkItemComment,
  WorkItemResponse,
} from '../types/index.ts';

/**
 * Azure DevOps stores rich-text fields as HTML. Reduce it to something a model
 * reads cleanly without dragging markup into the prompt.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function field(item: WorkItemResponse, name: string): string {
  const value = item.fields[name];
  return value === undefined || value === null ? '' : String(value);
}

/** Human-readable work item context: title, description and full comment thread. */
export function buildWorkItemContext(
  item: WorkItemResponse,
  comments: WorkItemComment[],
  config?: AppConfig,
): string {
  const lines: string[] = [
    `# Work item #${item.id}`,
    `**Type:** ${field(item, 'System.WorkItemType')}`,
    `**Title:** ${field(item, 'System.Title')}`,
    `**State:** ${field(item, 'System.State')}`,
    `**Tags:** ${field(item, 'System.Tags')}`,
  ];

  // Without this the planner investigates the trigger tag as if it were a
  // product concern — it searched both repos and .claude/ for it, found only a
  // prior run's own output, and reported "no automation meaning" as an
  // ambiguity. The tags are ours; say so rather than let it spend a round
  // reaching a wrong conclusion about them.
  if (config) {
    lines.push(
      '',
      '> The tags above include this orchestrator\'s own signalling: ' +
        `\`${config.triggerTag}\` (start or resume), \`${config.waitingTag}\` (paused for your ` +
        `questions), \`${config.doneTag}\`, \`${config.failedTag}\`. The pipeline that invoked you ` +
        'sets and clears them. They mean nothing inside the product repositories — do not search ' +
        'for them, and do not treat them as part of the requirement.',
    );
  }

  lines.push(
    '',
    '## Description',
    htmlToText(field(item, 'System.Description')) || '(empty)',
  );

  const repro = htmlToText(field(item, 'Microsoft.VSTS.TCM.ReproSteps'));
  if (repro) {
    lines.push('', '## Repro steps / additional detail', repro);
  }

  const acceptance = htmlToText(field(item, 'Microsoft.VSTS.Common.AcceptanceCriteria'));
  if (acceptance) {
    lines.push('', '## Acceptance criteria', acceptance);
  }

  lines.push('', '## Comment thread (oldest first)');
  if (comments.length === 0) {
    lines.push('(no comments)');
  } else {
    for (const comment of comments) {
      const who = comment.createdBy?.displayName ?? 'unknown';
      const when = comment.createdDate ?? '';
      lines.push('', `### Comment ${comment.id} — ${who} ${when}`.trim());
      lines.push(htmlToText(comment.text ?? ''));
    }
  }

  return lines.join('\n');
}

export interface PhasePaths {
  /** Directory holding this job's artifacts, inside the banking worktree. */
  agentDir: string;
  questionsPath: string;
  artifactsPath: string;
  designDocPath: string;
  taskListPath: string;
  verifyResultPath: string;
  /**
   * Where the implement phase records what it changed, for publish to read
   * — so publish can be entered directly, without implement having run in
   * the same process.
   */
  implementSummaryPath: string;
  /**
   * The implement agent's per-task report. The orchestrator checks it against
   * the task list, so a run that stops partway cannot pass for a finished one.
   */
  implementResultPath: string;
}

export function buildPlanningPrompt(
  config: AppConfig,
  context: string,
  paths: PhasePaths,
  bankingWorktree: string,
  setupFilesWorktree: string,
  previousQuestions?: PlanQuestions,
  /**
   * 'revision' when a follow-up round finds the previous round's plan on
   * disk: the planner patches that plan instead of re-running every phase.
   */
  mode: 'full' | 'revision' = 'full',
  /** True when the run has the AL language server (AL_LSP_PLUGIN_DIR). */
  lsp = false,
): string {
  const followUp =
    previousQuestions &&
    (previousQuestions.blocking.length > 0 || previousQuestions.ambiguities.length > 0)
      ? [
          '',
          '## This is a follow-up round',
          'You previously asked the questions below. The answers are in the comment',
          'thread above — read the newest comments first, apply them, and only ask',
          'again about things that are still genuinely unresolved.',
          '',
          'An ambiguity listed below that no answer contradicts is accepted as decided:',
          'do not list it again. List only ambiguities that are new this round, or whose',
          'decision an answer changed.',
          '',
          '```json',
          JSON.stringify(previousQuestions, null, 2),
          '```',
        ].join('\n')
      : '';

  return `You are planning a new bank communication integration for Continia Banking.

${context}
${followUp}
${lsp ? AL_LSP_SECTION : ''}
## Repositories available to you

- **continia-banking** (AL source, your working directory): \`${bankingWorktree}\`
- **setup-files** (bank/bank-system configuration JSON): \`${setupFilesWorktree}\`

Both paths are also recorded in \`.claude/repo-paths.json\` as \`continia-banking\` and
\`setup-files\`, which is where the skills expect to find them.

## What to do

${mode === 'revision' ? revisionInstructions(paths) : fullPlanInstructions(paths)}

The planner is plan-only: do **not** write any AL code, edit any setup JSON, or
create any branch in this phase.

## Required artifacts — write these files before you finish

1. \`${paths.questionsPath}\` — JSON, always written even when empty:

\`\`\`json
{
  "blocking": [{ "question": "...", "rationale": "why this blocks planning" }],
  "ambiguities": [{ "question": "...", "decisionTaken": "what you decided", "rationale": "why" }]
}
\`\`\`

   - \`blocking\`: anything you genuinely cannot plan soundly without an answer.
     Never invent endpoints, field names, or auth flows to fill a gap — ask.
   - \`ambiguities\`: things that were unclear where you made a defensible call that a
     person outside the planning must be able to correct. State the decision.
     - Only externally visible behavior: the Online/bank API contract, product scope,
       or what the user sees. Internal design, testability and the plan's own flow are
       engineering calls for the design doc's Decisions & Limitations — never ask a human
       how your own plan works.
     - One entry per decision; no duplicates under different ids.
     - Go-live checks with no code impact go in the design doc, not here.
     - At most 10, most costly-if-wrong first; the rest go in the design doc.
   - Both empty means "the plan is clear and complete".

2. \`${paths.artifactsPath}\` — JSON describing what you produced:

\`\`\`json
{
  "bankName": "PascalCaseBankName",
  "designDocPath": "${paths.designDocPath}",
  "taskListPath": "${paths.taskListPath}",
  "objectCount": 0,
  "testCount": 0,
  "waveCount": 0${mode === 'revision' ? REVISION_ARTIFACT_FIELDS : ''}
}
\`\`\`

Both files are read by the orchestrator, so paths and field names must match
exactly. Write them even if the planner gated at Phase 1 — in that case
\`blocking\` carries the gaps and the design doc may be absent.

When you are done, reply with a two-line summary: bank name, and whether the plan
is complete or waiting on answers.`;
}

/**
 * Planner subagents grepped the AL tree hundreds of times per plan, each one
 * rediscovering the same reference-bank and framework code. The language
 * server answers those questions in one call. The rules below come from the
 * 2026-10-01 spike: the server needs a moment to index, and calls made
 * through an interface resolve to the interface member, not the codeunit.
 */
const AL_LSP_SECTION = `
## AL language server

The \`LSP\` tool is available, backed by the AL language server.
**Pass this section on to every subagent you dispatch**, word for word, so they use it too.

**Warm it up first.** Before your first Grep, Bash search or subagent dispatch:

1. Call \`documentSymbol\` on \`base-application/Logging/Codeunits/RequestEntryID.Codeunit.al\`.
   Opening a file is what makes the server load the project; \`workspaceSymbol\` alone never
   does. If it says "server is starting", run \`sleep 10\` in Bash and retry.
2. Then \`workspaceSymbol\` for "ABNAMRO", repeated with \`sleep 20\` between tries (up to 6)
   until it returns results. Measured on this repo: ready about 30 seconds after step 1.

Subagents share this session's server, so once it answers you, it answers them.

- Use LSP before Grep or Bash for AL symbols:
  - \`workspaceSymbol\` to find objects by name (for example "ABNAMRO").
  - \`goToImplementation\` on an interface to find "who implements X".
  - \`documentSymbol\` to list a file's procedures.
  - \`findReferences\` to find callers.
- Calls made through an interface (\`IHttpFactory.GetRequestEntryIDLog().LogRequestEntryID(...)\`)
  are references to the **interface member**. Ask \`findReferences\` on the interface member; on the
  implementing codeunit's procedure it returns no callers.
- The server indexes the workspace when it starts. "Server is starting" or "has not finished
  indexing" means wait and retry, not "no results".
- Symbols from dependencies (Microsoft base app, other Continia apps) may not resolve, and
  diagnostics about them (AL0185, AL0118) are expected. Use Grep for those, and for setup-files JSON.
- Read a file only once LSP has told you which lines matter.
`;

/** Resumes a planning session that ended before writing its artifacts. */
export function buildPlanningNudge(paths: PhasePaths, mode: 'full' | 'revision' = 'full'): string {
  const work =
    mode === 'revision'
      ? 'finish the revision as the "Follow-up round (revision mode)" section describes'
      : 'finish the remaining bank-integration-planner phases';
  return `You stopped before finishing: the planning job is not complete, because
\`${paths.questionsPath}\` or \`${paths.artifactsPath}\` does not exist yet.

Continue from where you stopped. Do not start over. A subagent that had not reported back
when you stopped is gone: redo its step yourself or dispatch it again. Then ${work},
and write every required artifact exactly as the original instructions specify:

- design doc → \`${paths.designDocPath}\`
- task list → \`${paths.taskListPath}\`
- questions → \`${paths.questionsPath}\`
- artifacts → \`${paths.artifactsPath}\`

Then reply with the two-line summary the original instructions ask for.`;
}

function fullPlanInstructions(paths: PhasePaths): string {
  return `Invoke the **bank-integration-planner** skill and run it to completion. Give it the
work item content above as its Phase 0 inputs, and use this output path for its
artifacts:

- design doc  → \`${paths.designDocPath}\`
- task list   → \`${paths.taskListPath}\`
- questions   → \`${paths.questionsPath}\``;
}

/**
 * A full re-plan costs as much as the first round (~$32 on #83634) to absorb a
 * handful of answers. The previous round's plan is on disk, so revise it.
 */
function revisionInstructions(paths: PhasePaths): string {
  return `The previous round already produced a plan. Do **not** re-run the
**bank-integration-planner** skill from Phase 0. Follow its "Follow-up round (revision mode)"
section instead: apply the new answers to the existing plan and revise only what they affect.

The existing plan, which you revise in place:

- design doc  → \`${paths.designDocPath}\`
- task list   → \`${paths.taskListPath}\`
- questions   → the previous round's are in the follow-up section above; write the new ones
  to \`${paths.questionsPath}\`
- planner working files (fragments, verdicts), if any → \`${paths.agentDir}/plan/\`

If an answer changes the plan's foundation (a different auth flow, reference bank or set of
file types), say so and run the skill in full instead. Before that full run, move the
existing design doc, task list and planner working files into \`${paths.agentDir}/plan/superseded/\`,
so a later round never revises a plan you rejected. Record which you did in
\`revisionMode\` below.`;
}

const REVISION_ARTIFACT_FIELDS = `,
  "revisionMode": "incremental | full",
  "revisionReason": "which answers changed which sections, or why a full re-plan was needed"`;

export function buildImplementPrompt(
  config: AppConfig,
  context: string,
  paths: PhasePaths,
  bankingWorktree: string,
  setupFilesWorktree: string,
): string {
  return `You are implementing an approved bank integration plan for Continia Banking.

${context}

## The plan

- design doc: \`${paths.designDocPath}\`
- task list:  \`${paths.taskListPath}\`

Read both before you start. The task list is wave-grouped; execute it wave by wave
and respect the declared dependencies.

## This worktree may already hold partial work

An earlier run may have been interrupted partway through this same task list —
the worktree survives a crash or restart so work is not thrown away. Before you
start, inspect what is already here: run \`git status\` in both repositories, and
check whether the AL objects and setup entries the task list names already exist.
Continue the plan from whatever is already done rather than re-creating it —
object IDs are reserved through the Ninja MCP, so redoing finished work burns new
IDs for objects that already have one. On a fresh worktree this costs one
\`git status\` and finds nothing.

## Repositories — both are yours to edit

- **continia-banking** (AL objects, your working directory): \`${bankingWorktree}\`
- **setup-files** (bank/bank-system configuration JSON): \`${setupFilesWorktree}\`

Changes belong in whichever repo the plan assigns them to. AL objects, interface
implementations, the \`CommunicationType\` enum registration and \`Bank\`/\`Bank Account\`
table fields go in continia-banking. Bank system definitions, communication type
setup, bank entries, allowed file types per direction, payment methods and request
header mappings go in setup-files. Do not duplicate configuration as hard-coded AL.

## Rules

- Follow the repo's own CLAUDE.md and coding rules, and the skills available to you
  (\`new-bank-communication\`, \`bank-communication-operations\`, \`async-flow-patterns\`,
  \`bank-system-setup-wizard\`, \`setup-files-investigate\`).
- Write the tests the plan's Test Plan section specifies.
- Do **not** commit, create branches, push, or open pull requests. The orchestrator
  handles all git operations.
- Do not touch \`.claude/\` — those are symlinks into the orchestrator's own repo.

## Required artifact — finish every task

Build the whole task list in this run. Do not stop partway to save time or budget, and
do not hand unfinished tasks to "the next run": the orchestrator checks this report
against the task list, and an incomplete build is sent back to you, not to review.

Keep \`${paths.implementResultPath}\` up to date as you finish each task, so the report
survives an interruption. If the file already exists, an earlier run wrote it — keep
its \`done\` entries and continue with the rest:

\`\`\`json
{
  "summary": "- continia-banking: ...\\n- setup-files: ...",
  "tasks": [
    { "id": 1, "status": "done" },
    { "id": 7, "status": "blocked", "note": "why this task cannot be done" }
  ]
}
\`\`\`

- One entry per task \`id\` in the task list. \`done\` means built as the task specifies.
- \`blocked\` is only for a task that cannot be done as specified — a contradiction in the
  plan or something missing from the repo — never for one you have not got to yet. Say
  why in \`note\`. A blocked task fails the job for a human to look at.
- \`summary\` is a bullet list of the changes, grouped by repo, kept to what a reviewer
  needs: it becomes the pull request description.`;
}

/** Resume an implement session that stopped with tasks still unreported. */
export function buildImplementNudge(paths: PhasePaths, remaining: Array<number | string>): string {
  return `You stopped before finishing: these task ids from \`${paths.taskListPath}\` are not
marked \`done\` in \`${paths.implementResultPath}\`: ${remaining.join(', ')}.

Continue from where you stopped. Do not start over and do not redo finished tasks. A
subagent that had not reported back when you stopped is gone: redo its step yourself or
dispatch it again. Build every remaining task, and update \`${paths.implementResultPath}\`
as the original instructions specify, including its \`summary\` of all changes.`;
}

export function buildVerifyPrompt(
  config: AppConfig,
  paths: PhasePaths,
  bankingWorktree: string,
): string {
  return `Build and test the changes in \`${bankingWorktree}\` on a real BC environment.

The Continia CLI is on PATH as \`continia\` (a Linux build; it authenticates from
\`CONTINIA_API_TOKEN\` in the environment, so there is no VS Code setting to read).
When a skill tells you the CLI lives at \`.tools/continia.exe\`, use \`continia\` instead.

## Steps

1. **continia-env-setup** — find or start a running environment. Reuse an existing
   running environment when there is one; do not create a new one unnecessarily.
2. **continia-deps** — download symbols / install dependencies for the apps you touched.
3. **continia-deploy** — compile and publish the changed app(s).
4. **continia-test** — run the test codeunits the plan added, plus any existing
   codeunit your change could regress. Tests must run **sequentially** — BC cannot
   run concurrent test jobs on one environment.

If a test fails, read the stack trace, fix the code, redeploy, and re-run that test.
Iterate until it passes or you are confident the failure is not something you can fix.

**Do not stop or delete the environment when you are finished — leave it running.**

## Required artifact

Write \`${paths.verifyResultPath}\`:

\`\`\`json
{
  "passed": true,
  "envId": "...",
  "envUrl": "https://...",
  "summary": "one or two sentences: what was deployed, what was run, the counts",
  "failedTests": []
}
\`\`\`

\`passed\` must be \`false\` if anything is still failing, with the failing test names in
\`failedTests\`. Be accurate — a false \`true\` puts broken code in front of reviewers.`;
}

/**
 * Hidden sentinel this pipeline prepends to every comment it posts.
 *
 * The intent: staleness detection has to ignore our own comments, or every
 * retry sees "new comments" and resume never engages, and a marker sidesteps
 * author-based filtering, which is unusable — `createdBy.uniqueName` is the
 * PAT owner, who is also likely to be the person answering.
 *
 * **It does not work.** Verified 2026-08-07 against work item 80969: posted
 * a comment through `addWorkItemComment` and read it straight back with
 * `getWorkItemComments` (the evidence comment is id 20930846). The marker
 * was absent from both the POST response and the GET — Azure DevOps strips
 * HTML comment nodes from work item comments server-side — while `<b>` and
 * `<code>` in the same body survived untouched. So `isBotComment` below can
 * never match in production; every comment this pipeline posts reads as
 * human input to the staleness check that consults it.
 *
 * The feature works anyway, because of a mechanism added after this one:
 * `reportFailure`'s caller (`pipeline.ts`, search `lastSeenCommentId: Math.max`)
 * advances `job.lastSeenCommentId` to the id of the failure comment it just
 * posted. That bump — not this marker — is what keeps the pipeline's own
 * comments from looking like new human input on the next run; see that
 * comment for why it covers every recorded phase staleness is ever consulted
 * from.
 *
 * The marker is kept regardless: it costs nothing to keep posting, it is a
 * correct filter if ADO's sanitiser behaviour ever changes, and the tests
 * asserting our builders emit it are about our builders, not about ADO, so
 * they still have value. Do not remove it or `isBotComment` on the strength
 * of this comment.
 */
export const BOT_COMMENT_MARKER = '<!-- new-comm-builder -->';

export function isBotComment(text: string): boolean {
  return text.includes(BOT_COMMENT_MARKER);
}

/** The comment we post when the planner needs human input. */
export function buildQuestionsComment(
  config: AppConfig,
  questions: PlanQuestions,
  round: number,
  isFinalRound: boolean,
): string {
  const trigger = `<code>${escapeHtml(config.triggerTag)}</code>`;
  const waiting = `<code>${escapeHtml(config.waitingTag)}</code>`;

  // The call to action goes first and is repeated at the end. Buried at the
  // bottom under the rationale it was easy to miss, and a missed instruction
  // means the job sits in awaiting-answers indefinitely — the tag is the only
  // thing that resumes it, so silence looks identical to a hung bot.
  const lines: string[] = [
    BOT_COMMENT_MARKER,
    `<b>Bank integration planner — round ${round}: input needed</b>`,
    '',
    '<b>This job is paused and will not continue on its own.</b>',
    '<ol>',
    '<li>Answer the questions below in a comment on this work item.</li>',
    `<li><b>Re-add the ${trigger} tag.</b> I removed it so the poller would ` +
      `stop; the item now carries ${waiting} instead.</li>`,
    '</ol>',
    `I pick it up on the next poll (within ${config.pollIntervalMinutes} minute` +
      `${config.pollIntervalMinutes === 1 ? '' : 's'}) and continue from where I ` +
      'stopped — the planning already done is not repeated.',
    '',
    '<hr/>',
    '',
  ];

  if (questions.blocking.length > 0) {
    lines.push('<b>Questions I need answered</b>', '<ol>');
    for (const q of questions.blocking) {
      const rationale = q.rationale ? ` <i>(${escapeHtml(q.rationale)})</i>` : '';
      lines.push(`<li>${escapeHtml(q.question)}${rationale}</li>`);
    }
    lines.push('</ol>');
  }

  if (questions.ambiguities.length > 0) {
    lines.push('<b>Ambiguities where I made a call — correct me if wrong</b>', '<ol>');
    for (const q of questions.ambiguities) {
      const decision = q.decisionTaken
        ? `<br/><b>Decision:</b> ${escapeHtml(q.decisionTaken)}`
        : '';
      const rationale = q.rationale ? `<br/><b>Why:</b> ${escapeHtml(q.rationale)}` : '';
      lines.push(`<li>${escapeHtml(q.question)}${decision}${rationale}</li>`);
    }
    lines.push('</ol>');
  }

  lines.push('', '<hr/>', '');

  if (isFinalRound && questions.blocking.length === 0 && round < config.maxClarifyRounds) {
    // Only the ambiguity cap is reached: a new blocking question could still
    // pause a later round, so do not promise never to ask again.
    lines.push(
      '<b>Last review of these decisions.</b> I will not pause for them again — on the ' +
        'next run I proceed on the decisions above, with any corrections you give, and ' +
        'only stop again if something blocks the plan. ' +
        `<b>Re-add the ${trigger} tag</b> to run with whatever you have provided.`,
    );
  } else if (isFinalRound) {
    lines.push(
      `<b>Last clarification round (${round} of ${config.maxClarifyRounds}).</b> ` +
        'I will not ask again — on the next run I proceed on the decisions above, ' +
        'answered or not. ' +
        `<b>Re-add the ${trigger} tag</b> to run with whatever you have provided.`,
    );
  } else {
    lines.push(
      `<b>To continue: answer in a comment, then re-add the ${trigger} tag.</b> ` +
        'Nothing happens until that tag is back on the work item.',
    );
  }

  return lines.join('\n');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
