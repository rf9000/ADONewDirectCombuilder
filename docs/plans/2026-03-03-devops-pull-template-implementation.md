# DevOpsPullTemplate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a GitHub template repository with full scaffolding for Azure DevOps automation projects, including working stubs, tests, and documentation.

**Architecture:** Mirror the AzureDevopsReleaseNoteCreator structure (Approach A). Every source file has a corresponding test file. Stubs demonstrate "process work items from completed PRs" as a generic example. DI pattern throughout for testability.

**Tech Stack:** Bun runtime, TypeScript (strict), Zod validation, @anthropic-ai/claude-agent-sdk, Bun test framework.

---

### Task 1: Project configuration files

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`

**Step 1: Create package.json**

```json
{
  "name": "devops-pull-template",
  "version": "0.1.0",
  "type": "module",
  "module": "src/cli/index.ts",
  "scripts": {
    "start": "bun run src/cli/index.ts watch",
    "once": "bun run src/cli/index.ts run-once",
    "test": "bun test --preload ./tests/setup.ts tests/**/*.test.ts",
    "test:unit": "bun test --preload ./tests/setup.ts ./tests/config/ ./tests/sdk/ ./tests/state/ ./tests/services/",
    "test:integration": "bun test --preload ./tests/setup.ts tests/integration/**/*.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "latest"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noEmit": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

**Step 3: Create .gitignore**

```
node_modules/
dist/
coverage/
.env
.env.*.local
.state/
.cache/
.DS_Store
```

**Step 4: Create .env.example**

```bash
# Azure DevOps Configuration (required)
AZURE_DEVOPS_PAT=your-pat-here
AZURE_DEVOPS_ORG=your-org-name
AZURE_DEVOPS_PROJECT=your-project-name
AZURE_DEVOPS_REPO_IDS=repo-id-1,repo-id-2

# To find repo IDs, run:
#   curl -u ":YOUR_PAT" "https://dev.azure.com/YOUR_ORG/YOUR_PROJECT/_apis/git/repositories?api-version=7.0"

# Optional: Polling interval in minutes (default: 15)
# POLL_INTERVAL_MINUTES=15

# Optional: Claude model to use (default: claude-sonnet-4-6)
# CLAUDE_MODEL=claude-sonnet-4-6

# Optional: Path to AI prompt file (default: .claude/commands/do-process-item.md)
# PROMPT_PATH=.claude/commands/do-process-item.md

# Optional: State file directory (default: .state)
# STATE_DIR=.state
```

**Step 5: Install dependencies**

Run: `bun install`
Expected: `node_modules/` created, `bun.lock` generated

**Step 6: Verify typecheck setup**

Run: `bun run typecheck`
Expected: Succeeds (no source files yet, so no errors)

**Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore .env.example bun.lock
git commit -m "chore: add project configuration (bun, typescript, zod)"
```

---

### Task 2: Types

**Files:**
- Create: `src/types/index.ts`

**Step 1: Create types file**

```typescript
/** Application configuration loaded from environment variables. */
export interface AppConfig {
  org: string;
  orgUrl: string;
  project: string;
  pat: string;
  repoIds: string[];
  pollIntervalMinutes: number;
  claudeModel: string;
  promptPath: string;
  stateDir: string;
  dryRun: boolean;
}

/** Shape returned by the Azure DevOps Pull Request API. */
export interface AzureDevOpsPullRequest {
  pullRequestId: number;
  title: string;
  description: string;
  status: string;
  creationDate: string;
  closedDate: string;
  sourceRefName: string;
  targetRefName: string;
  lastMergeSourceCommit: { commitId: string };
  lastMergeTargetCommit: { commitId: string };
  repository: { id: string; name: string };
}

/** Reference to a work item linked to a pull request. */
export interface PRWorkItemRef {
  id: string;
  url: string;
}

/** Response shape when fetching a single work item. */
export interface WorkItemResponse {
  id: number;
  fields: Record<string, unknown>;
  rev: number;
  url: string;
}

/** A single change entry inside a diff response. */
export interface DiffChange {
  item: { path: string };
  changeType: string;
}

/** Response shape for a commit diff query. */
export interface DiffResponse {
  changes: DiffChange[];
}

/** Persisted state tracking which PRs have already been processed. */
export interface ProcessedState {
  processedPRIds: number[];
  lastRunAt: string;
}

/** Result summary after processing a single pull request. */
export interface PRProcessResult {
  prId: number;
  processed: number;
  skipped: number;
  errors: number;
}
```

**Step 2: Verify it compiles**

Run: `bun run typecheck`
Expected: PASS (no errors)

**Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add shared TypeScript types"
```

---

### Task 3: Config with Zod validation + tests

**Files:**
- Create: `src/config/index.ts`
- Create: `tests/setup.ts`
- Create: `tests/config/config.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, expect, it } from "bun:test";
import { loadConfig } from "../../src/config/index.ts";

const validEnv: Record<string, string> = {
  AZURE_DEVOPS_PAT: "test-pat-token",
  AZURE_DEVOPS_ORG: "my-org",
  AZURE_DEVOPS_PROJECT: "my-project",
  AZURE_DEVOPS_REPO_IDS: "repo1,repo2",
};

describe("loadConfig", () => {
  it("returns correct AppConfig for valid env", () => {
    const config = loadConfig(validEnv);

    expect(config.pat).toBe("test-pat-token");
    expect(config.org).toBe("my-org");
    expect(config.orgUrl).toBe("https://dev.azure.com/my-org");
    expect(config.project).toBe("my-project");
    expect(config.repoIds).toEqual(["repo1", "repo2"]);
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

  it("throws when AZURE_DEVOPS_REPO_IDS is missing", () => {
    const env = { ...validEnv };
    delete env.AZURE_DEVOPS_REPO_IDS;
    expect(() => loadConfig(env)).toThrow("Invalid configuration");
  });

  it("applies default values when optional vars are absent", () => {
    const config = loadConfig(validEnv);

    expect(config.pollIntervalMinutes).toBe(15);
    expect(config.claudeModel).toBe("claude-sonnet-4-6");
    expect(config.promptPath).toBe(".claude/commands/do-process-item.md");
    expect(config.stateDir).toBe(".state");
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

  it("splits repo IDs and trims whitespace", () => {
    const env = {
      ...validEnv,
      AZURE_DEVOPS_REPO_IDS: "id1, id2, id3",
    };

    const config = loadConfig(env);
    expect(config.repoIds).toEqual(["id1", "id2", "id3"]);
  });

  it("handles single repo ID without commas", () => {
    const env = {
      ...validEnv,
      AZURE_DEVOPS_REPO_IDS: "single-repo",
    };

    const config = loadConfig(env);
    expect(config.repoIds).toEqual(["single-repo"]);
  });

  it("derives orgUrl from org name", () => {
    const env = { ...validEnv, AZURE_DEVOPS_ORG: "contoso" };
    const config = loadConfig(env);
    expect(config.orgUrl).toBe("https://dev.azure.com/contoso");
  });
});
```

**Step 2: Create tests/setup.ts**

```typescript
delete process.env.CLAUDECODE;
```

**Step 3: Run test to verify it fails**

Run: `bun test --preload ./tests/setup.ts tests/config/config.test.ts`
Expected: FAIL (module not found)

**Step 4: Write config implementation**

```typescript
import { z } from "zod";
import type { AppConfig } from "../types/index.ts";

const envSchema = z.object({
  AZURE_DEVOPS_PAT: z.string().min(1, "AZURE_DEVOPS_PAT is required"),
  AZURE_DEVOPS_ORG: z.string().min(1, "AZURE_DEVOPS_ORG is required"),
  AZURE_DEVOPS_PROJECT: z.string().min(1, "AZURE_DEVOPS_PROJECT is required"),
  AZURE_DEVOPS_REPO_IDS: z.string().min(1, "AZURE_DEVOPS_REPO_IDS is required"),
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

  const repoIds = parsed.AZURE_DEVOPS_REPO_IDS
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  return {
    org: parsed.AZURE_DEVOPS_ORG,
    orgUrl: `https://dev.azure.com/${parsed.AZURE_DEVOPS_ORG}`,
    project: parsed.AZURE_DEVOPS_PROJECT,
    pat: parsed.AZURE_DEVOPS_PAT,
    repoIds,
    pollIntervalMinutes: parsed.POLL_INTERVAL_MINUTES,
    claudeModel: parsed.CLAUDE_MODEL,
    promptPath: parsed.PROMPT_PATH,
    stateDir: parsed.STATE_DIR,
    dryRun: false,
  };
}
```

**Step 5: Run tests to verify they pass**

Run: `bun test --preload ./tests/setup.ts tests/config/config.test.ts`
Expected: All 9 tests PASS

**Step 6: Commit**

```bash
git add src/config/index.ts tests/setup.ts tests/config/config.test.ts
git commit -m "feat: add Zod-based config validation with tests"
```

---

### Task 4: State store + tests

**Files:**
- Create: `src/state/state-store.ts`
- Create: `tests/state/state-store.test.ts`

**Step 1: Write the test file**

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
  it('save + load roundtrip preserves processed PRs', () => {
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
    const filePath = join(dir, 'processed-prs.json');
    writeFileSync(filePath, '{{not valid json!!!', 'utf-8');

    const store = new StateStore(dir);

    expect(store.processedCount).toBe(0);
    expect(store.isProcessed(1)).toBe(false);
  });

  it('does not duplicate when marking the same PR twice', () => {
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

**Step 2: Run test to verify it fails**

Run: `bun test --preload ./tests/setup.ts tests/state/state-store.test.ts`
Expected: FAIL (module not found)

**Step 3: Write state-store implementation**

```typescript
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import type { ProcessedState } from '../types/index.ts';

export class StateStore {
  private filePath: string;
  private state: ProcessedState;
  private processedSet: Set<number>;

  constructor(stateDir: string) {
    this.filePath = join(stateDir, 'processed-prs.json');
    this.state = this.load();
    this.processedSet = new Set(this.state.processedPRIds);
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
          'processedPRIds' in parsed &&
          Array.isArray((parsed as ProcessedState).processedPRIds)
        ) {
          return parsed as ProcessedState;
        }
      }
    } catch {
      // file doesn't exist or is corrupted JSON — start fresh
    }
    return { processedPRIds: [], lastRunAt: '' };
  }

  save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.state.lastRunAt = new Date().toISOString();
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  isProcessed(prId: number): boolean {
    return this.processedSet.has(prId);
  }

  markProcessed(prId: number): void {
    if (!this.processedSet.has(prId)) {
      this.processedSet.add(prId);
      this.state.processedPRIds.push(prId);
    }
  }

  reset(): void {
    this.state = { processedPRIds: [], lastRunAt: '' };
    this.processedSet = new Set();
    this.save();
  }

  get processedCount(): number {
    return this.state.processedPRIds.length;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test --preload ./tests/setup.ts tests/state/state-store.test.ts`
Expected: All 7 tests PASS

**Step 5: Commit**

```bash
git add src/state/state-store.ts tests/state/state-store.test.ts
git commit -m "feat: add JSON-based state store with tests"
```

---

### Task 5: Azure DevOps SDK client + tests

**Files:**
- Create: `src/sdk/azure-devops-client.ts`
- Create: `tests/sdk/azure-devops-client.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, test, expect, afterEach, mock } from 'bun:test';
import type { AppConfig } from '../../src/types/index.ts';
import {
  AzureDevOpsError,
  adoFetch,
  adoFetchWithRetry,
  listCompletedPRs,
  getPRWorkItems,
  getWorkItem,
  getPRChangedFiles,
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
    repoIds: ['repo-1'],
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

describe('listCompletedPRs', () => {
  test('builds correct URL and returns value array', async () => {
    const prs = [
      { pullRequestId: 1, title: 'PR 1' },
      { pullRequestId: 2, title: 'PR 2' },
    ];
    setMockFetch({ value: prs });
    const config = mockConfig();

    const result = await listCompletedPRs(config, 'repo-1', 10);

    expect(result as unknown[]).toEqual(prs);
    const url = mockFn.mock.calls[0]![0] as string;
    expect(url).toContain('git/repositories/repo-1/pullrequests');
    expect(url).toContain('searchCriteria.status=completed');
    expect(url).toContain('$top=10');
    expect(url).toContain('api-version=7.0');
  });
});

describe('getPRWorkItems', () => {
  test('builds correct URL and returns value array', async () => {
    const items = [
      { id: '100', url: 'https://example.com/100' },
      { id: '200', url: 'https://example.com/200' },
    ];
    setMockFetch({ value: items });
    const config = mockConfig();

    const result = await getPRWorkItems(config, 'repo-1', 42);

    expect(result).toEqual(items);
    const url = mockFn.mock.calls[0]![0] as string;
    expect(url).toContain(
      'git/repositories/repo-1/pullrequests/42/workitems',
    );
    expect(url).toContain('api-version=7.0');
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

describe('getPRChangedFiles', () => {
  test('extracts file paths from changes', async () => {
    const diff = {
      changes: [
        { item: { path: '/src/index.ts' }, changeType: 'edit' },
        { item: { path: '/README.md' }, changeType: 'add' },
      ],
    };
    setMockFetch(diff);
    const config = mockConfig();

    const result = await getPRChangedFiles(
      config,
      'repo-1',
      'abc123',
      'def456',
    );

    expect(result).toEqual(['/src/index.ts', '/README.md']);
    const url = mockFn.mock.calls[0]![0] as string;
    expect(url).toContain('git/repositories/repo-1/diffs/commits');
    expect(url).toContain('baseVersion=abc123');
    expect(url).toContain('targetVersion=def456');
    expect(url).toContain('api-version=7.0');
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
      await listCompletedPRs(config, 'no-such-repo');
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

**Step 2: Run test to verify it fails**

Run: `bun test --preload ./tests/setup.ts tests/sdk/azure-devops-client.test.ts`
Expected: FAIL (module not found)

**Step 3: Write SDK implementation**

```typescript
import type {
  AppConfig,
  AzureDevOpsPullRequest,
  PRWorkItemRef,
  WorkItemResponse,
  DiffResponse,
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

export async function listCompletedPRs(
  config: AppConfig,
  repoId: string,
  top = 50,
): Promise<AzureDevOpsPullRequest[]> {
  const path = `git/repositories/${repoId}/pullrequests?searchCriteria.status=completed&$top=${top}&api-version=7.0`;
  const data = await adoFetchWithRetry<{ value: AzureDevOpsPullRequest[] }>(
    config,
    path,
  );
  return data.value;
}

export async function getPullRequest(
  config: AppConfig,
  repoId: string,
  prId: number,
): Promise<AzureDevOpsPullRequest> {
  const path = `git/repositories/${repoId}/pullrequests/${prId}?api-version=7.0`;
  return adoFetchWithRetry<AzureDevOpsPullRequest>(config, path);
}

export async function getPRWorkItems(
  config: AppConfig,
  repoId: string,
  prId: number,
): Promise<PRWorkItemRef[]> {
  const path = `git/repositories/${repoId}/pullrequests/${prId}/workitems?api-version=7.0`;
  const data = await adoFetchWithRetry<{ value: PRWorkItemRef[] }>(
    config,
    path,
  );
  return data.value;
}

export async function getWorkItem(
  config: AppConfig,
  workItemId: number,
): Promise<WorkItemResponse> {
  const path = `wit/workitems/${workItemId}?$expand=all&api-version=7.0`;
  return adoFetchWithRetry<WorkItemResponse>(config, path);
}

export async function getPRChangedFiles(
  config: AppConfig,
  repoId: string,
  baseCommit: string,
  targetCommit: string,
): Promise<string[]> {
  const path = `git/repositories/${repoId}/diffs/commits?baseVersion=${baseCommit}&targetVersion=${targetCommit}&api-version=7.0`;
  const data = await adoFetchWithRetry<DiffResponse>(config, path);
  return data.changes.map((c) => c.item.path);
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

Run: `bun test --preload ./tests/setup.ts tests/sdk/azure-devops-client.test.ts`
Expected: All 10 tests PASS

**Step 5: Commit**

```bash
git add src/sdk/azure-devops-client.ts tests/sdk/azure-devops-client.test.ts
git commit -m "feat: add Azure DevOps REST client with retry and tests"
```

---

### Task 6: AI generator service + tests

**Files:**
- Create: `src/services/ai-generator.ts`
- Create: `tests/services/ai-generator.test.ts`
- Create: `.claude/commands/do-process-item.md`

**Step 1: Create the example prompt template**

Create `.claude/commands/do-process-item.md`:

```markdown
You are an Azure DevOps work item processor. Given context about a pull request and its linked work item, generate a brief summary of what changed and why.

## Output Format

Write 2-3 sentences summarizing:
1. What the PR changes
2. Why the change was made (based on the work item)
3. Any notable files affected

Keep the summary concise and factual. Do not use markdown formatting. Return plain text only.
```

**Step 2: Write the test file**

```typescript
import { describe, test, expect } from 'bun:test';
import { buildUserPrompt } from '../../src/services/ai-generator.ts';
import type { GeneratorContext } from '../../src/services/ai-generator.ts';

describe('buildUserPrompt', () => {
  const baseContext: GeneratorContext = {
    prTitle: 'Fix login timeout',
    prDescription: 'Increased timeout from 5s to 30s',
    changedFiles: ['src/auth/login.ts', 'src/auth/config.ts'],
    workItemTitle: 'Login times out too quickly',
    workItemType: 'Bug',
  };

  test('includes PR title', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).toContain('**Title:** Fix login timeout');
  });

  test('includes PR description when present', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).toContain('**Description:** Increased timeout from 5s to 30s');
  });

  test('omits description when empty', () => {
    const prompt = buildUserPrompt({ ...baseContext, prDescription: '' });
    expect(prompt).not.toContain('**Description:**');
  });

  test('lists changed files', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).toContain('## Changed Files');
    expect(prompt).toContain('- src/auth/login.ts');
    expect(prompt).toContain('- src/auth/config.ts');
  });

  test('omits changed files section when empty', () => {
    const prompt = buildUserPrompt({ ...baseContext, changedFiles: [] });
    expect(prompt).not.toContain('## Changed Files');
  });

  test('truncates at 50 files with overflow message', () => {
    const manyFiles = Array.from({ length: 60 }, (_, i) => `src/file${i}.ts`);
    const prompt = buildUserPrompt({ ...baseContext, changedFiles: manyFiles });
    expect(prompt).toContain('- src/file49.ts');
    expect(prompt).not.toContain('- src/file50.ts');
    expect(prompt).toContain('...and 10 more files');
  });

  test('includes work item type and title', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).toContain('**Type:** Bug');
    expect(prompt).toContain('**Title:** Login times out too quickly');
  });

  test('includes all sections in order', () => {
    const prompt = buildUserPrompt(baseContext);
    const prSection = prompt.indexOf('## Pull Request');
    const filesSection = prompt.indexOf('## Changed Files');
    const wiSection = prompt.indexOf('## Work Item');
    expect(prSection).toBeLessThan(filesSection);
    expect(filesSection).toBeLessThan(wiSection);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `bun test --preload ./tests/setup.ts tests/services/ai-generator.test.ts`
Expected: FAIL (module not found)

**Step 4: Write AI generator implementation**

```typescript
import { readFileSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AppConfig } from '../types/index.ts';

export interface GeneratorContext {
  prTitle: string;
  prDescription: string;
  changedFiles: string[];
  workItemTitle: string;
  workItemType: string;
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
    `## Pull Request`,
    `**Title:** ${context.prTitle}`,
  ];

  if (context.prDescription) {
    lines.push(`**Description:** ${context.prDescription}`);
  }

  if (context.changedFiles.length > 0) {
    lines.push('', '## Changed Files');
    const shown = context.changedFiles.slice(0, 50);
    for (const f of shown) {
      lines.push(`- ${f}`);
    }
    if (context.changedFiles.length > 50) {
      lines.push(`- ...and ${context.changedFiles.length - 50} more files`);
    }
  }

  lines.push('', '## Work Item');
  lines.push(`**Type:** ${context.workItemType}`);
  lines.push(`**Title:** ${context.workItemTitle}`);

  return lines.join('\n');
}
```

**Step 5: Run tests to verify they pass**

Run: `bun test --preload ./tests/setup.ts tests/services/ai-generator.test.ts`
Expected: All 8 tests PASS

**Step 6: Commit**

```bash
git add src/services/ai-generator.ts tests/services/ai-generator.test.ts .claude/commands/do-process-item.md
git commit -m "feat: add AI generator service with Claude SDK integration and tests"
```

---

### Task 7: Processor service + tests

**Files:**
- Create: `src/services/processor.ts`
- Create: `tests/services/processor.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, test, expect, mock } from 'bun:test';
import type { AppConfig, AzureDevOpsPullRequest } from '../../src/types/index.ts';
import { processPR } from '../../src/services/processor.ts';
import type { ProcessorDeps } from '../../src/services/processor.ts';

function mockConfig(): AppConfig {
  return {
    org: 'my-org',
    orgUrl: 'https://dev.azure.com/my-org',
    project: 'my-project',
    pat: 'test-pat-token',
    repoIds: ['repo-1'],
    pollIntervalMinutes: 5,
    claudeModel: 'claude-sonnet-4-6',
    promptPath: './prompt.md',
    stateDir: '.state',
    dryRun: false,
  };
}

function mockPR(overrides: Partial<AzureDevOpsPullRequest> = {}): AzureDevOpsPullRequest {
  return {
    pullRequestId: 42,
    title: 'Add new feature',
    description: 'Adds a great new feature to the system',
    status: 'completed',
    creationDate: '2025-01-01T00:00:00Z',
    closedDate: '2025-01-02T00:00:00Z',
    sourceRefName: 'refs/heads/feature/new-feature',
    targetRefName: 'refs/heads/main',
    lastMergeSourceCommit: { commitId: 'source-commit-abc' },
    lastMergeTargetCommit: { commitId: 'target-commit-def' },
    repository: { id: 'repo-1', name: 'my-repo' },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ProcessorDeps> = {}): ProcessorDeps {
  return {
    getPRWorkItems: mock(() => Promise.resolve([])),
    getWorkItem: mock(() =>
      Promise.resolve({
        id: 100,
        fields: { 'System.Title': 'Work item', 'System.WorkItemType': 'User Story' },
        rev: 1,
        url: 'https://example.com/100',
      }),
    ),
    getPRChangedFiles: mock(() => Promise.resolve(['/src/index.ts', '/README.md'])),
    updateWorkItemField: mock(() =>
      Promise.resolve({
        id: 100,
        fields: {},
        rev: 2,
        url: 'https://example.com/100',
      }),
    ),
    generateWithAI: mock(() => Promise.resolve('Generated output')),
    ...overrides,
  };
}

describe('processPR', () => {
  test('PR with no linked work items returns zeroed result', async () => {
    const config = mockConfig();
    const pr = mockPR();
    const deps = makeDeps({
      getPRWorkItems: mock(() => Promise.resolve([])),
    });

    const result = await processPR(config, pr, deps);

    expect(result).toEqual({ prId: 42, processed: 0, skipped: 0, errors: 0 });
    expect(deps.getPRWorkItems).toHaveBeenCalledTimes(1);
    expect(deps.getWorkItem).toHaveBeenCalledTimes(0);
    expect(deps.getPRChangedFiles).toHaveBeenCalledTimes(0);
  });

  test('PR with work item generates and writes output', async () => {
    const config = mockConfig();
    const pr = mockPR();
    const deps = makeDeps({
      getPRWorkItems: mock(() =>
        Promise.resolve([{ id: '100', url: 'https://example.com/100' }]),
      ),
      getWorkItem: mock(() =>
        Promise.resolve({
          id: 100,
          fields: {
            'System.Title': 'Fix login bug',
            'System.WorkItemType': 'Bug',
          },
          rev: 1,
          url: 'https://example.com/100',
        }),
      ),
      getPRChangedFiles: mock(() =>
        Promise.resolve(['/src/auth/login.ts']),
      ),
      generateWithAI: mock(() => Promise.resolve('AI generated output')),
    });

    const result = await processPR(config, pr, deps);

    expect(result).toEqual({ prId: 42, processed: 1, skipped: 0, errors: 0 });
    expect(deps.generateWithAI).toHaveBeenCalledTimes(1);
  });

  test('PR with generation failure counts as error', async () => {
    const config = mockConfig();
    const pr = mockPR();
    const deps = makeDeps({
      getPRWorkItems: mock(() =>
        Promise.resolve([{ id: '300', url: 'https://example.com/300' }]),
      ),
      getWorkItem: mock(() =>
        Promise.resolve({
          id: 300,
          fields: {
            'System.Title': 'Broken feature',
            'System.WorkItemType': 'Bug',
          },
          rev: 1,
          url: 'https://example.com/300',
        }),
      ),
      generateWithAI: mock(() =>
        Promise.reject(new Error('Claude API error')),
      ),
    });

    const result = await processPR(config, pr, deps);

    expect(result).toEqual({ prId: 42, processed: 0, skipped: 0, errors: 1 });
    expect(deps.updateWorkItemField).toHaveBeenCalledTimes(0);
  });

  test('changed files fetch failure still processes work items', async () => {
    const config = mockConfig();
    const pr = mockPR();
    const deps = makeDeps({
      getPRWorkItems: mock(() =>
        Promise.resolve([{ id: '100', url: 'https://example.com/100' }]),
      ),
      getWorkItem: mock(() =>
        Promise.resolve({
          id: 100,
          fields: {
            'System.Title': 'Some feature',
            'System.WorkItemType': 'User Story',
          },
          rev: 1,
          url: 'https://example.com/100',
        }),
      ),
      getPRChangedFiles: mock(() =>
        Promise.reject(new Error('Diff API failed')),
      ),
      generateWithAI: mock(() =>
        Promise.resolve('Output without file context'),
      ),
    });

    const result = await processPR(config, pr, deps);

    expect(result).toEqual({ prId: 42, processed: 1, skipped: 0, errors: 0 });

    const genCall = (deps.generateWithAI as ReturnType<typeof mock>).mock.calls[0]!;
    expect(genCall[1]).toEqual({
      prTitle: 'Add new feature',
      prDescription: 'Adds a great new feature to the system',
      changedFiles: [],
      workItemTitle: 'Some feature',
      workItemType: 'User Story',
    });
  });

  test('dry run generates but does not write', async () => {
    const config = { ...mockConfig(), dryRun: true };
    const pr = mockPR();
    const deps = makeDeps({
      getPRWorkItems: mock(() =>
        Promise.resolve([{ id: '100', url: 'https://example.com/100' }]),
      ),
      getWorkItem: mock(() =>
        Promise.resolve({
          id: 100,
          fields: {
            'System.Title': 'Feature',
            'System.WorkItemType': 'User Story',
          },
          rev: 1,
          url: 'https://example.com/100',
        }),
      ),
      generateWithAI: mock(() => Promise.resolve('Dry run output')),
    });

    const result = await processPR(config, pr, deps);

    expect(result).toEqual({ prId: 42, processed: 1, skipped: 0, errors: 0 });
    expect(deps.updateWorkItemField).toHaveBeenCalledTimes(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test --preload ./tests/setup.ts tests/services/processor.test.ts`
Expected: FAIL (module not found)

**Step 3: Write processor implementation**

```typescript
import type {
  AppConfig,
  AzureDevOpsPullRequest,
  PRProcessResult,
  PRWorkItemRef,
  WorkItemResponse,
} from '../types/index.ts';
import type { GeneratorContext } from './ai-generator.ts';

import * as sdk from '../sdk/azure-devops-client.ts';
import * as gen from './ai-generator.ts';

export interface ProcessorDeps {
  getPRWorkItems: (
    config: AppConfig,
    repoId: string,
    prId: number,
  ) => Promise<PRWorkItemRef[]>;

  getWorkItem: (
    config: AppConfig,
    workItemId: number,
  ) => Promise<WorkItemResponse>;

  getPRChangedFiles: (
    config: AppConfig,
    repoId: string,
    baseCommit: string,
    targetCommit: string,
  ) => Promise<string[]>;

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
  getPRWorkItems: sdk.getPRWorkItems,
  getWorkItem: sdk.getWorkItem,
  getPRChangedFiles: sdk.getPRChangedFiles,
  updateWorkItemField: sdk.updateWorkItemField,
  generateWithAI: gen.generateWithAI,
};

function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

// TODO: Replace this stub with your project-specific processing logic.
// This example processes work items linked to completed PRs and generates
// AI-powered summaries. Adapt the field checks, generation context, and
// update logic to match your use case.

export async function processPR(
  config: AppConfig,
  pr: AzureDevOpsPullRequest,
  deps: ProcessorDeps = defaultDeps,
): Promise<PRProcessResult> {
  const result: PRProcessResult = {
    prId: pr.pullRequestId,
    processed: 0,
    skipped: 0,
    errors: 0,
  };

  log(`Processing PR #${pr.pullRequestId}: ${pr.title}`);

  const workItemRefs = await deps.getPRWorkItems(
    config,
    pr.repository.id,
    pr.pullRequestId,
  );

  if (workItemRefs.length === 0) {
    log(`  PR #${pr.pullRequestId}: No linked work items, skipping`);
    return result;
  }

  let changedFiles: string[] = [];
  try {
    changedFiles = await deps.getPRChangedFiles(
      config,
      pr.repository.id,
      pr.lastMergeTargetCommit.commitId,
      pr.lastMergeSourceCommit.commitId,
    );
  } catch (err) {
    log(
      `  PR #${pr.pullRequestId}: Warning — could not fetch changed files: ${err}`,
    );
  }

  for (const ref of workItemRefs) {
    const workItemId = Number(ref.id);
    try {
      const workItem = await deps.getWorkItem(config, workItemId);

      const workItemTitle = String(workItem.fields['System.Title'] ?? '');
      const workItemType = String(
        workItem.fields['System.WorkItemType'] ?? '',
      );

      const context: GeneratorContext = {
        prTitle: pr.title,
        prDescription: pr.description ?? '',
        changedFiles,
        workItemTitle,
        workItemType,
      };

      log(`  WI #${workItemId}: Generating AI output...`);
      const output = await deps.generateWithAI(config, context);

      if (config.dryRun) {
        log(`  WI #${workItemId}: [DRY RUN] Generated:\n    "${output}"`);
        result.processed++;
        continue;
      }

      // TODO: Replace 'System.Description' with the field you want to update
      await deps.updateWorkItemField(
        config,
        workItemId,
        'System.Description',
        output,
      );
      log(`  WI #${workItemId}: Output written`);
      result.processed++;
    } catch (err) {
      log(`  WI #${workItemId}: Error — ${err}`);
      result.errors++;
    }
  }

  return result;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test --preload ./tests/setup.ts tests/services/processor.test.ts`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add src/services/processor.ts tests/services/processor.test.ts
git commit -m "feat: add processor service with DI pattern and tests"
```

---

### Task 8: Watcher service + tests

**Files:**
- Create: `src/services/watcher.ts`
- Create: `tests/services/watcher.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AppConfig, AzureDevOpsPullRequest } from '../../src/types/index.ts';
import { runPollCycle } from '../../src/services/watcher.ts';
import type { WatcherDeps } from '../../src/services/watcher.ts';
import { StateStore } from '../../src/state/state-store.ts';

function mockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    org: 'my-org',
    orgUrl: 'https://dev.azure.com/my-org',
    project: 'my-project',
    pat: 'test-pat-token',
    repoIds: ['repo-1'],
    pollIntervalMinutes: 5,
    claudeModel: 'claude-sonnet-4-6',
    promptPath: './prompt.md',
    stateDir: '.state',
    dryRun: false,
    ...overrides,
  };
}

function mockPR(overrides: Partial<AzureDevOpsPullRequest> = {}): AzureDevOpsPullRequest {
  return {
    pullRequestId: 42,
    title: 'Add new feature',
    description: 'Adds a great new feature to the system',
    status: 'completed',
    creationDate: '2025-01-01T00:00:00Z',
    closedDate: '2025-01-02T00:00:00Z',
    sourceRefName: 'refs/heads/feature/new-feature',
    targetRefName: 'refs/heads/main',
    lastMergeSourceCommit: { commitId: 'source-commit-abc' },
    lastMergeTargetCommit: { commitId: 'target-commit-def' },
    repository: { id: 'repo-1', name: 'my-repo' },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<WatcherDeps> = {}): WatcherDeps {
  return {
    listCompletedPRs: mock(() => Promise.resolve([])),
    processPR: mock(() =>
      Promise.resolve({ prId: 0, processed: 0, skipped: 0, errors: 0 }),
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

  test('no new PRs returns all zeros', async () => {
    const config = mockConfig();
    const deps = makeDeps({
      listCompletedPRs: mock(() => Promise.resolve([])),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 0, skipped: 0, errors: 0 });
    expect(deps.listCompletedPRs).toHaveBeenCalledTimes(1);
    expect(deps.processPR).toHaveBeenCalledTimes(0);
  });

  test('new PR found calls processPR, marks as processed, and saves state', async () => {
    const config = mockConfig();
    const pr = mockPR({ pullRequestId: 101 });

    const deps = makeDeps({
      listCompletedPRs: mock(() => Promise.resolve([pr])),
      processPR: mock(() =>
        Promise.resolve({ prId: 101, processed: 1, skipped: 0, errors: 0 }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 1, skipped: 0, errors: 0 });
    expect(deps.processPR).toHaveBeenCalledTimes(1);
    expect(stateStore.isProcessed(101)).toBe(true);

    const reloadedStore = new StateStore(tmpDir);
    expect(reloadedStore.isProcessed(101)).toBe(true);
  });

  test('already processed PR is filtered out', async () => {
    const config = mockConfig();
    const pr = mockPR({ pullRequestId: 200 });

    stateStore.markProcessed(200);
    stateStore.save();

    const deps = makeDeps({
      listCompletedPRs: mock(() => Promise.resolve([pr])),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 0, skipped: 0, errors: 0 });
    expect(deps.processPR).toHaveBeenCalledTimes(0);
  });

  test('processPR throws: PR not marked as processed, error counted', async () => {
    const config = mockConfig();
    const pr = mockPR({ pullRequestId: 300 });

    const deps = makeDeps({
      listCompletedPRs: mock(() => Promise.resolve([pr])),
      processPR: mock(() => Promise.reject(new Error('Fatal processing error'))),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 0, skipped: 0, errors: 1 });
    expect(stateStore.isProcessed(300)).toBe(false);
  });

  test('PR with errors in result is not marked as processed', async () => {
    const config = mockConfig();
    const pr = mockPR({ pullRequestId: 400 });

    const deps = makeDeps({
      listCompletedPRs: mock(() => Promise.resolve([pr])),
      processPR: mock(() =>
        Promise.resolve({ prId: 400, processed: 0, skipped: 0, errors: 1 }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 0, skipped: 0, errors: 1 });
    expect(stateStore.isProcessed(400)).toBe(false);
  });

  test('multiple repos polls each one', async () => {
    const config = mockConfig({ repoIds: ['repo-a', 'repo-b', 'repo-c'] });

    const prA = mockPR({
      pullRequestId: 501,
      repository: { id: 'repo-a', name: 'repo-a' },
    });
    const prB = mockPR({
      pullRequestId: 502,
      repository: { id: 'repo-b', name: 'repo-b' },
    });

    const listMock = mock((cfg: AppConfig, repoId: string) => {
      if (repoId === 'repo-a') return Promise.resolve([prA]);
      if (repoId === 'repo-b') return Promise.resolve([prB]);
      return Promise.resolve([]);
    });

    const deps = makeDeps({
      listCompletedPRs: listMock,
      processPR: mock(() =>
        Promise.resolve({ prId: 0, processed: 1, skipped: 0, errors: 0 }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ processed: 2, skipped: 0, errors: 0 });
    expect(deps.listCompletedPRs).toHaveBeenCalledTimes(3);
    expect(deps.processPR).toHaveBeenCalledTimes(2);
    expect(stateStore.isProcessed(501)).toBe(true);
    expect(stateStore.isProcessed(502)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test --preload ./tests/setup.ts tests/services/watcher.test.ts`
Expected: FAIL (module not found)

**Step 3: Write watcher implementation**

```typescript
import type {
  AppConfig,
  AzureDevOpsPullRequest,
  PRProcessResult,
} from '../types/index.ts';
import { StateStore } from '../state/state-store.ts';
import * as sdk from '../sdk/azure-devops-client.ts';
import * as proc from './processor.ts';

export interface WatcherDeps {
  listCompletedPRs: (
    config: AppConfig,
    repoId: string,
    top?: number,
  ) => Promise<AzureDevOpsPullRequest[]>;

  processPR: (
    config: AppConfig,
    pr: AzureDevOpsPullRequest,
  ) => Promise<PRProcessResult>;
}

const defaultDeps: WatcherDeps = {
  listCompletedPRs: sdk.listCompletedPRs,
  processPR: proc.processPR,
};

function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

export async function runPollCycle(
  config: AppConfig,
  stateStore: StateStore,
  deps: WatcherDeps = defaultDeps,
): Promise<{ processed: number; skipped: number; errors: number }> {
  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const repoId of config.repoIds) {
    log(`Polling repo ${repoId}...`);

    const prs = await deps.listCompletedPRs(config, repoId);
    const newPRs = prs.filter(pr => !stateStore.isProcessed(pr.pullRequestId));

    log(`  Found ${prs.length} completed PRs, ${newPRs.length} unprocessed`);

    for (const pr of newPRs) {
      try {
        const result = await deps.processPR(config, pr);
        totalProcessed += result.processed;
        totalSkipped += result.skipped;
        totalErrors += result.errors;

        if (result.errors === 0) {
          stateStore.markProcessed(pr.pullRequestId);
        }
      } catch (err) {
        log(`  PR #${pr.pullRequestId}: Fatal error — ${err}`);
        totalErrors++;
      }
    }
  }

  stateStore.save();
  return { processed: totalProcessed, skipped: totalSkipped, errors: totalErrors };
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
  log(`Watching ${config.repoIds.length} repo(s)`);
  log(`${stateStore.processedCount} PRs already processed`);

  while (!signal.aborted) {
    try {
      const result = await runPollCycle(config, stateStore);
      log(`Cycle complete: ${result.processed} processed, ${result.skipped} skipped, ${result.errors} errors`);
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

Run: `bun test --preload ./tests/setup.ts tests/services/watcher.test.ts`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add src/services/watcher.ts tests/services/watcher.test.ts
git commit -m "feat: add polling watcher with graceful shutdown and tests"
```

---

### Task 9: CLI entry point

**Files:**
- Create: `src/cli/index.ts`

**Step 1: Write CLI implementation**

```typescript
#!/usr/bin/env bun

import { loadConfig } from '../config/index.ts';
import { startWatcher, runPollCycle } from '../services/watcher.ts';
import { StateStore } from '../state/state-store.ts';
import { getPullRequest } from '../sdk/azure-devops-client.ts';
import { processPR } from '../services/processor.ts';

const HELP = `
DevOps Pull Template

Usage:
  devops-pull <command>

Commands:
  watch            Start the long-running watcher (polls every N minutes)
  run-once         Run a single poll cycle and exit
  test-pr <id>     Process a single PR (dry-run, no writes)
  reset-state      Clear the processed PR state and exit
  help             Show this help message

Options:
  --dry-run        Read-only mode: generate but skip Azure DevOps writes

Environment variables:
  AZURE_DEVOPS_PAT          Azure DevOps personal access token (required)
  AZURE_DEVOPS_ORG          Azure DevOps organization name (required)
  AZURE_DEVOPS_PROJECT      Azure DevOps project name (required)
  AZURE_DEVOPS_REPO_IDS     Comma-separated repository IDs (required)
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
    console.log(`Done: ${result.processed} processed, ${result.skipped} skipped, ${result.errors} errors`);
    break;
  }

  case 'test-pr': {
    const prIdArg = process.argv[3];
    if (!prIdArg || isNaN(Number(prIdArg))) {
      console.error('Usage: devops-pull test-pr <pr-id>');
      process.exitCode = 1;
      break;
    }
    const config = loadConfig();
    config.dryRun = true;
    console.log(`[DRY RUN] Testing processing for PR #${prIdArg}\n`);
    const repoId = config.repoIds[0]!;
    const pr = await getPullRequest(config, repoId, Number(prIdArg));
    const result = await processPR(config, pr);
    console.log(`\nDone: ${result.processed} generated, ${result.skipped} skipped, ${result.errors} errors`);
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

**Step 2: Verify it runs**

Run: `bun src/cli/index.ts help`
Expected: Prints help text

**Step 3: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat: add CLI entry point with command dispatcher"
```

---

### Task 10: Integration test

**Files:**
- Create: `tests/integration/end-to-end.test.ts`

**Step 1: Write integration test**

```typescript
import { describe, test, expect } from 'bun:test';
import { loadConfig } from '../../src/config/index.ts';
import { listCompletedPRs, getPRWorkItems, getWorkItem } from '../../src/sdk/azure-devops-client.ts';

const hasCredentials = Boolean(
  process.env.AZURE_DEVOPS_PAT &&
  process.env.AZURE_DEVOPS_ORG &&
  process.env.AZURE_DEVOPS_PROJECT &&
  process.env.AZURE_DEVOPS_REPO_IDS,
);

describe.skipIf(!hasCredentials)('Integration: Azure DevOps API', () => {
  test('can list completed PRs', async () => {
    const config = loadConfig();
    const repoId = config.repoIds[0]!;
    const prs = await listCompletedPRs(config, repoId, 5);
    expect(Array.isArray(prs)).toBe(true);
    if (prs.length > 0) {
      const pr = prs[0]!;
      expect(pr.pullRequestId).toBeNumber();
      expect(pr.title).toBeString();
      expect(pr.status).toBe('completed');
    }
  });

  test('can get PR work items', async () => {
    const config = loadConfig();
    const repoId = config.repoIds[0]!;
    const prs = await listCompletedPRs(config, repoId, 5);
    if (prs.length > 0) {
      const pr = prs[0]!;
      const workItems = await getPRWorkItems(config, repoId, pr.pullRequestId);
      expect(Array.isArray(workItems)).toBe(true);
    }
  });

  test('can get work item details', async () => {
    const config = loadConfig();
    const repoId = config.repoIds[0]!;
    const prs = await listCompletedPRs(config, repoId, 5);
    if (prs.length > 0) {
      const pr = prs[0]!;
      const workItems = await getPRWorkItems(config, repoId, pr.pullRequestId);
      if (workItems.length > 0) {
        const wi = await getWorkItem(config, Number(workItems[0]!.id));
        expect(wi.id).toBeNumber();
        expect(wi.fields).toBeDefined();
        expect(wi.fields['System.Title']).toBeString();
      }
    }
  });
});
```

**Step 2: Run full test suite**

Run: `bun test --preload ./tests/setup.ts tests/**/*.test.ts`
Expected: All unit tests PASS, integration tests skipped (no credentials)

**Step 3: Commit**

```bash
git add tests/integration/end-to-end.test.ts
git commit -m "feat: add integration test for end-to-end flow"
```

---

### Task 11: Documentation

**Files:**
- Modify: `README.md`
- Create: `PATTERNS.md`
- Modify: `CLAUDE.md`

**Step 1: Write README.md**

```markdown
# DevOpsPullTemplate

A GitHub template repository for building Azure DevOps automation projects with Bun, TypeScript, Zod, and Claude AI.

## What is this?

This template provides production-ready scaffolding for projects that:
- Pull data from Azure DevOps (PRs, work items, commits)
- Process items with AI using Claude
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
3. **Replace the processor** — edit `src/services/processor.ts` with your business logic
4. **Replace the AI prompt** — edit `.claude/commands/do-process-item.md`
5. **Update types** — add project-specific interfaces to `src/types/index.ts`
6. **Update this README** — describe what your project does

## Project structure

```
src/
├── cli/index.ts              # CLI entry point (watch, run-once, test-pr, reset-state)
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
| `bun src/cli/index.ts test-pr <id>` | Process a single PR in dry-run mode |
| `bun src/cli/index.ts reset-state` | Clear processed state |
| `bun test` | Run all tests |
| `bun run typecheck` | Run TypeScript type checking |

Add `--dry-run` to any command to skip Azure DevOps writes.

## Patterns

See [PATTERNS.md](PATTERNS.md) for a quick reference of all architectural patterns used in this template.
```

**Step 2: Write PATTERNS.md**

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

Simple `switch` statement on `process.argv[2]`. Supports `watch`, `run-once`, `test-pr <id>`, `reset-state`, `help`. Global `--dry-run` flag. No external CLI framework needed.

## Testing with Mock Helpers

**Files:** `tests/services/processor.test.ts`, `tests/services/watcher.test.ts`

`mockConfig()`, `mockPR()`, and `makeDeps()` factory functions create test fixtures with sensible defaults. Override specific fields via spread syntax. Uses `bun:test` mock functions.
```

**Step 3: Update CLAUDE.md**

```markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DevOpsPullTemplate is a GitHub template repository for Azure DevOps automation projects. It provides production-ready scaffolding for pulling data from Azure DevOps, processing it (optionally with AI), and tracking state.

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

## Commands

- `bun test` — run all tests
- `bun run typecheck` — TypeScript type checking
- `bun run start` — start the watcher
- `bun run once` — single poll cycle

## File Layout

- `src/config/` — Zod env validation
- `src/sdk/` — Azure DevOps REST client
- `src/services/` — business logic (processor, watcher, AI generator)
- `src/state/` — JSON persistence
- `src/types/` — shared interfaces
- `tests/` — mirrors src/ structure
```

**Step 4: Commit**

```bash
git add README.md PATTERNS.md CLAUDE.md
git commit -m "docs: add README, PATTERNS reference, and CLAUDE.md"
```

---

### Task 12: Full verification

**Step 1: Run full test suite**

Run: `bun test --preload ./tests/setup.ts tests/**/*.test.ts`
Expected: All tests PASS (integration tests skipped without credentials)

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

**Step 3: Verify CLI works**

Run: `bun src/cli/index.ts help`
Expected: Prints help text

**Step 4: Verify file structure is complete**

Run: `find . -not -path './node_modules/*' -not -path './.git/*' -type f | sort`
Expected: All planned files present

**Step 5: Mark repo as template (manual)**

Go to GitHub repo Settings → check "Template repository"
