import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mockConfig } from '../helpers.ts';
import {
  buildChildEnv,
  expandEnvPlaceholders,
  formatModelUsage,
  formatTokens,
  loadMcpServers,
  readJsonArtifact,
  runAgent,
  tailLog,
  withMcpTools,
} from '../../src/services/agent-runner.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-runner-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadMcpServers', () => {
  test('reads mcpServers from a .mcp.json in the working directory', () => {
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          azureDevOps: { command: 'npx', args: ['-y', 'ado-mcp'] },
          'al-object-id-ninja': { command: 'node', args: ['ninja.js'] },
        },
      }),
      'utf-8',
    );

    const servers = loadMcpServers(dir);
    expect(Object.keys(servers).sort()).toEqual(['al-object-id-ninja', 'azureDevOps']);
  });

  // The third argument is the project-root fallback. These cases assert the
  // absence of any config, so it must point somewhere empty rather than at this
  // repo's own .mcp.json.
  test('returns nothing when no config exists', () => {
    expect(loadMcpServers(dir, {}, dir)).toEqual({});
  });

  test('returns nothing when mcpServers is empty', () => {
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf-8');
    expect(loadMcpServers(dir, {}, dir)).toEqual({});
  });

  test('survives an unparseable config instead of throwing', () => {
    writeFileSync(join(dir, '.mcp.json'), '{ broken', 'utf-8');
    expect(loadMcpServers(dir, {}, dir)).toEqual({});
  });

  test('falls back to the project root when the worktree has no config', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-runner-root-'));
    try {
      writeFileSync(
        join(root, '.mcp.json'),
        JSON.stringify({ mcpServers: { ado: { command: 'npx' } } }),
        'utf-8',
      );
      expect(loadMcpServers(dir, {}, root)).toEqual({ ado: { command: 'npx' } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The credential lives in the environment, not in the file, so the file can
  // be committed and baked into the image without leaking a PAT.
  test('resolves environment placeholders in the loaded config', () => {
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          ado: {
            command: 'npx',
            args: ['-y', '@azure-devops/mcp', '${AZURE_DEVOPS_ORG}'],
            env: { PERSONAL_ACCESS_TOKEN: '${ADO_MCP_PAT_B64}' },
          },
        },
      }),
      'utf-8',
    );

    const servers = loadMcpServers(dir, {
      AZURE_DEVOPS_ORG: 'continia-software',
      ADO_MCP_PAT_B64: 'YmFzZTY0',
    });

    expect(servers).toEqual({
      ado: {
        command: 'npx',
        args: ['-y', '@azure-devops/mcp', 'continia-software'],
        env: { PERSONAL_ACCESS_TOKEN: 'YmFzZTY0' },
      },
    });
  });
});

describe('expandEnvPlaceholders', () => {
  test('substitutes a set variable', () => {
    expect(expandEnvPlaceholders('${TOKEN}', { TOKEN: 'secret' })).toBe('secret');
  });

  test('substitutes within surrounding text and more than once', () => {
    expect(expandEnvPlaceholders('${A}-${B}-${A}', { A: 'x', B: 'y' })).toBe('x-y-x');
  });

  test('falls back to the :- default when unset or empty', () => {
    expect(expandEnvPlaceholders('${MISSING:-fallback}', {})).toBe('fallback');
    expect(expandEnvPlaceholders('${EMPTY:-fallback}', { EMPTY: '' })).toBe('fallback');
  });

  // Leaving the placeholder makes the misconfiguration visible in the MCP
  // server's own error, rather than sending it an empty credential.
  test('leaves an unresolved placeholder verbatim', () => {
    expect(expandEnvPlaceholders('${NOPE}', {})).toBe('${NOPE}');
  });

  test('recurses through nested objects and arrays', () => {
    const expanded = expandEnvPlaceholders(
      { args: ['-y', '${ORG}'], env: { PAT: '${PAT}' }, type: 'stdio' },
      { ORG: 'continia-software', PAT: 'abc' },
    );

    expect(expanded).toEqual({
      args: ['-y', 'continia-software'],
      env: { PAT: 'abc' },
      type: 'stdio',
    });
  });

  test('leaves non-string values alone', () => {
    expect(expandEnvPlaceholders({ n: 1, b: true, z: null }, {})).toEqual({
      n: 1,
      b: true,
      z: null,
    });
  });
});

describe('withMcpTools', () => {
  // Without this, adding an MCP server would silently have no effect, because
  // allowedTools is an allowlist.
  test('grants each configured server so its tools are reachable', () => {
    const tools = withMcpTools(['Read', 'Bash'], {
      azureDevOps: {},
      'al-object-id-ninja': {},
    });

    expect(tools).toContain('Read');
    expect(tools).toContain('mcp__azureDevOps');
    expect(tools).toContain('mcp__al-object-id-ninja');
  });

  test('leaves the base list untouched when no servers are configured', () => {
    expect(withMcpTools(['Read'], {})).toEqual(['Read']);
  });
});

describe('readJsonArtifact', () => {
  test('parses an artifact the agent wrote', () => {
    const path = join(dir, 'questions.json');
    writeFileSync(path, JSON.stringify({ blocking: [], ambiguities: [] }), 'utf-8');

    expect(readJsonArtifact<Record<string, unknown>>(path)).toEqual({
      blocking: [],
      ambiguities: [],
    });
  });

  test('returns undefined for a missing file, so callers can decide', () => {
    expect(readJsonArtifact(join(dir, 'nope.json'))).toBeUndefined();
  });

  test('returns undefined rather than throwing on malformed JSON', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, 'not json at all', 'utf-8');
    expect(readJsonArtifact(path)).toBeUndefined();
  });
});

describe('tailLog', () => {
  test('returns the last N lines', () => {
    const path = join(dir, 'run.log');
    writeFileSync(path, Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'));

    const tail = tailLog(path, 3);
    expect(tail).toBe('line 97\nline 98\nline 99');
  });

  test('returns a placeholder when the log is missing', () => {
    expect(tailLog(join(dir, 'missing.log'))).toBe('(no log)');
  });

  test('returns a placeholder when the path is a directory', () => {
    const sub = join(dir, 'subdir');
    mkdirSync(sub);
    expect(tailLog(sub)).toBe('(log unreadable)');
  });
});

describe('buildChildEnv', () => {
  test('returns undefined when nothing overrides the environment', () => {
    expect(buildChildEnv({})).toBeUndefined();
  });

  test('adds CLAUDE_CODE_SUBAGENT_MODEL on top of the given env', () => {
    const env = buildChildEnv({ env: { PATH: '/bin' }, subagentModel: 'claude-haiku-4-5-20251001' });
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5-20251001' });
  });

  test('spreads process.env when only the subagent model is set', () => {
    const env = buildChildEnv({ subagentModel: 'm' });
    expect(env?.CLAUDE_CODE_SUBAGENT_MODEL).toBe('m');
    expect(env?.PATH).toBe(process.env.PATH);
  });
});

describe('formatModelUsage', () => {
  test('prints one line per model with compact token counts', () => {
    expect(formatTokens(1_234_567)).toBe('1.2M');
    expect(formatTokens(40_100)).toBe('40k');
    expect(formatTokens(512)).toBe('512');
    expect(
      formatModelUsage({
        'claude-sonnet-5-5': {
          inputTokens: 1_200_000,
          outputTokens: 40_000,
          cacheReadTokens: 900_000,
          cacheWriteTokens: 80_000,
          costUsd: 3.1,
        },
      }),
    ).toEqual([
      'claude-sonnet-5-5: 1.2M in / 40k out / 900k cache-read / 80k cache-write — $3.10',
    ]);
  });
});

describe('runAgent with an injected query', () => {
  function usage(cost: number) {
    return {
      'claude-opus-5-5': {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 5,
        webSearchRequests: 0,
        costUSD: cost,
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
      },
    };
  }

  function result(total: number) {
    return {
      type: 'result',
      subtype: 'success',
      result: 'done',
      session_id: 's1',
      total_cost_usd: total,
      num_turns: 3,
      duration_ms: 1234,
      usage: { input_tokens: 100, output_tokens: 10 },
      modelUsage: usage(total),
    };
  }

  function fakeQuery(messages: unknown[], seen: { params?: any }) {
    return ((params: unknown) => {
      seen.params = params;
      return (async function* () {
        for (const m of messages) yield m;
      })();
    }) as never;
  }

  test('passes model, effort, env, allowedTools and skips MCP when asked', async () => {
    const seen: { params?: any } = {};
    await runAgent(
      mockConfig(),
      'hi',
      {
        cwd: dir,
        logFile: join(dir, 'run.log'),
        model: 'claude-sonnet-5-5',
        effort: 'low',
        subagentModel: 'claude-haiku-4-5-20251001',
        env: { PATH: '/bin' },
        allowedTools: ['Read'],
        mcp: false,
      },
      fakeQuery([result(1)], seen),
    );
    const options = seen.params.options;
    expect(options.model).toBe('claude-sonnet-5-5');
    expect(options.effort).toBe('low');
    expect(options.env).toEqual({ PATH: '/bin', CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5-20251001' });
    expect(options.allowedTools).toEqual(['Read']);
    expect(options.mcpServers).toBeUndefined();
  });

  test('leaves model, effort and env at production defaults without overrides', async () => {
    const seen: { params?: any } = {};
    const config = mockConfig();
    await runAgent(config, 'hi', { cwd: dir, logFile: join(dir, 'run.log') }, fakeQuery([result(1)], seen));
    const options = seen.params.options;
    expect(options.model).toBe(config.claudeModel);
    expect(options.effort).toBeUndefined();
    expect(options.env).toBeUndefined();
  });

  test('takes modelUsage from the last result instead of summing', async () => {
    const res = await runAgent(
      mockConfig(),
      'hi',
      { cwd: dir, logFile: join(dir, 'run.log') },
      fakeQuery([result(1), result(3)], {}),
    );
    expect(res.costUsd).toBe(3);
    expect(res.durationMs).toBe(1234);
    expect(res.modelUsage).toEqual({
      'claude-opus-5-5': {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 50,
        cacheWriteTokens: 5,
        costUsd: 3,
      },
    });
  });

  test('keeps a rate-limit rejection and the assistant error', async () => {
    const res = await runAgent(
      mockConfig(),
      'hi',
      { cwd: dir, logFile: join(dir, 'run.log') },
      fakeQuery(
        [
          { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1700000000 } },
          { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
          { type: 'assistant', error: 'rate_limit', message: { content: [] } },
          { ...result(0.5), subtype: 'error_during_execution' },
        ],
        {},
      ),
    );
    expect(res.success).toBe(false);
    expect(res.rateLimit).toEqual({ status: 'rejected', type: 'five_hour', resetsAt: 1700000000 });
    expect(res.assistantError).toBe('rate_limit');
  });
});

describe('runAgent hardening', () => {
  function result(subtype: string, total: number) {
    return {
      type: 'result',
      subtype,
      result: 'x',
      session_id: 's1',
      total_cost_usd: total,
      num_turns: 2,
      duration_ms: 10,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
    };
  }

  function throwingQuery(messages: unknown[], seen: { params?: any } = {}) {
    return ((params: unknown) => {
      seen.params = params;
      return (async function* () {
        for (const m of messages) yield m;
        throw new Error('Claude Code returned an error result: budget');
      })();
    }) as never;
  }

  test('returns the gathered result when the SDK throws after an error result', async () => {
    const res = await runAgent(
      mockConfig(),
      'hi',
      { cwd: dir, logFile: join(dir, 'run.log') },
      throwingQuery([
        { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } },
        result('error_max_budget_usd', 12.5),
      ]),
    );
    expect(res).toMatchObject({ success: false, subtype: 'error_max_budget_usd', costUsd: 12.5 });
    expect(res.rateLimit?.status).toBe('rejected');
  });

  test('still throws when the SDK fails before any result', async () => {
    await expect(
      runAgent(mockConfig(), 'hi', { cwd: dir, logFile: join(dir, 'run.log') }, throwingQuery([])),
    ).rejects.toThrow('returned an error result');
  });

  test('restricts the available tools and ignores other MCP configs when tools are restricted', async () => {
    const seen: { params?: any } = {};
    await runAgent(
      mockConfig(),
      'hi',
      { cwd: dir, logFile: join(dir, 'run.log'), allowedTools: ['Read', 'Write'] },
      ((params: unknown) => {
        seen.params = params;
        return (async function* () {
          yield result('success', 1);
        })();
      }) as never,
    );
    expect(seen.params.options.tools).toEqual(['Read', 'Write']);
    expect(seen.params.options.strictMcpConfig).toBe(true);
  });

  test('leaves tools and strictMcpConfig unset in production', async () => {
    const seen: { params?: any } = {};
    await runAgent(
      mockConfig(),
      'hi',
      { cwd: dir, logFile: join(dir, 'run.log') },
      ((params: unknown) => {
        seen.params = params;
        return (async function* () {
          yield result('success', 1);
        })();
      }) as never,
    );
    expect(seen.params.options.tools).toBeUndefined();
    expect(seen.params.options.strictMcpConfig).toBeUndefined();
  });
});

describe('runAgent turn counting', () => {
  test('sums turns across the results of one query', async () => {
    const res = await runAgent(
      mockConfig(),
      'hi',
      { cwd: dir, logFile: join(dir, 'run.log') },
      ((_params: unknown) =>
        (async function* () {
          for (const [turns, total] of [[25, 4], [3, 30], [5, 30]] as const) {
            yield {
              type: 'result',
              subtype: 'success',
              result: 'x',
              session_id: 's',
              total_cost_usd: total,
              num_turns: turns,
              duration_ms: 1,
              usage: { input_tokens: 1, output_tokens: 1 },
              modelUsage: {},
            };
          }
        })()) as never,
    );
    expect(res.numTurns).toBe(33);
    expect(res.costUsd).toBe(30);
  });
});


describe('runAgent AL language server', () => {
  function capture(config: ReturnType<typeof mockConfig>, extra: Record<string, unknown> = {}) {
    const seen: { params?: any } = {};
    return runAgent(
      config,
      'hi',
      { cwd: dir, logFile: join(dir, 'run.log'), ...extra },
      ((params: unknown) => {
        seen.params = params;
        return (async function* () {
          yield {
            type: 'result', subtype: 'success', result: 'x', session_id: 's', total_cost_usd: 0,
            num_turns: 1, duration_ms: 1, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {},
          };
        })();
      }) as never,
    ).then(() => seen.params.options);
  }

  test('loads the plugin and allows the LSP tool when a plugin folder is configured', async () => {
    const options = await capture(mockConfig({ alLspPluginDir: '/opt/al-lsp' }));
    expect(options.plugins).toEqual([{ type: 'local', path: '/opt/al-lsp' }]);
    expect(options.allowedTools).toContain('LSP');
  });

  test('a run can opt out with lsp: false', async () => {
    const options = await capture(mockConfig({ alLspPluginDir: '/opt/al-lsp' }), { lsp: false });
    expect(options.plugins).toBeUndefined();
    expect(options.allowedTools).not.toContain('LSP');
  });

  test('a restricted run (the judge) gets no language server', async () => {
    const options = await capture(mockConfig({ alLspPluginDir: '/opt/al-lsp' }), { allowedTools: ['Read'] });
    expect(options.plugins).toBeUndefined();
    expect(options.tools).toEqual(['Read']);
  });

  test('production default: no plugin folder, no plugin, no LSP tool', async () => {
    const options = await capture(mockConfig());
    expect(options.plugins).toBeUndefined();
    expect(options.allowedTools).not.toContain('LSP');
  });
});

describe('runAgent session resume', () => {
  test('passes resumeSessionId to the SDK as resume', async () => {
    const seen: { params?: any } = {};
    await runAgent(
      mockConfig(),
      'continue',
      { cwd: dir, logFile: join(dir, 'run.log'), resumeSessionId: 'sess-1' },
      ((params: unknown) => {
        seen.params = params;
        return (async function* () {
          yield {
            type: 'result', subtype: 'success', result: 'x', session_id: 'sess-1', total_cost_usd: 0,
            num_turns: 1, duration_ms: 1, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {},
          };
        })();
      }) as never,
    );
    expect(seen.params.options.resume).toBe('sess-1');
  });
});

describe('runAgent transcript', () => {
  test('has written and closed the whole log by the time it returns', async () => {
    const logFile = join(dir, 'run.log');
    await runAgent(
      mockConfig(),
      'hi',
      { cwd: dir, logFile },
      ((_params: unknown) =>
        (async function* () {
          yield {
            type: 'result', subtype: 'success', result: 'x', session_id: 's', total_cost_usd: 0,
            num_turns: 1, duration_ms: 1, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {},
          };
        })()) as never,
    );
    expect(readFileSync(logFile, 'utf-8')).toContain('===== run ended');
  });
});
