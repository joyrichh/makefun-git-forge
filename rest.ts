// rest.ts — the REST v3 API under /api/v3 (repos, issues, pull requests,
// contents, refs, branches, labels, comments). GitHub-shaped JSON; the
// suite is the only client and its checks pin the shapes, the status codes
// and the pagination behaviour. Auth is enforced by the router before this
// module is called.

import type { IncomingMessage, ServerResponse } from "node:http";
import { store, type Repo, type Issue, type Pull } from "./store.ts";
import { parseCommit } from "./gitobj.ts";
import { VIEWER } from "./scenario.ts";

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  if (body.length === 0) return {};
  // A malformed body throws (SyntaxError); handleRest turns it into a 400.
  const parsed = JSON.parse(body.toString("utf8"));
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

// ---------------------------------------------------------------- shapes

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    name: VIEWER.name,
    email: VIEWER.email,
    type: "User",
    avatar_url: "",
    html_url: "",
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.ownerLogin}/${repo.name}`,
    owner: { login: repo.ownerLogin, id: VIEWER.id, type: "User" },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: "",
    created_at: store.isoFromSeq(repo.createdSeq),
    updated_at: store.isoFromSeq(repo.createdSeq),
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    name,
    color: label?.color ?? "000000",
    description: label?.description ?? "",
    default: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: VIEWER.login, id: VIEWER.id, type: "User" },
    created_at: store.isoFromSeq(issue.createdSeq),
    updated_at: store.isoFromSeq(issue.updatedSeq),
    comments: issue.comments.length,
    html_url: "",
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? "closed" : pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.ownerLogin}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.ownerLogin}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.merged ? true : store.pullMergeable(repo, pull) === "MERGEABLE",
    user: { login: VIEWER.login, id: VIEWER.id, type: "User" },
    created_at: store.isoFromSeq(pull.createdSeq),
    updated_at: store.isoFromSeq(pull.updatedSeq),
    html_url: "",
  };
}

function commentJson(comment: { id: number; body: string; userLogin: string; createdSeq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.userLogin, id: VIEWER.id, type: "User" },
    created_at: store.isoFromSeq(comment.createdSeq),
    updated_at: store.isoFromSeq(comment.createdSeq),
  };
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const m = line.match(/^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/);
  if (!m) return { name: line, email: "", date: "" };
  return { name: m[1], email: m[2], date: new Date(parseInt(m[3], 10) * 1000).toISOString() };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== "commit") return null;
  const commit = parseCommit(obj.data);
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  return {
    sha,
    commit: {
      message: commit.message,
      author,
      committer,
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER.login, id: VIEWER.id },
    committer: { login: VIEWER.login, id: VIEWER.id },
    parents: commit.parents.map((p) => ({ sha: p })),
  };
}

/** Commits reachable from `tip`, newest first (tip, then parents depth-first). */
function commitsFrom(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i--) stack.push(parents[i]);
  }
  return out;
}

// ---------------------------------------------------------------- routing

/** Resolve a viewer-owned repo; answers 404 when absent. */
function resolveRepo(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) {
    sendError(res, 404, "Not Found");
    return null;
  }
  const repo = store.getRepo(name);
  if (!repo) {
    sendError(res, 404, "Not Found");
    return null;
  }
  return repo;
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function baseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "127.0.0.1";
  return `http://${host}`;
}

export async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  try {
    return await dispatchRest(req, res);
  } catch (err) {
    if (err instanceof SyntaxError) {
      sendError(res, 400, "Invalid JSON");
      return true;
    }
    throw err;
  }
}

async function dispatchRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", baseUrl(req));
  const segments = url.pathname.split("/").filter((s) => s.length > 0).map(decodeSegment);
  const method = req.method ?? "GET";
  const query = url.searchParams;

  // The router only calls us for /api/v3/*.
  if (segments[0] !== "api" || segments[1] !== "v3") return false;

  // GET /api/v3/ — root. 200 JSON + the OAuth scopes header.
  if (segments.length === 2) {
    if (method !== "GET") return sendError(res, 404, "Not Found"), true;
    sendJson(res, 200, {}, { "X-OAuth-Scopes": "repo, read:org" });
    return true;
  }

  // GET /api/v3/meta
  if (segments.length === 3 && segments[2] === "meta") {
    if (method !== "GET") return sendError(res, 404, "Not Found"), true;
    sendJson(res, 200, { installed_version: "1.0.0" });
    return true;
  }

  // GET /api/v3/user
  if (segments.length === 3 && segments[2] === "user") {
    if (method !== "GET") return sendError(res, 404, "Not Found"), true;
    sendJson(res, 200, userJson());
    return true;
  }

  // /api/v3/user/repos
  if (segments.length === 4 && segments[2] === "user" && segments[3] === "repos") {
    if (method === "POST") return createUserRepo(req, res);
    if (method === "GET") return listUserRepos(req, res, url, query);
    return sendError(res, 404, "Not Found"), true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 4 && segments[2] === "repos") {
    const owner = segments[3];
    const repoName = segments[4];
    if (!repoName) return sendError(res, 404, "Not Found"), true;
    const rest = segments.slice(5);

    if (rest.length === 0) {
      if (method === "GET") return getRepo(res, owner, repoName);
      if (method === "PATCH") return patchRepo(req, res, owner, repoName);
      if (method === "DELETE") return deleteRepo(res, owner, repoName);
      return sendError(res, 404, "Not Found"), true;
    }

    if (rest[0] === "branches") {
      if (rest.length === 1 && method === "GET") return listBranches(res, owner, repoName);
      if (rest.length >= 2 && method === "GET") {
        return getBranch(res, owner, repoName, rest.slice(1).join("/"));
      }
      return sendError(res, 404, "Not Found"), true;
    }

    if (rest[0] === "commits") {
      if (method === "GET") return listCommits(res, owner, repoName, query);
      return sendError(res, 404, "Not Found"), true;
    }

    if (rest[0] === "git" && rest[1] === "refs") {
      if (method === "POST" && rest.length === 2) return createRef(req, res, owner, repoName);
      if (method === "GET" && rest.length >= 3) {
        return getRef(res, owner, repoName, rest.slice(2).join("/"));
      }
      return sendError(res, 404, "Not Found"), true;
    }

    if (rest[0] === "contents") {
      const path = rest.slice(1).join("/");
      if (method === "GET") return getContents(res, owner, repoName, path, query);
      if (method === "PUT") return putContents(req, res, owner, repoName, path);
      if (method === "DELETE") return deleteContents(req, res, owner, repoName, path);
      return sendError(res, 404, "Not Found"), true;
    }

    if (rest[0] === "labels") {
      if (method === "POST") return createLabel(req, res, owner, repoName);
      if (method === "GET") return listLabels(res, owner, repoName);
      return sendError(res, 404, "Not Found"), true;
    }

    if (rest[0] === "issues") {
      if (rest.length === 1) {
        if (method === "POST") return createIssue(req, res, owner, repoName);
        if (method === "GET") return listIssues(res, owner, repoName, query);
        return sendError(res, 404, "Not Found"), true;
      }
      const num = parseInt(rest[1], 10);
      if (Number.isNaN(num)) return sendError(res, 404, "Not Found"), true;
      if (rest.length === 2) {
        if (method === "GET") return getIssue(res, owner, repoName, num);
        if (method === "PATCH") return patchIssue(req, res, owner, repoName, num);
        return sendError(res, 404, "Not Found"), true;
      }
      if (rest.length === 3 && rest[2] === "comments") {
        if (method === "POST") return createComment(req, res, owner, repoName, num);
        if (method === "GET") return listComments(res, owner, repoName, num);
        return sendError(res, 404, "Not Found"), true;
      }
      return sendError(res, 404, "Not Found"), true;
    }

    if (rest[0] === "pulls") {
      if (rest.length === 1) {
        if (method === "POST") return createPull(req, res, owner, repoName);
        if (method === "GET") return listPulls(res, owner, repoName, query);
        return sendError(res, 404, "Not Found"), true;
      }
      const num = parseInt(rest[1], 10);
      if (Number.isNaN(num)) return sendError(res, 404, "Not Found"), true;
      if (rest.length === 2 && method === "GET") return getPull(res, owner, repoName, num);
      if (rest.length === 3 && rest[2] === "files" && method === "GET") {
        return listPullFiles(res, owner, repoName, num);
      }
      if (rest.length === 3 && rest[2] === "merge" && method === "PUT") {
        return mergePull(req, res, owner, repoName, num);
      }
      return sendError(res, 404, "Not Found"), true;
    }
  }

  return sendError(res, 404, "Not Found"), true;
}

// ---------------------------------------------------------------- repos

async function createUserRepo(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = await readJson(req);
  const name = str(body.name);
  if (!name) return sendError(res, 422, "Validation Failed"), true;
  if (store.getRepo(name)) return sendError(res, 422, "name already exists on this account"), true;
  const repo = store.createRepo(name, {
    description: str(body.description),
    isPrivate: bool(body.private),
    defaultBranch: str(body.default_branch) || "main",
  });
  sendJson(res, 201, repoJson(repo));
  return true;
}

async function listUserRepos(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  query: URLSearchParams,
): Promise<boolean> {
  const perPage = Math.max(1, parseInt(query.get("per_page") ?? "30", 10) || 30);
  const page = Math.max(1, parseInt(query.get("page") ?? "1", 10) || 1);
  const all = store.listRepos();
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (page < totalPages) {
    const next = new URL(url.pathname, baseUrl(req));
    next.searchParams.set("per_page", String(perPage));
    next.searchParams.set("page", String(page + 1));
    const last = new URL(url.pathname, baseUrl(req));
    last.searchParams.set("per_page", String(perPage));
    last.searchParams.set("page", String(totalPages));
    headers.Link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  sendJson(res, 200, slice.map((r) => repoJson(r)), headers);
  return true;
}

async function getRepo(res: ServerResponse, owner: string, name: string): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  sendJson(res, 200, repoJson(repo));
  return true;
}

async function patchRepo(req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const body = await readJson(req);
  if (typeof body.description === "string") repo.description = body.description;
  if (typeof body.private === "boolean") repo.isPrivate = body.private;
  sendJson(res, 200, repoJson(repo));
  return true;
}

async function deleteRepo(res: ServerResponse, owner: string, name: string): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  store.deleteRepo(name);
  sendNoContent(res);
  return true;
}

// ---------------------------------------------------------------- branches / commits / refs

async function listBranches(res: ServerResponse, owner: string, name: string): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const branches = store
    .listRefs(repo)
    .filter((r) => r.ref.startsWith("refs/heads/"))
    .map((r) => ({
      name: r.ref.slice("refs/heads/".length),
      commit: { sha: r.oid },
      protected: false,
    }));
  sendJson(res, 200, branches);
  return true;
}

async function getBranch(res: ServerResponse, owner: string, name: string, branch: string): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const tip = store.branchTip(repo, branch);
  if (!tip) return sendError(res, 404, "Not Found"), true;
  sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
  return true;
}

async function listCommits(
  res: ServerResponse,
  owner: string,
  name: string,
  query: URLSearchParams,
): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const ref = query.get("sha") ?? repo.defaultBranch;
  let tip = store.branchTip(repo, ref);
  if (!tip) {
    // `sha` may name a commit directly.
    tip = repo.objects.has(ref) ? ref : undefined;
  }
  if (!tip) return sendError(res, 404, "Not Found"), true;
  const commits = commitsFrom(repo, tip)
    .map((sha) => commitJson(repo, sha))
    .filter((c): c is Record<string, unknown> => c !== null);
  sendJson(res, 200, commits);
  return true;
}

async function createRef(req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const body = await readJson(req);
  const ref = str(body.ref);
  const sha = str(body.sha);
  if (!ref.startsWith("refs/") || !/^[0-9a-f]{40}$/.test(sha)) {
    return sendError(res, 422, "Validation Failed"), true;
  }
  if (!repo.objects.has(sha)) return sendError(res, 422, "Object does not exist"), true;
  if (repo.refs.has(ref)) return sendError(res, 422, "Reference already exists"), true;
  store.setRef(repo, ref, sha);
  sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)!.type } });
  return true;
}

async function getRef(res: ServerResponse, owner: string, name: string, refPath: string): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  // refPath is e.g. "heads/main" or "heads/feature/x" (after /git/refs/).
  const ref = `refs/${refPath}`;
  const oid = repo.refs.get(ref);
  if (!oid) return sendError(res, 404, "Not Found"), true;
  sendJson(res, 200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? "commit" } });
  return true;
}

// ---------------------------------------------------------------- contents

function refTipForContents(repo: Repo, query: URLSearchParams, body?: Record<string, unknown>): string | undefined {
  const branch = (body?.branch as string) || query.get("ref") || repo.defaultBranch;
  return store.branchTip(repo, branch) ?? store.headTip(repo);
}

async function getContents(
  res: ServerResponse,
  owner: string,
  name: string,
  path: string,
  query: URLSearchParams,
): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const tip = refTipForContents(repo, query);
  if (!tip) return sendError(res, 404, "Not Found"), true;
  if (!path) {
    // Root directory listing.
    const entries = store.listDirAt(repo, tip, "");
    sendJson(res, 200, entries.map((e) => ({
      type: e.isDir ? "dir" : "file",
      name: e.name,
      path: e.path,
      sha: e.oid,
      size: e.isDir ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
    })));
    return true;
  }
  const file = store.readFileAt(repo, tip, path);
  if (file) {
    sendJson(res, 200, {
      type: "file",
      encoding: "base64",
      size: file.data.length,
      name: path.split("/").pop(),
      path,
      content: file.data.toString("base64"),
      sha: file.oid,
    });
    return true;
  }
  const dir = store.listDirAt(repo, tip, path);
  if (dir.length > 0) {
    sendJson(res, 200, dir.map((e) => ({
      type: e.isDir ? "dir" : "file",
      name: e.name,
      path: e.path,
      sha: e.oid,
      size: e.isDir ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
    })));
    return true;
  }
  return sendError(res, 404, "Not Found"), true;
}

async function putContents(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  path: string,
): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const body = await readJson(req);
  const message = str(body.message) || "Update file";
  const contentB64 = str(body.content);
  const branch = str(body.branch) || repo.defaultBranch;
  const sha = typeof body.sha === "string" ? body.sha : undefined;
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, "base64");
  } catch {
    return sendError(res, 422, "Validation Failed"), true;
  }
  try {
    const { commitOid, blobOid, status } = store.writeFile(repo, branch, path, content, message, sha);
    sendJson(res, status === "created" ? 201 : 200, {
      content: {
        name: path.split("/").pop(),
        path,
        sha: blobOid,
        size: content.length,
        type: "file",
        encoding: "base64",
        content: contentB64,
      },
      commit: { sha: commitOid, message },
    });
  } catch (err) {
    if ((err as Error).message === "stale-sha") return sendError(res, 409, "sha does not match"), true;
    return sendError(res, 422, (err as Error).message), true;
  }
  return true;
}

async function deleteContents(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  path: string,
): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const body = await readJson(req);
  const message = str(body.message) || "Delete file";
  const branch = str(body.branch) || repo.defaultBranch;
  const sha = typeof body.sha === "string" ? body.sha : undefined;
  try {
    const { commitOid } = store.writeFile(repo, branch, path, null, message, sha);
    sendJson(res, 200, { commit: { sha: commitOid, message } });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "stale-sha") return sendError(res, 409, "sha does not match"), true;
    if (msg === "not-found") return sendError(res, 404, "Not Found"), true;
    return sendError(res, 422, msg), true;
  }
  return true;
}

// ---------------------------------------------------------------- labels

async function createLabel(req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const body = await readJson(req);
  const labelName = str(body.name);
  if (!labelName) return sendError(res, 422, "Validation Failed"), true;
  const label = store.createLabel(repo, labelName, str(body.color) || "000000", str(body.description));
  sendJson(res, 201, { id: label.id, name: label.name, color: label.color, description: label.description, default: false });
  return true;
}

async function listLabels(res: ServerResponse, owner: string, name: string): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  sendJson(res, 200, [...repo.labels.values()].map((l) => ({
    id: l.id, name: l.name, color: l.color, description: l.description, default: false,
  })));
  return true;
}

// ---------------------------------------------------------------- issues

async function createIssue(req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const body = await readJson(req);
  const title = str(body.title);
  if (!title) return sendError(res, 422, "Validation Failed"), true;
  const labels = Array.isArray(body.labels) ? body.labels.map((l) => String(l)) : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return sendError(res, 422, `Label does not exist: ${label}`), true;
  }
  const issue = store.createIssue(repo, title, str(body.body), labels);
  sendJson(res, 201, issueJson(repo, issue));
  return true;
}

async function listIssues(
  res: ServerResponse,
  owner: string,
  name: string,
  query: URLSearchParams,
): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const state = query.get("state") ?? "open";
  const sort = query.get("sort") ?? "created";
  const direction = query.get("direction") ?? "desc";
  let issues = [...repo.issues.values()];
  if (state !== "all") issues = issues.filter((i) => i.state === state);
  const key = sort === "updated" ? (i: Issue) => i.updatedSeq : (i: Issue) => i.createdSeq;
  issues.sort((a, b) => (direction === "asc" ? key(a) - key(b) : key(b) - key(a)));
  sendJson(res, 200, issues.map((i) => issueJson(repo, i)));
  return true;
}

async function getIssue(res: ServerResponse, owner: string, name: string, num: number): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const issue = repo.issues.get(num);
  if (!issue) return sendError(res, 404, "Not Found"), true;
  sendJson(res, 200, issueJson(repo, issue));
  return true;
}

async function patchIssue(req: IncomingMessage, res: ServerResponse, owner: string, name: string, num: number): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const issue = repo.issues.get(num);
  if (!issue) return sendError(res, 404, "Not Found"), true;
  const body = await readJson(req);
  if (typeof body.title === "string") issue.title = body.title;
  if (typeof body.body === "string") issue.body = body.body;
  if (typeof body.state === "string" && (body.state === "open" || body.state === "closed")) {
    issue.state = body.state;
  }
  if (Array.isArray(body.labels)) {
    const labels = body.labels.map((l) => String(l));
    for (const label of labels) {
      if (!repo.labels.has(label)) return sendError(res, 422, `Label does not exist: ${label}`), true;
    }
    issue.labels = labels;
  }
  issue.updatedSeq = store.nextSeq();
  sendJson(res, 200, issueJson(repo, issue));
  return true;
}

async function createComment(req: IncomingMessage, res: ServerResponse, owner: string, name: string, num: number): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const issue = repo.issues.get(num);
  if (!issue) return sendError(res, 404, "Not Found"), true;
  const body = await readJson(req);
  const commentBody = str(body.body);
  if (!commentBody) return sendError(res, 422, "Validation Failed"), true;
  const comment = store.addComment(repo, issue, commentBody);
  sendJson(res, 201, commentJson(comment));
  return true;
}

async function listComments(res: ServerResponse, owner: string, name: string, num: number): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const issue = repo.issues.get(num);
  if (!issue) return sendError(res, 404, "Not Found"), true;
  sendJson(res, 200, issue.comments.map((c) => commentJson(c)));
  return true;
}

// ---------------------------------------------------------------- pulls

async function createPull(req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const body = await readJson(req);
  const title = str(body.title);
  const head = str(body.head);
  const base = str(body.base);
  if (!title || !head || !base) return sendError(res, 422, "Validation Failed"), true;
  if (!store.branchTip(repo, head)) return sendError(res, 422, "head branch does not exist"), true;
  if (!store.branchTip(repo, base)) return sendError(res, 422, "base branch does not exist"), true;
  const pull = store.createPull(repo, title, str(body.body), head, base);
  sendJson(res, 201, pullJson(repo, pull));
  return true;
}

async function listPulls(
  res: ServerResponse,
  owner: string,
  name: string,
  query: URLSearchParams,
): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const state = query.get("state") ?? "open";
  let pulls = [...repo.pulls.values()];
  if (state !== "all") {
    pulls = pulls.filter((p) => (state === "closed" ? p.state === "closed" : p.state === state));
  }
  pulls.sort((a, b) => a.number - b.number);
  sendJson(res, 200, pulls.map((p) => pullJson(repo, p)));
  return true;
}

async function getPull(res: ServerResponse, owner: string, name: string, num: number): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const pull = repo.pulls.get(num);
  if (!pull) return sendError(res, 404, "Not Found"), true;
  sendJson(res, 200, pullJson(repo, pull));
  return true;
}

async function listPullFiles(res: ServerResponse, owner: string, name: string, num: number): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const pull = repo.pulls.get(num);
  if (!pull) return sendError(res, 404, "Not Found"), true;
  sendJson(res, 200, store.pullFiles(repo, pull));
  return true;
}

async function mergePull(req: IncomingMessage, res: ServerResponse, owner: string, name: string, num: number): Promise<boolean> {
  const repo = resolveRepo(res, owner, name);
  if (!repo) return true;
  const pull = repo.pulls.get(num);
  if (!pull) return sendError(res, 404, "Not Found"), true;
  if (pull.merged) {
    return sendJson(res, 200, { sha: pull.mergeCommitSha, merged: true, message: "Pull request already merged" }), true;
  }
  const body = await readJson(req);
  const method = str(body.merge_method) || "merge";
  const sha = store.mergePull(repo, pull, method);
  if (!sha) {
    return sendJson(res, 405, { message: "Merge conflict" }), true;
  }
  sendJson(res, 200, { sha, merged: true, message: "Pull request successfully merged" });
  return true;
}
