import { describe, test, expect } from 'bun:test';
import { mockConfig, mockWorkItem } from '../helpers.ts';
import {
  htmlToText,
  buildWorkItemContext,
  buildQuestionsComment,
  buildImplementPrompt,
  escapeHtml,
  BOT_COMMENT_MARKER,
  isBotComment,
} from '../../src/services/prompts.ts';
import type { PhasePaths } from '../../src/services/prompts.ts';
import type { PlanQuestions } from '../../src/types/index.ts';

const TEST_PATHS: PhasePaths = {
  agentDir: '/work/.agent',
  questionsPath: '/work/.agent/plan/questions.json',
  artifactsPath: '/work/.agent/plan/artifacts.json',
  designDocPath: '/work/.agent/plan/design-doc.md',
  taskListPath: '/work/.agent/plan/tasklist.json',
  verifyResultPath: '/work/.agent/verify/result.json',
  implementSummaryPath: '/work/.agent/implement/summary.json',
};

describe('htmlToText', () => {
  test('turns block tags into line breaks', () => {
    expect(htmlToText('<div>one</div><div>two</div>')).toBe('one\ntwo');
    expect(htmlToText('a<br/>b')).toBe('a\nb');
  });

  test('renders list items as dashes', () => {
    expect(htmlToText('<ul><li>a</li><li>b</li></ul>')).toBe('- a\n- b');
  });

  test('decodes the common entities', () => {
    expect(htmlToText('a&nbsp;&amp;&nbsp;b &lt;tag&gt; &quot;q&quot; &#39;s&#39;')).toBe(
      'a & b <tag> "q" \'s\'',
    );
  });

  test('collapses runs of blank lines', () => {
    expect(htmlToText('<p>a</p><p></p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
  });

  test('returns an empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
  });
});

describe('buildWorkItemContext', () => {
  test('includes the title, description and every comment in order', () => {
    const context = buildWorkItemContext(mockWorkItem(), [
      { id: 1, text: '<div>First answer</div>', createdBy: { displayName: 'RF' } },
      { id: 2, text: 'Second answer' },
    ]);

    expect(context).toContain('Add Acme Bank communication');
    expect(context).toContain('Implement Acme Bank via OAuth.');
    expect(context).toContain('First answer');
    expect(context).toContain('Second answer');
    expect(context.indexOf('First answer')).toBeLessThan(
      context.indexOf('Second answer'),
    );
    expect(context).toContain('RF');
  });

  test('marks an empty description and an empty thread explicitly', () => {
    const context = buildWorkItemContext(
      mockWorkItem({ fields: { 'System.Title': 'x' } }),
      [],
    );
    expect(context).toContain('(empty)');
    expect(context).toContain('(no comments)');
  });

  test('includes repro steps and acceptance criteria when present', () => {
    const context = buildWorkItemContext(
      mockWorkItem({
        fields: {
          'System.Title': 'x',
          'Microsoft.VSTS.TCM.ReproSteps': '<div>Swagger at https://acme/api</div>',
          'Microsoft.VSTS.Common.AcceptanceCriteria': '<div>Payments work</div>',
        },
      }),
      [],
    );
    expect(context).toContain('Swagger at https://acme/api');
    expect(context).toContain('Payments work');
  });

  test('omits the optional sections when they are blank', () => {
    const context = buildWorkItemContext(mockWorkItem(), []);
    expect(context).not.toContain('Repro steps');
    expect(context).not.toContain('Acceptance criteria');
  });
});

describe('buildQuestionsComment', () => {
  const questions: PlanQuestions = {
    blocking: [{ question: 'Which auth flow?', rationale: 'Swagger shows two' }],
    ambiguities: [
      {
        question: 'Statement format?',
        decisionTaken: 'Assumed CAMT.053',
        rationale: 'Matches the reference bank',
      },
    ],
  };

  test('lists blocking questions and decided ambiguities', () => {
    const comment = buildQuestionsComment(mockConfig(), questions, 1, false);

    expect(comment).toContain('Which auth flow?');
    expect(comment).toContain('Swagger shows two');
    expect(comment).toContain('Statement format?');
    expect(comment).toContain('Assumed CAMT.053');
    expect(comment).toContain('round 1');
  });

  test('tells the human how to resume the loop', () => {
    const comment = buildQuestionsComment(mockConfig(), questions, 1, false);
    expect(comment).toContain('create-new-comm');
    expect(comment).toContain('Re-add');
  });

  test('leads with the paused-state callout, before the questions', () => {
    const comment = buildQuestionsComment(mockConfig(), questions, 1, false);

    // The instruction is the only thing the human must act on, so it must not
    // sit below a wall of rationale where it gets skimmed past.
    expect(comment).toContain('paused and will not continue on its own');
    expect(comment.indexOf('paused and will not continue')).toBeLessThan(
      comment.indexOf('Which auth flow?'),
    );
    // Names the waiting tag so the current state is self-explanatory in ADO.
    expect(comment).toContain('create-new-comm-waiting');
    // And says when, so silence is distinguishable from a hung bot.
    expect(comment).toContain('within 5 minutes');
  });

  test('repeats the call to action after the questions', () => {
    const comment = buildQuestionsComment(mockConfig(), questions, 1, false);
    expect(comment).toContain('Nothing happens until that tag is back');
    expect(comment.indexOf('Nothing happens until that tag is back')).toBeGreaterThan(
      comment.indexOf('Which auth flow?'),
    );
  });

  test('says it will proceed on the final round', () => {
    const comment = buildQuestionsComment(mockConfig(), questions, 3, true);
    expect(comment).toContain('3 of 3');
    expect(comment).toContain('proceed on the decisions above');
    expect(comment).toContain('I will not ask again');
  });

  test('omits a section that has no entries', () => {
    const comment = buildQuestionsComment(
      mockConfig(),
      { blocking: [], ambiguities: questions.ambiguities },
      1,
      false,
    );
    expect(comment).not.toContain('Questions I need answered');
    expect(comment).toContain('Ambiguities where I made a call');
  });

  test('escapes html in question text so markup cannot break the comment', () => {
    const comment = buildQuestionsComment(
      mockConfig(),
      { blocking: [{ question: 'Use <script>alert(1)</script>?' }], ambiguities: [] },
      1,
      false,
    );
    expect(comment).not.toContain('<script>');
    expect(comment).toContain('&lt;script&gt;');
  });
});

describe('escapeHtml', () => {
  test('escapes the four dangerous characters', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('bot comment marker', () => {
  test('every comment the pipeline posts carries the marker', () => {
    const questions: PlanQuestions = {
      blocking: [{ question: 'Which auth flow?' }],
      ambiguities: [],
    };

    // A new comment type added without a marker would make staleness
    // detection permanently re-plan, so assert on every builder.
    expect(buildQuestionsComment(mockConfig(), questions, 1, false)).toContain(
      BOT_COMMENT_MARKER,
    );
    expect(buildQuestionsComment(mockConfig(), questions, 3, true)).toContain(
      BOT_COMMENT_MARKER,
    );
  });

  test('isBotComment matches only marked text', () => {
    expect(isBotComment(`<!-- new-comm-builder -->\n<b>hi</b>`)).toBe(true);
    expect(isBotComment('I answered your questions')).toBe(false);
    expect(isBotComment('')).toBe(false);
  });

  test('the marker is stripped from prompt text', () => {
    expect(htmlToText(`${BOT_COMMENT_MARKER}\nplain`)).toBe('plain');
  });
});

describe('buildImplementPrompt', () => {
  test('tells the agent the worktree may already hold partial work', () => {
    const prompt = buildImplementPrompt(
      mockConfig(),
      'work item context',
      TEST_PATHS,
      '/worktrees/banking',
      '/worktrees/setupFiles',
    );

    // A resumed implement re-enters this exact prompt on a tree that may hold
    // half the waves — it must be told to inventory before acting, not just
    // to "execute wave by wave" as if starting from scratch.
    expect(prompt).toContain('git status');
    expect(prompt).toContain('already hold partial work');
    expect(prompt).toContain('Continue the plan');
    expect(prompt).toContain('Ninja MCP');
  });
});

describe('buildWorkItemContext orchestration note', () => {
  test('names the pipeline tags so the agent does not investigate them', () => {
    const context = buildWorkItemContext(
      mockWorkItem({ fields: { 'System.Tags': 'create-new-comm' } }),
      [],
      mockConfig(),
    );

    expect(context).toContain('create-new-comm');
    expect(context).toContain('start or resume');
    expect(context).toContain('mean nothing inside the product repositories');
  });

  test('omits the note when no config is supplied', () => {
    const context = buildWorkItemContext(mockWorkItem(), []);
    expect(context).not.toContain('mean nothing inside the product repositories');
  });
});
