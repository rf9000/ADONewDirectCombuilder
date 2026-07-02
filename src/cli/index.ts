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
