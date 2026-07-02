import { describe, test, expect, mock } from 'bun:test';
import type { AppConfig, WorkItemResponse } from '../../src/types/index.ts';
import { processItem } from '../../src/services/processor.ts';
import type { ProcessorDeps } from '../../src/services/processor.ts';

function mockConfig(): AppConfig {
  return {
    org: 'my-org',
    orgUrl: 'https://dev.azure.com/my-org',
    project: 'my-project',
    pat: 'test-pat-token',
    wiqlQuery: "SELECT [System.Id] FROM workitems WHERE [System.State] = 'New'",
    pollIntervalMinutes: 5,
    claudeModel: 'claude-sonnet-4-6',
    promptPath: './prompt.md',
    stateDir: '.state',
    dryRun: false,
  };
}

function mockWorkItem(overrides: Partial<WorkItemResponse> = {}): WorkItemResponse {
  return {
    id: 42,
    fields: {
      'System.Title': 'Fix login bug',
      'System.WorkItemType': 'Bug',
      'System.Description': 'The login page has a timeout issue.',
      'System.State': 'New',
    },
    rev: 1,
    url: 'https://example.com/42',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ProcessorDeps> = {}): ProcessorDeps {
  return {
    updateWorkItemField: mock(() =>
      Promise.resolve({
        id: 42,
        fields: {},
        rev: 2,
        url: 'https://example.com/42',
      }),
    ),
    generateWithAI: mock(() => Promise.resolve('Generated output')),
    ...overrides,
  };
}

describe('processItem', () => {
  test('generates AI output and updates work item', async () => {
    const config = mockConfig();
    const item = mockWorkItem();
    const deps = makeDeps();

    const result = await processItem(config, item, deps);

    expect(result).toEqual({ itemId: 42, processed: true });
    expect(deps.generateWithAI).toHaveBeenCalledTimes(1);
    expect(deps.updateWorkItemField).toHaveBeenCalledTimes(1);
  });

  test('passes correct context to AI generator', async () => {
    const config = mockConfig();
    const item = mockWorkItem();
    const deps = makeDeps();

    await processItem(config, item, deps);

    const genCall = (deps.generateWithAI as ReturnType<typeof mock>).mock.calls[0]!;
    const context = genCall[1];
    expect(context.itemTitle).toBe('Fix login bug');
    expect(context.itemType).toBe('Bug');
    expect(context.itemDescription).toBe('The login page has a timeout issue.');
  });

  test('returns error result when AI generation fails', async () => {
    const config = mockConfig();
    const item = mockWorkItem();
    const deps = makeDeps({
      generateWithAI: mock(() =>
        Promise.reject(new Error('Claude API error')),
      ),
    });

    const result = await processItem(config, item, deps);

    expect(result.itemId).toBe(42);
    expect(result.processed).toBe(false);
    expect(result.error).toContain('Claude API error');
    expect(deps.updateWorkItemField).toHaveBeenCalledTimes(0);
  });

  test('returns error result when update fails', async () => {
    const config = mockConfig();
    const item = mockWorkItem();
    const deps = makeDeps({
      updateWorkItemField: mock(() =>
        Promise.reject(new Error('API write error')),
      ),
    });

    const result = await processItem(config, item, deps);

    expect(result.itemId).toBe(42);
    expect(result.processed).toBe(false);
    expect(result.error).toContain('API write error');
  });

  test('dry run generates but does not update', async () => {
    const config = { ...mockConfig(), dryRun: true };
    const item = mockWorkItem();
    const deps = makeDeps();

    const result = await processItem(config, item, deps);

    expect(result).toEqual({ itemId: 42, processed: true });
    expect(deps.generateWithAI).toHaveBeenCalledTimes(1);
    expect(deps.updateWorkItemField).toHaveBeenCalledTimes(0);
  });

  test('handles missing description gracefully', async () => {
    const config = mockConfig();
    const item = mockWorkItem({
      fields: {
        'System.Title': 'No description item',
        'System.WorkItemType': 'Task',
      },
    });
    const deps = makeDeps();

    const result = await processItem(config, item, deps);

    expect(result).toEqual({ itemId: 42, processed: true });
    const genCall = (deps.generateWithAI as ReturnType<typeof mock>).mock.calls[0]!;
    expect(genCall[1].itemDescription).toBe('');
  });
});
