import type {
  AgentRunResult,
  AuthMode,
  ModelUsageSummary,
  RateLimitInfo,
} from '../types/index.ts';
import { formatTokens } from './agent-runner.ts';
import type { FrozenDoc } from './experiment-input.ts';
import type { JudgeResult } from './experiment-judge.ts';

export type VariantStatus = 'ok' | 'failed' | 'budget-stopped' | 'rate-limited' | 'context-overflow';

/** What one variant cost and produced. Written to <variant>/usage.json. */
export interface VariantUsage {
  variant: string;
  model: string;
  effort?: string;
  subagentModel?: string;
  status: VariantStatus;
  error?: string;
  costUsd: number;
  modelUsage: Record<string, ModelUsageSummary>;
  numTurns: number;
  durationMs: number;
  blocking: number;
  ambiguities: number;
  taskCount?: number;
  designDoc: boolean;
  rateLimit?: RateLimitInfo;
  /** Where this variant's worktrees live; the name is opaque so the judge cannot tell. */
  worktreeRoot?: string;
}

export interface ExperimentResults {
  workItemId: number;
  title: string;
  runId: string;
  auth: AuthMode;
  judgeModel: string;
  baseline: string;
  shas: { banking: string; setupFiles: string };
  docs: FrozenDoc[];
  variants: VariantUsage[];
  judges: JudgeResult[];
  /** Why the judge was skipped or stopped, and similar caveats. */
  notes: string[];
  stoppedReason?: string;
  totalUsd: number;
}

const CONTEXT_OVERFLOW = /prompt is too long|context window|context length/i;

export function classifyStatus(
  result: AgentRunResult | undefined,
  error: string | undefined,
): VariantStatus {
  if (!result) return 'failed';
  if (result.rateLimit?.status === 'rejected' || result.assistantError === 'rate_limit') {
    return 'rate-limited';
  }
  if (result.subtype === 'error_max_budget_usd') return 'budget-stopped';
  if (!result.success && CONTEXT_OVERFLOW.test(`${result.text} ${error ?? ''}`)) {
    return 'context-overflow';
  }
  return result.success && !error ? 'ok' : 'failed';
}

/** The planner's task-list shape is the skill's, not ours; count what we recognise. */
export function countTasks(taskList: unknown): number | undefined {
  if (Array.isArray(taskList)) return taskList.length;
  if (taskList && typeof taskList === 'object') {
    const obj = taskList as { tasks?: unknown; waves?: unknown };
    if (Array.isArray(obj.tasks)) return obj.tasks.length;
    if (Array.isArray(obj.waves)) {
      return obj.waves.reduce<number>((sum, wave) => sum + (countTasks(wave) ?? 0), 0);
    }
  }
  return undefined;
}

function isGoodEnough(judge: JudgeResult | undefined): boolean {
  if (!judge?.scores || !judge.verdict) return false;
  if (judge.verdict !== 'equivalent' && judge.verdict !== 'better') return false;
  return Object.values(judge.scores).every((s) => s >= 4);
}

/** Cheapest variant the judge found as good as the baseline; the baseline itself qualifies. */
export function cheapestGoodEnough(results: ExperimentResults): string | undefined {
  const candidates = results.variants.filter(
    (v) =>
      v.status === 'ok' &&
      (v.variant === results.baseline ||
        isGoodEnough(results.judges.find((j) => j.variant === v.variant))),
  );
  candidates.sort((a, b) => a.costUsd - b.costUsd);
  return candidates[0]?.variant;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;

export function renderReport(r: ExperimentResults): string {
  const baseline = r.variants.find((v) => v.variant === r.baseline);
  const lines: string[] = [
    `# Planning experiment — work item #${r.workItemId}`,
    '',
    `- **Title:** ${r.title}`,
    `- **Run:** ${r.runId}`,
    `- **Auth:** ${r.auth} — all costs are API-equivalent USD`,
    `- **Judge model:** ${r.judgeModel}`,
    `- **Frozen SHAs:** banking \`${r.shas.banking}\`, setup-files \`${r.shas.setupFiles}\``,
    `- **Total spend:** ${usd(r.totalUsd)}`,
    '- **MCP servers:** none loaded (production planning loads `.mcp.json`)',
  ];

  const warnings: string[] = [];
  if (r.stoppedReason) warnings.push(`> **Partial report.** ${r.stoppedReason}`);
  for (const d of r.docs.filter((d) => d.error)) {
    warnings.push(`> API doc download failed: ${d.url} — ${d.error}`);
  }
  for (const note of r.notes) warnings.push(`> ${note}`);
  for (const v of r.variants.filter((v) => v.status === 'ok' && !v.designDoc)) {
    warnings.push(
      `> \`${v.variant}\` stopped at questions (${v.blocking} blocking) without a design doc — only its questions were compared.`,
    );
  }
  if (warnings.length > 0) lines.push('', ...warnings.flatMap((w) => [w, '']));

  lines.push(
    '',
    '## Summary',
    '',
    '| Variant | Model | Effort | Subagents | Status | Cost | vs baseline | Turns | Time | Verdict | Cov | Corr | Fit | Tasks | Qs |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const v of [...r.variants].sort((a, b) => a.costUsd - b.costUsd)) {
    const j = r.judges.find((x) => x.variant === v.variant);
    const pct =
      baseline && baseline.costUsd > 0 ? `${Math.round((v.costUsd / baseline.costUsd) * 100)}%` : '—';
    const verdict =
      v.variant === r.baseline ? 'baseline' : j?.error ? 'judge failed' : (j?.verdict ?? '—');
    const s = j?.scores;
    lines.push(
      `| ${v.variant} | ${v.model} | ${v.effort ?? '—'} | ${v.subagentModel ?? 'inherit'} | ${v.status} | ` +
        `${usd(v.costUsd)} | ${pct} | ${v.numTurns} | ${minutes(v.durationMs)} | ${verdict} | ` +
        `${s?.coverage ?? '—'} | ${s?.correctness ?? '—'} | ${s?.patternFit ?? '—'} | ` +
        `${s?.taskActionability ?? '—'} | ${s?.questionQuality ?? '—'} |`,
    );
  }

  lines.push('', '## Cost by model');
  for (const v of r.variants) {
    lines.push(
      '',
      `### ${v.variant}`,
      '',
      '| Model | Input | Output | Cache read | Cache write | Cost |',
      '|---|---|---|---|---|---|',
    );
    for (const [model, u] of Object.entries(v.modelUsage)) {
      lines.push(
        `| ${model} | ${formatTokens(u.inputTokens)} | ${formatTokens(u.outputTokens)} | ` +
          `${formatTokens(u.cacheReadTokens)} | ${formatTokens(u.cacheWriteTokens)} | ${usd(u.costUsd)} |`,
      );
    }
    if (v.error) lines.push('', `Error: ${v.error}`);
  }

  if (r.judges.length > 0) {
    lines.push('', '## Gaps found by the judge');
    for (const j of r.judges) {
      lines.push('', `### ${j.variant} — ${j.error ? `judge failed: ${j.error}` : j.verdict}`);
      if (j.summary) lines.push('', j.summary);
      for (const g of j.gaps) lines.push(`- ${g.item}${g.section ? ` (${g.section})` : ''}`);
    }
  }

  const pick = cheapestGoodEnough(r);
  lines.push(
    '',
    '## Suggestion',
    '',
    pick
      ? `**Cheapest good-enough:** \`${pick}\` — verdict equivalent or better and no score below 4. A suggestion; read the gaps before deciding.`
      : 'No variant qualified as good enough.',
    '',
  );

  return lines.join('\n');
}
