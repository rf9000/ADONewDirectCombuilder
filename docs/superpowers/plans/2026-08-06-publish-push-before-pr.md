# Follow-up: make the publish phase survive a failure, and survive a resume

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Status:** not started. Hand over after `docs/superpowers/plans/2026-08-05-plan-resume.md` is
complete — Task 2 below is a **prerequisite for that plan's Task 5 being safe**, so do not run
the resumed pipeline in anger until this lands.

**Goal:** A failure while publishing must not destroy work, and re-entering the publish phase
must not create duplicate pull requests.

---

## What happened

Work item 80969, 2026-08-05. Implement and verify both completed. Publish then failed on ADO's
4000-character description limit (fixed separately in `549a3a9`). The observable damage was
worse than the error:

- **Continia Banking** — committed, pushed, branch exists on the remote.
- **setup-files** — no branch, no commit, work lost.

`pipeline.ts:336` interleaves the two operations per repository:

```ts
for (const repo of [config.repos.banking, config.repos.setupFiles]) {
  const pushed = await deps.commitAndPush(...);   // banking: succeeds
  if (!pushed) continue;
  const pr = await deps.createPullRequest(...);   // banking: throws
}                                                  // setup-files: never reached
```

The throw aborted the loop before setup-files was ever committed. The failure path then removed
the worktrees, so the JSON work — five files, with array counts the agent had asserted on — was
gone. It survived only as prose in the design doc.

Whether the AL half or the JSON half survives is decided by array order, which is not a property
anyone chose.

---

## Task 1: Push every repo before creating any pull request

**Files:**
- Modify: `src/services/pipeline.ts` — `runPublishPhase`
- Test: `tests/services/pipeline.test.ts`

**Interfaces:**
- Consumes: `deps.commitAndPush`, `deps.createPullRequest` — unchanged signatures
- Produces: `runPublishPhase` keeps its signature and return type

- [ ] **Step 1: Write the failing test**

```ts
test('every repo is pushed before any PR is created', async () => {
  const deps = makeDeps();
  // The first PR call throws, exactly as the 4000-character limit did.
  deps.createPullRequest = mock(() => {
    throw new Error('Invalid argument value.');
  });

  await runJob(config(), mockWorkItem(), store, deps).catch(() => undefined);

  // Both repos must already be on the remote: work is never lost to the
  // iteration order of a loop that fails partway.
  const pushed = (deps.commitAndPush as ReturnType<typeof mock>).mock.calls.map(
    (c) => String(c[1]),
  );
  expect(pushed.some((p) => p.endsWith('banking'))).toBe(true);
  expect(pushed.some((p) => p.endsWith('setupFiles'))).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/services/pipeline.test.ts`
Expected: FAIL — `setupFiles` was never pushed.

- [ ] **Step 3: Split the loop**

Replace the single loop in `runPublishPhase` with two:

```ts
  // Push everything first. A pull request that cannot be created is
  // recoverable; work that was never pushed is not — and on 80969 the loop
  // aborted on banking's PR and abandoned setup-files entirely.
  const pushedRepos: RepoTarget[] = [];
  for (const repo of [config.repos.banking, config.repos.setupFiles]) {
    const pushed = await deps.commitAndPush(
      config,
      ctx.worktrees[repo.key],
      ctx.branch,
      `${title}\n\nWork item #${item.id}`,
      COMMIT_AUTHOR,
    );
    if (pushed) pushedRepos.push(repo);
    else log(`  Item #${item.id}: ${repo.name} unchanged — no branch, no PR`);
  }

  for (const repo of pushedRepos) {
    const pr = await deps.createPullRequest(config, repo, {
      title,
      description,
      sourceBranch: ctx.branch,
      targetBranch: repo.defaultBranch,
      isDraft: config.draftPr,
      workItemIds: [item.id],
      reviewerIds: config.reviewerIds,
    });
    prs.push(pr);
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/pipeline.ts tests/services/pipeline.test.ts
git commit -m "Push every repo before creating any pull request

A throw creating the first repo's PR aborted the loop before the second was
ever committed. On work item 80969 that lost the whole setup-files change,
while the AL half survived purely because banking is first in the array. A
PR that cannot be created is recoverable; work that was never pushed is not."
```

---

## Task 2: Make publish idempotent — required before resume is safe

**Files:**
- Modify: `src/sdk/azure-devops-client.ts` — add `findActivePullRequest`
- Modify: `src/services/pipeline.ts` — `runPublishPhase`
- Test: `tests/sdk/azure-devops-client.test.ts`, `tests/services/pipeline.test.ts`

**Interfaces:**
- Produces:

```ts
export function findActivePullRequest(
  config: AppConfig,
  repo: RepoTarget,
  sourceBranch: string,
): Promise<PullRequestRef | undefined>;
```

**Why this blocks the resume plan.** `2026-08-05-plan-resume.md` Task 5 lets the pipeline enter
directly at `publishing`. Today publish always calls `createPullRequest`, so a job resumed after
a partial publish — banking's PR created, setup-files' throwing — would create a **second**
pull request for banking. `commitAndPush` is already idempotent (it no-ops when there is nothing
to commit); PR creation is not.

- [ ] **Step 1: Write the failing SDK test**

```ts
test('findActivePullRequest matches on the source branch', async () => {
  setMockFetch({
    value: [
      {
        pullRequestId: 100,
        repository: { name: 'Continia Banking' },
        isDraft: true,
        sourceRefName: 'refs/heads/Userstory/agent/42-x',
      },
    ],
  });

  const found = await findActivePullRequest(
    mockConfig(),
    mockConfig().repos.banking,
    'Userstory/agent/42-x',
  );

  expect(found?.pullRequestId).toBe(100);
  const url = mockFn.mock.calls[0]![0] as string;
  expect(url).toContain('searchCriteria.sourceRefName=refs%2Fheads%2F');
  expect(url).toContain('searchCriteria.status=active');
});

test('findActivePullRequest returns undefined when there is none', async () => {
  setMockFetch({ value: [] });
  const found = await findActivePullRequest(
    mockConfig(),
    mockConfig().repos.banking,
    'Userstory/agent/42-x',
  );
  expect(found).toBeUndefined();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/sdk/azure-devops-client.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the lookup**

```ts
/**
 * Find an open pull request already raised from `sourceBranch`.
 *
 * Publish is re-entrant: a job resumed at `publishing` must not raise a second
 * pull request for a repo whose PR already exists.
 */
export async function findActivePullRequest(
  config: AppConfig,
  repo: RepoTarget,
  sourceBranch: string,
): Promise<PullRequestRef | undefined> {
  const ref = encodeURIComponent(`refs/heads/${sourceBranch}`);
  const path =
    `git/repositories/${repo.id}/pullrequests` +
    `?searchCriteria.sourceRefName=${ref}` +
    `&searchCriteria.status=active&api-version=7.0`;

  const data = await adoFetchWithRetry<{ value?: RawPullRequest[] }>(config, path);
  const found = data.value?.[0];
  if (!found) return undefined;

  return {
    repoKey: repo.key,
    repoName: repo.name,
    pullRequestId: found.pullRequestId,
    url: pullRequestUrl(config, repo, found.pullRequestId),
    isDraft: found.isDraft ?? false,
  };
}
```

Reuse whatever type and URL helper `createPullRequest` already uses for its response rather than
introducing new ones.

- [ ] **Step 4: Write the failing pipeline test**

```ts
test('publish reuses an existing PR instead of creating a duplicate', async () => {
  const deps = makeDeps();
  deps.findActivePullRequest = mock(async (_cfg, repo) =>
    repo.key === 'banking'
      ? {
          repoKey: 'banking',
          repoName: repo.name,
          pullRequestId: 100,
          url: 'https://ado/banking/pullrequest/100',
          isDraft: true,
        }
      : undefined,
  );

  await runJob(config(), mockWorkItem(), store, deps);

  // Banking already had one; only setup-files should be created.
  const created = (deps.createPullRequest as ReturnType<typeof mock>).mock.calls.map(
    (c) => (c[1] as { key: string }).key,
  );
  expect(created).toEqual(['setupFiles']);
});
```

Add `findActivePullRequest` to `PipelineDeps`, to `defaultDeps`, and to `makeDeps()` with a
default of `mock(async () => undefined)`.

- [ ] **Step 5: Use it in publish**

In the PR loop from Task 1:

```ts
  for (const repo of pushedRepos) {
    // Publish is re-entrant — a resumed job must not raise a second PR.
    const existing = await deps.findActivePullRequest(config, repo, ctx.branch);
    if (existing) {
      log(`  Item #${item.id}: ${repo.name} already has PR !${existing.pullRequestId}`);
      prs.push(existing);
      continue;
    }
    const pr = await deps.createPullRequest(config, repo, { /* as before */ });
    prs.push(pr);
  }
```

- [ ] **Step 6: Run everything**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/sdk/azure-devops-client.ts src/services/pipeline.ts tests/
git commit -m "Make publish idempotent so a resumed job cannot double-raise PRs

commitAndPush already no-ops when there is nothing to commit; PR creation
did not. Once the pipeline can be entered at publishing, a job resumed after
a partial publish would raise a second pull request for the repo that had
already succeeded."
```

---

## Recovering work item 80969

The banking branch is on the remote with the AL objects. The setup-files change is gone; it is
specified file-by-file in the design doc (`~/80969-design-doc.md` on the VM, the only surviving
copy) with the array counts the agent asserted on.

Do **not** open the banking pull request on its own — the AL references bank-system codes that
do not exist in setup-files yet, so the change is not reviewable in halves.

Options, cheapest first:

1. Recreate the five setup-files JSON files by hand from the design doc, push to the same branch,
   then open both PRs.
2. Re-run the job once these fixes and the resume plan have landed. Costs another implement pass
   (~$38 measured), but exercises the fixed path end to end.

---

## Related

- `549a3a9` — the 4000-character limit that triggered this
- `docs/superpowers/plans/2026-08-05-plan-resume.md` Task 6 — keeping worktrees on failure would
  have preserved the setup-files work even with the loop bug present. The two fixes are
  complementary: Task 6 preserves the work locally, Task 1 here preserves it on the remote.
- `fw-create-pr.md` has no length guard either, so the same 400 is latent in other fleet bots
