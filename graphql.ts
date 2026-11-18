// GraphQL v4 at /api/graphql: a small parser and executor for the documents gh
// and github-mcp-server actually send. It is a real GraphQL implementation for
// this schema, not a pattern match on the known documents: it tokenizes, parses
// (operations, variables, fragments, aliases, input objects, enums, batching),
// validates fields against the type table, and answers unknown fields and
// unknown repositories the way GitHub does — HTTP 200 with an errors array for
// the first, data.repository null with no errors for the second.

import {
  branchTipOf,
  cursorOf,
  globalId,
  numberOfCursor,
  parseGlobalId,
  type IssueComment,
  type IssueLike,
  type Repo,
  type Store,
} from './store.ts';
import { VIEWER } from './seed.ts';
import { createItem, doMergePull, hasConflict, pullFiles } from './rest.ts';

// ---------------------------------------------------------------- tokenizer

type TokenKind =
  | 'braceL'
  | 'braceR'
  | 'parenL'
  | 'parenR'
  | 'bracketL'
  | 'bracketR'
  | 'colon'
  | 'bang'
  | 'dollar'
  | 'equals'
  | 'at'
  | 'spread'
  | 'name'
  | 'int'
  | 'float'
  | 'string'
  | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    const single: Record<string, TokenKind> = {
      '{': 'braceL',
      '}': 'braceR',
      '(': 'parenL',
      ')': 'parenR',
      '[': 'bracketL',
      ']': 'bracketR',
      ':': 'colon',
      '!': 'bang',
      $: 'dollar',
      '=': 'equals',
      '@': 'at',
    };
    const kind = single[ch];
    if (kind !== undefined) {
      tokens.push({ kind, value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j] as string;
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in a GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

export type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: ReadonlyArray<{ readonly name: string; readonly value: ValueNode }> };

export interface FieldNode {
  readonly alias: string | null;
  readonly name: string;
  readonly args: ReadonlyArray<{ readonly name: string; readonly value: ValueNode }>;
  readonly selectionSet: readonly SelectionNode[] | null;
}

export type SelectionNode =
  | { readonly kind: 'field'; readonly field: FieldNode }
  | { readonly kind: 'fragmentSpread'; readonly name: string }
  | { readonly kind: 'inlineFragment'; readonly typeCondition: string | null; readonly selectionSet: readonly SelectionNode[] };

export interface OperationDefinition {
  readonly kind: 'operation';
  readonly operation: 'query' | 'mutation' | 'subscription';
  readonly name: string | null;
  readonly variableDefinitions: ReadonlyArray<{ readonly name: string; readonly required: boolean; readonly defaultValue: ValueNode | null }>;
  readonly selectionSet: readonly SelectionNode[];
}

export interface FragmentDefinition {
  readonly kind: 'fragment';
  readonly name: string;
  readonly typeCondition: string;
  readonly selectionSet: readonly SelectionNode[];
}

export type DefinitionNode = OperationDefinition | FragmentDefinition;

class Parser {
  private pos = 0;
  private readonly tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expect(kind: TokenKind, what: string): Token {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`expected ${what}, found ${JSON.stringify(token.value)}`);
    return token;
  }

  private expectName(what = 'a name'): string {
    return this.expect('name', what).value;
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token.kind === 'braceL') {
      return { kind: 'operation', operation: 'query', name: null, variableDefinitions: [], selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName('a fragment name');
      if (this.expectName('on') !== 'on') throw new Error('expected on after a fragment name');
      const typeCondition = this.expectName('a type condition');
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      let variableDefinitions: OperationDefinition['variableDefinitions'] = [];
      if (this.peek().kind === 'parenL') variableDefinitions = this.parseVariableDefinitions();
      this.skipDirectives();
      return { kind: 'operation', operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`unexpected token ${JSON.stringify(token.value)} at the top of a document`);
  }

  private parseVariableDefinitions(): OperationDefinition['variableDefinitions'] {
    this.expect('parenL', '(');
    const defs: Array<{ name: string; required: boolean; defaultValue: ValueNode | null }> = [];
    while (this.peek().kind !== 'parenR') {
      this.expect('dollar', '$');
      const name = this.expectName('a variable name');
      this.expect('colon', ':');
      this.parseType();
      let required = false;
      if (this.peek().kind === 'bang') {
        this.next();
        required = true;
      }
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === 'equals') {
        this.next();
        defaultValue = this.parseValue(true);
      }
      defs.push({ name, required, defaultValue });
    }
    this.expect('parenR', ')');
    return defs;
  }

  private parseType(): void {
    if (this.peek().kind === 'bracketL') {
      this.next();
      this.parseType();
      this.expect('bracketR', ']');
    } else {
      this.expectName('a type name');
    }
    if (this.peek().kind === 'bang') this.next();
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'at') {
      this.next();
      this.expectName('a directive name');
      if (this.peek().kind === 'parenL') this.parseArguments();
    }
  }

  private parseSelectionSet(): readonly SelectionNode[] {
    this.expect('braceL', '{');
    const selections: SelectionNode[] = [];
    while (this.peek().kind !== 'braceR') selections.push(this.parseSelection());
    this.expect('braceR', '}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type condition');
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'colon') {
      this.next();
      alias = first;
      name = this.expectName('a field name');
    }
    let args: FieldNode['args'] = [];
    if (this.peek().kind === 'parenL') args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: readonly SelectionNode[] | null = null;
    if (this.peek().kind === 'braceL') selectionSet = this.parseSelectionSet();
    return { kind: 'field', field: { alias, name, args, selectionSet } };
  }

  private parseArguments(): FieldNode['args'] {
    this.expect('parenL', '(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (this.peek().kind !== 'parenR') {
      const name = this.expectName('an argument name');
      this.expect('colon', ':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expect('parenR', ')');
    return args;
  }

  private parseValue(constLiteral: boolean): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'dollar': {
        if (constLiteral) throw new Error('a variable is not allowed in a constant value');
        return { kind: 'variable', name: this.expectName('a variable name') };
      }
      case 'int':
        return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(token.value) };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'bracketL': {
        const values: ValueNode[] = [];
        while (this.peek().kind !== 'bracketR') values.push(this.parseValue(constLiteral));
        this.expect('bracketR', ']');
        return { kind: 'list', values };
      }
      case 'braceL': {
        const fields: Array<{ name: string; value: ValueNode }> = [];
        while (this.peek().kind !== 'braceR') {
          const name = this.expectName('an input field name');
          this.expect('colon', ':');
          fields.push({ name, value: this.parseValue(constLiteral) });
        }
        this.expect('braceR', '}');
        return { kind: 'object', fields };
      }
      case 'name': {
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      }
      default:
        throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
    }
  }
}

export function parseDocument(source: string): DefinitionNode[] {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------- schema

interface GqlError {
  readonly message: string;
  readonly path?: ReadonlyArray<string | number>;
}

interface GqlContext {
  readonly store: Store;
}

type AnyRecord = Record<string, unknown>;

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issues', 'issue', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'mergedAt', 'createdAt', 'updatedAt', 'author'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'createdAt', 'author'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'ofType', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __Directive: ['name', 'description', 'locations', 'args'],
};

const TYPE_KINDS: Readonly<Record<string, string>> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  User: 'OBJECT',
  Repository: 'OBJECT',
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  IssueCommentConnection: 'OBJECT',
  IssueEdge: 'OBJECT',
  PullRequestEdge: 'OBJECT',
  IssueCommentEdge: 'OBJECT',
  PageInfo: 'OBJECT',
  Ref: 'OBJECT',
  Label: 'OBJECT',
  IssueComment: 'OBJECT',
  PullRequestFile: 'OBJECT',
  CreateIssuePayload: 'OBJECT',
  CloseIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  RepositoryPermission: 'ENUM',
  OrderDirection: 'ENUM',
  IssueOrderField: 'ENUM',
  __Type: 'OBJECT',
  __Field: 'OBJECT',
  __EnumValue: 'OBJECT',
  __InputValue: 'OBJECT',
  __Schema: 'OBJECT',
  __Directive: 'OBJECT',
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['DISCUSSION', 'ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'],
};

function typeInfo(name: string): AnyRecord | null {
  const kind = TYPE_KINDS[name];
  if (kind === undefined) return null;
  return {
    __typename: '__Type',
    _typeName: name,
    name,
    kind,
    description: null,
    _fields: TYPE_FIELDS[name] ?? [],
    _enumValues: ENUM_VALUES[name] ?? [],
  };
}

function userObject(): AnyRecord {
  return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function repoObject(repo: Repo): AnyRecord {
  return { __typename: 'Repository', _repo: repo };
}

function itemObject(repo: Repo, item: IssueLike): AnyRecord {
  return { __typename: item.kind === 'pull' ? 'PullRequest' : 'Issue', _repo: repo, _item: item };
}

function commentObject(repo: Repo, item: IssueLike, comment: IssueComment): AnyRecord {
  return { __typename: 'IssueComment', _repo: repo, _item: item, _comment: comment };
}

function stateOf(item: IssueLike): string {
  if (item.kind === 'pull') {
    if (item.merged) return 'MERGED';
    return item.state === 'open' ? 'OPEN' : 'CLOSED';
  }
  return item.state === 'open' ? 'OPEN' : 'CLOSED';
}

interface ConnectionInput {
  readonly first?: number;
  readonly after?: string | null;
  readonly states?: readonly string[];
  readonly orderBy?: { readonly field?: string; readonly direction?: string };
}

function connectionOf<T extends AnyRecord>(
  typename: string,
  edgeTypename: string,
  items: readonly T[],
  input: ConnectionInput,
  numberOf: (item: T) => number,
  filterStates?: (item: T, states: readonly string[]) => boolean,
): AnyRecord {
  let list = [...items];
  if (input.states !== undefined && input.states.length > 0 && filterStates !== undefined) {
    list = list.filter((item) => filterStates(item, input.states as readonly string[]));
  }
  const direction = input.orderBy?.direction === 'ASC' ? 1 : -1;
  const field = input.orderBy?.field;
  list.sort((a, b) => {
    if (field === 'UPDATED_AT') {
      const ua = String((a as AnyRecord).updatedAt ?? '');
      const ub = String((b as AnyRecord).updatedAt ?? '');
      if (ua !== ub) return direction * (ua < ub ? -1 : 1);
    }
    return direction * (numberOf(a) - numberOf(b));
  });
  let start = 0;
  if (typeof input.after === 'string' && input.after !== '') {
    const afterNumber = numberOfCursor(input.after);
    if (afterNumber !== null) {
      const index = list.findIndex((item) => numberOf(item) === afterNumber);
      if (index >= 0) start = index + 1;
    }
  }
  const first = typeof input.first === 'number' && input.first >= 0 ? input.first : list.length;
  const page = list.slice(start, start + first);
  const hasNextPage = start + first < list.length;
  const endCursor = page.length > 0 ? cursorOf(numberOf(page[page.length - 1] as T)) : null;
  const startCursor = page.length > 0 ? cursorOf(numberOf(page[0] as T)) : null;
  return {
    __typename: typename,
    nodes: page,
    edges: page.map((node) => ({ __typename: edgeTypename, node, cursor: cursorOf(numberOf(node)) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor,
      endCursor,
    },
    totalCount: list.length,
  };
}

// ---------------------------------------------------------------- values

function evalValue(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- resolvers

function repoFromId(store: Store, id: unknown): Repo | null {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  if (parsed === null || parsed.kind !== 'Repository') return null;
  const repoId = Number.parseInt(parsed.parts[0] ?? '', 10);
  if (!Number.isSafeInteger(repoId)) return null;
  return store.repoById.get(repoId) ?? null;
}

function itemFromId(store: Store, id: unknown): { repo: Repo; item: IssueLike } | null {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  if (parsed === null) return null;
  if (parsed.kind !== 'Issue' && parsed.kind !== 'PullRequest') return null;
  const repoId = Number.parseInt(parsed.parts[0] ?? '', 10);
  const number = Number.parseInt(parsed.parts[1] ?? '', 10);
  if (!Number.isSafeInteger(repoId) || !Number.isSafeInteger(number)) return null;
  const repo = store.repoById.get(repoId);
  if (repo === undefined) return null;
  const item = repo.items.get(number);
  if (item === undefined) return null;
  return { repo, item };
}

function addCommentTo(store: Store, repo: Repo, item: IssueLike, body: string): IssueComment {
  const now = store.stamp();
  const comment: IssueComment = {
    id: store.nextCommentId,
    body,
    createdAt: now.iso,
    updatedAt: now.iso,
    authorLogin: VIEWER.login,
  };
  store.nextCommentId += 1;
  item.comments.push(comment);
  return comment;
}

type Resolver = (value: AnyRecord, args: Record<string, unknown>, ctx: GqlContext, errors: GqlError[]) => unknown;

const RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: () => userObject(),
    repository: (value, args, ctx) => {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoObject(repo);
    },
    node: (value, args, ctx) => {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = repoFromId(ctx.store, id);
        return repo === null ? null : repoObject(repo);
      }
      const found = itemFromId(ctx.store, id);
      return found === null ? null : itemObject(found.repo, found.item);
    },
    __type: (value, args) => {
      const name = args.name;
      return typeof name === 'string' ? typeInfo(name) : null;
    },
    __schema: () => ({ __typename: '__Schema' }),
  },
  Mutation: {
    createIssue: (value, args, ctx, errors) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromId(ctx.store, input.repositoryId);
      if (repo === null) {
        errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        return { __typename: 'CreateIssuePayload', _issue: null, clientMutationId: input.clientMutationId ?? null };
      }
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') {
        errors.push({ message: 'A title is required to create an issue.' });
        return { __typename: 'CreateIssuePayload', _issue: null, clientMutationId: input.clientMutationId ?? null };
      }
      const item = createItem(ctx.store, repo, 'issue', { title, body: typeof input.body === 'string' ? input.body : '' });
      return { __typename: 'CreateIssuePayload', _issue: itemObject(repo, item), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (value, args, ctx, errors) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = itemFromId(ctx.store, input.issueId);
      if (found === null) {
        errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        return { __typename: 'CloseIssuePayload', _issue: null, clientMutationId: input.clientMutationId ?? null };
      }
      if (found.item.state === 'open') {
        found.item.state = 'closed';
        found.item.closedAt = ctx.store.stamp().iso;
        found.item.updatedAt = found.item.closedAt;
      }
      return { __typename: 'CloseIssuePayload', _issue: itemObject(found.repo, found.item), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (value, args, ctx, errors) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromId(ctx.store, input.repositoryId);
      const fail = (message: string): AnyRecord => {
        errors.push({ message });
        return { __typename: 'CreatePullRequestPayload', _pull: null, clientMutationId: input.clientMutationId ?? null };
      };
      if (repo === null) return fail('Could not resolve to a Repository with the id provided.');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
      const title = typeof input.title === 'string' ? input.title : '';
      const headSha = branchTipOf(repo, head);
      if (headSha === null) return fail(`Head branch ${head} not found.`);
      const baseSha = branchTipOf(repo, base);
      if (baseSha === null) return fail(`Base branch ${base} not found.`);
      const duplicate = [...repo.items.values()].find(
        (item) => item.kind === 'pull' && item.state === 'open' && item.headRef === head && item.baseRef === base,
      );
      if (duplicate !== undefined) return fail('A pull request already exists for this head and base.');
      const item = createItem(ctx.store, repo, 'pull', {
        title,
        body: typeof input.body === 'string' ? input.body : '',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
      });
      return { __typename: 'CreatePullRequestPayload', _pull: itemObject(repo, item), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (value, args, ctx, errors) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = itemFromId(ctx.store, input.pullRequestId);
      const fail = (message: string): AnyRecord => {
        errors.push({ message });
        return { __typename: 'MergePullRequestPayload', _pull: null, clientMutationId: input.clientMutationId ?? null };
      };
      if (found === null) return fail('Could not resolve to a PullRequest with the id provided.');
      const merged = doMergePull(ctx.store, found.repo, found.item);
      if (!merged.ok) return fail(merged.message);
      return { __typename: 'MergePullRequestPayload', _pull: itemObject(found.repo, found.item), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (value, args, ctx, errors) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = itemFromId(ctx.store, input.subjectId);
      if (found === null) {
        errors.push({ message: 'Could not resolve to a subject with the id provided.' });
        return { __typename: 'AddCommentPayload', _commentEdge: null, clientMutationId: input.clientMutationId ?? null };
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = addCommentTo(ctx.store, found.repo, found.item, body);
      return {
        __typename: 'AddCommentPayload',
        _commentEdge: { __typename: 'IssueCommentEdge', node: commentObject(found.repo, found.item, comment), cursor: cursorOf(comment.id) },
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
  User: {
    login: (value) => value.login ?? null,
    id: (value) => value.id ?? null,
    name: (value) => value.name ?? null,
    email: (value) => value.email ?? null,
  },
  Repository: {
    id: (value) => globalId('Repository', (value._repo as Repo).id),
    databaseId: (value) => (value._repo as Repo).id,
    name: (value) => (value._repo as Repo).name,
    nameWithOwner: (value) => `${(value._repo as Repo).owner}/${(value._repo as Repo).name}`,
    owner: () => userObject(),
    defaultBranchRef: (value) => {
      const repo = value._repo as Repo;
      const tip = branchTipOf(repo, repo.defaultBranch);
      return tip === null ? null : { __typename: 'Ref', name: repo.defaultBranch, _target: tip };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issues: (value, args) => {
      const repo = value._repo as Repo;
      const items = [...repo.items.values()].filter((item) => item.kind === 'issue');
      return connectionOf(
        'IssueConnection',
        'IssueEdge',
        items.map((item) => itemObject(repo, item)),
        args as ConnectionInput,
        (node) => (node._item as IssueLike).number,
        (node, states) => states.includes(stateOf(node._item as IssueLike)),
      );
    },
    issue: (value, args) => {
      const repo = value._repo as Repo;
      const number = typeof args.number === 'number' ? args.number : -1;
      const item = repo.items.get(number);
      return item === undefined || item.kind !== 'issue' ? null : itemObject(repo, item);
    },
    pullRequests: (value, args) => {
      const repo = value._repo as Repo;
      const items = [...repo.items.values()].filter((item) => item.kind === 'pull');
      return connectionOf(
        'PullRequestConnection',
        'PullRequestEdge',
        items.map((item) => itemObject(repo, item)),
        args as ConnectionInput,
        (node) => (node._item as IssueLike).number,
        (node, states) => states.includes(stateOf(node._item as IssueLike)),
      );
    },
    pullRequest: (value, args) => {
      const repo = value._repo as Repo;
      const number = typeof args.number === 'number' ? args.number : -1;
      const item = repo.items.get(number);
      return item === undefined || item.kind !== 'pull' ? null : itemObject(repo, item);
    },
  },
  Issue: {
    id: (value) => globalId('Issue', (value._repo as Repo).id, (value._item as IssueLike).number),
    number: (value) => (value._item as IssueLike).number,
    title: (value) => (value._item as IssueLike).title,
    body: (value) => (value._item as IssueLike).body,
    state: (value) => stateOf(value._item as IssueLike),
    url: (value) => `https://github.com/${(value._repo as Repo).owner}/${(value._repo as Repo).name}/issues/${(value._item as IssueLike).number}`,
    createdAt: (value) => (value._item as IssueLike).createdAt,
    updatedAt: (value) => (value._item as IssueLike).updatedAt,
    author: () => userObject(),
    labels: (value) => {
      const repo = value._repo as Repo;
      const item = value._item as IssueLike;
      return item.labels.map((name) => {
        const found = repo.labels.get(name);
        return { __typename: 'Label', id: globalId('Label', repo.id, name), name, color: found?.color ?? 'ededed', description: found?.description ?? '' };
      });
    },
    comments: (value, args) => {
      const repo = value._repo as Repo;
      const item = value._item as IssueLike;
      return connectionOf(
        'IssueCommentConnection',
        'IssueCommentEdge',
        item.comments.map((comment) => commentObject(repo, item, comment)),
        args as ConnectionInput,
        (node) => (node._comment as IssueComment).id,
      );
    },
  },
  PullRequest: {
    id: (value) => globalId('PullRequest', (value._repo as Repo).id, (value._item as IssueLike).number),
    number: (value) => (value._item as IssueLike).number,
    title: (value) => (value._item as IssueLike).title,
    body: (value) => (value._item as IssueLike).body,
    state: (value) => stateOf(value._item as IssueLike),
    merged: (value) => (value._item as IssueLike).merged,
    mergeable: (value, args, ctx) => {
      const repo = value._repo as Repo;
      const item = value._item as IssueLike;
      if (item.headSha === null || item.baseSha === null) return 'UNKNOWN';
      return hasConflict(ctx.store, repo, item) ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (value) => (value._item as IssueLike).headRef,
    baseRefName: (value) => (value._item as IssueLike).baseRef,
    headRefOid: (value) => (value._item as IssueLike).headSha,
    baseRefOid: (value) => (value._item as IssueLike).baseSha,
    files: (value, args, ctx) => {
      const repo = value._repo as Repo;
      const item = value._item as IssueLike;
      const changes = pullFiles(ctx.store, repo, item);
      const nodes = changes.map((change) => ({
        __typename: 'PullRequestFile',
        path: change.filename,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
        status: change.status.toUpperCase(),
      }));
      return connectionOf('PullRequestConnection', 'PullRequestEdge', nodes, args as ConnectionInput, (node) => 0);
    },
    mergedAt: (value) => (value._item as IssueLike).mergedAt,
    createdAt: (value) => (value._item as IssueLike).createdAt,
    updatedAt: (value) => (value._item as IssueLike).updatedAt,
    author: () => userObject(),
  },
  Ref: {
    name: (value) => value.name ?? null,
    target: (value) => (value._target !== undefined ? { __typename: 'Commit', oid: value._target } : null),
  },
  Label: {
    id: (value) => value.id ?? null,
    name: (value) => value.name ?? null,
    color: (value) => value.color ?? null,
    description: (value) => value.description ?? null,
  },
  IssueComment: {
    id: (value) => globalId('IssueComment', (value._comment as IssueComment).id),
    body: (value) => (value._comment as IssueComment).body,
    createdAt: (value) => (value._comment as IssueComment).createdAt,
    author: () => userObject(),
  },
  IssueEdge: {
    node: (value) => value.node ?? null,
    cursor: (value) => value.cursor ?? null,
  },
  PullRequestEdge: {
    node: (value) => value.node ?? null,
    cursor: (value) => value.cursor ?? null,
  },
  IssueCommentEdge: {
    node: (value) => value.node ?? null,
    cursor: (value) => value.cursor ?? null,
  },
  IssueConnection: {
    nodes: (value) => value.nodes ?? [],
    edges: (value) => value.edges ?? [],
    pageInfo: (value) => value.pageInfo ?? null,
    totalCount: (value) => value.totalCount ?? 0,
  },
  PullRequestConnection: {
    nodes: (value) => value.nodes ?? [],
    edges: (value) => value.edges ?? [],
    pageInfo: (value) => value.pageInfo ?? null,
    totalCount: (value) => value.totalCount ?? 0,
  },
  IssueCommentConnection: {
    nodes: (value) => value.nodes ?? [],
    edges: (value) => value.edges ?? [],
    pageInfo: (value) => value.pageInfo ?? null,
    totalCount: (value) => value.totalCount ?? 0,
  },
  PageInfo: {
    hasNextPage: (value) => value.hasNextPage ?? false,
    hasPreviousPage: (value) => value.hasPreviousPage ?? false,
    startCursor: (value) => value.startCursor ?? null,
    endCursor: (value) => value.endCursor ?? null,
  },
  PullRequestFile: {
    path: (value) => value.path ?? null,
    additions: (value) => value.additions ?? 0,
    deletions: (value) => value.deletions ?? 0,
    changes: (value) => value.changes ?? 0,
    status: (value) => value.status ?? null,
  },
  CreateIssuePayload: {
    issue: (value) => value._issue ?? null,
    clientMutationId: (value) => value.clientMutationId ?? null,
  },
  CloseIssuePayload: {
    issue: (value) => value._issue ?? null,
    clientMutationId: (value) => value.clientMutationId ?? null,
  },
  CreatePullRequestPayload: {
    pullRequest: (value) => value._pull ?? null,
    clientMutationId: (value) => value.clientMutationId ?? null,
  },
  MergePullRequestPayload: {
    pullRequest: (value) => value._pull ?? null,
    clientMutationId: (value) => value.clientMutationId ?? null,
  },
  AddCommentPayload: {
    commentEdge: (value) => value._commentEdge ?? null,
    clientMutationId: (value) => value.clientMutationId ?? null,
  },
  __Type: {
    name: (value) => value.name ?? null,
    kind: (value) => value.kind ?? null,
    description: (value) => value.description ?? null,
    fields: (value) => {
      const names = (value._fields ?? []) as string[];
      return names.map((name) => ({ __typename: '__Field', name, description: null, isDeprecated: false, deprecationReason: null }));
    },
    enumValues: (value) => {
      const names = (value._enumValues ?? []) as string[];
      return names.map((name) => ({ __typename: '__EnumValue', name, description: null, isDeprecated: false, deprecationReason: null }));
    },
    inputFields: () => [],
    ofType: () => null,
    interfaces: () => [],
    possibleTypes: () => null,
  },
  __Field: {
    name: (value) => value.name ?? null,
    description: (value) => value.description ?? null,
    args: () => [],
    type: () => ({ __typename: '__Type', name: 'String', kind: 'SCALAR', _fields: [], _enumValues: [] }),
    isDeprecated: (value) => value.isDeprecated ?? false,
    deprecationReason: (value) => value.deprecationReason ?? null,
  },
  __EnumValue: {
    name: (value) => value.name ?? null,
    description: (value) => value.description ?? null,
    isDeprecated: (value) => value.isDeprecated ?? false,
    deprecationReason: (value) => value.deprecationReason ?? null,
  },
  __InputValue: {
    name: (value) => value.name ?? null,
    description: (value) => value.description ?? null,
    type: () => null,
    defaultValue: () => null,
  },
  __Schema: {
    types: () =>
      Object.keys(TYPE_KINDS).map((name) => typeInfo(name)).filter((entry): entry is AnyRecord => entry !== null),
    queryType: () => typeInfo('Query'),
    mutationType: () => typeInfo('Mutation'),
    subscriptionType: () => null,
    directives: () => [],
  },
  __Directive: {
    name: (value) => value.name ?? null,
    description: () => null,
    locations: () => [],
    args: () => [],
  },
};

// ---------------------------------------------------------------- executor

function resolveValue(
  parentType: string,
  parentValue: AnyRecord | null,
  field: FieldNode,
  ctx: GqlContext,
  variables: Readonly<Record<string, unknown>>,
  fragments: ReadonlyMap<string, FragmentDefinition>,
  errors: GqlError[],
  path: ReadonlyArray<string | number>,
): unknown {
  if (parentValue === null || parentValue === undefined) return null;
  const responseKey = field.alias ?? field.name;
  if (field.name === '__typename') return parentType;
  const fields = TYPE_FIELDS[parentType] ?? [];
  if (!fields.includes(field.name)) {
    errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".`, path: [...path, responseKey] });
    return null;
  }
  const resolver = RESOLVERS[parentType]?.[field.name];
  if (resolver === undefined) return null;
  const args = argsOf(field, variables);
  const value = resolver(parentValue, args, ctx, errors);
  if (field.selectionSet === null) return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (entry === null || typeof entry !== 'object') return entry;
      const typename = (entry as AnyRecord).__typename as string | undefined;
      if (typename === undefined) return entry;
      return resolveSelectionSet(typename, entry as AnyRecord, field.selectionSet as readonly SelectionNode[], ctx, variables, fragments, errors, [...path, responseKey, index]);
    });
  }
  if (typeof value === 'object') {
    const typename = (value as AnyRecord).__typename as string | undefined;
    if (typename === undefined) return value;
    return resolveSelectionSet(typename, value as AnyRecord, field.selectionSet as readonly SelectionNode[], ctx, variables, fragments, errors, [...path, responseKey]);
  }
  return value;
}

function resolveSelectionSet(
  parentType: string,
  parentValue: AnyRecord,
  selections: readonly SelectionNode[],
  ctx: GqlContext,
  variables: Readonly<Record<string, unknown>>,
  fragments: ReadonlyMap<string, FragmentDefinition>,
  errors: GqlError[],
  path: ReadonlyArray<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.field.alias ?? selection.field.name;
      out[key] = resolveValue(parentType, parentValue, selection.field, ctx, variables, fragments, errors, path);
    } else if (selection.kind === 'fragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (fragment.typeCondition !== parentType) continue;
      Object.assign(out, resolveSelectionSet(parentType, parentValue, fragment.selectionSet, ctx, variables, fragments, errors, path));
    } else {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      Object.assign(out, resolveSelectionSet(parentType, parentValue, selection.selectionSet, ctx, variables, fragments, errors, path));
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function executeOne(store: Store, request: unknown): { status: number; json: unknown } {
  if (!isRecord(request) || typeof request.query !== 'string') {
    return { status: 400, json: { errors: [{ message: 'A GraphQL request must carry a query string.' }] } };
  }
  let definitions: DefinitionNode[];
  try {
    definitions = parseDocument(request.query);
  } catch (err) {
    return { status: 400, json: { errors: [{ message: err instanceof Error ? err.message : 'GraphQL syntax error.' }] } };
  }
  const fragments = new Map<string, FragmentDefinition>();
  const operations: OperationDefinition[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  let operation: OperationDefinition | undefined;
  if (typeof request.operationName === 'string' && request.operationName !== '') {
    operation = operations.find((candidate) => candidate.name === request.operationName);
  } else {
    operation = operations[0];
  }
  if (operation === undefined) {
    return { status: 400, json: { errors: [{ message: 'No operation to run.' }] } };
  }
  const variables = isRecord(request.variables) ? request.variables : {};
  const errors: GqlError[] = [];
  for (const variable of operation.variableDefinitions) {
    if (variable.required && variables[variable.name] === undefined && variable.defaultValue === null) {
      errors.push({ message: `Variable $${variable.name} of required type was not provided.` });
    }
  }
  const ctx: GqlContext = { store };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const rootValue: AnyRecord = { __typename: rootType };
  const data = errors.length > 0 ? null : resolveSelectionSet(rootType, rootValue, operation.selectionSet, ctx, variables, fragments, errors, []);
  const body: Record<string, unknown> = { data };
  if (errors.length > 0) body.errors = errors;
  return { status: 200, json: body };
}

/** Answer one GraphQL HTTP body (a single operation, or a batch array of them). */
export function handleGraphQL(store: Store, body: unknown): { status: number; json: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((request) => executeOne(store, request));
    return { status: 200, json: results.map((result) => result.json) };
  }
  return executeOne(store, body);
}
