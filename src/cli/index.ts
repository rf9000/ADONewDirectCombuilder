#!/usr/bin/env bun

import { loadConfig } from '../config/index.ts';
import { startWatcher, runPollCycle } from '../services/watcher.ts';
import { StateStore } from '../state/state-store.ts';
import { getWorkItem } from '../sdk/azure-devops-client.ts';
import { processItem } from '../services/processor.ts';
import { removeAllWorktrees } from '../services/workspace.ts';

const HELP = `
New Bank Communication Builder

Polls Azure DevOps for work items tagged with TRIGGER_TAG, plans a new bank
communication with the bank-integration-planner skill, implements it in git
worktrees of the Continia Banking and setup-files repos, verifies it on a BC
environment, and opens a draft pull request on each repo.

Usage:
  bun run src/cli/index.ts <command>

Commands:
  watch                Start the long-running watcher (polls every N minutes)
  run-once             Run a single poll cycle and exit
  run-item <id>        Run the pipeline for one work item, ignoring its tags
  status               Show tracked jobs and their phases
  reset-state          Clear all job state and exit
  reset-item <id>      Clear state for one work item so it runs from scratch
  cleanup-worktrees <id>  Remove the worktrees for one work item
  help                 Show this help message

Options:
  --dry-run            Read the work item and its comments, then stop (no writes)

Configuration is read from the environment; see .env.example for every variable.
`.trim();

const command = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

function requireItemId(): number | undefined {
  const arg = process.argv[3];
  if (!arg || Number.isNaN(Number(arg))) {
    console.error(`Usage: bun run src/cli/index.ts ${command} <work-item-id>`);
    process.exitCode = 1;
    return undefined;
  }
  return Number(arg);
}

switch (command) {
  case 'watch': {
    const config = loadConfig();
    config.dryRun = dryRun;
    if (dryRun) console.log('[DRY RUN] No writes will be made\n');
    await startWatcher(config);
    break;
  }

  case 'run-once': {
    const config = loadConfig();
    config.dryRun = dryRun;
    if (dryRun) console.log('[DRY RUN] No writes will be made\n');
    const stateStore = new StateStore(config.stateDir);
    const result = await runPollCycle(config, stateStore);
    console.log(
      `Done: ${result.processed} processed, ${result.errors} errors, ${result.skipped} skipped`,
    );
    break;
  }

  case 'run-item': {
    const itemId = requireItemId();
    if (itemId === undefined) break;

    const config = loadConfig();
    config.dryRun = dryRun;
    if (dryRun) console.log(`[DRY RUN] Reading work item #${itemId}\n`);

    const stateStore = new StateStore(config.stateDir);
    const item = await getWorkItem(config, itemId);
    const result = await processItem(config, item, stateStore);
    stateStore.save();
    console.log(
      `\nDone: phase=${result.phase}${result.error ? ` error=${result.error}` : ''}`,
    );
    if (!result.processed) process.exitCode = 1;
    break;
  }

  case 'status': {
    const config = loadConfig();
    const stateStore = new StateStore(config.stateDir);
    const jobs = stateStore.all();

    console.log(`Org/project: ${config.org}/${config.project}`);
    console.log(`Trigger tag: ${config.triggerTag}`);
    console.log(`Poll interval: ${config.pollIntervalMinutes} minute(s)`);
    console.log(`Banking repo: ${config.repos.banking.name} (${config.repos.banking.id || 'ID NOT SET'})`);
    console.log(
      `Setup-files repo: ${config.repos.setupFiles.name} (${config.repos.setupFiles.id || 'ID NOT SET'})`,
    );
    console.log(`Build/test: ${config.skipBuildTest ? 'SKIPPED' : 'enabled'}`);
    console.log(`\n${jobs.length} tracked job(s): ${JSON.stringify(stateStore.countByPhase())}\n`);

    for (const job of jobs.sort((a, b) => a.itemId - b.itemId)) {
      const prs = job.prs.map((pr) => `!${pr.pullRequestId}`).join(' ');
      console.log(
        `  #${job.itemId}  ${job.phase.padEnd(17)} rounds=${job.clarifyRounds}` +
          `${job.branch ? `  ${job.branch}` : ''}${prs ? `  PRs: ${prs}` : ''}` +
          `${job.error ? `\n      error: ${job.error}` : ''}`,
      );
    }
    break;
  }

  case 'reset-state': {
    const config = loadConfig();
    const stateStore = new StateStore(config.stateDir);
    stateStore.reset();
    console.log('Job state has been reset');
    break;
  }

  case 'reset-item': {
    const itemId = requireItemId();
    if (itemId === undefined) break;
    const config = loadConfig();
    const stateStore = new StateStore(config.stateDir);
    stateStore.remove(itemId);
    stateStore.save();
    console.log(`State for #${itemId} cleared`);
    break;
  }

  case 'cleanup-worktrees': {
    const itemId = requireItemId();
    if (itemId === undefined) break;
    const config = loadConfig();
    await removeAllWorktrees(config, itemId);
    const stateStore = new StateStore(config.stateDir);
    if (stateStore.get(itemId)) {
      stateStore.update(itemId, { worktrees: {} });
      stateStore.save();
    }
    console.log(`Worktrees for #${itemId} removed`);
    break;
  }

  case 'help':
  default:
    console.log(HELP);
    break;
}
