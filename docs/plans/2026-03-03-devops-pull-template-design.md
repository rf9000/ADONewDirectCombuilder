# DevOpsPullTemplate Design

## Context

We're building a GitHub template repository that serves as a baseline for new Azure DevOps automation projects. Each new project (release note generation, bug investigation, Zendesk sync, etc.) follows the same architecture, so scaffolding should be ready out of the box.

Reference project: `C:\GeneralDev\AzureDevopsReleaseNoteCreator`

## Approach

Mirror the reference project structure exactly (Approach A), replacing project-specific logic with generic stubs. Developers familiar with the release note creator will instantly recognize the layout.

## Architecture

### Project Config & Tooling

```
DevOpsPullTemplate/
├── package.json          # bun scripts: start, once, test
├── tsconfig.json         # ESNext, strict mode
├── .env.example          # All env vars with comments
├── .gitignore            # node_modules, .env, .state/
├── README.md             # Setup guide + "How to use this template"
├── PATTERNS.md           # Quick-reference for all patterns
├── CLAUDE.md             # Claude Code project guidance
└── .claude/
    └── commands/
        └── do-process-item.md   # Example Claude prompt template
```

**Dependencies:** `zod`, `@anthropic-ai/claude-agent-sdk`
**Dev dependencies:** `@types/bun`, `typescript`

**Environment variables (.env.example):**
- Required: `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PROJECT`, `AZURE_DEVOPS_REPO_IDS`
- Optional with defaults: `POLL_INTERVAL_MINUTES` (15), `CLAUDE_MODEL` (claude-sonnet-4-6), `STATE_DIR` (.state), `PROMPT_PATH` (.claude/commands/do-process-item.md)

### Source Code

```
src/
├── cli/index.ts              # Command dispatcher: watch, run-once, reset-state, help, --dry-run
├── config/index.ts           # Zod env validation, typed AppConfig, testable via env param
├── sdk/azure-devops-client.ts # adoFetch + adoFetchWithRetry, AzureDevOpsError, exported API helpers
├── services/
│   ├── watcher.ts            # Polling loop, AbortController, interruptible sleep, SIGINT/SIGTERM
│   ├── processor.ts          # DI pattern, stub: fetch PRs → get work items → call AI → log
│   └── ai-generator.ts       # DI pattern, stub: load prompt, build context, call query()
├── state/state-store.ts      # Class: load/save/isProcessed/markProcessed/reset, JSON persistence
└── types/index.ts            # AppConfig, AzureDevOpsPullRequest, WorkItemResponse, ProcessResult, etc.
```

**Key patterns:**
- Dependency injection via interfaces for all services (testability)
- Exponential backoff retry on 5xx/network errors, immediate re-throw on 4xx
- Graceful shutdown via AbortController + signal listeners
- State tracking with Set-based O(1) lookups + JSON persistence
- Claude integration via @anthropic-ai/claude-agent-sdk query()

### Tests

```
tests/
├── setup.ts                          # Clean env vars
├── config/config.test.ts             # Valid, missing, defaults
├── sdk/azure-devops-client.test.ts   # Fetch, retry, errors
├── services/
│   ├── watcher.test.ts               # Poll cycle, shutdown
│   ├── processor.test.ts             # DI mocks, happy path, edge cases
│   └── ai-generator.test.ts          # Prompt building, Claude call
├── state/state-store.test.ts         # Load, save, corruption recovery
└── integration/end-to-end.test.ts    # Full flow with mocked ADO + Claude
```

Mock helpers: `mockConfig()`, `mockPR()`, `makeDeps()`. All tests pass with no real API calls.

### Documentation

- **README.md:** What is this, getting started, project structure
- **PATTERNS.md:** Quick-reference for each pattern (Zod config, DI, retry, state store, polling, Claude SDK, CLI dispatch) with links to source files
- **CLAUDE.md:** Architecture guidance for Claude Code
