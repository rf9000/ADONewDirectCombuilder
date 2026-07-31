import type {
  AppConfig,
  WorkItemResponse,
  WiqlQueryResult,
  WorkItemComment,
  WorkItemCommentsResult,
  GitRef,
  PullRequestRef,
  RepoTarget,
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

export async function queryWorkItems(
  config: AppConfig,
  wiql: string,
): Promise<number[]> {
  const path = 'wit/wiql?api-version=7.0';
  const data = await adoFetchWithRetry<WiqlQueryResult>(config, path, {
    method: 'POST',
    body: JSON.stringify({ query: wiql }),
  });
  return data.workItems.map((wi) => wi.id);
}

export async function getWorkItem(
  config: AppConfig,
  workItemId: number,
): Promise<WorkItemResponse> {
  const path = `wit/workitems/${workItemId}?$expand=all&api-version=7.0`;
  return adoFetchWithRetry<WorkItemResponse>(config, path);
}

export async function getWorkItemsBatch(
  config: AppConfig,
  ids: number[],
): Promise<WorkItemResponse[]> {
  if (ids.length === 0) return [];
  const idList = ids.join(',');
  const path = `wit/workitems?ids=${idList}&$expand=all&api-version=7.0`;
  const data = await adoFetchWithRetry<{ value: WorkItemResponse[] }>(
    config,
    path,
  );
  return data.value;
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

// ---------------------------------------------------------------------------
// Work item comments
// ---------------------------------------------------------------------------

/** The comments endpoint is still preview-only in API 7.0. */
const COMMENTS_API_VERSION = '7.0-preview.3';

export async function getWorkItemComments(
  config: AppConfig,
  workItemId: number,
): Promise<WorkItemComment[]> {
  const path = `wit/workItems/${workItemId}/comments?api-version=${COMMENTS_API_VERSION}`;
  const data = await adoFetchWithRetry<WorkItemCommentsResult>(config, path);
  // Oldest first, so the conversation reads top-to-bottom.
  return [...(data.comments ?? [])].sort((a, b) => a.id - b.id);
}

export async function addWorkItemComment(
  config: AppConfig,
  workItemId: number,
  text: string,
): Promise<WorkItemComment> {
  const path = `wit/workItems/${workItemId}/comments?api-version=${COMMENTS_API_VERSION}`;
  return adoFetchWithRetry<WorkItemComment>(config, path, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** Azure DevOps stores tags as a single '; '-separated string. */
export function parseTags(item: WorkItemResponse): string[] {
  const raw = item.fields['System.Tags'];
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw
    .split(';')
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

export function hasTag(item: WorkItemResponse, tag: string): boolean {
  const wanted = tag.toLowerCase();
  return parseTags(item).some((t) => t.toLowerCase() === wanted);
}

export async function setWorkItemTags(
  config: AppConfig,
  workItemId: number,
  tags: string[],
): Promise<WorkItemResponse> {
  return updateWorkItemField(config, workItemId, 'System.Tags', tags.join('; '));
}

/**
 * Swap tags in one PATCH: everything in `remove` goes, everything in `add`
 * arrives. Case-insensitive on removal, order-preserving otherwise.
 */
export async function swapWorkItemTags(
  config: AppConfig,
  item: WorkItemResponse,
  remove: string[],
  add: string[],
): Promise<WorkItemResponse> {
  const removeSet = new Set(remove.map((t) => t.toLowerCase()));
  const kept = parseTags(item).filter((t) => !removeSet.has(t.toLowerCase()));
  const keptSet = new Set(kept.map((t) => t.toLowerCase()));
  const added = add.filter((t) => !keptSet.has(t.toLowerCase()));
  return setWorkItemTags(config, item.id, [...kept, ...added]);
}

// ---------------------------------------------------------------------------
// Git: refs, branches, pull requests
// ---------------------------------------------------------------------------

export async function getBranchTip(
  config: AppConfig,
  repoId: string,
  branch: string,
): Promise<GitRef> {
  const path =
    `git/repositories/${encodeURIComponent(repoId)}/refs` +
    `?filter=heads/${encodeURIComponent(branch)}&api-version=7.0`;
  const data = await adoFetchWithRetry<{ value: GitRef[] }>(config, path);
  const ref = data.value?.[0];
  if (!ref) {
    throw new Error(`Branch '${branch}' not found in repository ${repoId}`);
  }
  return ref;
}

export async function createBranch(
  config: AppConfig,
  repoId: string,
  branch: string,
  baseObjectId: string,
): Promise<void> {
  const path = `git/repositories/${encodeURIComponent(repoId)}/refs?api-version=7.0`;
  await adoFetchWithRetry(config, path, {
    method: 'POST',
    body: JSON.stringify([
      {
        name: `refs/heads/${branch}`,
        oldObjectId: '0000000000000000000000000000000000000000',
        newObjectId: baseObjectId,
      },
    ]),
  });
}

export interface CreatePullRequestOptions {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  isDraft: boolean;
  workItemIds?: number[];
  reviewerIds?: string[];
}

interface PullRequestResponse {
  pullRequestId: number;
  repository?: { webUrl?: string; name?: string };
  isDraft?: boolean;
  url?: string;
}

export async function createPullRequest(
  config: AppConfig,
  repo: RepoTarget,
  options: CreatePullRequestOptions,
): Promise<PullRequestRef> {
  const path = `git/repositories/${encodeURIComponent(repo.id)}/pullrequests?api-version=7.0`;

  const body: Record<string, unknown> = {
    title: options.title,
    description: options.description,
    sourceRefName: `refs/heads/${options.sourceBranch}`,
    targetRefName: `refs/heads/${options.targetBranch}`,
    isDraft: options.isDraft,
  };

  if (options.workItemIds && options.workItemIds.length > 0) {
    body.workItemRefs = options.workItemIds.map((id) => ({ id: String(id) }));
  }
  if (options.reviewerIds && options.reviewerIds.length > 0) {
    body.reviewers = options.reviewerIds.map((id) => ({ id }));
  }

  const pr = await adoFetchWithRetry<PullRequestResponse>(config, path, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const webUrl =
    pr.repository?.webUrl ??
    `${config.orgUrl}/${encodeURIComponent(config.project)}/_git/${encodeURIComponent(repo.name)}`;

  return {
    repoKey: repo.key,
    repoName: repo.name,
    pullRequestId: pr.pullRequestId,
    url: `${webUrl}/pullrequest/${pr.pullRequestId}`,
    isDraft: pr.isDraft ?? options.isDraft,
  };
}

/** Credential-free clone URL, safe to persist in .git/config. */
export function buildCloneUrl(config: AppConfig, repo: RepoTarget): string {
  const org = encodeURIComponent(config.org);
  const project = encodeURIComponent(config.project);
  const name = encodeURIComponent(repo.name);
  return `https://dev.azure.com/${org}/${project}/_git/${name}`;
}

/**
 * Per-invocation git auth. Passed as `-c` args so the PAT never lands in
 * .git/config, where it would survive in the cached mirror clone.
 */
export function buildGitAuthArgs(config: AppConfig): string[] {
  const basic = Buffer.from(':' + config.pat).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}
