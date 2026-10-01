import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { extname, join } from 'path';
import type {
  AppConfig,
  PlanQuestions,
  RepoTarget,
  WorkItemComment,
  WorkItemResponse,
} from '../types/index.ts';
import * as prompts from './prompts.ts';

/** Where each variant's banking worktree gets the frozen API docs. */
export const LOCAL_DOCS_DIR = '.agent/input-docs';

/** Far above any real ADO comment id, so it always sorts as the newest. */
const ANSWERS_COMMENT_ID = 2_000_000_000;

/** The Ponto dev container app cold-starts in ~11 s; leave generous room. */
const DOC_TIMEOUT_MS = 60_000;

const DOC_LINK = /\.(json|ya?ml)(\?|#|$)|swagger|openapi/i;

export interface FrozenDoc {
  url: string;
  file?: string;
  error?: string;
}

/** Everything every variant must see identically. Written to input.json. */
export interface FrozenInput {
  workItemId: number;
  title: string;
  frozenAt: string;
  item: WorkItemResponse;
  comments: WorkItemComment[];
  context: string;
  shas: { banking: string; setupFiles: string };
  docs: FrozenDoc[];
  previousQuestions?: PlanQuestions;
  /** An earlier variant's plan folder that every variant starts from (revision mode). */
  fromPlan?: string;
}

export interface FreezeDeps {
  getWorkItem(config: AppConfig, id: number): Promise<WorkItemResponse>;
  getWorkItemComments(config: AppConfig, id: number): Promise<WorkItemComment[]>;
  resolveRemoteSha(config: AppConfig, repo: RepoTarget): Promise<string>;
  fetchDoc(url: string): Promise<string>;
}

/** Links in a description that look like machine-readable API docs. */
export function extractDocLinks(html: string): string[] {
  const urls = (html.match(/https?:\/\/[^\s"'<>]+/g) ?? []).map((u) =>
    u.replace(/&amp;/g, '&').replace(/[).,;]+$/, ''),
  );
  return [...new Set(urls)].filter((u) => DOC_LINK.test(u));
}

/**
 * Local answers dressed as an ADO comment, so the planner reads them exactly
 * as it would read a human's reply. Escaped because buildWorkItemContext runs
 * comment text through htmlToText.
 */
export function answersComment(text: string, when: string): WorkItemComment {
  return {
    id: ANSWERS_COMMENT_ID,
    text: prompts.escapeHtml(text.trim()).replace(/\r?\n/g, '<br>'),
    createdBy: { displayName: 'Local answers (experiment)' },
    createdDate: when,
  };
}

function docsSection(docs: FrozenDoc[]): string {
  const saved = docs.filter((d) => d.file);
  if (saved.length === 0) return '';
  return [
    '',
    '',
    '## Local copies of linked API documentation',
    'These links were downloaded before this run. Read the local files (relative to your',
    'working directory) instead of fetching the URLs:',
    ...saved.map((d) => `- ${d.url} → \`${LOCAL_DOCS_DIR}/${d.file}\``),
  ].join('\n');
}

function docExtension(url: string): string {
  try {
    return extname(new URL(url).pathname) || '.json';
  } catch {
    return '.json';
  }
}

export async function fetchDocOverHttp(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOC_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function freezeInput(
  config: AppConfig,
  itemId: number,
  runDir: string,
  opts: { answersFile?: string; questionsFile?: string; fromPlan?: string },
  deps: FreezeDeps,
): Promise<FrozenInput> {
  const item = await deps.getWorkItem(config, itemId);
  const comments = await deps.getWorkItemComments(config, itemId);
  const frozenAt = new Date().toISOString();

  if (opts.answersFile) {
    comments.push(answersComment(readFileSync(opts.answersFile, 'utf-8'), frozenAt));
  }

  const docsDir = join(runDir, 'input', 'docs');
  mkdirSync(docsDir, { recursive: true });
  const docs: FrozenDoc[] = [];
  const links = extractDocLinks(prompts.field(item, 'System.Description'));
  for (const [i, url] of links.entries()) {
    const file = `doc-${i + 1}${docExtension(url)}`;
    try {
      writeFileSync(join(docsDir, file), await deps.fetchDoc(url), 'utf-8');
      docs.push({ url, file });
    } catch (err) {
      docs.push({ url, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const frozen: FrozenInput = {
    workItemId: itemId,
    title: prompts.field(item, 'System.Title'),
    frozenAt,
    item,
    comments,
    context: prompts.buildWorkItemContext(item, comments, config) + docsSection(docs),
    shas: {
      banking: await deps.resolveRemoteSha(config, config.repos.banking),
      setupFiles: await deps.resolveRemoteSha(config, config.repos.setupFiles),
    },
    docs,
    previousQuestions: (() => {
      // An earlier plan carries the questions its answers respond to.
      const file = opts.questionsFile ?? (opts.fromPlan ? join(opts.fromPlan, 'questions.json') : undefined);
      return file ? (JSON.parse(readFileSync(file, 'utf-8')) as PlanQuestions) : undefined;
    })(),
    fromPlan: opts.fromPlan,
  };

  writeFileSync(join(runDir, 'input.json'), JSON.stringify(frozen, null, 2), 'utf-8');
  return frozen;
}
