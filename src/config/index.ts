import { z } from "zod";
import type { AppConfig } from "../types/index.ts";

/**
 * Built from the trigger tag rather than hardcoded, so changing TRIGGER_TAG
 * changes what we poll for. AZURE_DEVOPS_WIQL_QUERY still overrides it entirely.
 */
export function buildTagWiql(tag: string): string {
  return (
    "SELECT [System.Id] FROM workitems " +
    `WHERE [System.Tags] CONTAINS '${tag}' AND [System.State] <> 'Closed' ` +
    "ORDER BY [System.ChangedDate] ASC"
  );
}

/** Env vars are strings; accept the usual truthy spellings. */
function boolFlag(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? defaultValue
        : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()),
    );
}

const envSchema = z.object({
  // --- Azure DevOps (required) ---
  AZURE_DEVOPS_PAT: z.string().min(1, "AZURE_DEVOPS_PAT is required"),
  AZURE_DEVOPS_ORG: z.string().min(1, "AZURE_DEVOPS_ORG is required"),
  AZURE_DEVOPS_PROJECT: z.string().min(1, "AZURE_DEVOPS_PROJECT is required"),
  AZURE_DEVOPS_WIQL_QUERY: z.string().optional(),

  // --- Trigger tags ---
  TRIGGER_TAG: z.string().default("create-new-comm"),
  WAITING_TAG: z.string().default("create-new-comm-waiting"),
  DONE_TAG: z.string().default("create-new-comm-done"),
  FAILED_TAG: z.string().default("create-new-comm-failed"),

  // --- Polling / job control ---
  POLL_INTERVAL_MINUTES: z.coerce.number().positive().default(5),
  JOB_TIMEOUT_MINUTES: z.coerce.number().positive().default(240),
  MAX_CLARIFY_ROUNDS: z.coerce.number().int().nonnegative().default(3),

  // --- Claude ---
  CLAUDE_MODEL: z.string().default("claude-opus-5"),
  AGENT_MAX_TURNS: z.coerce.number().int().positive().default(400),

  // --- Repositories ---
  BANKING_REPO_NAME: z.string().default("Continia Banking"),
  BANKING_REPO_ID: z.string().default(""),
  BANKING_DEFAULT_BRANCH: z.string().default("main"),
  SETUP_FILES_REPO_NAME: z.string().default("Continia Banking Setup Files"),
  SETUP_FILES_REPO_ID: z.string().default(""),
  SETUP_FILES_DEFAULT_BRANCH: z.string().default("main"),

  // --- Paths ---
  REPO_CACHE_DIR: z.string().default("/data/repos"),
  WORKTREE_ROOT: z.string().default("/data/worktrees"),
  LOG_DIR: z.string().default("/data/logs"),
  STATE_DIR: z.string().default("/data/state"),
  SKILLS_SOURCE_DIR: z.string().default("/app/.claude"),

  // --- Continia CLI ---
  CONTINIA_CLI_PATH: z.string().default("/usr/local/bin/continia"),

  // --- Behaviour ---
  DRAFT_PR: boolFlag(true),
  SKIP_BUILD_TEST: boolFlag(false),
  BRANCH_PREFIX: z.string().default("Userstory/agent"),
  PR_REVIEWER_IDS: z.string().default(""),
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
    wiqlQuery:
      parsed.AZURE_DEVOPS_WIQL_QUERY && parsed.AZURE_DEVOPS_WIQL_QUERY.trim() !== ''
        ? parsed.AZURE_DEVOPS_WIQL_QUERY
        : buildTagWiql(parsed.TRIGGER_TAG),

    triggerTag: parsed.TRIGGER_TAG,
    waitingTag: parsed.WAITING_TAG,
    doneTag: parsed.DONE_TAG,
    failedTag: parsed.FAILED_TAG,

    pollIntervalMinutes: parsed.POLL_INTERVAL_MINUTES,
    jobTimeoutMinutes: parsed.JOB_TIMEOUT_MINUTES,
    maxClarifyRounds: parsed.MAX_CLARIFY_ROUNDS,

    claudeModel: parsed.CLAUDE_MODEL,
    agentMaxTurns: parsed.AGENT_MAX_TURNS,

    repos: {
      banking: {
        key: 'banking',
        name: parsed.BANKING_REPO_NAME,
        id: parsed.BANKING_REPO_ID,
        defaultBranch: parsed.BANKING_DEFAULT_BRANCH,
      },
      setupFiles: {
        key: 'setupFiles',
        name: parsed.SETUP_FILES_REPO_NAME,
        id: parsed.SETUP_FILES_REPO_ID,
        defaultBranch: parsed.SETUP_FILES_DEFAULT_BRANCH,
      },
    },

    repoCacheDir: parsed.REPO_CACHE_DIR,
    worktreeRoot: parsed.WORKTREE_ROOT,
    logDir: parsed.LOG_DIR,
    stateDir: parsed.STATE_DIR,
    skillsSourceDir: parsed.SKILLS_SOURCE_DIR,

    continiaCliPath: parsed.CONTINIA_CLI_PATH,

    draftPr: parsed.DRAFT_PR,
    skipBuildTest: parsed.SKIP_BUILD_TEST,
    branchPrefix: parsed.BRANCH_PREFIX,
    reviewerIds: parsed.PR_REVIEWER_IDS.split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    dryRun: false,
  };
}
