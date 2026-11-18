// The MCP endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP.
//
// Two protocol eras, one endpoint, as the suite's client drives them: the
// modern 2026-07-28 revision (no handshake; every request declares its revision
// and `server/discover` answers identity, capabilities and supported versions)
// and the legacy handshake (initialize, then notifications/initialized). The
// tools act on the same store as REST, so a tool's effect is visible over REST
// and the other way round.

import { branchTipOf, globalId, type IssueLike, type Repo, type Store } from './store.ts';
import { VIEWER } from './seed.ts';
import { createItem, doMergePull } from './rest.ts';

export const MCP_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_NAME = 'github-core-forge';
const SERVER_VERSION = '1.0.0';
const SESSION_ID = 'session-1';

interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, Record<string, unknown>>;
    readonly required: readonly string[];
  };
}

/** The tools, built once: tools/list must be byte-identical across calls. */
export const TOOLS: readonly McpToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository for the token owner.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the token owner repositories.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_issue',
    description: 'Get one issue or pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue or pull request number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
]);

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueObject(repo: Repo, item: IssueLike): Record<string, unknown> {
  return {
    id: item.id,
    node_id: globalId(item.kind === 'pull' ? 'PullRequest' : 'Issue', repo.id, item.number),
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    labels: item.labels,
    comments: item.comments.length,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    closed_at: item.closedAt,
    user: { login: VIEWER.login },
  };
}

function pullObject(repo: Repo, item: IssueLike): Record<string, unknown> {
  return {
    ...issueObject(repo, item),
    head: { ref: item.headRef, sha: item.headSha },
    base: { ref: item.baseRef, sha: item.baseSha },
    merged: item.merged,
    merged_at: item.mergedAt,
    merge_commit_sha: item.mergeCommitSha,
  };
}

interface ToolResult {
  readonly content: Array<{ readonly type: 'text'; readonly text: string }>;
  readonly structuredContent: unknown;
  readonly isError?: boolean;
}

function toolOk(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function lookupRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  return store.getRepo(owner, repo) ?? null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (store.getRepo(VIEWER.login, repoName) !== undefined) return toolError('Repository already exists');
      const repo = store.createRepo(VIEWER.login, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: typeof args.private === 'boolean' ? args.private : false,
      });
      return toolOk(repoObject(repo));
    }
    case 'get_repo': {
      const repo = lookupRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      return toolOk(repoObject(repo));
    }
    case 'create_issue': {
      const repo = lookupRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      const item = createItem(store, repo, 'issue', { title, body: typeof args.body === 'string' ? args.body : '' });
      return toolOk(issueObject(repo, item));
    }
    case 'list_issues': {
      const repo = lookupRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const items = [...repo.items.values()].filter((item) => item.kind === 'issue' && (state === 'all' || item.state === state));
      const list = items.map((item) => issueObject(repo, item));
      return toolOk({ issues: list });
    }
    case 'create_pull_request': {
      const repo = lookupRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
      const title = typeof args.title === 'string' ? args.title : '';
      const headSha = branchTipOf(repo, head);
      if (headSha === null) return toolError(`Head branch ${head} not found`);
      const baseSha = branchTipOf(repo, base);
      if (baseSha === null) return toolError(`Base branch ${base} not found`);
      const duplicate = [...repo.items.values()].find(
        (item) => item.kind === 'pull' && item.state === 'open' && item.headRef === head && item.baseRef === base,
      );
      if (duplicate !== undefined) return toolError('A pull request already exists for this head and base');
      const item = createItem(store, repo, 'pull', {
        title,
        body: typeof args.body === 'string' ? args.body : '',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
      });
      return toolOk(pullObject(repo, item));
    }
    case 'merge_pull_request': {
      const repo = lookupRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : -1;
      const item = repo.items.get(number);
      if (item === undefined || item.kind !== 'pull') return toolError('Pull request not found');
      const merged = doMergePull(store, repo, item);
      if (!merged.ok) return toolError(merged.message);
      return toolOk({ sha: merged.sha, merged: true, message: item.title });
    }
    case 'list_repos': {
      const repos = [...store.repos.values()]
        .filter((repo) => repo.owner === VIEWER.login)
        .map((repo) => repoObject(repo));
      return toolOk({ repositories: repos });
    }
    case 'get_issue': {
      const repo = lookupRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const number = typeof args.issue_number === 'number' ? args.issue_number : -1;
      const item = repo.items.get(number);
      if (item === undefined) return toolError('Issue not found');
      return toolOk(item.kind === 'pull' ? pullObject(repo, item) : issueObject(repo, item));
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

export interface McpResponse {
  readonly status: number;
  /** Null when the response has no body (a notification acknowledgement). */
  readonly json: unknown;
  readonly headers?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Answer one POST /mcp request. `text` is the raw request body; `protocolVersion`
 * is the MCP-Protocol-Version request header, when the client sent one.
 */
export function handleMcp(store: Store, text: string, protocolVersion: string | null): McpResponse {
  let request: unknown;
  try {
    request = JSON.parse(text);
  } catch {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!isRecord(request) || typeof request.method !== 'string') {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const id = request.id ?? null;
  const method = request.method;
  const meta = isRecord(request._meta) ? request._meta : {};
  const declared = typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string' ? (meta['io.modelcontextprotocol/protocolVersion'] as string) : null;
  const version = protocolVersion ?? declared ?? MCP_VERSION;
  const negotiated = SUPPORTED_VERSIONS.includes(version) ? version : MCP_VERSION;
  const headers: Record<string, string> = { 'mcp-protocol-version': negotiated };
  // A notification (no id) is acknowledged with 202 and no body.
  if (id === null || id === undefined) {
    return { status: 202, json: null, headers };
  }
  const ok = (result: unknown, extraHeaders: Record<string, string> = {}): McpResponse => ({
    status: 200,
    json: { jsonrpc: '2.0', id, result },
    headers: { ...headers, ...extraHeaders },
  });
  const fail = (code: number, message: string): McpResponse => ({
    status: 200,
    json: { jsonrpc: '2.0', id, error: { code, message } },
    headers,
  });
  if (method === 'server/discover') {
    return ok({
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const params = isRecord(request.params) ? request.params : {};
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_VERSION;
    const chosen = SUPPORTED_VERSIONS.includes(offered) ? offered : MCP_VERSION;
    return ok(
      {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
      { 'mcp-protocol-version': chosen, 'mcp-session-id': SESSION_ID },
    );
  }
  if (method === 'ping') {
    return ok({});
  }
  if (method === 'tools/list') {
    return ok({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = isRecord(request.params) ? request.params : {};
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) return fail(-32602, `Unknown tool: ${name}`);
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null);
    if (missing.length > 0) return fail(-32602, `Missing required argument: ${missing.join(', ')}`);
    const result = callTool(store, name, args);
    return ok(result);
  }
  return fail(-32601, `Method not found: ${method}`);
}
