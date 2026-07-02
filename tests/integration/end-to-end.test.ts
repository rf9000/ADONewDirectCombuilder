import { describe, test, expect } from 'bun:test';
import { loadConfig } from '../../src/config/index.ts';
import { queryWorkItems, getWorkItem, getWorkItemsBatch } from '../../src/sdk/azure-devops-client.ts';

const hasCredentials = Boolean(
  process.env.AZURE_DEVOPS_PAT &&
  process.env.AZURE_DEVOPS_ORG &&
  process.env.AZURE_DEVOPS_PROJECT,
);

describe.skipIf(!hasCredentials)('Integration: Azure DevOps API', () => {
  test('can query work items via WIQL', async () => {
    const config = loadConfig();
    const ids = await queryWorkItems(config, config.wiqlQuery);
    expect(Array.isArray(ids)).toBe(true);
    if (ids.length > 0) {
      expect(ids[0]).toBeNumber();
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
