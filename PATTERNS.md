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
