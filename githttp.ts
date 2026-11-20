// githttp.ts — git smart HTTP: info/refs, upload-pack (protocol v2),
// receive-pack (protocol v0). No git binary; the packfile codec and the
// object model live in gitobj.ts, the data in store.ts.
//
// Wire notes (from the suite's client, which is the only client):
// - upload-pack info/refs is answered v2 when the request carries
//   `Git-Protocol: version=2`, v0 otherwise. receive-pack is always v0.
// - v2 ls-refs answers one line per ref: `<oid> <name>[ symref-target:X][ peeled:Y]`
//   or `unborn <name>[ symref-target:X]` for an unborn HEAD.
// - v2 fetch answers sections acknowledgments / shallow-info / wanted-refs /
//   packfile, separated by delim packets; the pack rides sideband band 1.
// - receive-pack answers a report-status stream inside sideband band 1:
//   `unpack ok`, then `ok <ref>` / `ng <ref> <reason>` per command.
// - A refused non-fast-forward carries the reason exactly `non-fast-forward`.

import type { IncomingMessage, ServerResponse } from "node:http";
import { store, type Repo } from "./store.ts";
import {
  pktLine,
  pktFlush,
  pktDelim,
  parsePktLines,
  readPack,
  writePack,
  collectReachable,
  parseTag,
  parseCommit,
  ZERO_OID,
  type GitObject,
} from "./gitobj.ts";
import { VIEWER } from "./scenario.ts";

const AGENT = "makefun-git-forge/1.0";
const MAX_SIDEBAND_DATA = 65500;

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": body.length,
  });
  res.end(body);
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  const body = Buffer.from(JSON.stringify({ message }), "utf8");
  send(res, status, "application/json", body);
}

/** Resolve a repo from the URL owner/name. Returns null (and answers) when absent. */
function resolveRepo(res: ServerResponse, owner: string, repoName: string): Repo | null {
  if (owner !== VIEWER.login) {
    jsonError(res, 404, "Not Found");
    return null;
  }
  const repo = store.getRepo(repoName);
  if (!repo) {
    jsonError(res, 404, "Not Found");
    return null;
  }
  return repo;
}

/** All refs of a repo as {ref, oid}: HEAD first, then branches and tags, sorted. */
function allRefs(repo: Repo): { ref: string; oid: string }[] {
  const refs = store.listRefs(repo);
  const head = store.headTip(repo);
  const out: { ref: string; oid: string }[] = [];
  if (head) out.push({ ref: "HEAD", oid: head });
  // Every branch and tag is listed in its own right (HEAD is in addition,
  // not instead: the suite checks refs/heads/main is present at the tip).
  for (const r of refs) out.push(r);
  return out;
}

/** The peeled (commit) oid for an annotated tag, else undefined. */
function peelTag(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== "tag") return undefined;
  const tag = parseTag(obj.data);
  let target = tag.object;
  for (let i = 0; i < 10; i++) {
    const t = repo.objects.get(target);
    if (!t) return undefined;
    if (t.type === "commit") return target;
    if (t.type !== "tag") return undefined;
    target = parseTag(t.data).object;
  }
  return undefined;
}

// ---------------------------------------------------------------- info/refs

function v2Advertisement(): Buffer {
  const lines = [
    "version 2\n",
    `agent=${AGENT}\n`,
    "ls-refs=unborn\n",
    "fetch=shallow wait-for-done\n",
    "object-format=sha1\n",
  ];
  return Buffer.concat([...lines.map((l) => pktLine(l)), pktFlush()]);
}

const V2_ADVERTISEMENT = v2Advertisement();

function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = [
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
    "report-status",
    "report-status-v2",
    "side-band-64k",
    "delete-refs",
    "ofs-delta",
    "object-format=sha1",
    `agent=${AGENT}`,
  ].join(" ");
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(pktFlush());
  const refs = allRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((r, i) => {
      const suffix = i === 0 ? `\0${caps}` : "";
      parts.push(pktLine(`${r.oid} ${r.ref}${suffix}\n`));
      if (r.ref.startsWith("refs/tags/")) {
        const peeled = peelTag(repo, r.oid);
        if (peeled) parts.push(pktLine(`${peeled} ${r.ref}^{}\n`));
      }
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export async function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  service: string | null,
): Promise<void> {
  const repo = resolveRepo(res, owner, repoName);
  if (!repo) return;
  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    jsonError(res, 404, "Not Found");
    return;
  }
  const proto = (req.headers["git-protocol"] ?? "").toString();
  const wantV2 = service === "git-upload-pack" && proto.includes("version=2");
  if (service === "git-upload-pack") {
    const body = wantV2 ? V2_ADVERTISEMENT : v0Advertisement(repo, service);
    send(res, 200, "application/x-git-upload-pack-advertisement", body);
  } else {
    const body = v0Advertisement(repo, service);
    send(res, 200, "application/x-git-receive-pack-advertisement", body);
  }
}

// ---------------------------------------------------------------- upload-pack

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(items: ReturnType<typeof parsePktLines>["items"]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenDelim = false;
  for (const item of items) {
    if (item.kind === "delim") {
      seenDelim = true;
      continue;
    }
    if (item.kind !== "data" || !seenDelim) continue;
    const line = item.data.toString("utf8").replace(/\n$/, "");
    if (line === "peel") args.peel = true;
    else if (line === "symrefs") args.symrefs = true;
    else if (line === "unborn") args.unborn = true;
    else if (line.startsWith("ref-prefix ")) args.prefixes.push(line.slice("ref-prefix ".length));
  }
  return args;
}

const lsRefsResponses = new WeakMap<Repo, { version: number; key: string; body: Buffer }>();

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const key = JSON.stringify([repo.defaultBranch, args]);
  const cached = lsRefsResponses.get(repo);
  if (cached?.version === repo.gitVersion && cached.key === key) return cached.body;
  const parts: Buffer[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const headTip = store.headTip(repo);
  // HEAD first (symref), then branches, then tags.
  const lines: string[] = [];
  if (keep("HEAD")) {
    if (headTip) {
      lines.push(args.symrefs ? `${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${headTip} HEAD\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  }
  for (const r of store.listRefs(repo)) {
    if (!keep(r.ref)) continue;
    let line = `${r.oid} ${r.ref}`;
    if (args.peel && r.ref.startsWith("refs/tags/")) {
      const peeled = peelTag(repo, r.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  for (const l of lines) parts.push(pktLine(l));
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  lsRefsResponses.set(repo, { version: repo.gitVersion, key, body });
  return body;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  thinPack: boolean;
}

function parseFetchArgs(items: ReturnType<typeof parsePktLines>["items"]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, thinPack: false };
  let seenDelim = false;
  for (const item of items) {
    if (item.kind === "delim") {
      seenDelim = true;
      continue;
    }
    if (item.kind !== "data" || !seenDelim) continue;
    const line = item.data.toString("utf8").replace(/\n$/, "");
    if (line === "thin-pack") args.thinPack = true;
    else if (line.startsWith("want ")) args.wants.push(line.slice(5).trim());
    else if (line.startsWith("have ")) args.haves.push(line.slice(5).trim());
    else if (line.startsWith("shallow ")) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith("deepen ")) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    }
  }
  return args;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < pack.length; i += MAX_SIDEBAND_DATA) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + MAX_SIDEBAND_DATA));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (out.length === 0) {
    // A packfile section must carry at least one sideband packet, even for
    // an empty pack.
    out.push(pktLine(Buffer.concat([Buffer.from([1]), writePack([])])));
  }
  return out;
}

const fetchResponses = new WeakMap<Repo, { version: number; key: string; body: Buffer }>();

function fetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const key = JSON.stringify(args);
  const cached = fetchResponses.get(repo);
  if (cached?.version === repo.gitVersion && cached.key === key) return cached.body;
  const parts: Buffer[] = [];
  const haves = new Set(args.haves);
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const { objects, shallow } = collectReachable(lookup, args.wants, {
    haves,
    shallow: args.shallow,
    depth: args.depth ?? undefined,
  });

  // acknowledgments
  parts.push(pktLine("acknowledgments\n"));
  let acked = false;
  for (const have of args.haves) {
    const obj = repo.objects.get(have);
    if (!obj) continue;
    // ACK a have that is an ancestor of (or equal to) a want.
    const common = args.wants.some((w) => w === have || store.isAncestor(repo, have, w));
    if (common) {
      parts.push(pktLine(`ACK ${have}\n`));
      acked = true;
    }
  }
  if (!acked) parts.push(pktLine("NAK\n"));
  parts.push(pktLine("ready\n"));
  parts.push(pktDelim());

  // shallow-info
  if (args.depth !== null || args.shallow.length > 0) {
    parts.push(pktLine("shallow-info\n"));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    // A client boundary is unshallow once its parents are delivered: the
    // boundary itself is no longer shallow.
    for (const boundary of args.shallow) {
      const obj = repo.objects.get(boundary);
      if (!obj || obj.type !== "commit") continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((p) => objects.has(p))) {
        parts.push(pktLine(`unshallow ${boundary}\n`));
      }
    }
    parts.push(pktDelim());
  }

  // wanted-refs: wants that are ref tips
  const refByOid = new Map<string, string>();
  for (const r of store.listRefs(repo)) refByOid.set(r.oid, r.ref);
  const wanted = args.wants.filter((w) => refByOid.has(w));
  if (wanted.length > 0) {
    parts.push(pktLine("wanted-refs\n"));
    for (const w of wanted) parts.push(pktLine(`${w} ${refByOid.get(w)!}\n`));
    parts.push(pktDelim());
  }

  // packfile
  parts.push(pktLine("packfile\n"));
  const pack = writePack(objects);
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  fetchResponses.set(repo, { version: repo.gitVersion, key, body });
  return body;
}

export async function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
): Promise<void> {
  const repo = resolveRepo(res, owner, repoName);
  if (!repo) return;
  const body = await readBody(req);
  const { items } = parsePktLines(body);
  const first = items.find((i) => i.kind === "data");
  if (!first || first.kind !== "data") {
    jsonError(res, 400, "malformed git request");
    return;
  }
  const command = first.data.toString("utf8").replace(/\n$/, "");
  if (command === "command=ls-refs") {
    const args = parseLsRefsArgs(items);
    const out = lsRefsResponse(repo, args);
    send(res, 200, "application/x-git-upload-pack-result", out);
    return;
  }
  if (command === "command=fetch") {
    const args = parseFetchArgs(items);
    if (args.wants.length === 0) {
      // No wants: an empty fetch result (no sections, just a flush).
      send(res, 200, "application/x-git-upload-pack-result", pktFlush());
      return;
    }
    const out = fetchResponse(repo, args);
    send(res, 200, "application/x-git-upload-pack-result", out);
    return;
  }
  jsonError(res, 400, "unknown git command");
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } | null {
  const { items, consumed } = parsePktLines(body);
  const commands: PushCommand[] = [];
  let sawFlush = false;
  for (const item of items) {
    if (item.kind === "flush") {
      sawFlush = true;
      break;
    }
    if (item.kind !== "data") continue;
    let line = item.data.toString("utf8");
    const nul = line.indexOf("\0");
    if (nul >= 0) line = line.slice(0, nul);
    line = line.replace(/\n$/, "");
    const parts = line.split(" ");
    if (parts.length < 3) return null;
    const [oldOid, newOid, ref] = parts;
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid)) return null;
    if (!ref.startsWith("refs/")) return null;
    commands.push({ oldOid, newOid, ref });
  }
  if (!sawFlush || commands.length === 0) return null;
  const pack = consumed < body.length ? body.subarray(consumed) : null;
  return { commands, pack };
}

export async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
): Promise<void> {
  const repo = resolveRepo(res, owner, repoName);
  if (!repo) return;
  const body = await readBody(req);
  const parsed = parsePushBody(body);
  if (!parsed) {
    // Malformed command list: answer 400 and stay healthy.
    jsonError(res, 400, "malformed git push");
    return;
  }
  const { commands, pack } = parsed;

  const reportInner: Buffer[] = [];
  const reportLines: string[] = [];

  // Unpack the pack first (objects must exist before ref updates).
  let unpackError: string | null = null;
  if (pack && pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => repo.objects.get(oid));
      store.putObjects(repo, objects);
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }

  if (unpackError) {
    reportLines.push(`unpack ${unpackError}`);
  } else {
    reportLines.push("unpack ok");
    for (const cmd of commands) {
      const result = applyPushCommand(repo, cmd);
      reportLines.push(result);
    }
  }

  for (const line of reportLines) reportInner.push(pktLine(`${line}\n`));
  reportInner.push(pktFlush());
  const inner = Buffer.concat(reportInner);
  // Wrap the report in sideband band 1.
  const outer: Buffer[] = [];
  for (let i = 0; i < inner.length; i += MAX_SIDEBAND_DATA) {
    const chunk = inner.subarray(i, Math.min(inner.length, i + MAX_SIDEBAND_DATA));
    outer.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  outer.push(pktFlush());
  send(res, 200, "application/x-git-receive-pack-result", Buffer.concat(outer));
}

/** Apply one push command; returns the `ok` / `ng` report line. */
function applyPushCommand(repo: Repo, cmd: PushCommand): string {
  const { oldOid, newOid, ref } = cmd;
  const current = repo.refs.get(ref);

  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return `ng ${ref} remote ref does not exist`;
    if (oldOid !== ZERO_OID && current !== oldOid) return `ng ${ref} old value does not match`;
    store.deleteRef(repo, ref);
    return `ok ${ref}`;
  }

  const obj = repo.objects.get(newOid);
  if (!obj) return `ng ${ref} object not found`;

  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return `ng ${ref} reference already exists`;
    store.setRef(repo, ref, newOid);
    return `ok ${ref}`;
  }

  // Update.
  if (current === undefined) return `ng ${ref} remote ref does not exist`;
  if (current !== oldOid) return `ng ${ref} non-fast-forward`;
  if (obj.type === "commit") {
    if (oldOid !== newOid && !store.isAncestor(repo, oldOid, newOid)) {
      return `ng ${ref} non-fast-forward`;
    }
  }
  store.setRef(repo, ref, newOid);
  return `ok ${ref}`;
}
