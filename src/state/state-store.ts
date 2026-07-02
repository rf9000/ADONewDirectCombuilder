import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import type { ProcessedState } from '../types/index.ts';

export class StateStore {
  private filePath: string;
  private state: ProcessedState;
  private processedSet: Set<number>;

  constructor(stateDir: string) {
    this.filePath = join(stateDir, 'processed-items.json');
    this.state = this.load();
    this.processedSet = new Set(this.state.processedItemIds);
  }

  private load(): ProcessedState {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'processedItemIds' in parsed &&
          Array.isArray((parsed as ProcessedState).processedItemIds)
        ) {
          return parsed as ProcessedState;
        }
      }
    } catch {
      // file doesn't exist or is corrupted JSON — start fresh
    }
    return { processedItemIds: [], lastRunAt: '' };
  }

  save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.state.lastRunAt = new Date().toISOString();
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  isProcessed(itemId: number): boolean {
    return this.processedSet.has(itemId);
  }

  markProcessed(itemId: number): void {
    if (!this.processedSet.has(itemId)) {
      this.processedSet.add(itemId);
      this.state.processedItemIds.push(itemId);
    }
  }

  reset(): void {
    this.state = { processedItemIds: [], lastRunAt: '' };
    this.processedSet = new Set();
    this.save();
  }

  get processedCount(): number {
    return this.state.processedItemIds.length;
  }
}
