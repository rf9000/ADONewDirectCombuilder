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
