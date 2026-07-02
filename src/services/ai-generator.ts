import { readFileSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AppConfig } from '../types/index.ts';

export interface GeneratorContext {
  itemTitle: string;
  itemType: string;
  itemDescription: string;
  itemFields: Record<string, unknown>;
}

export async function generateWithAI(
  config: AppConfig,
  context: GeneratorContext,
): Promise<string> {
  const systemPrompt = readFileSync(config.promptPath, 'utf-8');
  const userPrompt = buildUserPrompt(context);

  let result: string | undefined;

  for await (const message of query({
    prompt: userPrompt,
    options: {
      model: config.claudeModel,
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt,
    },
  })) {
    if (message.type === 'result') {
      console.log(
        `  Cost: $${message.total_cost_usd.toFixed(4)} | ${message.usage.input_tokens ?? 0} in / ${message.usage.output_tokens ?? 0} out | ${message.num_turns} turns`,
      );
      if (message.subtype === 'success') {
        result = message.result;
      }
    }
  }

  if (result === undefined) {
    throw new Error('No result received from Claude Agent SDK');
  }

  return result.trim();
}

export function buildUserPrompt(context: GeneratorContext): string {
  const lines: string[] = [
    `## Work Item`,
    `**Type:** ${context.itemType}`,
    `**Title:** ${context.itemTitle}`,
  ];

  if (context.itemDescription) {
    lines.push(`**Description:** ${context.itemDescription}`);
  }

  const fieldEntries = Object.entries(context.itemFields);
  if (fieldEntries.length > 0) {
    lines.push('', '## Fields');
    for (const [key, value] of fieldEntries) {
      lines.push(`- **${key}:** ${String(value)}`);
    }
  }

  return lines.join('\n');
}
