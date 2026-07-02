import type {
  AppConfig,
  WorkItemResponse,
  ItemProcessResult,
} from '../types/index.ts';
import type { GeneratorContext } from './ai-generator.ts';

import * as sdk from '../sdk/azure-devops-client.ts';
import * as gen from './ai-generator.ts';

export interface ProcessorDeps {
  updateWorkItemField: (
    config: AppConfig,
    workItemId: number,
    fieldName: string,
    value: string,
  ) => Promise<WorkItemResponse>;

  generateWithAI: (
    config: AppConfig,
    context: GeneratorContext,
  ) => Promise<string>;
}

const defaultDeps: ProcessorDeps = {
  updateWorkItemField: sdk.updateWorkItemField,
  generateWithAI: gen.generateWithAI,
};

function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

// TODO: Replace this stub with your project-specific processing logic.
// This example processes work items found via WIQL query and generates
// AI-powered summaries. Adapt the field checks, generation context, and
// update logic to match your use case.

export async function processItem(
  config: AppConfig,
  item: WorkItemResponse,
  deps: ProcessorDeps = defaultDeps,
): Promise<ItemProcessResult> {
  log(`Processing item #${item.id}: ${String(item.fields['System.Title'] ?? '(untitled)')}`);

  const context: GeneratorContext = {
    itemTitle: String(item.fields['System.Title'] ?? ''),
    itemType: String(item.fields['System.WorkItemType'] ?? ''),
    itemDescription: String(item.fields['System.Description'] ?? ''),
    itemFields: Object.fromEntries(
      Object.entries(item.fields).filter(
        ([key]) =>
          !['System.Title', 'System.WorkItemType', 'System.Description'].includes(key),
      ),
    ),
  };

  try {
    log(`  Item #${item.id}: Generating AI output...`);
    const output = await deps.generateWithAI(config, context);

    if (config.dryRun) {
      log(`  Item #${item.id}: [DRY RUN] Generated:\n    "${output}"`);
      return { itemId: item.id, processed: true };
    }

    // TODO: Replace 'System.Description' with the field you want to update
    await deps.updateWorkItemField(
      config,
      item.id,
      'System.Description',
      output,
    );
    log(`  Item #${item.id}: Output written`);
    return { itemId: item.id, processed: true };
  } catch (err) {
    log(`  Item #${item.id}: Error — ${err}`);
    return { itemId: item.id, processed: false, error: String(err) };
  }
}
