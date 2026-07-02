# Generalize Template: PR → Work Item Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all PR-specific code with generic "Item" naming and ship a concrete work item example, so the template supports pulling any Azure DevOps data.

**Architecture:** Generic core (Item types, state store, watcher) with a work item example implementation. WIQL queries replace repo-based PR listing. The processor takes a `WorkItemResponse` directly instead of a PR wrapper.

**Tech Stack:** Bun, TypeScript, Zod, @anthropic-ai/claude-agent-sdk, Azure DevOps REST API v7.0

---

### Task 1: Update types — remove PR types, add generic Item types

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Replace the types file**

Replace the entire contents of `src/types/index.ts` with:

```typescript
/** Application configuration loaded from environment variables. */
export interface AppConfig {
  org: string;
  orgUrl: string;
  project: string;
  pat: string;
  wiqlQuery: string;
  pollIntervalMinutes: number;
  claudeModel: string;
  promptPath: string;
  stateDir: string;
  dryRun: boolean;
}

/** Response shape when fetching a single work item. */
export interface WorkItemResponse {
  id: number;
  fields: Record<string, unknown>;
  rev: number;
  url: string;
}

/** Response shape from a WIQL query. */
export interface WiqlQueryResult {
  workItems: Array<{ id: number; url: string }>;
}

/** Persisted state tracking which items have already been processed. */
export interface ProcessedState {
  processedItemIds: number[];
  lastRunAt: string;
}

/** Result summary after processing a single item. */
export interface ItemProcessResult {
  itemId: number;
  processed: boolean;
  error?: string;
}
```

**Step 2: Run typecheck to see what breaks**

Run: `bun run typecheck`
Expected: Many errors in files still referencing old types. This is expected — we fix them in subsequent tasks.

**Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "refactor: replace PR-specific types with generic Item types"
```

---

### Task 2: Update config — replace repoIds with wiqlQuery

**Files:**
- Modify: `src/config/index.ts`
- Modify: `tests/config/config.test.ts`
- Modify: `.env.example`

**Step 1: Write the updated config tests**

Replace `tests/config/config.test.ts` with:

```typescript
import { describe, expect, it } from "bun:test";
import { loadConfig } from "../../src/config/index.ts";

const validEnv: Record<string, string> = {
  AZURE_DEVOPS_PAT: "test-pat-token",
  AZURE_DEVOPS_ORG: "my-org",
  AZURE_DEVOPS_PROJECT: "my-project",
};

describe("loadConfig", () => {
  it("returns correct AppConfig for valid env", () => {
    const config = loadConfig(validEnv);

    expect(config.pat).toBe("test-pat-token");
    expect(config.org).toBe("my-org");
    expect(config.orgUrl).toBe("https://dev.azure.com/my-org");
    expect(config.project).toBe("my-project");
  });

  it("throws when AZURE_DEVOPS_PAT is missing", () => {
    const env = { ...validEnv };
    delete env.AZURE_DEVOPS_PAT;
    expect(() => loadConfig(env)).toThrow("Invalid configuration");
  });

  it("throws when AZURE_DEVOPS_ORG is missing", () => {
    const env = { ...validEnv };
    delete env.AZURE_DEVOPS_ORG;
    expect(() => loadConfig(env)).toThrow("Invalid configuration");
  });

  it("throws when AZURE_DEVOPS_PROJECT is missing", () => {
    const env = { ...validEnv };
    delete env.AZURE_DEVOPS_PROJECT;
    expect(() => loadConfig(env)).toThrow("Invalid configuration");
  });

  it("applies default values when optional vars are absent", () => {
    const config = loadConfig(validEnv);

    expect(config.pollIntervalMinutes).toBe(15);
    expect(config.claudeModel).toBe("claude-sonnet-4-6");
    expect(config.promptPath).toBe(".claude/commands/do-process-item.md");
    expect(config.stateDir).toBe(".state");
  });

  it("uses default WIQL query when not provided", () => {
    const config = loadConfig(validEnv);
    expect(config.wiqlQuery).toContain("SELECT [System.Id] FROM workitems");
  });

  it("uses custom WIQL query when provided", () => {
    const env = {
      ...validEnv,
      AZURE_DEVOPS_WIQL_QUERY: "SELECT [System.Id] FROM workitems WHERE [System.State] = 'Active'",
    };
    const config = loadConfig(env);
    expect(config.wiqlQuery).toBe(
      "SELECT [System.Id] FROM workitems WHERE [System.State] = 'Active'",
    );
  });

  it("overrides defaults when optional vars are provided", () => {
    const env = {
      ...validEnv,
      POLL_INTERVAL_MINUTES: "30",
      CLAUDE_MODEL: "claude-opus-4-6",
      PROMPT_PATH: "custom/prompt.md",
      STATE_DIR: "/tmp/state",
    };

    const config = loadConfig(env);

    expect(config.pollIntervalMinutes).toBe(30);
    expect(config.claudeModel).toBe("claude-opus-4-6");
    expect(config.promptPath).toBe("custom/prompt.md");
    expect(config.stateDir).toBe("/tmp/state");
  });

  it("derives orgUrl from org name", () => {
    const env = { ...validEnv, AZURE_DEVOPS_ORG: "contoso" };
    const config = loadConfig(env);
    expect(config.orgUrl).toBe("https://dev.azure.com/contoso");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/config/config.test.ts`
Expected: FAIL — `repoIds` still in config, `wiqlQuery` not yet added.

**Step 3: Update config source**

Replace `src/config/index.ts` with:

```typescript
import { z } from "zod";
import type { AppConfig } from "../types/index.ts";

const DEFAULT_WIQL = "SELECT [System.Id] FROM workitems WHERE [System.State] = 'New' ORDER BY [System.CreatedDate] DESC";

const envSchema = z.object({
  AZURE_DEVOPS_PAT: z.string().min(1, "AZURE_DEVOPS_PAT is required"),
  AZURE_DEVOPS_ORG: z.string().min(1, "AZURE_DEVOPS_ORG is required"),
  AZURE_DEVOPS_PROJECT: z.string().min(1, "AZURE_DEVOPS_PROJECT is required"),
  AZURE_DEVOPS_WIQL_QUERY: z.string().default(DEFAULT_WIQL),
  POLL_INTERVAL_MINUTES: z.coerce.number().default(15),
  CLAUDE_MODEL: z.string().default("claude-sonnet-4-6"),
  PROMPT_PATH: z.string().default(".claude/commands/do-process-item.md"),
  STATE_DIR: z.string().default(".state"),
});

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${messages}`);
  }

  const parsed = result.data;

  return {
    org: parsed.AZURE_DEVOPS_ORG,
    orgUrl: `https://dev.azure.com/${parsed.AZURE_DEVOPS_ORG}`,
    project: parsed.AZURE_DEVOPS_PROJECT,
    pat: parsed.AZURE_DEVOPS_PAT,
    wiqlQuery: parsed.AZURE_DEVOPS_WIQL_QUERY,
    pollIntervalMinutes: parsed.POLL_INTERVAL_MINUTES,
    claudeModel: parsed.CLAUDE_MODEL,
    promptPath: parsed.PROMPT_PATH,
    stateDir: parsed.STATE_DIR,
    dryRun: false,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/config/config.test.ts`
Expected: PASS

**Step 5: Update .env.example**

Replace `.env.example` with:

```
# Azure DevOps Configuration (required)
AZURE_DEVOPS_PAT=your-pat-here
AZURE_DEVOPS_ORG=your-org-name
AZURE_DEVOPS_PROJECT=your-project-name

# Optional: WIQL query to find items to process
# Default: SELECT [System.Id] FROM workitems WHERE [System.State] = 'New' ORDER BY [System.CreatedDate] DESC
# AZURE_DEVOPS_WIQL_QUERY=SELECT [System.Id] FROM workitems WHERE [System.AreaPath] UNDER 'MyProject\MyTeam' AND [System.State] = 'New'

# Optional: Polling interval in minutes (default: 15)
# POLL_INTERVAL_MINUTES=15

# Optional: Claude model to use (default: claude-sonnet-4-6)
# CLAUDE_MODEL=claude-sonnet-4-6

# Optional: Path to AI prompt file (default: .claude/commands/do-process-item.md)
# PROMPT_PATH=.claude/commands/do-process-item.md

# Optional: State file directory (default: .state)
# STATE_DIR=.state
```

**Step 6: Commit**

```bash
git add src/config/index.ts tests/config/config.test.ts .env.example
git commit -m "refactor: replace repoIds config with wiqlQuery"
```

---

### Task 3: Update SDK — remove PR functions, add WIQL query + batch fetch

**Files:**
- Modify: `src/sdk/azure-devops-client.ts`
- Modify: `tests/sdk/azure-devops-client.test.ts`

**Step 1: Write the updated SDK tests**

Replace `tests/sdk/azure-devops-client.test.ts` with:

```typescript
import { describe, test, expect, afterEach, mock } from 'bun:test';
import type { AppConfig } from '../../src/types/index.ts';
import {
  AzureDevOpsError,
  adoFetch,
  adoFetchWithRetry,
  queryWorkItems,
  getWorkItem,
  getWorkItemsBatch,
  updateWorkItemField,
} from '../../src/sdk/azure-devops-client.ts';

const originalFetch = globalThis.fetch;
let mockFn: ReturnType<typeof mock>;

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
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/sdk/azure-devops-client.test.ts`
Expected: FAIL — `queryWorkItems` and `getWorkItemsBatch` don't exist yet.

**Step 3: Update SDK source**

Replace `src/sdk/azure-devops-client.ts` with:

```typescript
import type {
  AppConfig,
  WorkItemResponse,
  WiqlQueryResult,
} from '../types/index.ts';

export class AzureDevOpsError extends Error {
  override readonly name = 'AzureDevOpsError';
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function adoFetch<T>(
  config: AppConfig,
  path: string,
  options?: RequestInit,
): Promise<T> {
  const url = `${config.orgUrl}/${config.project}/_apis/${path}`;
  const authHeader =
    'Basic ' + Buffer.from(':' + config.pat).toString('base64');

  const headers: Record<string, string> = {
    Authorization: authHeader,
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> | undefined),
  };

  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new AzureDevOpsError(
      `Azure DevOps API error ${res.status}: ${body}`,
      res.status,
    );
  }

  return (await res.json()) as T;
}

const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000];

export async function adoFetchWithRetry<T>(
  config: AppConfig,
  path: string,
  options?: RequestInit,
  retryDelays: number[] = DEFAULT_RETRY_DELAYS,
): Promise<T> {
  const maxAttempts = retryDelays.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await adoFetch<T>(config, path, options);
    } catch (err: unknown) {
      const isLastAttempt = attempt === maxAttempts;

      if (err instanceof AzureDevOpsError) {
        if (err.statusCode < 500) {
          throw err;
        }
        if (isLastAttempt) {
          throw err;
        }
      } else {
        if (isLastAttempt) {
          throw err;
        }
      }

      const delay = retryDelays[attempt - 1] ?? 0;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new Error('adoFetchWithRetry: unexpected code path');
}

export async function queryWorkItems(
  config: AppConfig,
  wiql: string,
): Promise<number[]> {
  const path = 'wit/wiql?api-version=7.0';
  const data = await adoFetchWithRetry<WiqlQueryResult>(config, path, {
    method: 'POST',
    body: JSON.stringify({ query: wiql }),
  });
  return data.workItems.map((wi) => wi.id);
}

export async function getWorkItem(
  config: AppConfig,
  workItemId: number,
): Promise<WorkItemResponse> {
  const path = `wit/workitems/${workItemId}?$expand=all&api-version=7.0`;
  return adoFetchWithRetry<WorkItemResponse>(config, path);
}

export async function getWorkItemsBatch(
  config: AppConfig,
  ids: number[],
): Promise<WorkItemResponse[]> {
  if (ids.length === 0) return [];
  const idList = ids.join(',');
  const path = `wit/workitems?ids=${idList}&$expand=all&api-version=7.0`;
  const data = await adoFetchWithRetry<{ value: WorkItemResponse[] }>(
    config,
    path,
  );
  return data.value;
}

export async function updateWorkItemField(
  config: AppConfig,
  workItemId: number,
  fieldName: string,
  value: string,
): Promise<WorkItemResponse> {
  const path = `wit/workitems/${workItemId}?api-version=7.0`;
  return adoFetchWithRetry<WorkItemResponse>(config, path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json-patch+json' },
    body: JSON.stringify([{ op: 'add', path: `/fields/${fieldName}`, value }]),
  });
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/sdk/azure-devops-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/sdk/azure-devops-client.ts tests/sdk/azure-devops-client.test.ts
git commit -m "refactor: replace PR SDK functions with WIQL query and batch fetch"
```

---

### Task 4: Update state store — rename processedPRIds to processedItemIds

**Files:**
- Modify: `src/state/state-store.ts`
- Modify: `tests/state/state-store.test.ts`

**Step 1: Update state store tests**

Replace `tests/state/state-store.test.ts` with:

```typescript
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StateStore } from '../../src/state/state-store.ts';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'state-store-test-'));
}

describe('StateStore', () => {
  it('save + load roundtrip preserves processed items', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    store.markProcessed(101);
    store.markProcessed(202);
    store.markProcessed(303);
    store.save();

    const store2 = new StateStore(dir);

    expect(store2.isProcessed(101)).toBe(true);
    expect(store2.isProcessed(202)).toBe(true);
    expect(store2.isProcessed(303)).toBe(true);
    expect(store2.processedCount).toBe(3);
  });

  it('starts empty when the state file does not exist', () => {
    const dir = makeTmpDir();
    const subDir = join(dir, 'nonexistent', 'nested');
    const store = new StateStore(subDir);

    expect(store.processedCount).toBe(0);
    expect(store.isProcessed(1)).toBe(false);
  });

  it('starts fresh when the state file contains corrupt JSON', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'processed-items.json');
    writeFileSync(filePath, '{{not valid json!!!', 'utf-8');

    const store = new StateStore(dir);

    expect(store.processedCount).toBe(0);
    expect(store.isProcessed(1)).toBe(false);
  });

  it('does not duplicate when marking the same item twice', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    store.markProcessed(42);
    store.markProcessed(42);

    expect(store.processedCount).toBe(1);
  });

  it('isProcessed returns false for unprocessed IDs', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    store.markProcessed(1);

    expect(store.isProcessed(1)).toBe(true);
    expect(store.isProcessed(2)).toBe(false);
    expect(store.isProcessed(999)).toBe(false);
  });

  it('reset clears all state and persists the empty state', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    store.markProcessed(10);
    store.markProcessed(20);
    store.save();

    store.reset();

    expect(store.processedCount).toBe(0);
    expect(store.isProcessed(10)).toBe(false);
    expect(store.isProcessed(20)).toBe(false);

    const store2 = new StateStore(dir);
    expect(store2.processedCount).toBe(0);
  });

  it('processedCount returns the correct count', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    expect(store.processedCount).toBe(0);

    store.markProcessed(1);
    expect(store.processedCount).toBe(1);

    store.markProcessed(2);
    expect(store.processedCount).toBe(2);

    store.markProcessed(3);
    expect(store.processedCount).toBe(3);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/state/state-store.test.ts`
Expected: FAIL — corrupt JSON test looks for `processed-items.json` but store still writes `processed-prs.json`.

**Step 3: Update state store source**

Replace `src/state/state-store.ts` with:

```typescript
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import type { ProcessedState } from '../types/index.ts';

export class StateStore {
  private filePath: string;
  private state: ProcessedState;
  private processedSet: Set<number>;

  constructor(stateDir: string) {
    this.filePath = join(stateDir, 'processed-items.json');
    this.state = this.load();
    this.processedSet = new Set(this.state.processedItemIds);
  }

  private load(): ProcessedState {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'processedItemIds' in parsed &&
          Array.isArray((parsed as ProcessedState).processedItemIds)
        ) {
          return parsed as ProcessedState;
        }
      }
    } catch {
      // file doesn't exist or is corrupted JSON — start fresh
    }
    return { processedItemIds: [], lastRunAt: '' };
  }

  save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.state.lastRunAt = new Date().toISOString();
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  isProcessed(itemId: number): boolean {
    return this.processedSet.has(itemId);
  }

  markProcessed(itemId: number): void {
    if (!this.processedSet.has(itemId)) {
      this.processedSet.add(itemId);
      this.state.processedItemIds.push(itemId);
    }
  }

  reset(): void {
    this.state = { processedItemIds: [], lastRunAt: '' };
    this.processedSet = new Set();
    this.save();
  }

  get processedCount(): number {
    return this.state.processedItemIds.length;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/state/state-store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/state/state-store.ts tests/state/state-store.test.ts
git commit -m "refactor: rename processedPRIds to processedItemIds in state store"
```

---

### Task 5: Update AI generator — replace PR context with work item context

**Files:**
- Modify: `src/services/ai-generator.ts`
- Modify: `tests/services/ai-generator.test.ts`

**Step 1: Write updated AI generator tests**

Replace `tests/services/ai-generator.test.ts` with:

```typescript
import { describe, test, expect } from 'bun:test';
import { buildUserPrompt } from '../../src/services/ai-generator.ts';
import type { GeneratorContext } from '../../src/services/ai-generator.ts';

describe('buildUserPrompt', () => {
  const baseContext: GeneratorContext = {
    itemTitle: 'Login times out too quickly',
    itemType: 'Bug',
    itemDescription: 'Users report that the login page times out after 5 seconds.',
    itemFields: {
      'System.State': 'New',
      'System.AreaPath': 'MyProject\\Auth',
    },
  };

  test('includes work item title', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).toContain('**Title:** Login times out too quickly');
  });

  test('includes work item type', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).toContain('**Type:** Bug');
  });

  test('includes description when present', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).toContain('**Description:** Users report that the login page times out after 5 seconds.');
  });

  test('omits description when empty', () => {
    const prompt = buildUserPrompt({ ...baseContext, itemDescription: '' });
    expect(prompt).not.toContain('**Description:**');
  });

  test('includes fields section', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).toContain('## Fields');
    expect(prompt).toContain('- **System.State:** New');
    expect(prompt).toContain('- **System.AreaPath:** MyProject\\Auth');
  });

  test('omits fields section when empty', () => {
    const prompt = buildUserPrompt({ ...baseContext, itemFields: {} });
    expect(prompt).not.toContain('## Fields');
  });

  test('includes all sections in order', () => {
    const prompt = buildUserPrompt(baseContext);
    const wiSection = prompt.indexOf('## Work Item');
    const fieldsSection = prompt.indexOf('## Fields');
    expect(wiSection).toBeLessThan(fieldsSection);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/services/ai-generator.test.ts`
Expected: FAIL — `GeneratorContext` still has `prTitle`/`prDescription`.

**Step 3: Update AI generator source**

Replace `src/services/ai-generator.ts` with:

```typescript
import { readFileSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AppConfig } from '../types/index.ts';

export interface GeneratorContext {
  itemTitle: string;
  itemType: string;
  itemDescription: string;
  itemFields: Record<string, unknown>;
}

export async function generateWithAI(
  config: AppConfig,
  context: GeneratorContext,
): Promise<string> {
  const systemPrompt = readFileSync(config.promptPath, 'utf-8');
  const userPrompt = buildUserPrompt(context);

  let result: string | undefined;

  for await (const message of query({
    prompt: userPrompt,
    options: {
      model: config.claudeModel,
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt,
    },
  })) {
    if (message.type === 'result' && message.subtype === 'success') {
      result = message.result;
    }
  }

  if (result === undefined) {
    throw new Error('No result received from Claude Agent SDK');
  }

  return result.trim();
}

export function buildUserPrompt(context: GeneratorContext): string {
  const lines: string[] = [
    `## Work Item`,
    `**Type:** ${context.itemType}`,
    `**Title:** ${context.itemTitle}`,
  ];

  if (context.itemDescription) {
    lines.push(`**Description:** ${context.itemDescription}`);
  }

  const fieldEntries = Object.entries(context.itemFields);
  if (fieldEntries.length > 0) {
    lines.push('', '## Fields');
    for (const [key, value] of fieldEntries) {
      lines.push(`- **${key}:** ${String(value)}`);
    }
  }

  return lines.join('\n');
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/services/ai-generator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/ai-generator.ts tests/services/ai-generator.test.ts
git commit -m "refactor: update AI generator context from PR fields to work item fields"
```

---

### Task 6: Update processor — rename processPR to processItem

**Files:**
- Modify: `src/services/processor.ts`
- Modify: `tests/services/processor.test.ts`

**Step 1: Write updated processor tests**

Replace `tests/services/processor.test.ts` with:

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/services/processor.test.ts`
Expected: FAIL — `processItem` doesn't exist yet.

**Step 3: Update processor source**

Replace `src/services/processor.ts` with:

```typescript
import type {
  AppConfig,
  WorkItemResponse,
  ItemProcessResult,
} from '../types/index.ts';
import type { GeneratorContext } from './ai-generator.ts';

import * as sdk from '../sdk/azure-devops-client.ts';
import * as gen from './ai-generator.ts';

export interface ProcessorDeps {
  updateWorkItemField: (
    config: AppConfig,
    workItemId: number,
    fieldName: string,
    value: string,
  ) => Promise<WorkItemResponse>;

  generateWithAI: (
    config: AppConfig,
    context: GeneratorContext,
  ) => Promise<string>;
}

const defaultDeps: ProcessorDeps = {
  updateWorkItemField: sdk.updateWorkItemField,
  generateWithAI: gen.generateWithAI,
};

function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

// TODO: Replace this stub with your project-specific processing logic.
// This example processes work items found via WIQL query and generates
// AI-powered summaries. Adapt the field checks, generation context, and
// update logic to match your use case.

export async function processItem(
  config: AppConfig,
  item: WorkItemResponse,
  deps: ProcessorDeps = defaultDeps,
): Promise<ItemProcessResult> {
  log(`Processing item #${item.id}: ${String(item.fields['System.Title'] ?? '(untitled)')}`);

  const context: GeneratorContext = {
    itemTitle: String(item.fields['System.Title'] ?? ''),
    itemType: String(item.fields['System.WorkItemType'] ?? ''),
    itemDescription: String(item.fields['System.Description'] ?? ''),
    itemFields: Object.fromEntries(
      Object.entries(item.fields).filter(
        ([key]) =>
          !['System.Title', 'System.WorkItemType', 'System.Description'].includes(key),
      ),
    ),
  };

  try {
    log(`  Item #${item.id}: Generating AI output...`);
    const output = await deps.generateWithAI(config, context);

    if (config.dryRun) {
      log(`  Item #${item.id}: [DRY RUN] Generated:\n    "${output}"`);
      return { itemId: item.id, processed: true };
    }

    // TODO: Replace 'System.Description' with the field you want to update
    await deps.updateWorkItemField(
      config,
      item.id,
      'System.Description',
      output,
    );
    log(`  Item #${item.id}: Output written`);
    return { itemId: item.id, processed: true };
  } catch (err) {
    log(`  Item #${item.id}: Error — ${err}`);
    return { itemId: item.id, processed: false, error: String(err) };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/services/processor.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/processor.ts tests/services/processor.test.ts
git commit -m "refactor: rename processPR to processItem, simplify to work item processing"
```

---

### Task 7: Update watcher — use WIQL query instead of repo iteration

**Files:**
- Modify: `src/services/watcher.ts`
- Modify: `tests/services/watcher.test.ts`

**Step 1: Write updated watcher tests**

Replace `tests/services/watcher.test.ts` with:

```typescript
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AppConfig, WorkItemResponse } from '../../src/types/index.ts';
import { runPollCycle } from '../../src/services/watcher.ts';
import type { WatcherDeps } from '../../src/services/watcher.ts';
import { StateStore } from '../../src/state/state-store.ts';

function mockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
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
    ...overrides,
  };
}

function mockWorkItem(overrides: Partial<WorkItemResponse> = {}): WorkItemResponse {
  return {
    id: 42,
    fields: {
      'System.Title': 'Test work item',
      'System.WorkItemType': 'Bug',
      'System.Description': 'A test work item.',
      'System.State': 'New',
    },
    rev: 1,
    url: 'https://example.com/42',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<WatcherDeps> = {}): WatcherDeps {
  return {
    fetchItems: mock(() => Promise.resolve([])),
    processItem: mock(() =>
      Promise.resolve({ itemId: 0, processed: true }),
    ),
    ...overrides,
  };
}

describe('runPollCycle', () => {
  let tmpDir: string;
  let stateStore: StateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'watcher-test-'));
    stateStore = new StateStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('no items returns all zeros', async () => {
    const config = mockConfig();
    const deps = makeDeps();

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 0, errors: 0 });
    expect(deps.fetchItems).toHaveBeenCalledTimes(1);
    expect(deps.processItem).toHaveBeenCalledTimes(0);
  });

  test('new item calls processItem, marks as processed, and saves state', async () => {
    const config = mockConfig();
    const item = mockWorkItem({ id: 101 });

    const deps = makeDeps({
      fetchItems: mock(() => Promise.resolve([item])),
      processItem: mock(() =>
        Promise.resolve({ itemId: 101, processed: true }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 1, errors: 0 });
    expect(deps.processItem).toHaveBeenCalledTimes(1);
    expect(stateStore.isProcessed(101)).toBe(true);

    const reloadedStore = new StateStore(tmpDir);
    expect(reloadedStore.isProcessed(101)).toBe(true);
  });

  test('already processed item is filtered out', async () => {
    const config = mockConfig();
    const item = mockWorkItem({ id: 200 });

    stateStore.markProcessed(200);
    stateStore.save();

    const deps = makeDeps({
      fetchItems: mock(() => Promise.resolve([item])),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 0, errors: 0 });
    expect(deps.processItem).toHaveBeenCalledTimes(0);
  });

  test('processItem throws: item not marked as processed, error counted', async () => {
    const config = mockConfig();
    const item = mockWorkItem({ id: 300 });

    const deps = makeDeps({
      fetchItems: mock(() => Promise.resolve([item])),
      processItem: mock(() => Promise.reject(new Error('Fatal processing error'))),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 0, errors: 1 });
    expect(stateStore.isProcessed(300)).toBe(false);
  });

  test('processItem returns error result: item not marked as processed', async () => {
    const config = mockConfig();
    const item = mockWorkItem({ id: 400 });

    const deps = makeDeps({
      fetchItems: mock(() => Promise.resolve([item])),
      processItem: mock(() =>
        Promise.resolve({ itemId: 400, processed: false, error: 'AI failed' }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 0, errors: 1 });
    expect(stateStore.isProcessed(400)).toBe(false);
  });

  test('multiple items processes each one', async () => {
    const config = mockConfig();
    const item1 = mockWorkItem({ id: 501 });
    const item2 = mockWorkItem({ id: 502 });
    const item3 = mockWorkItem({ id: 503 });

    const deps = makeDeps({
      fetchItems: mock(() => Promise.resolve([item1, item2, item3])),
      processItem: mock((cfg: AppConfig, item: WorkItemResponse) =>
        Promise.resolve({ itemId: item.id, processed: true }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 3, errors: 0 });
    expect(deps.fetchItems).toHaveBeenCalledTimes(1);
    expect(deps.processItem).toHaveBeenCalledTimes(3);
    expect(stateStore.isProcessed(501)).toBe(true);
    expect(stateStore.isProcessed(502)).toBe(true);
    expect(stateStore.isProcessed(503)).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/services/watcher.test.ts`
Expected: FAIL — `WatcherDeps` still has PR types.

**Step 3: Update watcher source**

Replace `src/services/watcher.ts` with:

```typescript
import type {
  AppConfig,
  WorkItemResponse,
  ItemProcessResult,
} from '../types/index.ts';
import { StateStore } from '../state/state-store.ts';
import * as sdk from '../sdk/azure-devops-client.ts';
import * as proc from './processor.ts';

export interface WatcherDeps {
  fetchItems: (
    config: AppConfig,
  ) => Promise<WorkItemResponse[]>;

  processItem: (
    config: AppConfig,
    item: WorkItemResponse,
  ) => Promise<ItemProcessResult>;
}

async function defaultFetchItems(config: AppConfig): Promise<WorkItemResponse[]> {
  const ids = await sdk.queryWorkItems(config, config.wiqlQuery);
  if (ids.length === 0) return [];
  return sdk.getWorkItemsBatch(config, ids);
}

const defaultDeps: WatcherDeps = {
  fetchItems: defaultFetchItems,
  processItem: proc.processItem,
};

function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

export async function runPollCycle(
  config: AppConfig,
  stateStore: StateStore,
  deps: WatcherDeps = defaultDeps,
): Promise<{ processed: number; errors: number }> {
  let totalProcessed = 0;
  let totalErrors = 0;

  log('Polling for items...');

  const items = await deps.fetchItems(config);
  const newItems = items.filter(item => !stateStore.isProcessed(item.id));

  log(`  Found ${items.length} items, ${newItems.length} unprocessed`);

  for (const item of newItems) {
    try {
      const result = await deps.processItem(config, item);

      if (result.processed) {
        stateStore.markProcessed(item.id);
        totalProcessed++;
      } else {
        totalErrors++;
      }
    } catch (err) {
      log(`  Item #${item.id}: Fatal error — ${err}`);
      totalErrors++;
    }
  }

  stateStore.save();
  return { processed: totalProcessed, errors: totalErrors };
}

function sleep(ms: number, signal: { aborted: boolean }): Promise<void> {
  return new Promise(resolve => {
    const checkInterval = 1000;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += checkInterval;
      if (signal.aborted || elapsed >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, checkInterval);
  });
}

export async function startWatcher(config: AppConfig): Promise<void> {
  const stateStore = new StateStore(config.stateDir);
  const signal = { aborted: false };

  const shutdown = () => {
    log('Shutting down...');
    signal.aborted = true;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log(`Starting watcher — polling every ${config.pollIntervalMinutes} minutes`);
  log(`${stateStore.processedCount} items already processed`);

  while (!signal.aborted) {
    try {
      const result = await runPollCycle(config, stateStore);
      log(`Cycle complete: ${result.processed} processed, ${result.errors} errors`);
    } catch (err) {
      log(`Cycle failed: ${err}`);
    }

    if (!signal.aborted) {
      log(`Sleeping ${config.pollIntervalMinutes} minutes...`);
      await sleep(config.pollIntervalMinutes * 60 * 1000, signal);
    }
  }

  log('Watcher stopped');
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/services/watcher.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/watcher.ts tests/services/watcher.test.ts
git commit -m "refactor: update watcher to use WIQL query instead of repo-based PR listing"
```

---

### Task 8: Update CLI — rename test-pr to test-item

**Files:**
- Modify: `src/cli/index.ts`

**Step 1: Replace CLI source**

Replace `src/cli/index.ts` with:

```typescript
#!/usr/bin/env bun

import { loadConfig } from '../config/index.ts';
import { startWatcher, runPollCycle } from '../services/watcher.ts';
import { StateStore } from '../state/state-store.ts';
import { getWorkItem } from '../sdk/azure-devops-client.ts';
import { processItem } from '../services/processor.ts';

const HELP = `
DevOps Pull Template

Usage:
  devops-pull <command>

Commands:
  watch            Start the long-running watcher (polls every N minutes)
  run-once         Run a single poll cycle and exit
  test-item <id>   Process a single work item (dry-run, no writes)
  reset-state      Clear the processed item state and exit
  help             Show this help message

Options:
  --dry-run        Read-only mode: generate but skip Azure DevOps writes

Environment variables:
  AZURE_DEVOPS_PAT          Azure DevOps personal access token (required)
  AZURE_DEVOPS_ORG          Azure DevOps organization name (required)
  AZURE_DEVOPS_PROJECT      Azure DevOps project name (required)
  AZURE_DEVOPS_WIQL_QUERY   WIQL query to find items (optional, has default)
  POLL_INTERVAL_MINUTES     Polling interval (default: 15)
  CLAUDE_MODEL              Claude model to use (default: claude-sonnet-4-6)
  PROMPT_PATH               Path to prompt file (default: .claude/commands/do-process-item.md)
  STATE_DIR                 State directory (default: .state)
`.trim();

const command = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

switch (command) {
  case 'watch': {
    const config = loadConfig();
    config.dryRun = dryRun;
    if (dryRun) console.log('[DRY RUN] No writes will be made to Azure DevOps\n');
    await startWatcher(config);
    break;
  }

  case 'run-once': {
    const config = loadConfig();
    config.dryRun = dryRun;
    if (dryRun) console.log('[DRY RUN] No writes will be made to Azure DevOps\n');
    const stateStore = new StateStore(config.stateDir);
    const result = await runPollCycle(config, stateStore);
    console.log(`Done: ${result.processed} processed, ${result.errors} errors`);
    break;
  }

  case 'test-item': {
    const itemIdArg = process.argv[3];
    if (!itemIdArg || isNaN(Number(itemIdArg))) {
      console.error('Usage: devops-pull test-item <work-item-id>');
      process.exitCode = 1;
      break;
    }
    const config = loadConfig();
    config.dryRun = true;
    console.log(`[DRY RUN] Testing processing for work item #${itemIdArg}\n`);
    const item = await getWorkItem(config, Number(itemIdArg));
    const result = await processItem(config, item);
    console.log(`\nDone: ${result.processed ? 'processed' : 'failed'}${result.error ? ` (${result.error})` : ''}`);
    break;
  }

  case 'reset-state': {
    const config = loadConfig();
    const stateStore = new StateStore(config.stateDir);
    stateStore.reset();
    console.log('State has been reset');
    break;
  }

  case 'help':
  default:
    console.log(HELP);
    break;
}
```

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/cli/index.ts
git commit -m "refactor: rename test-pr CLI command to test-item"
```

---

### Task 9: Update integration tests

**Files:**
- Modify: `tests/integration/end-to-end.test.ts`

**Step 1: Replace integration test**

Replace `tests/integration/end-to-end.test.ts` with:

```typescript
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
```

**Step 2: Run unit tests to make sure nothing is broken**

Run: `bun test tests/config/ tests/sdk/ tests/state/ tests/services/`
Expected: PASS (all unit tests green)

**Step 3: Commit**

```bash
git add tests/integration/end-to-end.test.ts
git commit -m "refactor: update integration tests for work item WIQL queries"
```

---

### Task 10: Update documentation — README, CLAUDE.md, PATTERNS.md, prompt file

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `PATTERNS.md`
- Modify: `.claude/commands/do-process-item.md`

**Step 1: Replace README.md**

```markdown
# DevOpsPullTemplate

A GitHub template repository for building Azure DevOps automation projects with Bun, TypeScript, Zod, and Claude AI.

## What is this?

This template provides production-ready scaffolding for projects that:
- Periodically pull data from Azure DevOps (work items, or any entity via WIQL)
- Process items with AI using Claude
- Push results back to Azure DevOps (update fields, add comments, etc.)
- Track state to avoid reprocessing
- Run as a watcher (continuous polling) or on-demand (single run)

## Getting started

1. Click **"Use this template"** on GitHub to create a new repository
2. Clone your new repo and install dependencies:
   ```bash
   git clone <your-repo-url>
   cd <your-repo>
   bun install
   ```
3. Copy `.env.example` to `.env` and fill in your Azure DevOps credentials:
   ```bash
   cp .env.example .env
   ```
4. Run tests to verify everything works:
   ```bash
   bun test
   ```
5. Try the CLI:
   ```bash
   bun src/cli/index.ts help
   bun src/cli/index.ts run-once --dry-run
   ```

## Customizing for your project

1. **Update `package.json`** — change the `name` field
2. **Update `.env.example`** — add any project-specific env vars
3. **Customize the WIQL query** — set `AZURE_DEVOPS_WIQL_QUERY` to find the items you want to process
4. **Replace the processor** — edit `src/services/processor.ts` with your business logic
5. **Replace the AI prompt** — edit `.claude/commands/do-process-item.md`
6. **Update types** — add project-specific interfaces to `src/types/index.ts`
7. **Update this README** — describe what your project does

## Project structure

```
src/
├── cli/index.ts              # CLI entry point (watch, run-once, test-item, reset-state)
├── config/index.ts           # Zod-based environment variable validation
├── sdk/azure-devops-client.ts # Azure DevOps REST API client with retry
├── services/
│   ├── watcher.ts            # Polling loop with graceful shutdown
│   ├── processor.ts          # Business logic (replace with your own)
│   └── ai-generator.ts       # Claude AI integration
├── state/state-store.ts      # JSON-based state persistence
└── types/index.ts            # Shared TypeScript interfaces

tests/                        # Mirror of src/ with full test coverage
```

## Commands

| Command | Description |
|---------|-------------|
| `bun run start` | Start the watcher (polls every N minutes) |
| `bun run once` | Run a single poll cycle and exit |
| `bun src/cli/index.ts test-item <id>` | Process a single work item in dry-run mode |
| `bun src/cli/index.ts reset-state` | Clear processed state |
| `bun test` | Run all tests |
| `bun run typecheck` | Run TypeScript type checking |

Add `--dry-run` to any command to skip Azure DevOps writes.

## Patterns

See [PATTERNS.md](PATTERNS.md) for a quick reference of all architectural patterns used in this template.
```

**Step 2: Replace CLAUDE.md**

```markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DevOpsPullTemplate is a GitHub template repository for Azure DevOps automation projects. It provides production-ready scaffolding for periodically pulling data from Azure DevOps, processing it with Claude AI, and pushing results back. The shipped example processes work items via WIQL queries.

## Architecture

- **Runtime:** Bun (TypeScript)
- **Validation:** Zod for environment config
- **AI:** @anthropic-ai/claude-agent-sdk for Claude integration
- **Testing:** Bun's built-in test framework

## Key Patterns

- **Dependency injection** via interfaces on all services for testability
- **Exponential backoff retry** on Azure DevOps API calls (5xx/network errors)
- **JSON state store** with Set-based O(1) lookups
- **Polling watcher** with graceful SIGINT/SIGTERM shutdown
- **WIQL queries** to find work items to process

## Commands

- `bun test` — run all tests
- `bun run typecheck` — TypeScript type checking
- `bun run start` — start the watcher
- `bun run once` — single poll cycle

## File Layout

- `src/config/` — Zod env validation
- `src/sdk/` — Azure DevOps REST client (WIQL queries, work item CRUD)
- `src/services/` — business logic (processor, watcher, AI generator)
- `src/state/` — JSON persistence
- `src/types/` — shared interfaces
- `tests/` — mirrors src/ structure
```

**Step 3: Replace PATTERNS.md**

```markdown
# Patterns Reference

Quick reference for the architectural patterns used in this template. Each links to the source file where it's implemented.

## Zod Config Validation

**File:** `src/config/index.ts`

Environment variables are validated at startup using a Zod schema. Required vars throw descriptive errors. Optional vars have defaults. The `loadConfig()` function accepts an optional `env` parameter for testing.

## Dependency Injection

**Files:** `src/services/processor.ts`, `src/services/watcher.ts`

Services define a `Deps` interface listing their external dependencies as function signatures. A `defaultDeps` object wires to production implementations. Test code passes mock deps directly — no module mocking needed.

## Exponential Backoff Retry

**File:** `src/sdk/azure-devops-client.ts`

`adoFetchWithRetry()` wraps `adoFetch()` with configurable retry delays (default: 1s, 2s, 4s). Retries on 5xx and network errors. Immediately re-throws 4xx errors. Tests pass `[0, 0, 0]` delays for speed.

## JSON State Store

**File:** `src/state/state-store.ts`

`StateStore` class tracks processed item IDs using an in-memory `Set` backed by a JSON file. O(1) lookups via `isProcessed()`. Graceful recovery from corrupted files. Creates directories recursively.

## Polling with Graceful Shutdown

**File:** `src/services/watcher.ts`

`startWatcher()` runs a polling loop with configurable interval. Uses `SIGINT`/`SIGTERM` listeners to set an abort flag. `sleep()` checks the flag every second so shutdown is responsive.

## Claude SDK Integration

**File:** `src/services/ai-generator.ts`

Uses `query()` from `@anthropic-ai/claude-agent-sdk` with a system prompt loaded from disk and a dynamically built user prompt. Streams results and returns the final text.

## CLI Command Dispatch

**File:** `src/cli/index.ts`

Simple `switch` statement on `process.argv[2]`. Supports `watch`, `run-once`, `test-item <id>`, `reset-state`, `help`. Global `--dry-run` flag. No external CLI framework needed.

## Testing with Mock Helpers

**Files:** `tests/services/processor.test.ts`, `tests/services/watcher.test.ts`

`mockConfig()`, `mockWorkItem()`, and `makeDeps()` factory functions create test fixtures with sensible defaults. Override specific fields via spread syntax. Uses `bun:test` mock functions.
```

**Step 4: Replace `.claude/commands/do-process-item.md`**

```markdown
You are an Azure DevOps work item processor. Given context about a work item, generate a brief summary of the item and suggest next steps.

## Output Format

Write 2-3 sentences summarizing:
1. What the work item is about
2. The current state and any relevant fields
3. Suggested next steps or actions

Keep the summary concise and factual. Do not use markdown formatting. Return plain text only.
```

**Step 5: Run all tests**

Run: `bun test`
Expected: PASS (all tests green)

**Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 7: Commit**

```bash
git add README.md CLAUDE.md PATTERNS.md .claude/commands/do-process-item.md
git commit -m "docs: update all documentation for generic work item template"
```

---

### Task 11: Final verification — run full test suite and typecheck

**Step 1: Run all tests**

Run: `bun test`
Expected: All tests PASS

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

**Step 3: Verify CLI help output**

Run: `bun src/cli/index.ts help`
Expected: Shows updated help text with `test-item`, `AZURE_DEVOPS_WIQL_QUERY`, no mention of PRs or repo IDs.

**Step 4: Final commit if any loose ends**

If any files were missed, stage and commit them.
