// The git smart-HTTP protocol, implemented in process: pkt-lines, packfiles,
// upload-pack v2 and v0, and receive-pack v0. No git binary is involved.
//
// The client is the kit's git-client.ts. Its exact expectations drive the shapes
// here: v2 advertisements start with `version 2` and carry `fetch=shallow filter`
// and `ls-refs=unborn`; v0 advertisements carry capabilities after a NUL on the
// first ref line; fetch answers come in `acknowledgments` / `shallow-info` /
// `packfile` sections with sideband framing; push reports are `unpack ok` plus
// one `ok` / `ng <ref> <reason>` line per command, inside band 1.

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { ZERO_OID, branchTipOf, isOid, parseCommit, parseTag, parseTree, type GitObject, type ObjType, type Repo, type Store } from './store.ts';

export const AGENT = 'github-core-forge/1.0.0';

// ---------------------------------------------------------------- pkt-lines

export type PacketKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Packet {
  readonly kind: PacketKind;
  readonly payload: Buffer;
}

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), data]);
}

export const pktFlush: Buffer = Buffer.from('0000', 'utf8');
export const pktDelim: Buffer = Buffer.from('0001', 'utf8');

/** Encode lines ('flush' / 'delim' become control packets, strings become data). */
export function encodePktLines(lines: readonly Array<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush);
    else if (line === 'delim') parts.push(pktDelim);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Parse a whole buffer into packets. Throws on a malformed length prefix. */
export function decodePktLines(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('pkt-line truncated at its length prefix');
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    const len = Number.parseInt(lenText, 16);
    if (!Number.isFinite(len) || len < 0 || len > 65520) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + len > buf.length) throw new Error('pkt-line truncated in its payload');
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

/** Split a request body into its pkt-line section and the raw bytes after the first flush. */
export function splitPktSection(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('pkt-line truncated at its length prefix');
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    const len = Number.parseInt(lenText, 16);
    if (!Number.isFinite(len) || len < 0 || len > 65520) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + len > buf.length) throw new Error('pkt-line truncated in its payload');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, rest: buf.subarray(offset) };
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a packfile (version 2, no deltas) for the given objects, in the given order. */
export function writePack(entries: readonly Array<{ oid: string; type: ObjType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  parts.push(head);
  for (const entry of entries) {
    const size = entry.data.length;
    const typeId = PACK_TYPE_IDS[entry.type];
    // varint: low 4 bits of size in the first byte, then 7 bits per byte.
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (remaining & 0x0f) | (typeId << 4);
    remaining >>>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let next = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining > 0) next |= 0x80;
      headerBytes.push(next);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(entry.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

/** Inflate the deflate stream at `start`, knowing it must produce `expectedSize` bytes. */
function inflateAt(buf: Buffer, start: number, expectedSize: number): { data: Buffer; next: number } {
  // inflateSync ignores trailing bytes and throws on a truncated stream, so the
  // smallest prefix that inflates to exactly the expected size is the stream.
  let lo = start;
  let hi = buf.length;
  const ok = (end: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(start, end));
      return out.length === expectedSize ? out : null;
    } catch {
      return null;
    }
  };
  if (ok(hi) === null) throw new Error('pack object has no valid deflate stream');
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ok(mid) !== null) hi = mid;
    else lo = mid;
  }
  const data = ok(hi);
  if (data === null) throw new Error('pack object deflate stream could not be bounded');
  return { data, next: hi };
}

/** Apply a git delta to a base object, returning the reconstructed bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta truncated in a varint');
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (offset >= delta.length) throw new Error('delta truncated in a copy offset');
          copyOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (offset >= delta.length) throw new Error('delta truncated in a copy size');
          copySize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past its base');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta truncated in an insert');
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      written += op;
    } else {
      throw new Error('delta has a zero opcode');
    }
  }
  if (written !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(parts);
}

export interface ReadPackResult {
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
}

/** Read a packfile into objects (deltas resolved against the pack and `baseOf`). */
export function readPack(buf: Buffer, baseOf?: (oid: string) => GitObject | undefined): ReadPackResult {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, string>();
  let deltaCount = 0;
  let offset = 12;
  const readObjectVarint = (): { type: number; size: number } => {
    const first = buf[offset] as number;
    offset += 1;
    let type = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let byte = first;
    while ((byte & 0x80) !== 0) {
      byte = buf[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    return { type, size };
  };
  for (let i = 0; i < count; i += 1) {
    const entryStart = offset;
    const { type, size } = readObjectVarint();
    if (type === 6) {
      // ofs-delta: a negative offset varint, then the delta stream.
      let byte = buf[offset] as number;
      offset += 1;
      let deltaOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[offset] as number;
        offset += 1;
        deltaOffset = ((deltaOffset + 1) << 7) | (byte & 0x7f);
      }
      const { data: delta, next } = inflateAt(buf, offset, size);
      offset = next;
      const baseOid = byOffset.get(entryStart - deltaOffset);
      if (baseOid === undefined) throw new Error('ofs-delta base is outside the pack');
      const base = objects.get(baseOid);
      if (base === undefined) throw new Error('ofs-delta base object is missing');
      const data = applyDelta(base.data, delta);
      const typeName = base.type;
      const { oid } = storeObject(objects, typeName, data);
      byOffset.set(entryStart, oid);
      deltaCount += 1;
    } else if (type === 7) {
      // ref-delta: a 20-byte base oid, then the delta stream.
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data: delta, next } = inflateAt(buf, offset, size);
      offset = next;
      const base = objects.get(baseOid) ?? baseOf?.(baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} is unknown`);
      const data = applyDelta(base.data, delta);
      const { oid } = storeObject(objects, base.type, data);
      byOffset.set(entryStart, oid);
      deltaCount += 1;
    } else {
      const typeName = PACK_TYPES[type];
      if (typeName === undefined) throw new Error(`unknown pack object type ${type}`);
      const { data, next } = inflateAt(buf, offset, size);
      offset = next;
      const { oid } = storeObject(objects, typeName, data);
      byOffset.set(entryStart, oid);
    }
  }
  return { objects, deltaCount };
}

function storeObject(map: Map<string, GitObject>, type: ObjType, data: Buffer): { oid: string } {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const oid = createHash('sha1').update(head).update(data).digest('hex');
  if (!map.has(oid)) map.set(oid, { type, data });
  return { oid };
}

// ---------------------------------------------------------------- reachability

export interface FetchSelection {
  readonly objects: Map<string, GitObject>;
  readonly shallow: string[];
}

/** The full closure of `tips` (commits, trees, blobs, tags followed to their target). */
function closureOf(store: Store, tips: readonly string[], stopParentsOf: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (out.has(oid)) continue;
    const object = store.getObject(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      queue.push(info.tree);
      // A shallow boundary's parents are NOT held by the client, so the
      // exclusion closure stops there: a deepen fetch must deliver them.
      if (!stopParentsOf.has(oid)) for (const parent of info.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    }
  }
  return out;
}

/**
 * The objects a fetch of `wants` sends: the reachable closure minus everything
 * reachable from `haves`, limited to `depth` commit generations when given.
 * `shallow` names the commits at the depth boundary. The walk follows parents
 * even through commits the client already holds, because a deepen fetch must
 * reach past the client's shallow boundary into its parents.
 */
export function collectForFetch(
  store: Store,
  wants: readonly string[],
  opts: { haves?: readonly string[]; depth?: number | null; noBlobs?: boolean; shallowBoundaries?: readonly string[] } = {},
): FetchSelection {
  const boundarySet = new Set(opts.shallowBoundaries ?? []);
  const excluded = closureOf(store, opts.haves ?? [], boundarySet);
  const objects = new Map<string, GitObject>();
  const shallow: string[] = [];
  const addTree = (treeOid: string): void => {
    const queue: string[] = [treeOid];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (objects.has(oid) || excluded.has(oid)) continue;
      const object = store.getObject(oid);
      if (object === undefined || object.type !== 'tree') continue;
      objects.set(oid, object);
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') queue.push(entry.oid);
        else if (!opts.noBlobs) {
          const blob = store.getObject(entry.oid);
          if (blob !== undefined && !excluded.has(entry.oid)) objects.set(entry.oid, blob);
        }
      }
    }
  };
  const queue: Array<{ oid: string; depth: number }> = wants.map((oid) => ({ oid, depth: 1 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.getObject(oid);
    if (object === undefined) continue;
    const isExcluded = excluded.has(oid);
    if (object.type === 'tag') {
      if (!isExcluded) objects.set(oid, object);
      queue.push({ oid: parseTag(object.data).object, depth });
      continue;
    }
    if (object.type === 'tree') {
      if (!isExcluded) addTree(oid);
      continue;
    }
    if (object.type === 'blob') {
      if (!isExcluded && !opts.noBlobs) objects.set(oid, object);
      continue;
    }
    // commit
    const info = parseCommit(object.data);
    if (opts.depth != null && depth >= opts.depth) {
      if (!isExcluded) shallow.push(oid);
    } else {
      for (const parent of info.parents) queue.push({ oid: parent, depth: depth + 1 });
    }
    if (isExcluded) continue;
    objects.set(oid, object);
    addTree(info.tree);
  }
  return { objects, shallow };
}

/** A packfile as sideband band-1 packets (each chunk at most 60000 bytes of data). */
export function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 60000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    out.push(pktLine(payload));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

// ---------------------------------------------------------------- advertisements

function refLines(store: Store, repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const { name, oid } of repoRefsSorted(repo)) {
    out.push({ name, oid });
    if (name.startsWith('refs/tags/')) {
      const peeled = peelTagOid(store, oid);
      if (peeled !== null) out.push({ name: `${name}^{}`, oid: peeled });
    }
  }
  return out;
}

function repoRefsSorted(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The commit an annotated tag points at, or null for a lightweight tag / non-tag. */
function peelTagOid(store: Store, oid: string): string | null {
  const object = store.getObject(oid);
  if (object === undefined || object.type !== 'tag') return null;
  const target = parseTag(object.data).object;
  const targetObject = store.getObject(target);
  if (targetObject === undefined || targetObject.type !== 'commit') return null;
  return target;
}

/** Build the info/refs body for a service. `v2` only applies to upload-pack. */
export function advertisement(
  store: Store,
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  v2: boolean,
): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(pktFlush);
  if (v2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine('fetch=shallow filter\n'));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    parts.push(pktFlush);
    return Buffer.concat(parts);
  }
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k ofs-delta agent=${AGENT} shallow thin-pack multi_ack`
      : `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const refs = refLines(store, repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    parts.push(pktFlush);
    return Buffer.concat(parts);
  }
  const headTip = branchTipOf(repo, repo.defaultBranch);
  const lines: string[] = [];
  if (headTip !== null) lines.push(`${headTip} HEAD\0${caps}\n`);
  for (const ref of refs) lines.push(`${ref.oid} ${ref.name}\n`);
  for (const line of lines) parts.push(pktLine(line));
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack

export interface UploadPackOutcome {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

function fetchResponse(
  store: Store,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
  filter: string | null,
  v2: boolean,
): Buffer {
  const { objects, shallow } = collectForFetch(store, wants, {
    haves,
    depth,
    noBlobs: filter !== null && filter.startsWith('blob:none'),
    shallowBoundaries,
  });
  const unshallow = shallowBoundaries.filter((oid) => {
    // A boundary is unshallow once its parent is in this pack: the client
    // now holds the boundary AND its parent, so it is no longer shallow.
    const object = store.getObject(oid);
    if (object === undefined || object.type !== 'commit') return false;
    return parseCommit(object.data).parents.some((parent) => objects.has(parent));
  });
  const packEntries = [...objects.entries()].map(([oid, object]) => ({ oid, type: object.type, data: object.data }));
  const pack = writePack(packEntries);
  const parts: Buffer[] = [];
  if (v2) {
    parts.push(pktLine('acknowledgments\n'));
    if (haves.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const have of haves) if (store.getObject(have) !== undefined) parts.push(pktLine(`ACK ${have}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(pktDelim);
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim);
    }
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPack(pack)) parts.push(packet);
    parts.push(pktFlush);
    return Buffer.concat(parts);
  }
  // v0: plain NAK/ACK/shallow lines, then the sideband pack.
  if (haves.length === 0) parts.push(pktLine('NAK\n'));
  else for (const have of haves) if (store.getObject(have) !== undefined) parts.push(pktLine(`ACK ${have}\n`));
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

export function handleUploadPack(store: Store, repo: Repo, body: Buffer, v2: boolean): UploadPackOutcome {
  const contentType = 'application/x-git-upload-pack-result';
  if (v2) {
    const { packets } = splitPktSection(body);
    const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
    if (lines.length === 0 || !lines[0]?.startsWith('command=')) throw new Error('upload-pack v2 needs a command line');
    const command = lines[0].slice('command='.length);
    const args = lines.slice(1);
    const delimAt = args.indexOf('');
    const afterDelim = delimAt < 0 ? args : args.slice(delimAt + 1);
    if (command === 'ls-refs') {
      let peel = false;
      let symrefs = false;
      const prefixes: string[] = [];
      for (const arg of afterDelim) {
        if (arg === 'peel') peel = true;
        else if (arg === 'symrefs') symrefs = true;
        else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
      }
      const out: Buffer[] = [];
      const headTip = branchTipOf(repo, repo.defaultBranch);
      const allRefs = refLines(store, repo);
      const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
      if (repo.refs.size === 0) {
        out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      } else {
        if (headTip !== null && keep('HEAD')) {
          const extra = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
          out.push(pktLine(`${headTip} HEAD${extra}\n`));
        }
        for (const ref of allRefs) {
          if (!keep(ref.name)) continue;
          const isPeeled = ref.name.endsWith('^{}');
          const baseName = isPeeled ? ref.name.slice(0, -3) : ref.name;
          if (isPeeled) {
            // The peeled line follows its tag line; emit as its own line with peeled:.
            continue;
          }
          let extra = '';
          if (peel) {
            const peeled = peelTagOid(store, ref.oid);
            if (peeled !== null) extra += ` peeled:${peeled}`;
          }
          void baseName;
          out.push(pktLine(`${ref.oid} ${ref.name}${extra}\n`));
        }
      }
      out.push(pktFlush);
      return { status: 200, contentType, body: Buffer.concat(out) };
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallowBoundaries: string[] = [];
      let depth: number | null = null;
      let filter: string | null = null;
      for (const arg of afterDelim) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) shallowBoundaries.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7), 10) || null;
        else if (arg.startsWith('filter ')) filter = arg.slice(7).trim();
      }
      return { status: 200, contentType, body: fetchResponse(store, wants, haves, shallowBoundaries, depth, filter, true) };
    }
    throw new Error(`unknown upload-pack v2 command ${JSON.stringify(command)}`);
  }
  // v0: want lines, shallow/deepen lines, flush, have lines, done, flush.
  const { packets } = splitPktSection(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const firstSpace = line.indexOf(' ');
    const word = firstSpace < 0 ? line : line.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : line.slice(firstSpace + 1);
    if (word === 'want') wants.push(rest.split(' ')[0] as string);
    else if (word === 'have') haves.push(rest.trim());
    else if (word === 'shallow') shallowBoundaries.push(rest.trim());
    else if (word === 'deepen') depth = Number.parseInt(rest, 10) || null;
  }
  if (wants.length === 0) throw new Error('upload-pack v0 needs a want line');
  return { status: 200, contentType, body: fetchResponse(store, wants, haves, shallowBoundaries, depth, null, false) };
}

// ---------------------------------------------------------------- receive-pack

export interface ReceivePackOutcome {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

export function handleReceivePack(store: Store, repo: Repo, body: Buffer): ReceivePackOutcome {
  const contentType = 'application/x-git-receive-pack-result';
  const { packets, rest } = splitPktSection(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const [index, line] of lines.entries()) {
    const text = index === 0 ? line.split('\0')[0] as string : line;
    const parts = text.split(' ');
    if (parts.length < 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid)) throw new Error('receive-pack command has a bad object id');
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new Error('receive-pack needs at least one command');
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (updatesRef) {
    if (rest.length === 0) {
      unpackOk = false;
      unpackDetail = 'missing pack';
    } else {
      try {
        const { objects } = readPack(rest, (oid) => store.getObject(oid));
        for (const [, object] of objects) store.putObject(object.type, object.data);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack error';
      }
    }
  }
  const reportLines: string[] = [unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack error`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (!repo.refs.has(command.ref)) reportLines.push(`ng ${command.ref} cannot delete a ref that does not exist`);
      else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    const existing = repo.refs.get(command.ref);
    if (command.oldOid === ZERO_OID) {
      if (existing !== undefined) {
        reportLines.push(`ng ${command.ref} already exists`);
        continue;
      }
    } else {
      if (existing === undefined) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      if (existing !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
    }
    const target = store.getObject(command.newOid);
    if (target === undefined) {
      reportLines.push(`ng ${command.ref} missing object`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      if (target.type !== 'commit') {
        reportLines.push(`ng ${command.ref} not a commit`);
        continue;
      }
      if (command.oldOid !== ZERO_OID && !store.isAncestor(command.newOid, command.oldOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}`);
  }
  // The report-status stream is itself pkt-framed inside sideband band 1.
  const inner = encodePktLines([...reportLines.map((line) => `${line}\n`), 'flush']);
  const outer = pktLine(Buffer.concat([Buffer.from([1]), inner]));
  return { status: 200, contentType, body: Buffer.concat([outer, pktFlush]) };
}
