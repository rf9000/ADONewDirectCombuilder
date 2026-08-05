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
}

export function buildPlanningPrompt(
  config: AppConfig,
  context: string,
  paths: PhasePaths,
  bankingWorktree: string,
  setupFilesWorktree: string,
  previousQuestions?: PlanQuestions,
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
          '```json',
          JSON.stringify(previousQuestions, null, 2),
          '```',
        ].join('\n')
      : '';

  return `You are planning a new bank communication integration for Continia Banking.

${context}
${followUp}

## Repositories available to you

- **continia-banking** (AL source, your working directory): \`${bankingWorktree}\`
- **setup-files** (bank/bank-system configuration JSON): \`${setupFilesWorktree}\`

Both paths are also recorded in \`.claude/repo-paths.json\` as \`continia-banking\` and
\`setup-files\`, which is where the skills expect to find them.

## What to do

Invoke the **bank-integration-planner** skill and run it to completion. Give it the
work item content above as its Phase 0 inputs, and use this output path for its
artifacts:

- design doc  → \`${paths.designDocPath}\`
- task list   → \`${paths.taskListPath}\`
- questions   → \`${paths.questionsPath}\`

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
   - \`ambiguities\`: things that were unclear where you made a defensible call.
     State the decision so a human can correct it.
   - Both empty means "the plan is clear and complete".

2. \`${paths.artifactsPath}\` — JSON describing what you produced:

\`\`\`json
{
  "bankName": "PascalCaseBankName",
  "designDocPath": "${paths.designDocPath}",
  "taskListPath": "${paths.taskListPath}",
  "objectCount": 0,
  "testCount": 0,
  "waveCount": 0
}
\`\`\`

Both files are read by the orchestrator, so paths and field names must match
exactly. Write them even if the planner gated at Phase 1 — in that case
\`blocking\` carries the gaps and the design doc may be absent.

When you are done, reply with a two-line summary: bank name, and whether the plan
is complete or waiting on answers.`;
}

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

When you are done, reply with a bullet list of the changes you made, grouped by repo.
Keep it to what a reviewer needs: this text becomes the pull request description.`;
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
 * Hidden sentinel on every comment this pipeline posts.
 *
 * Staleness detection has to ignore our own comments, or every retry sees
 * "new comments" and resume never engages. Author is not usable as the
 * discriminator: `createdBy.uniqueName` is the PAT owner, who is also likely
 * to be the person answering, and it breaks outright once the agent gets its
 * own service account or several people take turns re-triggering a job.
 *
 * `htmlToText` strips `<[^>]+>`, so this reaches neither the agent's prompt
 * nor the ADO comment editor.
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

  if (isFinalRound) {
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
