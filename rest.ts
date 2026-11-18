// The GitHub REST v3 surface under /api/v3.
//
// Every reply is application/json, every 4xx body is {"message": string}, every
// reply carries X-GitHub-Request-Id (the app layer adds it), and lists page with
// Link rel="next" headers. Auth is the app layer's job; this module only serves
// a request that already passed it. Shapes follow api.github.com: the fields the
// suite reads are all here, plus the usual neighbours, so a client that reads a
// little wider still finds what it expects.

import {
  branchTipOf,
  globalId,
  parseCommit,
  parseTree,
  type IssueComment,
  type IssueLike,
  type Repo,
  type Store,
} from './store.ts';
import { VIEWER } from './seed.ts';

export interface RestResponse {
  readonly status: number;
  readonly json: unknown;
  readonly headers?: Record<string, string>;
}

export interface RestRequest {
  readonly method: string;
  /** Path segments after /api/v3, URL-decoded. */
  readonly segments: string[];
  readonly query: URLSearchParams;
  /** Parsed JSON body, or null when there is none. */
  readonly body: unknown;
  /** The request's Host header, for absolute pagination URLs. */
  readonly host: string;
}

const ok = (status: number, json: unknown, headers?: Record<string, string>): RestResponse => ({ status, json, headers });
const err = (status: number, message: string): RestResponse => ({ status, json: { message } });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyOf(req: RestRequest): Record<string, unknown> {
  return isRecord(req.body) ? req.body : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** The API origin for absolute URLs, from the request's Host header. */
function apiOrigin(req: RestRequest): string {
  return `http://${req.host}`;
}

function repoUrl(req: RestRequest, repo: Repo): string {
  return `${apiOrigin(req)}/api/v3/repos/${repo.owner}/${repo.name}`;
}

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.id),
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER.id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER.login}`,
    html_url: `https://github.com/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
    bio: null,
    company: null,
    location: null,
    public_repos: 0,
    followers: 0,
    following: 0,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function repoJson(req: RestRequest, store: Store, repo: Repo): Record<string, unknown> {
  const openCount = [...repo.items.values()].filter((item) => item.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: userJson(),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: repoUrl(req, repo),
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openCount,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: Repo, name: string, color: string, description: string): Record<string, unknown> {
  return {
    id: repo.id * 1000 + name.length,
    node_id: globalId('Label', repo.id, name),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name,
    color,
    description,
    default: false,
  };
}

function commentJson(req: RestRequest, repo: Repo, item: IssueLike, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    url: `${repoUrl(req, repo)}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${item.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

function issueJson(req: RestRequest, store: Store, repo: Repo, item: IssueLike): Record<string, unknown> {
  const labels = item.labels.map((name) => {
    const found = repo.labels.get(name);
    return labelJson(repo, name, found?.color ?? 'ededed', found?.description ?? '');
  });
  const base: Record<string, unknown> = {
    id: item.id,
    node_id: globalId(item.kind === 'pull' ? 'PullRequest' : 'Issue', repo.id, item.number),
    url: `${repoUrl(req, repo)}/issues/${item.number}`,
    repository_url: repoUrl(req, repo),
    labels_url: `${repoUrl(req, repo)}/issues/${item.number}/labels{/name}`,
    comments_url: `${repoUrl(req, repo)}/issues/${item.number}/comments`,
    events_url: `${repoUrl(req, repo)}/issues/${item.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${item.number}`,
    number: item.number,
    state: item.state,
    title: item.title,
    body: item.body,
    user: userJson(),
    labels,
    assignee: null,
    assignees: [],
    locked: false,
    comments: item.comments.length,
    closed_at: item.closedAt,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    author_association: 'OWNER',
  };
  if (item.kind === 'pull') {
    base.pull_request = {
      url: `${repoUrl(req, repo)}/pulls/${item.number}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${item.number}`,
      diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${item.number}.diff`,
      patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${item.number}.patch`,
      merged_at: item.mergedAt,
    };
  }
  return base;
}

export function pullJson(req: RestRequest, store: Store, repo: Repo, item: IssueLike): Record<string, unknown> {
  const headRepo = repoJson(req, store, repo);
  const merged = item.merged;
  return {
    id: item.id,
    node_id: globalId('PullRequest', repo.id, item.number),
    url: `${repoUrl(req, repo)}/pulls/${item.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${item.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${item.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${item.number}.patch`,
    issue_url: `${repoUrl(req, repo)}/issues/${item.number}`,
    number: item.number,
    state: item.state,
    locked: false,
    title: item.title,
    body: item.body,
    user: userJson(),
    labels: [],
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    closed_at: item.closedAt,
    merged_at: item.mergedAt,
    merge_commit_sha: item.mergeCommitSha,
    mergeable: item.state === 'open' ? !hasConflict(store, repo, item) : null,
    mergeable_state: item.state === 'open' ? (hasConflict(store, repo, item) ? 'dirty' : 'clean') : 'closed',
    merged,
    draft: false,
    head: {
      label: `${repo.owner}:${item.headRef ?? ''}`,
      ref: item.headRef ?? '',
      sha: item.headSha ?? '',
      user: userJson(),
      repo: headRepo,
    },
    base: {
      label: `${repo.owner}:${item.baseRef ?? ''}`,
      ref: item.baseRef ?? '',
      sha: item.baseSha ?? '',
      user: userJson(),
      repo: headRepo,
    },
    _links: {},
    author_association: 'OWNER',
  };
}

function commitJson(req: RestRequest, store: Store, repo: Repo, oid: string): Record<string, unknown> | null {
  const object = store.getObject(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const info = parseCommit(object.data);
  const login = info.authorEmail === VIEWER.email ? VIEWER.login : info.authorEmail.split('@')[0] ?? info.authorName;
  return {
    sha: oid,
    node_id: globalId('Commit', oid),
    commit: {
      author: { name: info.authorName, email: info.authorEmail, date: new Date(info.authorTs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') },
      committer: { name: info.committerName, email: info.committerEmail, date: new Date(info.committerTs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') },
      message: info.message.replace(/\n$/, ''),
      tree: { sha: info.tree, url: `${repoUrl(req, repo)}/git/trees/${info.tree}` },
      url: `${repoUrl(req, repo)}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${repoUrl(req, repo)}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    comments_url: `${repoUrl(req, repo)}/commits/${oid}/comments`,
    author: { login, id: VIEWER.id, type: 'User' },
    committer: { login, id: VIEWER.id, type: 'User' },
    parents: info.parents.map((parent) => ({ sha: parent, url: `${repoUrl(req, repo)}/commits/${parent}`, html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${parent}` })),
  };
}

// ---------------------------------------------------------------- pagination

interface Page<T> {
  readonly items: T[];
  readonly headers: Record<string, string>;
}

function paginate<T>(req: RestRequest, path: string, items: readonly T[]): Page<T> {
  const perPageRaw = Number.parseInt(req.query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(req.query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const linkFor = (p: number): string => {
    const params = new URLSearchParams(req.query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `<${apiOrigin(req)}${path}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`${linkFor(page + 1)}; rel="next"`);
    links.push(`${linkFor(totalPages)}; rel="last"`);
  }
  if (page > 1) {
    links.push(`${linkFor(1)}; rel="first"`);
    links.push(`${linkFor(page - 1)}; rel="prev"`);
  }
  return { items: pageItems, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

// ---------------------------------------------------------------- merge logic

/** The paths a pull request changes, merge-base tree vs head tree. */
export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

function countLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

export function pullFiles(store: Store, repo: Repo, item: IssueLike): FileChange[] {
  if (item.headSha === null || item.baseSha === null) return [];
  const baseTip = currentBaseTip(store, repo, item) ?? item.baseSha;
  const base = store.findMergeBase(item.headSha, baseTip);
  const baseTree = base === null ? null : store.commitTree(base);
  const headTree = store.commitTree(item.headSha);
  if (headTree === null) return [];
  const basePaths = baseTree === null ? new Map() : store.flattenTree(baseTree);
  const headPaths = store.flattenTree(headTree);
  const out: FileChange[] = [];
  const allPaths = new Set([...basePaths.keys(), ...headPaths.keys()]);
  for (const path of [...allPaths].sort()) {
    const oldEntry = basePaths.get(path);
    const newEntry = headPaths.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    if (oldEntry === undefined && newEntry !== undefined) {
      const blob = store.getObject(newEntry.oid);
      const text = blob !== undefined && blob.type === 'blob' ? blob.data.toString('utf8') : '';
      const additions = countLines(text).length;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, oldOid: null, newOid: newEntry.oid });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      const blob = store.getObject(oldEntry.oid);
      const text = blob !== undefined && blob.type === 'blob' ? blob.data.toString('utf8') : '';
      const deletions = countLines(text).length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, oldOid: oldEntry.oid, newOid: null });
    } else if (oldEntry !== undefined && newEntry !== undefined) {
      const oldBlob = store.getObject(oldEntry.oid);
      const newBlob = store.getObject(newEntry.oid);
      const oldText = oldBlob !== undefined && oldBlob.type === 'blob' ? oldBlob.data.toString('utf8') : '';
      const newText = newBlob !== undefined && newBlob.type === 'blob' ? newBlob.data.toString('utf8') : '';
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  return out;
}

/** The current tip of a pull request's base branch (live), falling back to the recorded base sha. */
function currentBaseTip(store: Store, repo: Repo, item: IssueLike): string | null {
  return branchTipOf(repo, item.baseRef ?? repo.defaultBranch) ?? item.baseSha;
}

/** True when head and base both changed the same file differently since the merge-base. */
export function hasConflict(store: Store, repo: Repo, item: IssueLike): boolean {
  if (item.headSha === null || item.baseSha === null) return false;
  const baseTip = currentBaseTip(store, repo, item);
  if (baseTip === null) return false;
  const base = store.findMergeBase(item.headSha, baseTip);
  const baseTree = base === null ? null : store.commitTree(base);
  const headTree = store.commitTree(item.headSha);
  const baseTipTree = store.commitTree(baseTip);
  if (headTree === null || baseTipTree === null) return false;
  const basePaths = baseTree === null ? new Map() : store.flattenTree(baseTree);
  const headPaths = store.flattenTree(headTree);
  const tipPaths = store.flattenTree(baseTipTree);
  const allPaths = new Set([...basePaths.keys(), ...headPaths.keys(), ...tipPaths.keys()]);
  for (const path of allPaths) {
    const b = basePaths.get(path)?.oid ?? null;
    const h = headPaths.get(path)?.oid ?? null;
    const t = tipPaths.get(path)?.oid ?? null;
    if (h !== b && t !== b && h !== t) return true;
  }
  return false;
}

/** The squash-merge tree: the base tip tree with the head's changes since the merge-base applied. */
function mergedTreeOid(store: Store, repo: Repo, item: IssueLike): string | null {
  if (item.headSha === null || item.baseSha === null) return null;
  const baseTip = currentBaseTip(store, repo, item);
  if (baseTip === null) return null;
  const base = store.findMergeBase(item.headSha, baseTip);
  const baseTree = base === null ? null : store.commitTree(base);
  const headTree = store.commitTree(item.headSha);
  const baseTipTree = store.commitTree(baseTip);
  if (headTree === null || baseTipTree === null) return null;
  const basePaths = baseTree === null ? new Map() : store.flattenTree(baseTree);
  const headPaths = store.flattenTree(headTree);
  const result = store.flattenTree(baseTipTree);
  for (const path of new Set([...basePaths.keys(), ...headPaths.keys()])) {
    const b = basePaths.get(path);
    const h = headPaths.get(path);
    if (h === undefined && b !== undefined) result.delete(path);
    else if (h !== undefined && (b === undefined || b.oid !== h.oid)) result.set(path, h);
  }
  return store.buildTreeFromPaths(result);
}

/**
 * Merge an open pull request with a squash commit onto its base branch. Shared
 * by the REST merge endpoint and the GraphQL mergePullRequest mutation.
 * Returns the merge commit oid, or an error message when the merge cannot run.
 */
export function doMergePull(store: Store, repo: Repo, item: IssueLike): { ok: true; sha: string } | { ok: false; message: string } {
  if (item.kind !== 'pull') return { ok: false, message: 'Not a pull request' };
  if (item.state !== 'open') return { ok: false, message: item.merged ? 'Pull request is already merged' : 'Pull request is closed' };
  if (item.headSha === null || item.baseSha === null) return { ok: false, message: 'Pull request has no head or base' };
  if (hasConflict(store, repo, item)) return { ok: false, message: 'Merge conflict' };
  const treeOid = mergedTreeOid(store, repo, item);
  if (treeOid === null) return { ok: false, message: 'Merge failed' };
  const baseTip = currentBaseTip(store, repo, item) ?? item.baseSha;
  const now = store.stamp();
  const mergeCommit = store.putObject(
    'commit',
    Buffer.from(
      `tree ${treeOid}\nparent ${baseTip}\nauthor ${VIEWER.name} <${VIEWER.email}> ${now.sec} +0000\ncommitter ${VIEWER.name} <${VIEWER.email}> ${now.sec} +0000\n\n${item.title}\n`,
      'utf8',
    ),
  );
  if (item.baseRef !== null) repo.refs.set(`refs/heads/${item.baseRef}`, mergeCommit);
  item.merged = true;
  item.mergedAt = now.iso;
  item.mergeCommitSha = mergeCommit;
  item.state = 'closed';
  item.closedAt = now.iso;
  item.updatedAt = now.iso;
  item.baseSha = mergeCommit;
  repo.updatedAt = now.iso;
  return { ok: true, sha: mergeCommit };
}

/** Create an issue or pull request record on a repo (the shared numbering). */
export function createItem(
  store: Store,
  repo: Repo,
  kind: 'issue' | 'pull',
  fields: { title: string; body?: string; labels?: string[]; headRef?: string; baseRef?: string; headSha?: string; baseSha?: string },
): IssueLike {
  const now = store.stamp();
  const item: IssueLike = {
    kind,
    id: store.nextGlobalId,
    number: repo.nextNumber,
    repoId: repo.id,
    title: fields.title,
    body: fields.body ?? '',
    state: 'open',
    labels: fields.labels ?? [],
    comments: [],
    createdAt: now.iso,
    updatedAt: now.iso,
    closedAt: null,
    authorLogin: VIEWER.login,
    headRef: fields.headRef ?? null,
    baseRef: fields.baseRef ?? null,
    headSha: fields.headSha ?? null,
    baseSha: fields.baseSha ?? null,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  store.nextGlobalId += 1;
  repo.nextNumber += 1;
  repo.items.set(item.number, item);
  return item;
}

// ---------------------------------------------------------------- routes

function lookupRepo(store: Store, owner: string, name: string): Repo | null {
  return store.getRepo(owner, name) ?? null;
}

function treeAtPath(store: Store, treeOid: string, segments: readonly string[]): string | null {
  let current = treeOid;
  for (const segment of segments) {
    const object = store.getObject(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (entry === undefined || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return current;
}

function fileContentJson(req: RestRequest, repo: Repo, path: string, blobOid: string, blob: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: blob.length,
    name,
    path,
    content: blob.toString('base64'),
    sha: blobOid,
    url: `${repoUrl(req, repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `${repoUrl(req, repo)}/git/blobs/${blobOid}`,
    download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
    _links: {},
  };
}

function resolveRefTip(store: Store, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return branchTipOf(repo, repo.defaultBranch);
  if (/^[0-9a-f]{40}$/.test(ref)) return store.getObject(ref) !== undefined ? ref : null;
  const tip = branchTipOf(repo, ref);
  if (tip !== null) return tip;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  return tag ?? null;
}

function walkCommits(store: Store, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

/** Dispatch one REST request. Null when no route matches (the app answers a JSON 404). */
export function handleRest(store: Store, req: RestRequest): RestResponse | null {
  const { method, segments: s } = req;

  // GET /api/v3 — the API root.
  if (method === 'GET' && s.length === 0) {
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  // GET /api/v3/meta
  if (method === 'GET' && s.length === 1 && s[0] === 'meta') {
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }
  // GET /api/v3/user
  if (method === 'GET' && s.length === 1 && s[0] === 'user') {
    return ok(200, userJson());
  }
  // /api/v3/user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'GET') {
      const repos = [...store.repos.values()]
        .filter((repo) => repo.owner === VIEWER.login)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      const page = paginate(req, '/api/v3/user/repos', repos.map((repo) => repoJson(req, store, repo)));
      return ok(200, page.items, page.headers);
    }
    if (method === 'POST') {
      const body = bodyOf(req);
      const name = str(body.name);
      if (name === '') return err(422, 'name is required');
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) return err(422, 'name is invalid');
      if (store.getRepo(VIEWER.login, name) !== undefined) return err(422, 'Repository already exists on this account');
      const repo = store.createRepo(VIEWER.login, name, {
        description: str(body.description),
        private: bool(body.private),
        defaultBranch: str(body.default_branch, 'main'),
      });
      return ok(201, repoJson(req, store, repo));
    }
    return null;
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = s[1] as string;
    const name = s[2] as string;
    const repo = lookupRepo(store, owner, name);
    if (repo === null) return err(404, 'Not Found');
    const rest = s.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(req, store, repo));
      if (method === 'PATCH') {
        const body = bodyOf(req);
        if (body.description !== undefined) repo.description = str(body.description);
        if (body.private !== undefined) repo.private = bool(body.private);
        if (typeof body.default_branch === 'string' && body.default_branch !== '') {
          if (branchTipOf(repo, body.default_branch) === null && repo.refs.size > 0) return err(422, 'default branch does not exist');
          repo.defaultBranch = body.default_branch;
        }
        repo.updatedAt = store.stamp().iso;
        return ok(200, repoJson(req, store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        return { status: 204, json: null };
      }
      return null;
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort();
        return ok(
          200,
          branches.map((branch) => ({
            name: branch,
            commit: { sha: branchTipOf(repo, branch) ?? '', url: `${repoUrl(req, repo)}/commits/${branchTipOf(repo, branch) ?? ''}` },
            protected: false,
          })),
        );
      }
      if (rest.length >= 2 && method === 'GET') {
        const branch = rest.slice(1).join('/');
        const tip = branchTipOf(repo, branch);
        if (tip === null) return err(404, 'Branch not found');
        return ok(200, {
          name: branch,
          commit: { sha: tip, url: `${repoUrl(req, repo)}/commits/${tip}` },
          protected: false,
        });
      }
      return null;
    }

    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const ref = req.query.get('sha');
      const tip = resolveRefTip(store, repo, ref);
      if (tip === null) return err(404, 'No commit found for the given ref');
      const oids = walkCommits(store, tip);
      const page = paginate(
        req,
        `/api/v3/repos/${owner}/${name}/commits`,
        oids.map((oid) => commitJson(req, store, repo, oid)).filter((entry): entry is Record<string, unknown> => entry !== null),
      );
      return ok(200, page.items, page.headers);
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = bodyOf(req);
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/')) return err(422, 'ref must start with refs/');
        if (!/^[0-9a-f]{40}$/.test(sha) || store.getObject(sha) === undefined) return err(422, 'sha does not name an object');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        const object = store.getObject(sha);
        return ok(201, {
          ref,
          node_id: globalId('Ref', repo.id, ref),
          url: `${repoUrl(req, repo)}/git/refs/${ref.split('/').map(encodeURIComponent).join('/')}`,
          object: { sha, type: object?.type ?? 'commit', url: `${repoUrl(req, repo)}/git/${object?.type === 'tag' ? 'tags' : 'commits'}/${sha}` },
        });
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const oid = repo.refs.get(ref);
        if (oid === undefined) return err(404, 'Not Found');
        const object = store.getObject(oid);
        return ok(200, {
          ref,
          node_id: globalId('Ref', repo.id, ref),
          url: `${repoUrl(req, repo)}/git/refs/${ref.split('/').map(encodeURIComponent).join('/')}`,
          object: { sha: oid, type: object?.type ?? 'commit', url: `${repoUrl(req, repo)}/git/${object?.type === 'tag' ? 'tags' : 'commits'}/${oid}` },
        });
      }
      return null;
    }

    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') {
        const tip = resolveRefTip(store, repo, req.query.get('ref'));
        if (tip === null) return err(404, 'Not Found');
        const treeOid = store.commitTree(tip);
        if (treeOid === null) return err(404, 'Not Found');
        const segments = path === '' ? [] : path.split('/');
        if (path !== '') {
          const flat = store.flattenTree(treeOid);
          const file = flat.get(path);
          if (file !== undefined) {
            const blob = store.getObject(file.oid);
            if (blob === undefined || blob.type !== 'blob') return err(404, 'Not Found');
            return ok(200, fileContentJson(req, repo, path, file.oid, blob.data));
          }
          const dirTree = treeAtPath(store, treeOid, segments);
          if (dirTree === null) return err(404, 'Not Found');
          const dirObject = store.getObject(dirTree);
          if (dirObject === undefined) return err(404, 'Not Found');
          return ok(
            200,
            parseTree(dirObject.data).map((entry) => {
              const childPath = `${path}/${entry.name}`;
              if (entry.mode === '40000') {
                return { type: 'dir', name: entry.name, path: childPath, sha: entry.oid, size: 0, url: `${repoUrl(req, repo)}/contents/${childPath.split('/').map(encodeURIComponent).join('/')}`, html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${childPath}`, git_url: `${repoUrl(req, repo)}/git/trees/${entry.oid}`, download_url: null, _links: {} };
              }
              const childBlob = store.getObject(entry.oid);
              return { type: 'file', name: entry.name, path: childPath, sha: entry.oid, size: childBlob?.data.length ?? 0, url: `${repoUrl(req, repo)}/contents/${childPath.split('/').map(encodeURIComponent).join('/')}`, html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${childPath}`, git_url: `${repoUrl(req, repo)}/git/blobs/${entry.oid}`, download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${childPath}`, _links: {} };
            }),
          );
        }
        const rootObject = store.getObject(treeOid);
        if (rootObject === undefined) return err(404, 'Not Found');
        return ok(
          200,
          parseTree(rootObject.data).map((entry) => {
            const childPath = entry.name;
            if (entry.mode === '40000') {
              return { type: 'dir', name: entry.name, path: childPath, sha: entry.oid, size: 0, url: `${repoUrl(req, repo)}/contents/${encodeURIComponent(childPath)}`, html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${childPath}`, git_url: `${repoUrl(req, repo)}/git/trees/${entry.oid}`, download_url: null, _links: {} };
            }
            const childBlob = store.getObject(entry.oid);
            return { type: 'file', name: entry.name, path: childPath, sha: entry.oid, size: childBlob?.data.length ?? 0, url: `${repoUrl(req, repo)}/contents/${encodeURIComponent(childPath)}`, html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${childPath}`, git_url: `${repoUrl(req, repo)}/git/blobs/${entry.oid}`, download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${childPath}`, _links: {} };
          }),
        );
      }
      if (method === 'PUT') {
        const body = bodyOf(req);
        if (path === '') return err(422, 'path is required');
        if (typeof body.content !== 'string') return err(422, 'content is required');
        let decoded: Buffer;
        try {
          decoded = Buffer.from(body.content, 'base64');
        } catch {
          return err(422, 'content is not valid base64');
        }
        const message = str(body.message, `Update ${path}`);
        const branch = str(body.branch, repo.defaultBranch);
        let parent = branchTipOf(repo, branch);
        let paths: Map<string, { mode: string; oid: string }>;
        if (parent === null) {
          if (branch !== repo.defaultBranch) {
            parent = branchTipOf(repo, repo.defaultBranch);
            paths = parent === null ? new Map() : store.branchPaths(repo, repo.defaultBranch);
          } else {
            paths = new Map();
          }
        } else {
          paths = store.branchPaths(repo, branch);
        }
        const existing = paths.get(path);
        if (existing !== undefined) {
          if (typeof body.sha !== 'string' || body.sha !== existing.oid) return err(409, 'sha does not match the file');
        }
        const blobOid = store.putObject('blob', decoded);
        paths.set(path, { mode: '100644', oid: blobOid });
        const commitOid = store.createCommit(repo, branch, paths, message, parent);
        const commitObject = store.getObject(commitOid);
        const commitInfo = commitObject !== undefined ? parseCommit(commitObject.data) : null;
        return ok(existing !== undefined ? 200 : 201, {
          content: fileContentJson(req, repo, path, blobOid, decoded),
          commit: {
            sha: commitOid,
            node_id: globalId('Commit', commitOid),
            message,
            author: { name: VIEWER.name, email: VIEWER.email, date: commitInfo !== null ? new Date(commitInfo.authorTs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : repo.updatedAt },
            committer: { name: VIEWER.name, email: VIEWER.email, date: repo.updatedAt },
            tree: { sha: commitInfo?.tree ?? '', url: `${repoUrl(req, repo)}/git/trees/${commitInfo?.tree ?? ''}` },
            parents: parent === null ? [] : [{ sha: parent, url: `${repoUrl(req, repo)}/commits/${parent}`, html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${parent}` }],
            url: `${repoUrl(req, repo)}/git/commits/${commitOid}`,
          },
        });
      }
      if (method === 'DELETE') {
        const body = bodyOf(req);
        if (path === '') return err(422, 'path is required');
        const message = str(body.message, `Delete ${path}`);
        const branch = str(body.branch, repo.defaultBranch);
        const tip = branchTipOf(repo, branch);
        if (tip === null) return err(404, 'Not Found');
        const paths = store.branchPaths(repo, branch);
        const existing = paths.get(path);
        if (existing === undefined) return err(404, 'Not Found');
        if (typeof body.sha !== 'string' || body.sha !== existing.oid) return err(409, 'sha does not match the file');
        paths.delete(path);
        const commitOid = store.createCommit(repo, branch, paths, message, tip);
        return ok(200, {
          commit: {
            sha: commitOid,
            node_id: globalId('Commit', commitOid),
            message,
            author: { name: VIEWER.name, email: VIEWER.email, date: repo.updatedAt },
            committer: { name: VIEWER.name, email: VIEWER.email, date: repo.updatedAt },
            parents: [{ sha: tip, url: `${repoUrl(req, repo)}/commits/${tip}`, html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${tip}` }],
            url: `${repoUrl(req, repo)}/git/commits/${commitOid}`,
          },
        });
      }
      return null;
    }

    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        return ok(200, [...repo.labels.values()].map((label) => labelJson(repo, label.name, label.color, label.description)));
      }
      if (method === 'POST' && rest.length === 1) {
        const body = bodyOf(req);
        const name = str(body.name);
        if (name === '') return err(422, 'name is required');
        if (repo.labels.has(name)) return err(422, 'Label already exists');
        const color = str(body.color, 'ededed').replace(/^#/, '');
        const description = str(body.description);
        repo.labels.set(name, { name, color, description });
        return ok(201, labelJson(repo, name, color, description));
      }
      return null;
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const direction = req.query.get('direction') ?? 'desc';
          const sort = req.query.get('sort') ?? 'created';
          const labelsFilter = req.query.get('labels');
          let items = [...repo.items.values()];
          if (state !== 'all') items = items.filter((item) => item.state === state);
          if (labelsFilter !== null && labelsFilter !== '') {
            const wanted = labelsFilter.split(',').map((label) => label.trim());
            items = items.filter((item) => wanted.every((label) => item.labels.includes(label)));
          }
          items.sort((a, b) => (sort === 'created' ? (direction === 'asc' ? a.number - b.number : b.number - a.number) : 0));
          const page = paginate(req, `/api/v3/repos/${owner}/${name}/issues`, items.map((item) => issueJson(req, store, repo, item)));
          return ok(200, page.items, page.headers);
        }
        if (method === 'POST') {
          const body = bodyOf(req);
          const title = str(body.title);
          if (title === '') return err(422, 'title is required');
          const labels: string[] = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) return err(422, `Label "${label}" does not exist`);
          }
          const item = createItem(store, repo, 'issue', { title, body: str(body.body), labels });
          return ok(201, issueJson(req, store, repo, item));
        }
        return null;
      }
      const number = Number.parseInt(rest[1] ?? '', 10);
      if (!Number.isSafeInteger(number)) return null;
      const item = repo.items.get(number);
      if (rest.length === 2) {
        if (item === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, issueJson(req, store, repo, item));
        if (method === 'PATCH') {
          const body = bodyOf(req);
          if (typeof body.title === 'string') item.title = body.title;
          if (typeof body.body === 'string') item.body = body.body;
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
            if (body.state !== item.state) {
              item.state = body.state;
              item.closedAt = body.state === 'closed' ? store.stamp().iso : null;
            }
          }
          if (Array.isArray(body.labels)) {
            const labels = body.labels.filter((label): label is string => typeof label === 'string');
            for (const label of labels) {
              if (!repo.labels.has(label)) return err(422, `Label "${label}" does not exist`);
            }
            item.labels = labels;
          }
          item.updatedAt = store.stamp().iso;
          return ok(200, issueJson(req, store, repo, item));
        }
        return null;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (item === undefined) return err(404, 'Not Found');
        if (method === 'GET') {
          return ok(200, item.comments.map((comment) => commentJson(req, repo, item, comment)));
        }
        if (method === 'POST') {
          const body = bodyOf(req);
          const text = str(body.body);
          if (text === '') return err(422, 'body is required');
          const now = store.stamp();
          const comment: IssueComment = {
            id: store.nextCommentId,
            body: text,
            createdAt: now.iso,
            updatedAt: now.iso,
            authorLogin: VIEWER.login,
          };
          store.nextCommentId += 1;
          item.comments.push(comment);
          return ok(201, commentJson(req, repo, item, comment));
        }
        return null;
      }
      return null;
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const direction = req.query.get('direction') ?? 'desc';
          let items = [...repo.items.values()].filter((item) => item.kind === 'pull');
          if (state !== 'all') items = items.filter((item) => item.state === state);
          items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const page = paginate(req, `/api/v3/repos/${owner}/${name}/pulls`, items.map((item) => pullJson(req, store, repo, item)));
          return ok(200, page.items, page.headers);
        }
        if (method === 'POST') {
          const body = bodyOf(req);
          const title = str(body.title);
          const head = str(body.head);
          const base = str(body.base, repo.defaultBranch);
          if (title === '') return err(422, 'title is required');
          if (head === '') return err(422, 'head is required');
          const headSha = branchTipOf(repo, head);
          if (headSha === null) return err(422, 'head branch not found');
          const baseSha = branchTipOf(repo, base);
          if (baseSha === null) return err(422, 'base branch not found');
          const duplicate = [...repo.items.values()].find(
            (item) => item.kind === 'pull' && item.state === 'open' && item.headRef === head && item.baseRef === base,
          );
          if (duplicate !== undefined) return err(422, 'A pull request already exists for this head and base');
          const item = createItem(store, repo, 'pull', { title, body: str(body.body), headRef: head, baseRef: base, headSha, baseSha });
          return ok(201, pullJson(req, store, repo, item));
        }
        return null;
      }
      const number = Number.parseInt(rest[1] ?? '', 10);
      if (!Number.isSafeInteger(number)) return null;
      const item = repo.items.get(number);
      if (rest.length === 2) {
        if (item === undefined || item.kind !== 'pull') return err(404, 'Not Found');
        if (method === 'GET') return ok(200, pullJson(req, store, repo, item));
        return null;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (item === undefined || item.kind !== 'pull') return err(404, 'Not Found');
        return ok(
          200,
          pullFiles(store, repo, item).map((change) => ({
            sha: change.newOid ?? change.oldOid ?? '',
            filename: change.filename,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            changes: change.changes,
            blob_url: `${repoUrl(req, repo)}/git/blobs/${change.newOid ?? ''}`,
            raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${item.headRef}/${change.filename}`,
            contents_url: `${repoUrl(req, repo)}/contents/${change.filename.split('/').map(encodeURIComponent).join('/')}`,
          })),
        );
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (item === undefined || item.kind !== 'pull') return err(404, 'Not Found');
        const merged = doMergePull(store, repo, item);
        if (!merged.ok) {
          const status = merged.message === 'Merge conflict' || item.state !== 'open' ? 405 : 422;
          return err(status, merged.message);
        }
        return ok(200, { sha: merged.sha, merged: true, message: item.title });
      }
      return null;
    }
  }

  return null;
}
