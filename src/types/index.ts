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

  // --- Claude ---
  claudeModel: string;
  agentMaxTurns: number;

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

/** Outcome of one agent SDK run. */
export interface AgentRunResult {
  /** Final assistant text. */
  text: string;
  /** Session id, for resuming a later round. */
  sessionId?: string;
  /** True when the SDK reported subtype 'success'. */
  success: boolean;
  costUsd: number;
  numTurns: number;
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
}

/** Structured result of the verify phase. */
export interface VerifyResult {
  passed: boolean;
  envId?: string;
  envUrl?: string;
  summary: string;
  failedTests?: string[];
}
