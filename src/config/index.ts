import { z } from "zod";
import type { AppConfig } from "../types/index.ts";

const DEFAULT_WIQL = "SELECT [System.Id] FROM workitems WHERE [System.State] = 'New' ORDER BY [System.CreatedDate] DESC";

const envSchema = z.object({
  AZURE_DEVOPS_PAT: z.string().min(1, "AZURE_DEVOPS_PAT is required"),
  AZURE_DEVOPS_ORG: z.string().min(1, "AZURE_DEVOPS_ORG is required"),
  AZURE_DEVOPS_PROJECT: z.string().min(1, "AZURE_DEVOPS_PROJECT is required"),
  AZURE_DEVOPS_WIQL_QUERY: z.string().default(DEFAULT_WIQL),
  POLL_INTERVAL_MINUTES: z.coerce.number().default(15),
  CLAUDE_MODEL: z.string().default("claude-sonnet-4-6"),
  PROMPT_PATH: z.string().default(".claude/commands/do-process-item.md"),
  STATE_DIR: z.string().default(".state"),
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
    wiqlQuery: parsed.AZURE_DEVOPS_WIQL_QUERY,
    pollIntervalMinutes: parsed.POLL_INTERVAL_MINUTES,
    claudeModel: parsed.CLAUDE_MODEL,
    promptPath: parsed.PROMPT_PATH,
    stateDir: parsed.STATE_DIR,
    dryRun: false,
  };
}
