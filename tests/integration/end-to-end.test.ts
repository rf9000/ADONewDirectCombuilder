import { describe, test, expect } from 'bun:test';
import { loadConfig } from '../../src/config/index.ts';
import {
  queryWorkItems,
  getWorkItem,
  getWorkItemsBatch,
  getWorkItemComments,
  getBranchTip,
  hasTag,
} from '../../src/sdk/azure-devops-client.ts';

const hasCredentials = Boolean(
  process.env.AZURE_DEVOPS_PAT &&
    process.env.AZURE_DEVOPS_ORG &&
    process.env.AZURE_DEVOPS_PROJECT,
);

describe.skipIf(!hasCredentials)('Integration: Azure DevOps API', () => {
  test('can query work items via the tag-derived WIQL', async () => {
    const config = loadConfig();
    const ids = await queryWorkItems(config, config.wiqlQuery);
    expect(Array.isArray(ids)).toBe(true);
    if (ids.length > 0) {
      expect(ids[0]).toBeNumber();
    }
  });

  test('every returned item actually carries the trigger tag', async () => {
    const config = loadConfig();
    const ids = await queryWorkItems(config, config.wiqlQuery);
    if (ids.length === 0) return;

    const items = await getWorkItemsBatch(config, ids.slice(0, 5));
    for (const item of items) {
      expect(hasTag(item, config.triggerTag)).toBe(true);
    }
  });

  test('can get work item details', async () => {
    const config = loadConfig();
    const ids = await queryWorkItems(config, config.wiqlQuery);
    if (ids.length > 0) {
      const wi = await getWorkItem(config, ids[0]!);
      expect(wi.id).toBeNumber();
      expect(wi.fields).toBeDefined();
      expect(wi.fields['System.Title']).toBeString();
    }
  });

  test('can read the comment thread', async () => {
    const config = loadConfig();
    const ids = await queryWorkItems(config, config.wiqlQuery);
    if (ids.length === 0) return;

    const comments = await getWorkItemComments(config, ids[0]!);
    expect(Array.isArray(comments)).toBe(true);
    // Oldest-first ordering is what the prompt builder relies on.
    const idsInOrder = comments.map((c) => c.id);
    expect([...idsInOrder].sort((a, b) => a - b)).toEqual(idsInOrder);
  });

  test('can batch fetch work items', async () => {
    const config = loadConfig();
    const ids = await queryWorkItems(config, config.wiqlQuery);
    if (ids.length >= 2) {
      const items = await getWorkItemsBatch(config, ids.slice(0, 2));
      expect(items.length).toBe(2);
      expect(items[0]!.id).toBeNumber();
      expect(items[1]!.id).toBeNumber();
    }
  });
});

const hasRepoIds = Boolean(
  process.env.BANKING_REPO_ID && process.env.SETUP_FILES_REPO_ID,
);

describe.skipIf(!hasCredentials || !hasRepoIds)('Integration: repositories', () => {
  test('both configured repos exist and expose their default branch', async () => {
    const config = loadConfig();

    for (const repo of [config.repos.banking, config.repos.setupFiles]) {
      const ref = await getBranchTip(config, repo.id, repo.defaultBranch);
      expect(ref.objectId).toBeString();
      expect(ref.name).toBe(`refs/heads/${repo.defaultBranch}`);
    }
  });
});
