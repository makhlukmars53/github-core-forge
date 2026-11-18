// The HTTP server: one Node process, standard library only.
//
// Routing: /healthz (the env's boot probe), the git smart-HTTP surface at
// /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL at /api/graphql, and MCP
// at /mcp. Everything else is a JSON 404. Every reply carries a non-empty
// X-GitHub-Request-Id; every REST reply is application/json; git replies carry
// the content type the git client expects. Auth is a Bearer token from
// MAKEFUN_SHOP_TOKEN (any non-empty Bearer when the variable is unset, so the
// server still runs locally without one); /healthz and GET /api/v3/ are the only
// routes that answer without it. A malformed request body is a 400, never a crash.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { advertisement, handleReceivePack, handleUploadPack } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest } from './rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 32 * 1024 * 1024;

let requestSeq = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  const all: Record<string, string> = { ...headers };
  if (body !== null) {
    all['content-type'] = JSON_TYPE;
    all['content-length'] = String(Buffer.byteLength(text));
  } else {
    all['content-length'] = '0';
  }
  res.writeHead(status, all);
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), ...headers });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : (match[1] as string);
}

/** True when the request carries the trial's token (or any non-empty Bearer when unset). */
function authorized(req: IncomingMessage): boolean {
  const presented = bearerToken(req);
  if (presented === null || presented === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected === undefined || expected === '') return true;
  return presented === expected;
}

function decodeSegments(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    requestSeq += 1;
    const requestId = `req-${requestSeq}`;
    const baseHeaders: Record<string, string> = { 'x-github-request-id': requestId };
    const method = req.method ?? 'GET';
    const path = pathOf(req);
    const query = queryOf(req);

    const fail = (status: number, message: string): void => {
      sendJson(res, status, { message }, baseHeaders);
    };

    void (async () => {
      try {
        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, baseHeaders);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const suffix = gitMatch[3] ?? '';
          if (!authorized(req)) {
            fail(401, 'Bad credentials');
            return;
          }
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) {
            fail(404, 'Not Found');
            return;
          }
          const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          if (method === 'GET' && suffix === '/info/refs') {
            const service = query.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              fail(400, 'service is required');
              return;
            }
            const body = advertisement(store, repo, service, v2 && service === 'git-upload-pack');
            sendBuffer(res, 200, body, `application/x-${service}-advertisement`, baseHeaders);
            return;
          }
          if (method === 'POST' && suffix === '/git-upload-pack') {
            const raw = await readBody(req);
            try {
              const outcome = handleUploadPack(store, repo, raw, v2);
              sendBuffer(res, outcome.status, outcome.body, outcome.contentType, baseHeaders);
            } catch (err) {
              fail(400, err instanceof Error ? err.message : 'malformed upload-pack request');
            }
            return;
          }
          if (method === 'POST' && suffix === '/git-receive-pack') {
            const raw = await readBody(req);
            try {
              const outcome = handleReceivePack(store, repo, raw);
              sendBuffer(res, outcome.status, outcome.body, outcome.contentType, baseHeaders);
            } catch (err) {
              fail(400, err instanceof Error ? err.message : 'malformed receive-pack request');
            }
            return;
          }
          fail(404, 'Not Found');
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            fail(404, 'Not Found');
            return;
          }
          if (!authorized(req)) {
            fail(401, 'Bad credentials');
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'));
          } catch {
            fail(400, 'Malformed JSON');
            return;
          }
          const outcome = handleGraphQL(store, parsed);
          sendJson(res, outcome.status, outcome.json, baseHeaders);
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method !== 'POST') {
            fail(404, 'Not Found');
            return;
          }
          if (!authorized(req)) {
            fail(401, 'Bad credentials');
            return;
          }
          const raw = await readBody(req);
          const protocolVersion =
            typeof req.headers['mcp-protocol-version'] === 'string' ? (req.headers['mcp-protocol-version'] as string) : null;
          const outcome = handleMcp(store, raw.toString('utf8'), protocolVersion);
          if (outcome.json === null) {
            res.writeHead(outcome.status, { ...baseHeaders, ...(outcome.headers ?? {}), 'content-length': '0' });
            res.end();
            return;
          }
          sendJson(res, outcome.status, outcome.json, { ...baseHeaders, ...(outcome.headers ?? {}) });
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segments = decodeSegments(path === '/api/v3' ? '/' : path.slice('/api/v3'.length));
          const isRoot = segments.length === 0 && method === 'GET';
          if (!isRoot && !authorized(req)) {
            fail(401, 'Bad credentials');
            return;
          }
          let parsedBody: unknown = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                parsedBody = JSON.parse(raw.toString('utf8'));
              } catch {
                fail(400, 'Malformed JSON');
                return;
              }
            }
          }
          const restReq: RestRequest = { method, segments, query, body: parsedBody, host: req.headers.host ?? '127.0.0.1' };
          const outcome = handleRest(store, restReq);
          if (outcome === null) {
            fail(404, 'Not Found');
            return;
          }
          const headers: Record<string, string> = { ...baseHeaders, 'x-oauth-scopes': 'repo, read:org', ...(outcome.headers ?? {}) };
          sendJson(res, outcome.status, outcome.json, headers);
          return;
        }

        // Everything else: GitHub's 404 body.
        fail(404, 'Not Found');
      } catch (err) {
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) fail(500, 'Internal Server Error');
        else res.destroy();
      }
    })();
  });
}
