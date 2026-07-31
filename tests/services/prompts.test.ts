import { describe, test, expect } from 'bun:test';
import { mockConfig, mockWorkItem } from '../helpers.ts';
import {
  htmlToText,
  buildWorkItemContext,
  buildQuestionsComment,
  escapeHtml,
} from '../../src/services/prompts.ts';
import type { PlanQuestions } from '../../src/types/index.ts';

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
    expect(comment).toContain('re-add');
  });

  test('says it will proceed on the final round', () => {
    const comment = buildQuestionsComment(mockConfig(), questions, 3, true);
    expect(comment).toContain('round 3 of 3');
    expect(comment).toContain('proceed on the decisions above');
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
