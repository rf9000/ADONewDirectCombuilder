import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  expandEnvPlaceholders,
  loadMcpServers,
  readJsonArtifact,
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
