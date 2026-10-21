import type { WorkItemUpdate } from '../types/index.ts';

export const AUTOMATIC = 'automatic';
export const UNKNOWN = 'unknown';

/** Split an ADO `System.Tags` string ("a; b; c") into trimmed, lowercased, non-empty tags. */
function splitTags(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(';')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/**
 * Lowercased uniqueName of the most recent revision that added any of `tags`;
 * UNKNOWN when none. Scans newest-first so a tag that was removed and re-added
 * names whoever asked for the current attempt.
 */
export function triggeredByFrom(updates: WorkItemUpdate[], tags: string[]): string {
  const needles = tags.map((t) => t.trim().toLowerCase());
  for (let i = updates.length - 1; i >= 0; i--) {
    const change = updates[i]?.fields?.['System.Tags'];
    if (!change) continue;
    const before = splitTags(change.oldValue);
    const after = splitTags(change.newValue);
    if (!needles.some((n) => after.includes(n) && !before.includes(n))) continue;
    const name = updates[i]?.revisedBy?.uniqueName;
    return name ? name.toLowerCase() : UNKNOWN;
  }
  return UNKNOWN;
}

/** Never throws: fetch errors → warn once + UNKNOWN. */
export async function lookupTriggeredBy(
  fetchUpdates: () => Promise<WorkItemUpdate[]>,
  tags: string[],
  warn: (msg: string) => void,
): Promise<string> {
  try {
    return triggeredByFrom(await fetchUpdates(), tags);
  } catch (err) {
    warn(`triggeredBy lookup failed :: ${err instanceof Error ? err.message : String(err)}`);
    return UNKNOWN;
  }
}
