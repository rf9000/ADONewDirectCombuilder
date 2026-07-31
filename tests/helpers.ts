import { loadConfig } from '../src/config/index.ts';
import type { AppConfig, WorkItemResponse } from '../src/types/index.ts';

/** A fully-populated config built through loadConfig, so defaults stay in sync. */
export function mockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({
    AZURE_DEVOPS_PAT: 'test-pat-token',
    AZURE_DEVOPS_ORG: 'my-org',
    AZURE_DEVOPS_PROJECT: 'my-project',
    BANKING_REPO_ID: 'banking-guid',
    SETUP_FILES_REPO_ID: 'setup-files-guid',
  });
  return { ...base, ...overrides };
}

export function mockWorkItem(
  overrides: Partial<WorkItemResponse> = {},
): WorkItemResponse {
  return {
    id: 42,
    fields: {
      'System.Title': 'Add Acme Bank communication',
      'System.WorkItemType': 'User Story',
      'System.Description': '<div>Implement Acme Bank via OAuth.</div>',
      'System.State': 'New',
      'System.Tags': 'create-new-comm; banking',
    },
    rev: 1,
    url: 'https://example.com/42',
    ...overrides,
  };
}
