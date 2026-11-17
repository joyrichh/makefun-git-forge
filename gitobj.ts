// gitobj.ts — git object model, packfiles and pkt-lines (stdlib only).
//
// Everything the forge needs to speak git smart HTTP without a git binary:
// object hashing, blob/tree/commit/tag build+parse, pack v2 read/write
// (including OFS_DELTA / REF_DELTA resolution), pkt-line framing and
// reachability walks (with haves + shallow depth) for fetches.

import { createHash } from "node:crypto";
import { inflateSync, deflateSync } from "node:zlib";

export const ZERO_OID = "0".repeat(40);

export type ObjectType = "commit" | "tree" | "blob" | "tag";

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const CODE_TYPE: Record<number, ObjectType> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

export function sha1Hex(data: Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

/** The raw object bytes git hashes: "<type> <size>\0<data>". */
export function objectRaw(type: ObjectType, data: Buffer): Buffer {
  const header = Buffer.from(`${type} ${data.length}\0`, "ascii");
  return Buffer.concat([header, data]);
}

/** Hash an object (type + data) to its git oid. */
export function hashObject(type: ObjectType, data: Buffer): string {
  return sha1Hex(objectRaw(type, data));
}

export function oidToBuffer(oid: string): Buffer {
  return Buffer.from(oid, "hex");
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // "100644" file, "40000" dir, "100755" exec, "120000" symlink
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(i, space).toString("ascii");
    const name = data.subarray(space + 1, nul).toString("utf8");
    const oid = data.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries sort by name, directories as if ending in "/". */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const ka = a.mode === "40000" ? `${a.name}/` : a.name;
  const kb = b.mode === "40000" ? `${b.name}/` : b.name;
  return Buffer.compare(Buffer.from(ka, "utf8"), Buffer.from(kb, "utf8"));
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, "utf8"));
    parts.push(oidToBuffer(e.oid));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits

export interface Commit {
  tree: string;
  parents: string[];
  author: string; // "Name <email> <ts> +0000"
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): Commit {
  const text = data.toString("utf8");
  const blank = text.indexOf("\n\n");
  const header = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? "" : text.slice(blank + 2);
  let tree = "";
  const parents: string[] = [];
  let author = "";
  let committer = "";
  for (const line of header.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
    else if (line.startsWith("committer ")) committer = line.slice(10);
    else if (line.startsWith("author ")) author = line.slice(7);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(c: Commit): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`);
  lines.push(`committer ${c.committer}`);
  return Buffer.from(`${lines.join("\n")}\n\n${c.message}`, "utf8");
}

export function identityLine(name: string, email: string, ts: number): string {
  return `${name} <${email}> ${ts} +0000`;
}

// ---------------------------------------------------------------- tags

export interface Tag {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): Tag {
  const text = data.toString("utf8");
  const blank = text.indexOf("\n\n");
  const header = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? "" : text.slice(blank + 2);
  let object = "";
  let type: ObjectType = "commit";
  let tag = "";
  let tagger = "";
  for (const line of header.split("\n")) {
    if (line.startsWith("object ")) object = line.slice(7).trim();
    else if (line.startsWith("type ")) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith("tag ")) tag = line.slice(4);
    else if (line.startsWith("tagger ")) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const len = data.length + 4;
  const prefix = Buffer.from(len.toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([prefix, data]);
}

export const pktFlush = (): Buffer => Buffer.from("0000", "ascii");
export const pktDelim = (): Buffer => Buffer.from("0001", "ascii");
export const pktResponseEnd = (): Buffer => Buffer.from("0002", "ascii");

export type PktItem =
  | { kind: "data"; data: Buffer }
  | { kind: "flush" }
  | { kind: "delim" }
  | { kind: "end" };

/** Parse pkt-lines from the front of `buf`. Stops at end of buffer or a flush. */
export function parsePktLines(buf: Buffer): { items: PktItem[]; consumed: number } {
  const items: PktItem[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString("ascii");
    const len = parseInt(hex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      items.push({ kind: "flush" });
      i += 4;
      break;
    }
    if (len === 1) {
      items.push({ kind: "delim" });
      i += 4;
      continue;
    }
    if (len === 2) {
      items.push({ kind: "end" });
      i += 4;
      continue;
    }
    if (i + len > buf.length) break;
    items.push({ kind: "data", data: Buffer.from(buf.subarray(i + 4, i + len)) });
    i += len;
  }
  return { items, consumed: i };
}

// ---------------------------------------------------------------- packfiles

function encodeObjectHeader(typeCode: number, size: number): Buffer {
  const out: number[] = [];
  let b = (size & 0x0f) | (typeCode << 4);
  size >>= 4;
  if (size > 0) b |= 0x80;
  out.push(b);
  while (size > 0) {
    b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    out.push(b);
  }
  return Buffer.from(out);
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = pos;
  for (;;) {
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value, next: i };
}

/** Apply a git delta to a base object, returning the result. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readSize = (): number => {
    const r = readVarint(delta, i);
    i = r.next;
    return r.value;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error("delta source size mismatch");
  const out: Buffer[] = [];
  let produced = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[i++];
      if (op & 0x02) offset |= delta[i++] << 8;
      if (op & 0x04) offset |= delta[i++] << 16;
      if (op & 0x08) offset |= delta[i++] << 24;
      if (op & 0x10) size = delta[i++];
      if (op & 0x20) size |= delta[i++] << 8;
      if (op & 0x40) size |= delta[i++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(i, i + op));
      i += op;
      produced += op;
    } else {
      throw new Error("invalid delta opcode 0");
    }
  }
  const result = Buffer.concat(out);
  if (produced !== tgtSize || result.length !== tgtSize) {
    throw new Error("delta target size mismatch");
  }
  return result;
}

/**
 * Parse a packfile (v2/v3). Returns objects keyed by oid. `resolveBase` is
 * consulted for REF_DELTA bases not present in the pack itself (already in
 * the repo store). The client never sends deltas, but the reader handles
 * them so a delta pack cannot break a push.
 */
export function readPack(
  buf: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString("ascii") !== "PACK") {
    throw new Error("not a packfile");
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString("hex");
  const computed = sha1Hex(buf.subarray(0, trailerStart));
  if (trailer !== computed) throw new Error("pack trailer checksum mismatch");

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: ObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;

  const readObjectHeader = (): { typeCode: number; size: number } => {
    let b = buf[offset++];
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[offset++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    return { typeCode, size };
  };

  for (let n = 0; n < count; n++) {
    const entryOffset = offset;
    const { typeCode, size } = readObjectHeader();
    const entry: RawEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint
      let b = buf[offset++];
      let deltaOffset = b & 0x7f;
      while (b & 0x80) {
        b = buf[offset++];
        deltaOffset = ((deltaOffset + 1) << 7) | (b & 0x7f);
      }
      entry.baseOffset = entryOffset - deltaOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buf.subarray(offset, offset + 20).toString("hex");
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${n} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buf.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) {
      throw new Error(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();

  const resolve = (entry: RawEntry): { type: ObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error("delta cycle");
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error("ofs-delta base not in pack");
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      let base: { type: ObjectType; data: Buffer } | undefined;
      if (baseEntry) base = resolve(baseEntry);
      else if (resolveBase) base = resolveBase(entry.baseOid!);
      if (!base) throw new Error("ref-delta base not found");
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    resolving.delete(entry.offset);
    const oid = hashObject(type, data);
    entry.resolvedType = type;
    entry.resolved = data;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    objects.set(oid, { type, data });
    return { type, data, oid };
  };

  for (const entry of raw) resolve(entry);
  return objects;
}

/** Write a packfile (v2, plain objects, no deltas). Deterministic order. */
export function writePack(objects: GitObject[]): Buffer {
  const sorted = [...objects].sort((a, b) => {
    const oa = hashObject(a.type, a.data);
    const ob = hashObject(b.type, b.data);
    return oa < ob ? -1 : oa > ob ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const obj of sorted) {
    parts.push(encodeObjectHeader(TYPE_CODE[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash("sha1").update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- reachability

export type ObjectLookup = (oid: string) => GitObject | undefined;

export interface Reachable {
  objects: Map<string, GitObject>;
  shallow: string[];
}

/**
 * Walk from `tips` (commit/tag oids) and collect every object a fetch needs.
 * - `haves`: oids the client fully has. Every object reachable from a have
 *   is already held: never included, never traversed past.
 * - `shallow`: the client's shallow boundaries (from a previous depth-limited
 *   fetch). A boundary commit is already held (itself and its tree), but its
 *   parents are NOT held, so the walk still traverses into them — this is
 *   what makes `deepen` work. A boundary is also a have in the deepen
 *   request, so the shallow list wins over the have list for traversal.
 * - `depth`: max commit generations from the wants (1 = tip commits only).
 *   Commits at the depth boundary are returned as `shallow`.
 */
export function collectReachable(
  lookup: ObjectLookup,
  tips: string[],
  opts: { haves?: Set<string>; shallow?: string[]; depth?: number } = {},
): Reachable {
  const haves = opts.haves ?? new Set<string>();
  const shallowBoundaries = new Set(opts.shallow ?? []);
  const depth = opts.depth;
  const objects = new Map<string, GitObject>();
  const shallow: string[] = [];

  // Phase 1: everything reachable from the haves is already fully held —
  // except past a shallow boundary, whose parents are NOT held (that is
  // what makes a boundary shallow).
  const held = new Set<string>();
  const markHeld = (oid: string): void => {
    if (held.has(oid)) return;
    const obj = lookup(oid);
    if (!obj) return;
    held.add(oid);
    if (obj.type === "commit") {
      const parsed = parseCommit(obj.data);
      markHeld(parsed.tree);
      if (shallowBoundaries.has(oid)) return; // parents are not held
      for (const p of parsed.parents) markHeld(p);
    } else if (obj.type === "tree") {
      for (const e of parseTree(obj.data)) markHeld(e.oid);
    } else if (obj.type === "tag") {
      markHeld(parseTag(obj.data).object);
    }
  };
  for (const h of haves) markHeld(h);

  // Phase 2: walk from the wants, excluding held objects.
  const visitedGen = new Map<string, number>();

  const addObject = (oid: string): GitObject | undefined => {
    if (held.has(oid) || objects.has(oid)) return objects.get(oid) ?? lookup(oid);
    const obj = lookup(oid);
    if (obj) objects.set(oid, obj);
    return obj;
  };

  const addTree = (treeOid: string): void => {
    if (held.has(treeOid)) return;
    const tree = addObject(treeOid);
    if (!tree || tree.type !== "tree") return;
    for (const e of parseTree(tree.data)) {
      if (e.mode === "40000") addTree(e.oid);
      else addObject(e.oid);
    }
  };

  const addCommit = (oid: string, gen: number): void => {
    if (depth !== undefined && gen >= depth) return;
    const seenAt = visitedGen.get(oid);
    if (seenAt !== undefined && seenAt <= gen) return;
    visitedGen.set(oid, gen);
    const obj = lookup(oid);
    if (!obj || obj.type !== "commit") return;
    if (shallowBoundaries.has(oid)) {
      // Already held shallowly: not the commit, not its tree — but the
      // parents are not held, so traverse into them. (Checked before the
      // held test: a deepen request also lists the boundary as a have.)
      const parsed = parseCommit(obj.data);
      for (const p of parsed.parents) addCommit(p, gen + 1);
      return;
    }
    if (held.has(oid)) return; // fully held: skip, and do not traverse
    objects.set(oid, obj);
    const parsed = parseCommit(obj.data);
    addTree(parsed.tree);
    if (depth !== undefined && gen + 1 >= depth) {
      if (!shallow.includes(oid)) shallow.push(oid);
      return;
    }
    for (const p of parsed.parents) addCommit(p, gen + 1);
  };

  const addTagTarget = (tagOid: string, gen: number): void => {
    if (held.has(tagOid)) return;
    const tag = addObject(tagOid);
    if (!tag || tag.type !== "tag") return;
    const parsed = parseTag(tag.data);
    const target = lookup(parsed.object);
    if (!target) return;
    if (target.type === "commit") addCommit(parsed.object, gen);
    else if (target.type === "tree") addTree(parsed.object);
    else if (target.type === "tag") addTagTarget(parsed.object, gen);
    else addObject(parsed.object);
  };

  for (const tip of tips) {
    const obj = lookup(tip);
    if (!obj) continue;
    // Do not skip held tips here: a tip that is a shallow boundary must
    // still be traversed into (its parents are not held). addCommit /
    // addTree / addTagTarget apply the held and shallow rules themselves.
    if (obj.type === "commit") addCommit(tip, 0);
    else if (obj.type === "tree") addTree(tip);
    else if (obj.type === "tag") addTagTarget(tip, 0);
    else addObject(tip);
  }

  return { objects, shallow };
}
