# Generalize Template: PR-Specific → Generic with Work Item Example

**Date:** 2026-03-04
**Status:** Approved

## Context

The DevOpsPullTemplate is currently hardcoded around Azure DevOps Pull Requests. The template should be a general-purpose scaffold for periodically pulling data from Azure DevOps, processing it with Claude, and pushing results back. PRs are just one possible entity — work items, commits, builds, etc. are equally valid targets.

## Decision

**Approach A: Generic Core + Concrete Work Item Example.** Rename all PR-specific types/functions to generic names. Implement a working work item example as the shipped reference implementation. Keep the polling watcher + CLI one-shot trigger modes.

## Design

### Types (`src/types/index.ts`)

- **Remove:** `AzureDevOpsPullRequest`, `PRWorkItemRef`, `DiffChange`, `DiffResponse`
- **Rename:** `PRProcessResult` → `ItemProcessResult` (`prId` → `itemId`)
- **Rename:** `ProcessedState.processedPRIds` → `ProcessedState.processedItemIds`
- **Keep:** `WorkItemResponse` (becomes the core entity for the example)
- **Config change:** Replace `repoIds: string[]` with `wiqlQuery: string`

### SDK (`src/sdk/azure-devops-client.ts`)

- **Remove:** `listCompletedPRs`, `getPullRequest`, `getPRWorkItems`, `getPRChangedFiles`
- **Add:** `queryWorkItems(config, wiql)` — runs a WIQL query, returns work item IDs
- **Add:** `listWorkItemsBatch(config, ids)` — batch-fetch work items by ID
- **Keep:** `getWorkItem`, `updateWorkItemField`, `adoFetch`, `adoFetchWithRetry`

### Processor (`src/services/processor.ts`)

- `processPR(config, pr)` → `processItem(config, workItem)`
- `ProcessorDeps` simplified: remove PR-specific deps, keep `updateWorkItemField` + `generateWithAI`
- `GeneratorContext`: remove `prTitle`/`prDescription`, add `itemTitle`, `itemType`, `itemDescription`, `itemFields`

### AI Generator (`src/services/ai-generator.ts`)

- `GeneratorContext` updated with work-item fields instead of PR fields
- `buildUserPrompt` updated to format work item context instead of PR context

### Watcher (`src/services/watcher.ts`)

- No more repo iteration (work items are project-scoped)
- `WatcherDeps.listCompletedPRs` → `WatcherDeps.fetchItems` (WIQL query + batch fetch)
- Filters unprocessed items via state store, then calls `processItem`

### State Store (`src/state/state-store.ts`)

- File: `processed-prs.json` → `processed-items.json`
- Field: `processedPRIds` → `processedItemIds`
- Method params: `prId` → `itemId`

### CLI (`src/cli/index.ts`)

- `test-pr <id>` → `test-item <id>` (fetches single work item, dry-run)
- Help text updated throughout
- Remove `AZURE_DEVOPS_REPO_IDS` references

### Config (`src/config/index.ts`)

- Remove `AZURE_DEVOPS_REPO_IDS`
- Add `AZURE_DEVOPS_WIQL_QUERY` with sensible default

### Docs

- README.md — reframe around "pull data, process with Claude, push back"
- CLAUDE.md — update project description
- PATTERNS.md — update `mockPR()` → `mockWorkItem()`
- `.claude/commands/do-process-item.md` — minor updates

### Tests

All tests updated to mirror new naming. `mockPR()` → `mockWorkItem()`. Same test logic, different entity shapes.
