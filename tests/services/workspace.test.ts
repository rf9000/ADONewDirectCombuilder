import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mockConfig } from '../helpers.ts';
import {
  wireSkills,
  addGitExcludes,
  mirrorPath,
  worktreePath,
  ensureRepoCache,
  resolveSeedRepo,
} from '../../src/services/workspace.ts';

let root: string;
let skillsSource: string;
let worktree: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-'));

  // A stand-in for this repo's .claude directory.
  skillsSource = join(root, 'app', '.claude');
  mkdirSync(join(skillsSource, 'skills', 'bank-integration-planner'), {
    recursive: true,
  });
  writeFileSync(
    join(skillsSource, 'skills', 'bank-integration-planner', 'SKILL.md'),
    '# planner',
    'utf-8',
  );
  mkdirSync(join(skillsSource, 'skills', 'continia-test'), { recursive: true });
  writeFileSync(
    join(skillsSource, 'skills', 'continia-test', 'SKILL.md'),
    '# test',
    'utf-8',
  );
  mkdirSync(join(skillsSource, 'commands'), { recursive: true });
  writeFileSync(join(skillsSource, 'commands', 'fw-create-pr.md'), '# pr', 'utf-8');

  // A stand-in worktree whose .git is a file, as git creates for real worktrees —
  // including the `commondir` pointer, without which the fixture would be
  // unrealistic in exactly the way that hid the info/exclude bug.
  worktree = join(root, 'worktrees', '42', 'banking');
  mkdirSync(worktree, { recursive: true });
  const commonDir = join(root, 'repos', 'banking.git');
  const gitDir = join(commonDir, 'worktrees', 'banking');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`, 'utf-8');
  writeFileSync(join(gitDir, 'commondir'), '../..\n', 'utf-8');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function config() {
  return mockConfig({
    skillsSourceDir: skillsSource,
    repoCacheDir: join(root, 'repos'),
    worktreeRoot: join(root, 'worktrees'),
  });
}

function excludeLines(): string[] {
  // The COMMON dir, not the per-worktree gitdir — that is where git reads
  // info/exclude from, and writing it anywhere else is silently inert.
  const file = join(root, 'repos', 'banking.git', 'info', 'exclude');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

const repoPaths = {
  'continia-banking': '/data/worktrees/42/banking',
  'setup-files': '/data/worktrees/42/setupFiles',
};

describe('wireSkills', () => {
  test('symlinks every skill and command into the worktree', () => {
    wireSkills(config(), worktree, repoPaths);

    const skillsDir = join(worktree, '.claude', 'skills');
    expect(readdirSync(skillsDir).sort()).toEqual([
      'bank-integration-planner',
      'continia-test',
    ]);
    expect(readdirSync(join(worktree, '.claude', 'commands'))).toEqual([
      'fw-create-pr.md',
    ]);
  });

  test('links rather than copies, so skill edits take effect next run', () => {
    wireSkills(config(), worktree, repoPaths);

    const link = join(worktree, '.claude', 'skills', 'continia-test');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    // Edit the source; the worktree must see it through the link.
    writeFileSync(
      join(skillsSource, 'skills', 'continia-test', 'SKILL.md'),
      '# edited',
      'utf-8',
    );
    expect(readFileSync(join(link, 'SKILL.md'), 'utf-8')).toBe('# edited');
  });

  test('writes repo-paths.json, which the skills use to find sibling repos', () => {
    wireSkills(config(), worktree, repoPaths);

    const written = JSON.parse(
      readFileSync(join(worktree, '.claude', 'repo-paths.json'), 'utf-8'),
    ) as Record<string, string>;
    expect(written['continia-banking']).toBe('/data/worktrees/42/banking');
    expect(written['setup-files']).toBe('/data/worktrees/42/setupFiles');
  });

  test('excludes everything it adds so nothing lands in a PR diff', () => {
    wireSkills(config(), worktree, repoPaths);

    const lines = excludeLines();
    expect(lines).toContain('/.claude/skills/bank-integration-planner');
    expect(lines).toContain('/.claude/skills/continia-test');
    expect(lines).toContain('/.claude/commands/fw-create-pr.md');
    expect(lines).toContain('/.claude/repo-paths.json');
  });

  test('never clobbers a skill the target repo ships itself', () => {
    const ownSkill = join(worktree, '.claude', 'skills', 'continia-test');
    mkdirSync(ownSkill, { recursive: true });
    writeFileSync(join(ownSkill, 'SKILL.md'), '# the repo owns this', 'utf-8');

    wireSkills(config(), worktree, repoPaths);

    expect(lstatSync(ownSkill).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(ownSkill, 'SKILL.md'), 'utf-8')).toBe(
      '# the repo owns this',
    );
    // The other skill still gets linked.
    expect(
      lstatSync(join(worktree, '.claude', 'skills', 'bank-integration-planner'))
        .isSymbolicLink(),
    ).toBe(true);
  });

  test('is idempotent across repeated runs', () => {
    const cfg = config();
    wireSkills(cfg, worktree, repoPaths);
    wireSkills(cfg, worktree, repoPaths);

    const lines = excludeLines();
    const planner = lines.filter(
      (l) => l === '/.claude/skills/bank-integration-planner',
    );
    expect(planner).toHaveLength(1);
  });

  test('skips .claude subdirectories that do not exist in the source', () => {
    wireSkills(config(), worktree, repoPaths);
    // No agents/ or rules/ in our fixture — they must not be created empty.
    expect(existsSync(join(worktree, '.claude', 'agents'))).toBe(false);
    expect(existsSync(join(worktree, '.claude', 'rules'))).toBe(false);
  });
});

describe('addGitExcludes', () => {
  test('follows commondir to the shared gitdir, not the per-worktree one', () => {
    addGitExcludes(worktree, ['/.agent/']);

    expect(excludeLines()).toContain('/.agent/');
    // Writing here instead would be inert — git never reads it.
    expect(
      existsSync(
        join(root, 'repos', 'banking.git', 'worktrees', 'banking', 'info', 'exclude'),
      ),
    ).toBe(false);
  });

  test('real git worktree: an excluded path does not show in git status', async () => {
    const origin = join(root, 'origin');
    mkdirSync(origin, { recursive: true });
    const run = async (args: string[], cwd: string) => {
      const proc = Bun.spawn(['git', ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      // Without this the test passes vacuously: a failed git call yields empty
      // output, and "no output" is exactly what the assertion below wants.
      if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${err}`);
      return out;
    };

    await run(['init', '-q', '-b', 'main'], origin);
    await run(['config', 'user.email', 't@example.com'], origin);
    await run(['config', 'user.name', 'Test'], origin);
    writeFileSync(join(origin, 'README.md'), '# x', 'utf-8');
    await run(['add', '-A'], origin);
    await run(['commit', '-qm', 'init'], origin);

    const linked = join(root, 'linked');
    // --detach: `main` is already checked out in origin, and a linked worktree
    // cannot share a branch. The pipeline clones bare, so it never hits this.
    await run(['worktree', 'add', '-q', '--detach', linked, 'HEAD'], origin);

    // Simulate what the pipeline does: register the artifact dir, then create it.
    addGitExcludes(linked, ['/.agent/']);
    mkdirSync(join(linked, '.agent', 'plan'), { recursive: true });
    writeFileSync(join(linked, '.agent', 'plan', 'questions.json'), '{}', 'utf-8');

    // Positive control: an unexcluded file must still be reported, otherwise a
    // silently broken git harness would satisfy the .agent assertion for free.
    writeFileSync(join(linked, 'stray.txt'), 'x', 'utf-8');

    const status = await run(['status', '--porcelain'], linked);
    expect(status).toContain('stray.txt');
    expect(status).not.toContain('.agent');
  });

  test('appends without duplicating existing entries', () => {
    addGitExcludes(worktree, ['/.agent/']);
    addGitExcludes(worktree, ['/.agent/', '/other']);

    const lines = excludeLines();
    expect(lines.filter((l) => l === '/.agent/')).toHaveLength(1);
    expect(lines).toContain('/other');
  });

  test('handles a plain .git directory as well', () => {
    const plain = join(root, 'plain');
    mkdirSync(join(plain, '.git'), { recursive: true });

    addGitExcludes(plain, ['/x']);

    expect(
      readFileSync(join(plain, '.git', 'info', 'exclude'), 'utf-8'),
    ).toContain('/x');
  });

  test('does nothing when there is no git directory', () => {
    const notARepo = join(root, 'not-a-repo');
    mkdirSync(notARepo, { recursive: true });
    expect(() => addGitExcludes(notARepo, ['/x'])).not.toThrow();
  });

  test('does nothing for an empty path list', () => {
    addGitExcludes(worktree, []);
    expect(excludeLines()).toEqual([]);
  });
});

describe('path helpers', () => {
  test('mirrorPath is keyed by repo key', () => {
    const cfg = config();
    expect(mirrorPath(cfg, cfg.repos.banking)).toBe(
      join(root, 'repos', 'banking.git'),
    );
    expect(mirrorPath(cfg, cfg.repos.setupFiles)).toBe(
      join(root, 'repos', 'setupFiles.git'),
    );
  });

  test('worktreePath separates repos per work item', () => {
    const cfg = config();
    expect(worktreePath(cfg, cfg.repos.banking, 42)).toBe(
      join(root, 'worktrees', '42', 'banking'),
    );
    expect(worktreePath(cfg, cfg.repos.setupFiles, 42)).toBe(
      join(root, 'worktrees', '42', 'setupFiles'),
    );
  });
});

describe('ensureRepoCache', () => {
  test('fails with an actionable message when the repo id is unset', async () => {
    const cfg = config();
    cfg.repos.banking.id = '';
    await expect(ensureRepoCache(cfg, cfg.repos.banking)).rejects.toThrow(
      'BANKING_REPO_ID',
    );
  });

  test('names the right variable for the setup-files repo', async () => {
    const cfg = config();
    cfg.repos.setupFiles.id = '   ';
    await expect(ensureRepoCache(cfg, cfg.repos.setupFiles)).rejects.toThrow(
      'SETUP_FILES_REPO_ID',
    );
  });
});

describe('resolveSeedRepo', () => {
  test('is undefined when no seed is configured', () => {
    expect(resolveSeedRepo(undefined)).toBeUndefined();
    expect(resolveSeedRepo('')).toBeUndefined();
    expect(resolveSeedRepo('   ')).toBeUndefined();
  });

  test('accepts a working clone (has .git)', () => {
    const seed = join(root, 'seed-working');
    mkdirSync(join(seed, '.git'), { recursive: true });
    expect(resolveSeedRepo(seed)).toBe(seed);
  });

  test('accepts a bare clone (has HEAD)', () => {
    const seed = join(root, 'seed-bare.git');
    mkdirSync(seed, { recursive: true });
    writeFileSync(join(seed, 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
    expect(resolveSeedRepo(seed)).toBe(seed);
  });

  // A bind mount that vanished must cost the speedup, not the job: git clone
  // --reference fails outright on a path that is not a repository.
  test('falls back to a plain clone when the path is not a git repo', () => {
    const seed = join(root, 'seed-empty');
    mkdirSync(seed, { recursive: true });
    expect(resolveSeedRepo(seed)).toBeUndefined();
  });

  test('falls back to a plain clone when the path does not exist', () => {
    expect(resolveSeedRepo(join(root, 'does-not-exist'))).toBeUndefined();
  });
});
