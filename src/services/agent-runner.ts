import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentOverrides,
  AgentRunResult,
  AppConfig,
  ModelUsageSummary,
  RateLimitInfo,
} from '../types/index.ts';

/**
 * Tools the pipeline agents are allowed to use. `Task`/`Agent` matter because the
 * planner and code-review skills fan out to subagents.
 */
const ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'Skill',
  'Agent',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
];

export interface AgentRunOptions extends AgentOverrides {
  /** Working directory — the worktree whose .claude/ holds the wired skills. */
  cwd: string;
  /** Extra directories the agent may read and write (e.g. the sibling repo). */
  additionalDirectories?: string[];
  /** Where to stream the transcript. */
  logFile: string;
  /** Override the configured turn cap for cheap phases. */
  maxTurns?: number;
  /**
   * Spend cap in USD for this run, passed to the SDK as `maxBudgetUsd`.
   * Defaults to `config.agentMaxBudgetUsd`; the pipeline lowers it to what is
   * left of the job's budget.
   */
  maxBudgetUsd?: number;
  /** Optional extra system prompt appended to the default Claude Code preset. */
  appendSystemPrompt?: string;
  /** Replaces the default tool allowlist (the experiment judge runs read-only). */
  allowedTools?: string[];
}

function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Resolve `${VAR}` and `${VAR:-default}` in every string of an MCP config.
 *
 * The Claude Code CLI does this when it loads `.mcp.json` itself, but we parse
 * the file and hand the object to the SDK programmatically, so the substitution
 * is ours to do. It is what keeps credentials in the environment instead of in
 * a checked-in file. An unresolved placeholder is left verbatim and warned
 * about — clearer in the log than a silently empty credential.
 */
export function expandEnvPlaceholders<T>(
  value: T,
  env: Record<string, string | undefined> = process.env,
): T {
  if (typeof value === 'string') {
    return value.replace(ENV_PLACEHOLDER, (whole, name: string, fallback?: string) => {
      const resolved = env[name];
      if (resolved !== undefined && resolved !== '') return resolved;
      if (fallback !== undefined) return fallback;
      log(`  Warning: ${whole} in .mcp.json is not set in the environment`);
      return whole;
    }) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvPlaceholders(entry, env)) as T;
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expandEnvPlaceholders(entry, env)]),
    ) as T;
  }

  return value;
}

/**
 * Load MCP server definitions from a `.mcp.json` beside the agent's cwd, or
 * from this project's root. Lets the operator add the ado and
 * al-object-id-ninja servers without touching code.
 */
export function loadMcpServers(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  projectRoot: string = process.cwd(),
): Record<string, unknown> {
  const candidates = [join(cwd, '.mcp.json'), join(projectRoot, '.mcp.json')];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf-8'));
      if (parsed && typeof parsed === 'object' && 'mcpServers' in parsed) {
        const servers = (parsed as { mcpServers?: Record<string, unknown> }).mcpServers;
        if (servers && Object.keys(servers).length > 0) {
          return expandEnvPlaceholders(servers, env);
        }
      }
    } catch (err) {
      log(`  Warning: could not parse ${candidate} — ${err}`);
    }
  }

  return {};
}

/**
 * `allowedTools` is an allowlist, so MCP tools are blocked unless named. Server
 * names come from `.mcp.json` at runtime, so grant each configured server as a
 * whole (`mcp__<server>`) rather than guessing individual tool names — otherwise
 * adding an MCP server would silently have no effect.
 */
export function withMcpTools(
  base: string[],
  mcpServers: Record<string, unknown>,
): string[] {
  return [...base, ...Object.keys(mcpServers).map((name) => `mcp__${name}`)];
}

/**
 * Environment for the Claude Code child process, or undefined to let the SDK
 * inherit ours. The SDK's `env` option replaces the environment rather than
 * merging, so an override must carry everything else along with it.
 */
export function buildChildEnv(
  options: Pick<AgentRunOptions, 'env' | 'subagentModel'>,
): Record<string, string | undefined> | undefined {
  if (!options.env && !options.subagentModel) return undefined;
  const env = { ...(options.env ?? process.env) };
  if (options.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = options.subagentModel;
  return env;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** One line per model, so a log shows where a run's money went. */
export function formatModelUsage(usage: Record<string, ModelUsageSummary>): string[] {
  return Object.entries(usage).map(
    ([model, u]) =>
      `${model}: ${formatTokens(u.inputTokens)} in / ${formatTokens(u.outputTokens)} out / ` +
      `${formatTokens(u.cacheReadTokens)} cache-read / ${formatTokens(u.cacheWriteTokens)} cache-write — ` +
      `$${u.costUsd.toFixed(2)}`,
  );
}

/**
 * Run one agent turn-loop to completion, streaming the transcript to disk.
 *
 * `settingSources: ['project']` is the load-bearing option: it makes the Agent
 * SDK read `.claude/` (skills, commands, CLAUDE.md, settings) relative to
 * `cwd`, which is how the skills symlinked into the worktree become available.
 */
export async function runAgent(
  config: AppConfig,
  prompt: string,
  options: AgentRunOptions,
  queryFn: typeof query = query,
): Promise<AgentRunResult> {
  mkdirSync(dirname(options.logFile), { recursive: true });
  const logStream = createWriteStream(options.logFile, { flags: 'a' });

  const write = (line: string): void => {
    logStream.write(`${line}\n`);
  };

  write(`\n===== run started ${new Date().toISOString()} =====`);
  write(`cwd: ${options.cwd}`);
  write(`--- prompt ---\n${prompt}\n--- end prompt ---`);

  // A caller that restricts tools (the experiment judge) or opts out gets no
  // MCP servers: this repo's .mcp.json carries an ADO PAT.
  const useMcp = options.mcp !== false && options.allowedTools === undefined;
  const mcpServers = useMcp ? loadMcpServers(options.cwd) : {};
  const allowedTools = withMcpTools(options.allowedTools ?? ALLOWED_TOOLS, mcpServers);
  const env = buildChildEnv(options);

  let text = '';
  let sessionId: string | undefined;
  let success = false;
  let subtype: string | undefined;
  let costUsd = 0;
  let numTurns = 0;
  let modelUsage: Record<string, ModelUsageSummary> | undefined;
  let durationMs: number | undefined;
  let rateLimit: RateLimitInfo | undefined;
  let assistantError: string | undefined;

  try {
    for await (const message of queryFn({
      prompt,
      options: {
        model: options.model ?? config.claudeModel,
        ...(options.effort ? { effort: options.effort } : {}),
        ...(env ? { env } : {}),
        cwd: options.cwd,
        additionalDirectories: options.additionalDirectories,
        settingSources: ['project'],
        allowedTools,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: options.maxTurns ?? config.agentMaxTurns,
        maxBudgetUsd: options.maxBudgetUsd ?? config.agentMaxBudgetUsd,
        ...(Object.keys(mcpServers).length > 0
          ? { mcpServers: mcpServers as never }
          : {}),
        ...(options.appendSystemPrompt
          ? {
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: options.appendSystemPrompt,
              },
            }
          : {}),
      },
    })) {
      if (message.type === 'system' && 'session_id' in message) {
        sessionId = (message as { session_id?: string }).session_id ?? sessionId;
      }

      // Keep the first rejection: a later 'allowed' event must not hide that
      // the run was cut off by a plan limit.
      if (message.type === 'rate_limit_event') {
        const info = message.rate_limit_info;
        if (rateLimit?.status !== 'rejected') {
          rateLimit = { status: info.status, type: info.rateLimitType, resetsAt: info.resetsAt };
        }
      }

      if (message.type === 'assistant') {
        if (message.error) assistantError = message.error;
        for (const block of message.message.content) {
          if (block.type === 'text') {
            write(`[assistant] ${block.text}`);
          } else if (block.type === 'tool_use') {
            write(`[tool] ${block.name} ${JSON.stringify(block.input).slice(0, 2000)}`);
          }
        }
      }

      if (message.type === 'user') {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === 'object' && block !== null && 'type' in block) {
              if ((block as { type: string }).type === 'tool_result') {
                const result = (block as { content?: unknown }).content;
                write(`[result] ${JSON.stringify(result).slice(0, 2000)}`);
              }
            }
          }
        }
      }

      // One query can yield several results: background subagents wake the
      // session up again after its first answer. `total_cost_usd` is the
      // session's running total, not the cost of that result, so log the
      // delta alongside it — summing the logged totals overstates the spend.
      if (message.type === 'result') {
        sessionId = message.session_id ?? sessionId;
        const total = message.total_cost_usd ?? costUsd;
        const delta = total - costUsd;
        costUsd = total;
        numTurns = message.num_turns ?? 0;
        subtype = message.subtype;
        durationMs = message.duration_ms;
        // Cumulative like total_cost_usd, so the last result wins.
        modelUsage = Object.fromEntries(
          Object.entries(message.modelUsage ?? {}).map(([model, u]) => [
            model,
            {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheReadTokens: u.cacheReadInputTokens,
              cacheWriteTokens: u.cacheCreationInputTokens,
              costUsd: u.costUSD,
            },
          ]),
        );
        log(
          `  Cost: +$${delta.toFixed(4)} (run total $${costUsd.toFixed(4)}) | ${message.usage?.input_tokens ?? 0} in / ${message.usage?.output_tokens ?? 0} out | ${numTurns} turns`,
        );
        write(`[result] subtype=${message.subtype} cost=$${costUsd.toFixed(4)} turns=${numTurns}`);
        if (message.subtype === 'success') {
          success = true;
          text = message.result;
        } else {
          // A later non-success result (e.g. the budget ran out while a
          // background subagent was still working) overrides an earlier success.
          success = false;
          write(`[result] non-success subtype: ${message.subtype}`);
        }
      }
    }
  } finally {
    for (const line of formatModelUsage(modelUsage ?? {})) {
      log(`  ${line}`);
      write(`[usage] ${line}`);
    }
    write(`===== run ended ${new Date().toISOString()} =====`);
    logStream.end();
  }

  return {
    text: text.trim(),
    sessionId,
    success,
    subtype,
    costUsd,
    numTurns,
    modelUsage,
    durationMs,
    rateLimit,
    assistantError,
  };
}

/**
 * Read a JSON artifact the agent was asked to write. Returns undefined when the
 * file is missing or unparseable — callers decide whether that is fatal.
 *
 * Phases hand off through files rather than by parsing prose, so a chatty run
 * cannot corrupt the control flow.
 */
export function readJsonArtifact<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (err) {
    log(`  Warning: artifact ${path} is not valid JSON — ${err}`);
    return undefined;
  }
}

/** Last N lines of a log file, for error comments. */
export function tailLog(path: string, lines = 40): string {
  if (!existsSync(path)) return '(no log)';
  try {
    const all = readFileSync(path, 'utf-8').split(/\r?\n/);
    return all.slice(-lines).join('\n');
  } catch {
    return '(log unreadable)';
  }
}
