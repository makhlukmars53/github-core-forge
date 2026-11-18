// The forge's store: git objects plus the REST resources, all in memory.
//
// One Store holds everything the four surfaces share, so a push, a REST call, a
// GraphQL mutation and an MCP tool all read and write the same repos, refs,
// issues and pull requests. Nothing here touches disk or the network, and no
// request reads a wall clock: timestamps come from a fixed base plus a
// monotonic sequence, so the same request order always builds the same bytes.

import { createHash } from 'node:crypto';
import { VIEWER, isoOf, trialNowSec } from './seed.ts';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorTs: number;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committerTs: number;
  readonly message: string;
}

export interface TagInfo {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && OID_RE.test(value);
}

/** The git object id of `type` + `data`: sha1 of "<type> <len>\0<data>". */
export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorName = '';
  let authorEmail = '';
  let authorTs = 0;
  let committerName = '';
  let committerEmail = '';
  let committerTs = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ') || line.startsWith('committer ')) {
      const who = line.startsWith('author ') ? line.slice(7) : line.slice(10);
      const lt = who.indexOf('<');
      const gt = who.indexOf('>');
      const name = (lt < 0 ? who : who.slice(0, lt)).trim();
      const email = lt < 0 || gt < 0 ? '' : who.slice(lt + 1, gt);
      const rest = gt < 0 ? '' : who.slice(gt + 1).trim().split(/\s+/);
      const ts = Number.parseInt(rest[0] ?? '0', 10) || 0;
      if (line.startsWith('author ')) {
        authorName = name;
        authorEmail = email;
        authorTs = ts;
      } else {
        committerName = name;
        committerEmail = email;
        committerTs = ts;
      }
    }
  }
  return { tree, parents, authorName, authorEmail, authorTs, committerName, committerEmail, committerTs, message };
}

export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  authorName: string;
  authorEmail: string;
  authorTs: number;
  committerName: string;
  committerEmail: string;
  committerTs: number;
  message: string;
}): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.authorName} <${info.authorEmail}> ${info.authorTs} +0000`);
  lines.push(`committer ${info.committerName} <${info.committerEmail}> ${info.committerTs} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Serialise tree entries in git's order (directories sort as if named with '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- the store

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly authorLogin: string;
}

export interface IssueLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface IssueLike {
  readonly kind: 'issue' | 'pull';
  readonly id: number;
  readonly number: number;
  readonly repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly authorLogin: string;
  headRef: string | null;
  baseRef: string | null;
  headSha: string | null;
  baseSha: string | null;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** Full ref name (refs/heads/..., refs/tags/...) to the commit/tag oid. */
  readonly refs: Map<string, string>;
  readonly labels: Map<string, IssueLabel>;
  /** Issues and pull requests by their shared per-repo number. */
  readonly items: Map<number, IssueLike>;
  nextNumber: number;
}

/** The tip of a branch name (refs/heads/<branch>), or null. */
export function branchTipOf(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  readonly repoById = new Map<number, Repo>();
  /** Monotonic sequence: every created thing takes the next tick, so ordering is fixed. */
  seq = 0;
  nextRepoId = 5000;
  nextGlobalId = 1_000_000;
  nextCommentId = 2_000_000;
  readonly baseSec: number = trialNowSec();

  /** The next deterministic timestamp: base plus the sequence, as epoch seconds and ISO. */
  stamp(): { sec: number; iso: string } {
    this.seq += 1;
    const sec = this.baseSec + this.seq;
    return { sec, iso: isoOf(sec) };
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean; defaultBranch?: string }): Repo {
    const now = this.stamp();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      createdAt: now.iso,
      updatedAt: now.iso,
      refs: new Map(),
      labels: new Map(),
      items: new Map(),
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    this.repoById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    this.repoById.delete(repo.id);
  }

  /** The tip of a ref, or null when the ref does not exist. */
  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** The tip of a branch name (refs/heads/<branch>), or null. */
  branchTip(repo: Repo, branch: string): string | null {
    return branchTipOf(repo, branch);
  }

  /** All refs of a repo, in a stable order: HEAD's branch first, then the rest sorted. */
  sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
    const out = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** True when `ancestor` is reachable from `tip` through commit parents. */
  isAncestor(tip: string, ancestor: string): boolean {
    if (tip === ancestor) return true;
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const info = parseCommit(object.data);
      for (const parent of info.parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The nearest common ancestor of two commits, or null when they share none. */
  findMergeBase(a: string, b: string): string | null {
    const ancestors = new Set<string>();
    const queueA: string[] = [a];
    while (queueA.length > 0) {
      const oid = queueA.shift() as string;
      if (ancestors.has(oid)) continue;
      ancestors.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    const queueB: string[] = [b];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const oid = queueB.shift() as string;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestors.has(oid)) return oid;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    return null;
  }

  /** The tree oid of a commit, or null when the commit is unknown. */
  commitTree(oid: string): string | null {
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Every path in a tree, flattened: path -> { mode, oid }. */
  flattenTree(treeOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build a tree from a flat path map, writing every intermediate tree. Returns the root tree oid. */
  buildTreeFromPaths(paths: Map<string, { mode: string; oid: string }>): string {
    const buildLevel = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, { mode: string; oid: string }>>();
      for (const [path, value] of paths) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) entries.push({ mode: value.mode, name: rest, oid: value.oid });
        else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (sub === undefined) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(rest.slice(slash + 1), value);
        }
      }
      for (const [dir, sub] of dirs) {
        const subPaths = new Map<string, { mode: string; oid: string }>();
        for (const [p, v] of sub) subPaths.set(p, v);
        const childOid = this.buildTreeFromPathsAt(subPaths);
        entries.push({ mode: '40000', name: dir, oid: childOid });
      }
      return this.putObject('tree', buildTree(entries));
    };
    return buildLevel('');
  }

  private buildTreeFromPathsAt(paths: Map<string, { mode: string; oid: string }>): string {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, Map<string, { mode: string; oid: string }>>();
    for (const [path, value] of paths) {
      const slash = path.indexOf('/');
      if (slash < 0) entries.push({ mode: value.mode, name: path, oid: value.oid });
      else {
        const dir = path.slice(0, slash);
        let sub = dirs.get(dir);
        if (sub === undefined) {
          sub = new Map();
          dirs.set(dir, sub);
        }
        sub.set(path.slice(slash + 1), value);
      }
    }
    for (const [dir, sub] of dirs) {
      entries.push({ mode: '40000', name: dir, oid: this.buildTreeFromPathsAt(sub) });
    }
    return this.putObject('tree', buildTree(entries));
  }

  /** Create a commit on a repo's branch from a flat path map, with `parent` (null for a root commit). */
  createCommit(
    repo: Repo,
    branch: string,
    paths: Map<string, { mode: string; oid: string }>,
    message: string,
    parent: string | null,
  ): string {
    const treeOid = this.buildTreeFromPaths(paths);
    const now = this.stamp();
    const commit = buildCommit({
      tree: treeOid,
      parents: parent === null ? [] : [parent],
      authorName: VIEWER.name,
      authorEmail: VIEWER.email,
      authorTs: now.sec,
      committerName: VIEWER.name,
      committerEmail: VIEWER.email,
      committerTs: now.sec,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const oid = this.putObject('commit', commit);
    repo.refs.set(`refs/heads/${branch}`, oid);
    repo.updatedAt = now.iso;
    return oid;
  }

  /** The flat path map of a branch tip (empty when the branch does not exist). */
  branchPaths(repo: Repo, branch: string): Map<string, { mode: string; oid: string }> {
    const tip = this.branchTip(repo, branch);
    if (tip === null) return new Map();
    const tree = this.commitTree(tip);
    if (tree === null) return new Map();
    return this.flattenTree(tree);
  }
}

/** An opaque, stable global id: base64url of "<kind>:<parts...>". */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const split = text.split(':');
    if (split.length < 2) return null;
    return { kind: split[0] as string, parts: split.slice(1) };
  } catch {
    return null;
  }
}

/** A cursor for GraphQL/REST pagination: base64url of the item's number. */
export function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

export function numberOfCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice(7), 10);
    return Number.isSafeInteger(n) ? n : null;
  } catch {
    return null;
  }
}
