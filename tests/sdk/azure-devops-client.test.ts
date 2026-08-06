import { describe, test, expect, afterEach, mock } from 'bun:test';
import { mockConfig, mockWorkItem } from '../helpers.ts';
import {
  AzureDevOpsError,
  adoFetch,
  adoFetchWithRetry,
  queryWorkItems,
  getWorkItem,
  getWorkItemsBatch,
  updateWorkItemField,
  getWorkItemComments,
  addWorkItemComment,
  parseTags,
  hasTag,
  setWorkItemTags,
  swapWorkItemTags,
  getBranchTip,
  createBranch,
  createPullRequest,
  buildCloneUrl,
  buildGitAuthArgs,
  uploadAttachment,
  linkAttachmentToWorkItem,
} from '../../src/sdk/azure-devops-client.ts';

const originalFetch = globalThis.fetch;
let mockFn: ReturnType<typeof mock>;

function setMockFetch(body: unknown, status = 200, statusText = 'OK') {
  mockFn = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        statusText,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  globalThis.fetch = mockFn as unknown as typeof fetch;
}

function setSequentialMockFetch(
  ...responses: Array<{ body: unknown; status?: number }>
) {
  let callIndex = 0;
  mockFn = mock(() => {
    const r = responses[callIndex] ?? responses[responses.length - 1]!;
    callIndex++;
    return Promise.resolve(
      new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        statusText: r.status && r.status >= 400 ? 'Error' : 'OK',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  globalThis.fetch = mockFn as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('adoFetch', () => {
  test('builds the correct URL and auth header', async () => {
    setMockFetch({ hello: 'world' });
    const config = mockConfig();

    const result = await adoFetch<{ hello: string }>(config, 'some/path');

    expect(result).toEqual({ hello: 'world' });
    expect(mockFn).toHaveBeenCalledTimes(1);

    const call = mockFn.mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit;

    expect(url).toBe(
      'https://dev.azure.com/my-org/my-project/_apis/some/path',
    );

    const headers = init.headers as Record<string, string>;
    const expectedAuth =
      'Basic ' + Buffer.from(':test-pat-token').toString('base64');
    expect(headers['Authorization']).toBe(expectedAuth);
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('throws AzureDevOpsError on non-ok response', async () => {
    setMockFetch({ message: 'Not Found' }, 404, 'Not Found');
    const config = mockConfig();

    try {
      await adoFetch(config, 'missing/resource');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AzureDevOpsError);
      const adoErr = err as AzureDevOpsError;
      expect(adoErr.statusCode).toBe(404);
      expect(adoErr.name).toBe('AzureDevOpsError');
    }
  });
});

describe('adoFetchWithRetry', () => {
  test('retries on 500 and eventually succeeds', async () => {
    setSequentialMockFetch(
      { body: { error: 'Internal Server Error' }, status: 500 },
      { body: { ok: true }, status: 200 },
    );
    const config = mockConfig();

    const result = await adoFetchWithRetry<{ ok: boolean }>(
      config,
      'test/path',
      undefined,
      [0, 0, 0],
    );

    expect(result).toEqual({ ok: true });
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  test('does not retry on 404', async () => {
    setSequentialMockFetch(
      { body: { error: 'Not Found' }, status: 404 },
      { body: { ok: true }, status: 200 },
    );
    const config = mockConfig();

    try {
      await adoFetchWithRetry(config, 'test/path', undefined, [0, 0, 0]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AzureDevOpsError);
      expect((err as AzureDevOpsError).statusCode).toBe(404);
    }

    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  test('throws after exhausting retries on 500', async () => {
    setSequentialMockFetch(
      { body: { error: 'fail' }, status: 500 },
      { body: { error: 'fail' }, status: 500 },
      { body: { error: 'fail' }, status: 500 },
      { body: { error: 'fail' }, status: 500 },
    );
    const config = mockConfig();

    try {
      await adoFetchWithRetry(config, 'test/path', undefined, [0, 0, 0]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AzureDevOpsError);
      expect((err as AzureDevOpsError).statusCode).toBe(500);
    }

    expect(mockFn).toHaveBeenCalledTimes(4);
  });
});

describe('queryWorkItems', () => {
  test('posts WIQL query and returns work item IDs', async () => {
    setMockFetch({
      workItems: [
        { id: 1, url: 'https://example.com/1' },
        { id: 2, url: 'https://example.com/2' },
      ],
    });
    const config = mockConfig();

    const result = await queryWorkItems(config, "SELECT [System.Id] FROM workitems WHERE [System.State] = 'New'");

    expect(result).toEqual([1, 2]);
    const call = mockFn.mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(url).toContain('wit/wiql?api-version=7.0');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { query: string };
    expect(body.query).toBe("SELECT [System.Id] FROM workitems WHERE [System.State] = 'New'");
  });

  test('returns empty array when no work items match', async () => {
    setMockFetch({ workItems: [] });
    const config = mockConfig();

    const result = await queryWorkItems(config, "SELECT [System.Id] FROM workitems WHERE 1=0");
    expect(result).toEqual([]);
  });
});

describe('getWorkItem', () => {
  test('builds correct URL and returns work item directly', async () => {
    const workItem = {
      id: 100,
      fields: { 'System.Title': 'Some work item' },
      rev: 3,
      url: 'https://example.com/100',
    };
    setMockFetch(workItem);
    const config = mockConfig();

    const result = await getWorkItem(config, 100);

    expect(result).toEqual(workItem);
    const url = mockFn.mock.calls[0]![0] as string;
    expect(url).toContain('wit/workitems/100');
    expect(url).toContain('$expand=all');
    expect(url).toContain('api-version=7.0');
  });
});

describe('getWorkItemsBatch', () => {
  test('fetches multiple work items and returns them', async () => {
    const items = [
      { id: 1, fields: { 'System.Title': 'Item 1' }, rev: 1, url: 'https://example.com/1' },
      { id: 2, fields: { 'System.Title': 'Item 2' }, rev: 1, url: 'https://example.com/2' },
    ];
    setMockFetch({ value: items });
    const config = mockConfig();

    const result = await getWorkItemsBatch(config, [1, 2]);

    expect(result).toEqual(items);
    const url = mockFn.mock.calls[0]![0] as string;
    expect(url).toContain('wit/workitems?ids=1,2');
    expect(url).toContain('$expand=all');
    expect(url).toContain('api-version=7.0');
  });

  test('returns empty array for empty input', async () => {
    const config = mockConfig();
    const result = await getWorkItemsBatch(config, []);
    expect(result).toEqual([]);
  });
});

describe('updateWorkItemField', () => {
  test('sends PATCH with json-patch body and correct content-type', async () => {
    const updated = {
      id: 100,
      fields: { 'Custom.Field': 'New value' },
      rev: 4,
      url: 'https://example.com/100',
    };
    setMockFetch(updated);
    const config = mockConfig();

    const result = await updateWorkItemField(
      config,
      100,
      'Custom.Field',
      'New value',
    );

    expect(result).toEqual(updated);

    const call = mockFn.mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit;

    expect(url).toContain('wit/workitems/100');
    expect(url).toContain('api-version=7.0');
    expect(init.method).toBe('PATCH');

    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json-patch+json');

    const body = JSON.parse(init.body as string) as Array<{
      op: string;
      path: string;
      value: string;
    }>;
    expect(body).toEqual([
      { op: 'add', path: '/fields/Custom.Field', value: 'New value' },
    ]);
  });
});

describe('error handling', () => {
  test('404 throws AzureDevOpsError with statusCode', async () => {
    setMockFetch({ message: 'Resource not found' }, 404, 'Not Found');
    const config = mockConfig();

    try {
      await queryWorkItems(config, 'invalid');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AzureDevOpsError);
      const adoErr = err as AzureDevOpsError;
      expect(adoErr.statusCode).toBe(404);
      expect(adoErr.name).toBe('AzureDevOpsError');
      expect(adoErr.message).toContain('404');
    }
  });
});

describe('getWorkItemComments', () => {
  test('hits the preview comments endpoint and sorts oldest first', async () => {
    setMockFetch({
      totalCount: 2,
      count: 2,
      comments: [
        { id: 9, text: 'newer' },
        { id: 4, text: 'older' },
      ],
    });

    const result = await getWorkItemComments(mockConfig(), 42);

    expect(result.map((c) => c.id)).toEqual([4, 9]);
    const url = mockFn.mock.calls[0]![0] as string;
    expect(url).toContain('wit/workItems/42/comments');
    expect(url).toContain('api-version=7.0-preview.3');
  });

  test('tolerates a response with no comments array', async () => {
    setMockFetch({ totalCount: 0, count: 0 });
    const result = await getWorkItemComments(mockConfig(), 42);
    expect(result).toEqual([]);
  });
});

describe('addWorkItemComment', () => {
  test('posts the comment text', async () => {
    setMockFetch({ id: 11, text: 'hello' });

    await addWorkItemComment(mockConfig(), 42, 'hello');

    const init = mockFn.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello' });
  });
});

describe('tags', () => {
  test('parseTags splits and trims the semicolon-separated field', () => {
    const item = mockWorkItem({
      fields: { 'System.Tags': ' create-new-comm ;banking; ' },
    });
    expect(parseTags(item)).toEqual(['create-new-comm', 'banking']);
  });

  test('parseTags returns empty for a missing or blank field', () => {
    expect(parseTags(mockWorkItem({ fields: {} }))).toEqual([]);
    expect(parseTags(mockWorkItem({ fields: { 'System.Tags': '   ' } }))).toEqual([]);
  });

  test('hasTag is case-insensitive', () => {
    const item = mockWorkItem({ fields: { 'System.Tags': 'Create-New-Comm' } });
    expect(hasTag(item, 'create-new-comm')).toBe(true);
    expect(hasTag(item, 'other')).toBe(false);
  });

  test('setWorkItemTags joins with a semicolon', async () => {
    setMockFetch(mockWorkItem());
    await setWorkItemTags(mockConfig(), 42, ['a', 'b']);

    const init = mockFn.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{ value: string }>;
    expect(body[0]!.value).toBe('a; b');
  });

  test('swapWorkItemTags removes and adds without disturbing the rest', async () => {
    setMockFetch(mockWorkItem());
    const item = mockWorkItem({
      fields: { 'System.Tags': 'banking; Create-New-Comm; keep-me' },
    });

    await swapWorkItemTags(
      mockConfig(),
      item,
      ['create-new-comm'],
      ['create-new-comm-waiting'],
    );

    const init = mockFn.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{ op: string; value: string }>;
    expect(body[0]!.value).toBe('banking; keep-me; create-new-comm-waiting');
    // The op is load-bearing: ADO merges on `add`, so with `add` the computed
    // value above is correct and the removal still silently fails.
    expect(body[0]!.op).toBe('replace');
  });

  test('swapWorkItemTags falls back to add when the item has no tags yet', async () => {
    setMockFetch(mockWorkItem());
    const item = mockWorkItem({ fields: {} });

    await swapWorkItemTags(mockConfig(), item, ['create-new-comm'], ['waiting']);

    const init = mockFn.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{ op: string; value: string }>;
    // `replace` errors on a field that has never been set.
    expect(body[0]!.op).toBe('add');
    expect(body[0]!.value).toBe('waiting');
  });

  test('swapWorkItemTags does not duplicate a tag that is already present', async () => {
    setMockFetch(mockWorkItem());
    const item = mockWorkItem({ fields: { 'System.Tags': 'Waiting; banking' } });

    await swapWorkItemTags(mockConfig(), item, ['create-new-comm'], ['waiting']);

    const init = mockFn.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{ value: string }>;
    expect(body[0]!.value).toBe('Waiting; banking');
  });
});

describe('getBranchTip', () => {
  test('returns the ref and filters on the branch name', async () => {
    setMockFetch({ value: [{ name: 'refs/heads/main', objectId: 'abc123' }] });

    const ref = await getBranchTip(mockConfig(), 'repo-guid', 'main');

    expect(ref.objectId).toBe('abc123');
    const url = mockFn.mock.calls[0]![0] as string;
    expect(url).toContain('git/repositories/repo-guid/refs');
    expect(url).toContain('filter=heads/main');
  });

  test('throws when the branch does not exist', async () => {
    setMockFetch({ value: [] });
    await expect(getBranchTip(mockConfig(), 'repo-guid', 'nope')).rejects.toThrow(
      "Branch 'nope' not found",
    );
  });
});

describe('createBranch', () => {
  test('posts a ref update from the zero object id', async () => {
    setMockFetch({ value: [] });

    await createBranch(mockConfig(), 'repo-guid', 'feature/x', 'tip-sha');

    const init = mockFn.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<Record<string, string>>;
    expect(body[0]).toEqual({
      name: 'refs/heads/feature/x',
      oldObjectId: '0000000000000000000000000000000000000000',
      newObjectId: 'tip-sha',
    });
  });
});

describe('createPullRequest', () => {
  test('creates a draft PR linked to the work item', async () => {
    setMockFetch({
      pullRequestId: 4321,
      isDraft: true,
      repository: { webUrl: 'https://dev.azure.com/my-org/proj/_git/Banking' },
    });
    const config = mockConfig();

    const pr = await createPullRequest(config, config.repos.banking, {
      title: 'Add Acme Bank',
      description: '- did things',
      sourceBranch: 'Userstory/agent/42-add-acme',
      targetBranch: 'main',
      isDraft: true,
      workItemIds: [42],
      reviewerIds: ['reviewer-1'],
    });

    expect(pr.pullRequestId).toBe(4321);
    expect(pr.isDraft).toBe(true);
    expect(pr.repoKey).toBe('banking');
    expect(pr.url).toBe(
      'https://dev.azure.com/my-org/proj/_git/Banking/pullrequest/4321',
    );

    const call = mockFn.mock.calls[0]!;
    expect(call[0] as string).toContain('git/repositories/banking-guid/pullrequests');

    const body = JSON.parse((call[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body.isDraft).toBe(true);
    expect(body.sourceRefName).toBe('refs/heads/Userstory/agent/42-add-acme');
    expect(body.targetRefName).toBe('refs/heads/main');
    expect(body.workItemRefs).toEqual([{ id: '42' }]);
    expect(body.reviewers).toEqual([{ id: 'reviewer-1' }]);
  });

  test('omits workItemRefs and reviewers when there are none', async () => {
    setMockFetch({ pullRequestId: 1, isDraft: false });
    const config = mockConfig();

    await createPullRequest(config, config.repos.setupFiles, {
      title: 't',
      description: 'd',
      sourceBranch: 'b',
      targetBranch: 'main',
      isDraft: false,
      workItemIds: [],
      reviewerIds: [],
    });

    const body = JSON.parse(
      (mockFn.mock.calls[0]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty('workItemRefs');
    expect(body).not.toHaveProperty('reviewers');
  });

  test('falls back to a derived web url when the response omits one', async () => {
    setMockFetch({ pullRequestId: 7 });
    const config = mockConfig();

    const pr = await createPullRequest(config, config.repos.banking, {
      title: 't',
      description: 'd',
      sourceBranch: 'b',
      targetBranch: 'main',
      isDraft: true,
    });

    expect(pr.url).toContain('_git/Continia%20Banking/pullrequest/7');
  });
});

describe('attachments', () => {
  test('uploadAttachment posts the file name in the query', async () => {
    setMockFetch({ id: 'att-1', url: 'https://example/att-1' });
    const result = await uploadAttachment(mockConfig(), 'design doc.md', 'body');

    const url = mockFn.mock.calls[0]![0] as string;
    expect(url).toContain('wit/attachments');
    expect(url).toContain('fileName=design%20doc.md');
    expect(result.url).toBe('https://example/att-1');
  });

  test('linkAttachmentToWorkItem appends a relation', async () => {
    setMockFetch(mockWorkItem());
    await linkAttachmentToWorkItem(
      mockConfig(),
      42,
      'https://example/att-1',
      'design-doc.md',
      'Planning output',
    );

    const init = mockFn.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{
      op: string;
      path: string;
      value: { rel: string };
    }>;
    // `add` on /relations/- is an array append — genuine JSON Patch, unlike
    // System.Tags where `add` merges. Do not "fix" this to replace.
    expect(body[0]!.op).toBe('add');
    expect(body[0]!.path).toBe('/relations/-');
    expect(body[0]!.value.rel).toBe('AttachedFile');
  });
});

describe('git credentials', () => {
  test('the clone url carries no credentials', () => {
    const config = mockConfig();
    const url = buildCloneUrl(config, config.repos.banking);
    expect(url).toBe(
      'https://dev.azure.com/my-org/my-project/_git/Continia%20Banking',
    );
    expect(url).not.toContain(config.pat);
  });

  test('auth is passed per-invocation as an http.extraHeader', () => {
    const args = buildGitAuthArgs(mockConfig());
    const expected = Buffer.from(':test-pat-token').toString('base64');
    expect(args[0]).toBe('-c');
    expect(args[1]).toBe(`http.extraHeader=Authorization: Basic ${expected}`);
  });
});
