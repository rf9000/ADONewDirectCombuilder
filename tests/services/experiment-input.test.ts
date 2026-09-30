import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mockConfig, mockWorkItem } from '../helpers.ts';
import {
  answersComment,
  extractDocLinks,
  freezeInput,
  type FreezeDeps,
} from '../../src/services/experiment-input.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'exp-input-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

const SWAGGER = 'https://example.azurecontainerapps.io/swagger/v1/swagger.json';

function deps(overrides: Partial<FreezeDeps> = {}): FreezeDeps {
  return {
    getWorkItem: async () =>
      mockWorkItem({
        fields: {
          ...mockWorkItem().fields,
          'System.Description': `<div>Docs: ${SWAGGER}</div><div>Portal: https://ponto.com/en</div>`,
        },
      }),
    getWorkItemComments: async () => [{ id: 7, text: 'first comment' }],
    resolveRemoteSha: async (_cfg, repo) => (repo.key === 'banking' ? 'aaa111' : 'bbb222'),
    fetchDoc: async () => '{"openapi":"3.0.0"}',
    ...overrides,
  };
}

describe('extractDocLinks', () => {
  test('keeps API doc links and drops ordinary pages', () => {
    expect(
      extractDocLinks(
        `<a href="${SWAGGER}">x</a> see ${SWAGGER}. and https://ponto.com/en and https://x.io/api.yaml`,
      ),
    ).toEqual([SWAGGER, 'https://x.io/api.yaml']);
  });
});

describe('answersComment', () => {
  test('survives htmlToText with angle brackets and newlines intact', () => {
    const c = answersComment('Use <iban>\nas key', '2026-09-30T00:00:00Z');
    expect(c.text).toBe('Use &lt;iban&gt;<br>as key');
    expect(c.createdBy?.displayName).toBe('Local answers (experiment)');
  });
});

describe('freezeInput', () => {
  test('writes input.json with context, SHAs and the downloaded doc', async () => {
    const frozen = await freezeInput(mockConfig(), 42, dir, {}, deps());

    expect(frozen.shas).toEqual({ banking: 'aaa111', setupFiles: 'bbb222' });
    expect(frozen.docs).toEqual([{ url: SWAGGER, file: 'doc-1.json' }]);
    expect(readFileSync(join(dir, 'input', 'docs', 'doc-1.json'), 'utf-8')).toBe('{"openapi":"3.0.0"}');
    expect(frozen.context).toContain('first comment');
    expect(frozen.context).toContain(`- ${SWAGGER} → \`.agent/input-docs/doc-1.json\``);
    expect(JSON.parse(readFileSync(join(dir, 'input.json'), 'utf-8')).shas.banking).toBe('aaa111');
  });

  test('records a failed download and leaves it out of the context', async () => {
    const frozen = await freezeInput(
      mockConfig(),
      42,
      dir,
      {},
      deps({ fetchDoc: async () => { throw new Error('timeout'); } }),
    );
    expect(frozen.docs).toEqual([{ url: SWAGGER, error: 'timeout' }]);
    expect(frozen.context).not.toContain('Local copies of linked API documentation');
    expect(existsSync(join(dir, 'input.json'))).toBe(true);
  });

  test('appends local answers as a comment and loads previous questions', async () => {
    writeFileSync(join(dir, 'answers.md'), 'Auth uses the Ponto sandbox.', 'utf-8');
    writeFileSync(
      join(dir, 'questions.json'),
      JSON.stringify({ blocking: [{ question: 'Sandbox?' }], ambiguities: [] }),
      'utf-8',
    );

    const frozen = await freezeInput(
      mockConfig(),
      42,
      dir,
      { answersFile: join(dir, 'answers.md'), questionsFile: join(dir, 'questions.json') },
      deps(),
    );

    expect(frozen.comments.at(-1)?.createdBy?.displayName).toBe('Local answers (experiment)');
    expect(frozen.context).toContain('Auth uses the Ponto sandbox.');
    expect(frozen.previousQuestions?.blocking[0]?.question).toBe('Sandbox?');
  });
});
