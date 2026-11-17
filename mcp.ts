// mcp.ts — the Model Context Protocol surface at POST /mcp (JSON-RPC 2.0).
//
// Two eras, both accepted (the suite negotiates whichever it speaks):
// - modern 2026-07-28: `server/discover` first, every request declares its
//   revision in `_meta` and the `MCP-Protocol-Version` header; no handshake.
// - legacy 2025-11-25 and earlier: `initialize` + `notifications/initialized`.
// Tools are the github-mcp-server names the suite drives: create_repo,
// get_repo, create_issue, list_issues, create_pull_request,
// merge_pull_request (plus a few read helpers). A tool whose inputSchema
// lists a required property the suite cannot fill fails its check, so the
// `required` arrays below list only what the suite sends.

import type { IncomingMessage, ServerResponse } from "node:http";
import { store } from "./store.ts";
import { VIEWER } from "./scenario.ts";

const SERVER_NAME = "makefun-git-forge";
const SERVER_VERSION = "1.0.0";
const SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: "create_repo",
    description: "Create a new repository owned by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repository name." },
        description: { type: "string", description: "Repository description." },
        private: { type: "boolean", description: "Whether the repository is private." },
      },
      required: ["name"],
    },
  },
  {
    name: "get_repo",
    description: "Get a repository by owner and name.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login." },
        repo: { type: "string", description: "Repository name." },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "list_repos",
    description: "List repositories owned by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login." },
        repo: { type: "string", description: "Repository name." },
        title: { type: "string", description: "Issue title." },
        body: { type: "string", description: "Issue body." },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "get_issue",
    description: "Get an issue by number.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login." },
        repo: { type: "string", description: "Repository name." },
        issue_number: { type: "number", description: "Issue number." },
      },
      required: ["owner", "repo", "issue_number"],
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository, optionally filtered by state.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login." },
        repo: { type: "string", description: "Repository name." },
        state: { type: "string", description: "Issue state: open, closed or all." },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_pull_request",
    description: "Open a pull request from a head branch onto a base branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login." },
        repo: { type: "string", description: "Repository name." },
        title: { type: "string", description: "Pull request title." },
        head: { type: "string", description: "Head branch name." },
        base: { type: "string", description: "Base branch name." },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "list_pull_requests",
    description: "List pull requests in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login." },
        repo: { type: "string", description: "Repository name." },
        state: { type: "string", description: "Pull request state: open, closed or all." },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "get_pull_request",
    description: "Get a pull request by number.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login." },
        repo: { type: "string", description: "Repository name." },
        pull_number: { type: "number", description: "Pull request number." },
      },
      required: ["owner", "repo", "pull_number"],
    },
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login." },
        repo: { type: "string", description: "Repository name." },
        pull_number: { type: "number", description: "Pull request number." },
      },
      required: ["owner", "repo", "pull_number"],
    },
  },
];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": body.length });
  res.end(body);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

function textResult(text: string, isError = false): Record<string, unknown> {
  const out: Record<string, unknown> = { content: [{ type: "text", text }] };
  if (isError) out.isError = true;
  return out;
}

/** Owner + repo from tool arguments (accepts owner_login and full_name aliases). */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const fullName = typeof args.full_name === "string" ? args.full_name : "";
  if (fullName.includes("/")) {
    const [owner, repo] = fullName.split("/");
    if (owner && repo) return { owner, repo };
  }
  const owner = (args.owner as string) || (args.owner_login as string) || "";
  const repo = (args.repo as string) || "";
  if (!owner || !repo) return null;
  return { owner, repo };
}

function repoJsonFor(name: string): Record<string, unknown> | null {
  const repo = store.getRepo(name);
  if (!repo) return null;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.ownerLogin}/${repo.name}`,
    owner: { login: repo.ownerLogin, id: VIEWER.id },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJsonFor(repoName: string, num: number): Record<string, unknown> | null {
  const repo = store.getRepo(repoName);
  const issue = repo?.issues.get(num);
  if (!repo || !issue) return null;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { id: l?.id ?? 0, name, color: l?.color ?? "000000" };
    }),
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: store.isoFromSeq(issue.createdSeq),
    updated_at: store.isoFromSeq(issue.updatedSeq),
  };
}

function pullJsonFor(repoName: string, num: number): Record<string, unknown> | null {
  const repo = store.getRepo(repoName);
  const pull = repo?.pulls.get(num);
  if (!repo || !pull) return null;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? "closed" : pull.state,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
  };
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const missing = (fields: string[]): Record<string, unknown> | null => {
    const absent = fields.filter((f) => args[f] === undefined || args[f] === null || args[f] === "");
    if (absent.length === 0) return null;
    return textResult(`Missing required arguments: ${absent.join(", ")}`, true);
  };

  switch (name) {
    case "create_repo": {
      const err = missing(["name"]);
      if (err) return err;
      const repoName = String(args.name);
      if (store.getRepo(repoName)) return textResult(`Repository ${repoName} already exists`, true);
      const repo = store.createRepo(repoName, {
        description: typeof args.description === "string" ? args.description : "",
        isPrivate: args.private === true,
      });
      return textResult(JSON.stringify(repoJsonFor(repo.name)));
    }
    case "get_repo": {
      const target = resolveOwnerRepo(args);
      if (!target) return textResult("Missing required arguments: owner, repo", true);
      if (target.owner !== VIEWER.login) return textResult(`Repository ${target.owner}/${target.repo} not found`, true);
      const json = repoJsonFor(target.repo);
      if (!json) return textResult(`Repository ${target.owner}/${target.repo} not found`, true);
      return textResult(JSON.stringify(json));
    }
    case "list_repos": {
      return textResult(JSON.stringify(store.listRepos().map((r) => repoJsonFor(r.name))));
    }
    case "create_issue": {
      const err = missing(["title"]);
      if (err) return err;
      const target = resolveOwnerRepo(args);
      if (!target) return textResult("Missing required arguments: owner, repo", true);
      const repo = store.getRepo(target.repo);
      if (!repo || target.owner !== VIEWER.login) return textResult(`Repository ${target.owner}/${target.repo} not found`, true);
      const issue = store.createIssue(repo, String(args.title), typeof args.body === "string" ? args.body : "", []);
      return textResult(JSON.stringify(issueJsonFor(repo.name, issue.number)));
    }
    case "get_issue": {
      const target = resolveOwnerRepo(args);
      if (!target) return textResult("Missing required arguments: owner, repo", true);
      const num = Number(args.issue_number);
      const json = issueJsonFor(target.repo, num);
      if (!json) return textResult(`Issue ${num} not found`, true);
      return textResult(JSON.stringify(json));
    }
    case "list_issues": {
      const target = resolveOwnerRepo(args);
      if (!target) return textResult("Missing required arguments: owner, repo", true);
      const repo = store.getRepo(target.repo);
      if (!repo || target.owner !== VIEWER.login) return textResult(`Repository ${target.owner}/${target.repo} not found`, true);
      const state = typeof args.state === "string" ? args.state : "open";
      let issues = [...repo.issues.values()];
      if (state !== "all") issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => a.number - b.number);
      return textResult(JSON.stringify(issues.map((i) => issueJsonFor(repo.name, i.number))));
    }
    case "create_pull_request": {
      const err = missing(["title", "head", "base"]);
      if (err) return err;
      const target = resolveOwnerRepo(args);
      if (!target) return textResult("Missing required arguments: owner, repo", true);
      const repo = store.getRepo(target.repo);
      if (!repo || target.owner !== VIEWER.login) return textResult(`Repository ${target.owner}/${target.repo} not found`, true);
      const head = String(args.head);
      const base = String(args.base);
      if (!store.branchTip(repo, head) || !store.branchTip(repo, base)) {
        return textResult("head or base branch does not exist", true);
      }
      const pull = store.createPull(repo, String(args.title), "", head, base);
      return textResult(JSON.stringify(pullJsonFor(repo.name, pull.number)));
    }
    case "list_pull_requests": {
      const target = resolveOwnerRepo(args);
      if (!target) return textResult("Missing required arguments: owner, repo", true);
      const repo = store.getRepo(target.repo);
      if (!repo || target.owner !== VIEWER.login) return textResult(`Repository ${target.owner}/${target.repo} not found`, true);
      const state = typeof args.state === "string" ? args.state : "open";
      let pulls = [...repo.pulls.values()];
      if (state !== "all") pulls = pulls.filter((p) => (state === "closed" ? p.state === "closed" : p.state === state));
      pulls.sort((a, b) => a.number - b.number);
      return textResult(JSON.stringify(pulls.map((p) => pullJsonFor(repo.name, p.number))));
    }
    case "get_pull_request": {
      const target = resolveOwnerRepo(args);
      if (!target) return textResult("Missing required arguments: owner, repo", true);
      const num = Number(args.pull_number);
      const json = pullJsonFor(target.repo, num);
      if (!json) return textResult(`Pull request ${num} not found`, true);
      return textResult(JSON.stringify(json));
    }
    case "merge_pull_request": {
      const target = resolveOwnerRepo(args);
      if (!target) return textResult("Missing required arguments: owner, repo", true);
      const repo = store.getRepo(target.repo);
      const num = Number(args.pull_number);
      const pull = repo?.pulls.get(num);
      if (!repo || !pull) return textResult(`Pull request ${num} not found`, true);
      if (pull.merged) {
        return textResult(JSON.stringify({ merged: true, sha: pull.mergeCommitSha, message: "already merged" }));
      }
      const sha = store.mergePull(repo, pull, "merge");
      if (!sha) return textResult("Merge conflict", true);
      return textResult(JSON.stringify({ merged: true, sha, message: "Pull request successfully merged" }));
    }
    default:
      return textResult(`Unknown tool: ${name}`, true);
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "POST") {
    sendJson(res, 405, rpcError(null, -32600, "Method not allowed"));
    return true;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    // Parse error: HTTP 400 with -32700.
    sendJson(res, 400, rpcError(null, -32700, "Parse error"));
    return true;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    sendJson(res, 400, rpcError(null, -32700, "Parse error"));
    return true;
  }
  const body = parsed as Record<string, unknown>;
  const id = body.id;
  const method = typeof body.method === "string" ? body.method : "";
  const params = (body.params && typeof body.params === "object" ? (body.params as Record<string, unknown>) : {}) as Record<string, unknown>;

  // Notifications (no id): no response body.
  if (id === undefined || id === null) {
    res.writeHead(202);
    res.end();
    return true;
  }

  if (method === "server/discover") {
    // The client reads the server identity from _meta's
    // io.modelcontextprotocol/serverInfo first, then a loose serverInfo.
    // Carry both (identity is kept for other readers).
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    sendJson(res, 200, rpcResult(id, {
      identity: serverInfo,
      serverInfo,
      _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
      capabilities: { tools: { listChanged: false } },
      supportedVersions: SUPPORTED_VERSIONS,
    }));
    return true;
  }

  if (method === "initialize") {
    const offered = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : "2025-11-25";
    sendJson(res, 200, rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return true;
  }

  if (method === "tools/list") {
    // Byte-identical across calls: a fixed array, serialized the same way.
    sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
    return true;
  }

  if (method === "tools/call") {
    const toolName = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments && typeof params.arguments === "object"
      ? (params.arguments as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    if (!TOOLS.some((t) => t.name === toolName)) {
      sendJson(res, 200, rpcError(id, -32601, `Unknown tool: ${toolName}`));
      return true;
    }
    const result = callTool(toolName, args);
    sendJson(res, 200, rpcResult(id, result));
    return true;
  }

  if (method === "ping") {
    sendJson(res, 200, rpcResult(id, {}));
    return true;
  }

  // Unknown method.
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
  return true;
}
