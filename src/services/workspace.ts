import { spawn } from 'child_process';
import {
  mkdirSync,
  existsSync,
  readdirSync,
  symlinkSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  lstatSync,
} from 'fs';
import { join, resolve } from 'path';
import type { AppConfig, RepoTarget } from '../types/index.ts';
import { buildCloneUrl, buildGitAuthArgs } from '../sdk/azure-devops-client.ts';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

/**
 * Run a command without a shell, so PATs and paths with spaces can never be
 * re-interpreted. Rejects on non-zero exit unless `allowFailure` is set.
 */
export function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; allowFailure?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      const result: RunResult = { code: code ?? -1, stdout, stderr };
      if (result.code !== 0 && !options.allowFailure) {
        reject(
          new Error(
            `${command} ${args.join(' ')} exited ${result.code}\n${stderr || stdout}`,
          ),
        );
        return;
      }
      resolvePromise(result);
    });
  });
}

function git(
  config: AppConfig,
  args: string[],
  options: { cwd?: string; authenticated?: boolean; allowFailure?: boolean } = {},
): Promise<RunResult> {
  const prefix = options.authenticated ? buildGitAuthArgs(config) : [];
  return run('git', [...prefix, ...args], {
    cwd: options.cwd,
    allowFailure: options.allowFailure,
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
    },
  });
}

export function mirrorPath(config: AppConfig, repo: RepoTarget): string {
  return join(config.repoCacheDir, `${repo.key}.git`);
}

export function worktreePath(
  config: AppConfig,
  repo: RepoTarget,
  itemId: number,
): string {
  return join(config.worktreeRoot, String(itemId), repo.key);
}

/**
 * Accept a seed path only when it really is a git repository — either a working
 * clone (`.git`) or a bare one (`HEAD`). `git clone --reference` fails outright
 * on a path that is not a repo, and a misconfigured or unmounted seed should
 * cost us the speedup, not the job.
 */
export function resolveSeedRepo(seedPath?: string): string | undefined {
  if (!seedPath || seedPath.trim() === '') return undefined;

  const path = resolve(seedPath.trim());
  if (existsSync(join(path, '.git')) || existsSync(join(path, 'HEAD'))) return path;

  log(`  Warning: seed repo '${seedPath}' is not a git repository — cloning from origin`);
  return undefined;
}

/**
 * Make sure a bare clone of the repo exists in the cache volume and is current.
 * First call clones (minutes); later calls just fetch.
 *
 * Deliberately `--bare` and not `--mirror`: a mirror sets
 * `remote.origin.mirror=true` (so a plain `git push` would push *every* ref and
 * delete anything missing upstream) and fetches `+refs/*:refs/*` (so
 * `--prune` would delete the local branch of an in-flight job). Instead we
 * fetch upstream into `refs/remotes/origin/*` and keep `refs/heads/*` ours.
 */
export async function ensureRepoCache(
  config: AppConfig,
  repo: RepoTarget,
): Promise<string> {
  if (!repo.id || repo.id.trim() === '') {
    throw new Error(
      `Repository id for '${repo.key}' is not configured — set ${repo.key === 'banking' ? 'BANKING_REPO_ID' : 'SETUP_FILES_REPO_ID'}`,
    );
  }

  const target = mirrorPath(config, repo);
  mkdirSync(config.repoCacheDir, { recursive: true });

  if (!existsSync(join(target, 'HEAD'))) {
    const seed = resolveSeedRepo(repo.seedPath);
    await git(
      config,
      [
        'clone',
        '--bare',
        // Borrow objects from the local clone, then copy what we need and drop
        // the alternate: fast first clone without a lasting dependency on a
        // read-only mount that may not be there next time.
        ...(seed ? ['--reference', seed, '--dissociate'] : []),
        buildCloneUrl(config, repo),
        target,
      ],
      { authenticated: true },
    );
  }

  // A bare clone ships no fetch refspec — give it one so updates land in
  // remote-tracking refs instead of overwriting local branches.
  await git(
    config,
    ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    { cwd: target },
  );
  await git(config, ['fetch', '--prune', 'origin'], {
    cwd: target,
    authenticated: true,
  });

  return target;
}

/**
 * Create a worktree for `repo` on a new `branch` cut from the current upstream
 * tip of the repo's default branch. Idempotent: an existing worktree at the
 * same path is reused.
 */
export async function createWorktree(
  config: AppConfig,
  repo: RepoTarget,
  branch: string,
  itemId: number,
): Promise<string> {
  const mirror = await ensureRepoCache(config, repo);
  const path = worktreePath(config, repo, itemId);

  if (existsSync(join(path, '.git'))) return path;

  mkdirSync(join(config.worktreeRoot, String(itemId)), { recursive: true });

  // -B so a retry after a failed job reuses the branch name instead of erroring.
  await git(
    config,
    [
      'worktree',
      'add',
      '-B',
      branch,
      path,
      `refs/remotes/origin/${repo.defaultBranch}`,
    ],
    { cwd: mirror },
  );

  return path;
}

export async function removeWorktree(
  config: AppConfig,
  repo: RepoTarget,
  itemId: number,
): Promise<void> {
  const mirror = mirrorPath(config, repo);
  const path = worktreePath(config, repo, itemId);

  if (existsSync(mirror)) {
    await git(config, ['worktree', 'remove', '--force', path], {
      cwd: mirror,
      allowFailure: true,
    });
    await git(config, ['worktree', 'prune'], { cwd: mirror, allowFailure: true });
  }

  // git refuses to remove a worktree it no longer tracks; make sure the disk is clean.
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

/** Remove every worktree for a work item, including the parent directory. */
export async function removeAllWorktrees(
  config: AppConfig,
  itemId: number,
): Promise<void> {
  for (const repo of Object.values(config.repos)) {
    await removeWorktree(config, repo, itemId);
  }
  const parent = join(config.worktreeRoot, String(itemId));
  if (existsSync(parent)) rmSync(parent, { recursive: true, force: true });
}

/** Entries under .claude/ we link in, plus the file we generate. */
const LINKED_CLAUDE_DIRS = ['skills', 'commands', 'agents', 'rules'] as const;
const GENERATED_CLAUDE_FILES = ['repo-paths.json', 'settings.local.json'] as const;

/**
 * Make this repo's skills usable by an agent working inside a worktree.
 *
 * The Agent SDK loads `.claude/` relative to its `cwd` when
 * `settingSources: ['project']` is set, so symlinking our skills into the
 * worktree's `.claude/` is what puts them in the agent's hands. Symlinks (not
 * copies) mean editing a skill here takes effect on the next job.
 *
 * Everything we add is registered in `.git/info/exclude`, so it can never show
 * up in a commit or a pull request diff.
 */
export function wireSkills(
  config: AppConfig,
  worktree: string,
  repoPaths: Record<string, string>,
): void {
  const source = resolve(config.skillsSourceDir);
  const targetClaude = join(worktree, '.claude');
  mkdirSync(targetClaude, { recursive: true });

  const excluded: string[] = [];

  for (const dir of LINKED_CLAUDE_DIRS) {
    const sourceDir = join(source, dir);
    if (!existsSync(sourceDir)) continue;

    const destDir = join(targetClaude, dir);
    mkdirSync(destDir, { recursive: true });

    for (const entry of readdirSync(sourceDir)) {
      const dest = join(destDir, entry);
      // Never clobber a skill the target repo ships itself — theirs wins.
      if (existsSync(dest) || isSymlink(dest)) continue;
      symlinkSync(join(sourceDir, entry), dest, 'junction');
      excluded.push(`/.claude/${dir}/${entry}`);
    }
  }

  // Both setup-files-investigate (Step 0) and the planner's setup-data-model
  // resolve sibling repos through this file, and neither repo ships one.
  writeFileSync(
    join(targetClaude, 'repo-paths.json'),
    JSON.stringify(repoPaths, null, 2),
    'utf-8',
  );

  for (const file of GENERATED_CLAUDE_FILES) {
    excluded.push(`/.claude/${file}`);
  }

  addGitExcludes(worktree, excluded);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Append paths to .git/info/exclude, skipping ones already listed. */
export function addGitExcludes(worktree: string, paths: string[]): void {
  if (paths.length === 0) return;

  const gitDir = resolveGitCommonDir(worktree);
  if (!gitDir) return;

  const infoDir = join(gitDir, 'info');
  mkdirSync(infoDir, { recursive: true });
  const excludeFile = join(infoDir, 'exclude');

  const existing = existsSync(excludeFile)
    ? readFileSync(excludeFile, 'utf-8').split(/\r?\n/)
    : [];
  const known = new Set(existing.map((l) => l.trim()));
  const missing = paths.filter((p) => !known.has(p));
  if (missing.length === 0) return;

  const header = existing.length === 0 ? '# added by ADONewDirectCombuilder\n' : '';
  appendFileSync(excludeFile, `${header}${missing.join('\n')}\n`, 'utf-8');
}

/**
 * Resolve the directory whose `info/exclude` git actually reads.
 *
 * In a linked worktree `.git` is a file containing `gitdir: <path>`, and that
 * per-worktree gitdir is NOT where exclusions belong: git reads `info/exclude`
 * from the common dir, so anything written under `worktrees/<name>/info/` is
 * silently inert. Each linked worktree's gitdir carries a `commondir` file
 * pointing at the shared directory — follow it.
 *
 * This was a real bug: `.agent/` showed up as untracked in `git status` despite
 * being registered, and `commitAndPush` runs `git add -A`, so the plan and
 * verify artifacts would have landed in a pull request diff.
 */
function resolveGitCommonDir(worktree: string): string | undefined {
  const dotGit = join(worktree, '.git');
  if (!existsSync(dotGit)) return undefined;

  let gitDir: string;
  if (lstatSync(dotGit).isDirectory()) {
    gitDir = dotGit;
  } else {
    const contents = readFileSync(dotGit, 'utf-8').trim();
    const match = /^gitdir:\s*(.+)$/.exec(contents);
    if (!match || !match[1]) return undefined;
    gitDir = resolve(worktree, match[1].trim());
  }

  const commonDirFile = join(gitDir, 'commondir');
  if (!existsSync(commonDirFile)) return gitDir;

  const commonDir = readFileSync(commonDirFile, 'utf-8').trim();
  if (commonDir === '') return gitDir;
  return resolve(gitDir, commonDir);
}

export async function hasChanges(config: AppConfig, worktree: string): Promise<boolean> {
  const result = await git(config, ['status', '--porcelain'], { cwd: worktree });
  return result.stdout.trim() !== '';
}

/** Stage everything, commit, and push the branch. No-op when nothing changed. */
export async function commitAndPush(
  config: AppConfig,
  worktree: string,
  branch: string,
  message: string,
  author: { name: string; email: string },
): Promise<boolean> {
  if (!(await hasChanges(config, worktree))) return false;

  await git(config, ['add', '-A'], { cwd: worktree });
  await git(
    config,
    [
      '-c',
      `user.name=${author.name}`,
      '-c',
      `user.email=${author.email}`,
      'commit',
      '-m',
      message,
    ],
    { cwd: worktree },
  );
  // Explicit refspec rather than `--set-upstream <branch>`: it pushes exactly
  // one ref and does not depend on the bare clone's remote configuration.
  await git(config, ['push', 'origin', `HEAD:refs/heads/${branch}`], {
    cwd: worktree,
    authenticated: true,
  });

  return true;
}

/** Diff of the branch against its base, for PR description generation. */
export async function branchDiffStat(
  config: AppConfig,
  worktree: string,
  baseBranch: string,
): Promise<string> {
  const result = await git(
    config,
    ['diff', '--stat', `refs/remotes/origin/${baseBranch}...HEAD`],
    { cwd: worktree, allowFailure: true },
  );
  return result.stdout.trim();
}

/** Short log of commits the branch adds on top of its base. */
export async function branchCommitSubjects(
  config: AppConfig,
  worktree: string,
  baseBranch: string,
): Promise<string[]> {
  const result = await git(
    config,
    ['log', '--format=%s', `refs/remotes/origin/${baseBranch}..HEAD`],
    { cwd: worktree, allowFailure: true },
  );
  return result.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}
