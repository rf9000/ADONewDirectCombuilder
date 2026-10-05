/** A git repository the pipeline creates branches and pull requests in. */
export interface RepoTarget {
  /** Short key used in paths, state and logs. */
  key: 'banking' | 'setupFiles';
  /** Azure DevOps repository name (used to build the clone URL). */
  name: string;
  /** Azure DevOps repository GUID (used by the REST API). */
  id: string;
  /** Branch new work is based on and pull requests target. */
  defaultBranch: string;
  /**
   * Optional path to a local clone of the same repo, used only to seed the
   * first bare clone (`git clone --reference`). On the deployment host the
   * product repos are already bind-mounted read-only, so seeding turns a
   * multi-gigabyte download into a local object copy. Objects are copied and
   * the alternate dropped, so the cache never depends on the mount surviving.
   */
  seedPath?: string;
}

/** Application configuration loaded from environment variables. */
export interface AppConfig {
  // --- Azure DevOps ---
  org: string;
  orgUrl: string;
  project: string;
  pat: string;
  wiqlQuery: string;

  // --- Trigger tags ---
  triggerTag: string;
  waitingTag: string;
  doneTag: string;
  failedTag: string;

  // --- Polling / job control ---
  pollIntervalMinutes: number;
  jobTimeoutMinutes: number;
  maxClarifyRounds: number;
  /** Rounds that may pause when only ambiguities (no blocking questions) are open. */
  maxAmbiguityRounds: number;

  // --- Claude ---
  claudeModel: string;
  agentMaxTurns: number;
  /** Spend cap in USD for a single agent run (one phase). */
  agentMaxBudgetUsd: number;
  /** Spend cap in USD across every agent run a job has ever made. */
  jobMaxBudgetUsd: number;
  /** Spend cap in USD across every planning run a job has made, nudges included. */
  planningMaxBudgetUsd: number;
  /** Implement does not start unless at least this much job budget is left. */
  implementMinBudgetUsd: number;
  /**
   * Folder of a Claude Code plugin that provides the AL language server. When
   * set, agents load it and may use the LSP tool. Unset: no language server.
   */
  alLspPluginDir?: string;

  // --- Repositories ---
  repos: {
    banking: RepoTarget;
    setupFiles: RepoTarget;
  };

  // --- Paths ---
  repoCacheDir: string;
  worktreeRoot: string;
  logDir: string;
  stateDir: string;
  skillsSourceDir: string;

  // --- Continia CLI ---
  continiaCliPath: string;

  // --- Behaviour ---
  draftPr: boolean;
  skipBuildTest: boolean;
  branchPrefix: string;
  reviewerIds: string[];
  dryRun: boolean;
}

/** Response shape when fetching a single work item. */
export interface WorkItemResponse {
  id: number;
  fields: Record<string, unknown>;
  rev: number;
  url: string;
  /** Links and attachments; present when fetched with `$expand=all`. */
  relations?: Array<{ rel: string; url: string; attributes?: { name?: string } }>;
}

/** Response shape from a WIQL query. */
export interface WiqlQueryResult {
  workItems: Array<{ id: number; url: string }>;
}

/** A single comment on a work item. */
export interface WorkItemComment {
  id: number;
  text: string;
  createdBy?: { displayName?: string; uniqueName?: string };
  createdDate?: string;
}

/** Response shape from the work item comments endpoint. */
export interface WorkItemCommentsResult {
  totalCount: number;
  count: number;
  comments: WorkItemComment[];
}

/** A git ref as returned by the refs endpoint. */
export interface GitRef {
  name: string;
  objectId: string;
}

/** Reference to a created pull request. */
export interface PullRequestRef {
  repoKey: RepoTarget['key'];
  repoName: string;
  pullRequestId: number;
  url: string;
  isDraft: boolean;
  /** `vstfs:///Git/PullRequestId/...` — what a work item ArtifactLink points at. */
  artifactId?: string;
}

/** Where a work item's job currently sits in the pipeline. */
export type JobPhase =
  | 'new'
  | 'planning'
  | 'awaiting-answers'
  | 'implementing'
  | 'verifying'
  | 'publishing'
  | 'done'
  | 'failed';

/** Persisted per-work-item pipeline state. */
export interface JobRecord {
  itemId: number;
  phase: JobPhase;
  /** How many times we have asked the human for clarification. */
  clarifyRounds: number;
  /** Highest comment id we had already read when we last planned. */
  lastSeenCommentId: number;
  /**
   * Agent SDK session id of the last planning run, for correlating logs and
   * transcripts. Clarification rounds re-plan from the (durable) ADO comment
   * thread rather than resuming this session, so it survives a container restart.
   */
  plannerSessionId?: string;
  /** Absolute worktree paths, present while a job is active. */
  worktrees: Partial<Record<RepoTarget['key'], string>>;
  /** Branch name used in both repos. */
  branch?: string;
  /** Pull requests created during the publishing phase. */
  prs: PullRequestRef[];
  /** Path to the assembled design doc, relative to the banking worktree. */
  designDocPath?: string;
  /** Last error message, when phase is 'failed'. */
  error?: string;
  /**
   * Phase that threw, when phase is 'failed'. A retry resumes here instead of
   * re-planning from scratch.
   */
  failedAtPhase?: JobPhase;
  /**
   * Total USD spent on agent runs for this job, across every phase, round and
   * retry. Checked against `jobMaxBudgetUsd` before each agent run; only
   * `reset-budget <id>` (or `reset-item`) sets it back to zero.
   */
  spentUsd?: number;
  /**
   * The planning share of `spentUsd`, checked against `planningMaxBudgetUsd`.
   * Reset together with `spentUsd`.
   */
  planningSpentUsd?: number;
  updatedAt: string;
}

/** On-disk shape of the state file. */
export interface JobState {
  jobs: JobRecord[];
  lastRunAt: string;
}

/** Result summary after processing a single item. */
export interface ItemProcessResult {
  itemId: number;
  processed: boolean;
  phase: JobPhase;
  error?: string;
}

/** Reasoning effort accepted by the Agent SDK. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** How a local experiment authenticates the Claude Code child process. */
export type AuthMode = 'subscription' | 'api-key';

/** Tokens and cost one model spent during an agent run. */
export interface ModelUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** Last plan rate-limit state the SDK reported (subscription auth only). */
export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  type?: string;
  resetsAt?: number;
}

/**
 * Per-run changes to how an agent runs. Production never sets these; the
 * experiment command uses them to try cheaper configurations.
 */
export interface AgentOverrides {
  model?: string;
  effort?: EffortLevel;
  /** Model for subagents the agent dispatches, via CLAUDE_CODE_SUBAGENT_MODEL. */
  subagentModel?: string;
  /** Base environment for the Claude Code child process. */
  env?: Record<string, string | undefined>;
  /** False loads no MCP servers. Defaults to true. */
  mcp?: boolean;
  /** False keeps the AL language server out of this run even when configured. */
  lsp?: boolean;
}

/** Outcome of one agent SDK run. */
export interface AgentRunResult {
  /** Final assistant text. */
  text: string;
  /** Session id, for resuming a later round. */
  sessionId?: string;
  /** True when the SDK reported subtype 'success'. */
  success: boolean;
  /** SDK result subtype of the last result, e.g. 'error_max_budget_usd'. */
  subtype?: string;
  costUsd: number;
  numTurns: number;
  /** Per-model usage from the last result message — cumulative, never summed. */
  modelUsage?: Record<string, ModelUsageSummary>;
  durationMs?: number;
  /** Last rate-limit event, or the first rejection if one happened. */
  rateLimit?: RateLimitInfo;
  /** Last assistant-message error the SDK reported, e.g. 'rate_limit'. */
  assistantError?: string;
}

/** A question the planner needs a human to answer. */
export interface PlanQuestion {
  question: string;
  /** Present for ambiguities the planner resolved itself. */
  decisionTaken?: string;
  rationale?: string;
}

/** Machine-readable planner output the orchestrator turns into a comment. */
export interface PlanQuestions {
  blocking: PlanQuestion[];
  ambiguities: PlanQuestion[];
}

/** Artifacts the planner reports once a plan is complete. */
export interface PlanArtifacts {
  bankName: string;
  designDocPath: string;
  taskListPath: string;
  objectCount?: number;
  testCount?: number;
  waveCount?: number;
  /** Follow-up rounds only: whether the planner patched the plan or re-planned it. */
  revisionMode?: 'incremental' | 'full';
  revisionReason?: string;
}

/** One task's outcome, as the implement agent reports it. */
export interface ImplementTaskStatus {
  /** The task's `id` in plan/tasklist.json. */
  id: number | string;
  status: 'done' | 'blocked';
  /** Required for `blocked`: why the task cannot be done. */
  note?: string;
}

/** Structured result of the implement phase (implement/result.json). */
export interface ImplementResult {
  /** Reviewer-facing change summary; becomes the PR description. */
  summary?: string;
  tasks: ImplementTaskStatus[];
}

/** Structured result of the verify phase. */
export interface VerifyResult {
  passed: boolean;
  envId?: string;
  envUrl?: string;
  summary: string;
  failedTests?: string[];
}
