// app.ts — the HTTP server: routing, auth and the per-request headers.
//
// Auth: every API/git call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`
// (the token is in the entry's own environment). When the variable is unset
// (local practice) any non-empty Bearer token is accepted so the local
// grader can run with --token. /healthz and / are unauthenticated.
// Every reply carries a non-empty X-GitHub-Request-Id; REST replies are
// always JSON, never HTML.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleRest } from "./rest.ts";
import { handleGraphql } from "./graphql.ts";
import { handleMcp } from "./mcp.ts";
import { handleInfoRefs, handleUploadPack, handleReceivePack } from "./githttp.ts";

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": body.length });
  res.end(body);
}

function checkAuth(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return false;
  if (expected) return token === expected;
  return true; // no token configured: accept any non-empty Bearer token
}

export function createApp() {
  const server = createServer(async (req, res) => {
    const requestId = `req-${++requestCounter}`;
    res.setHeader("X-GitHub-Request-Id", requestId);
    try {
      await route(req, res);
    } catch (err) {
      // Never crash on a bad request; answer 400 and stay healthy.
      if (!res.headersSent) {
        sendJson(res, 400, { message: (err as Error).message || "Bad Request" });
      } else {
        res.end();
      }
    }
  });
  return server;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (method === "GET" && path === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === "GET" && path === "/") {
    sendJson(res, 200, { ok: true, service: "github-core-clone" });
    return;
  }

  // Everything else needs the shop token.
  if (!checkAuth(req)) {
    sendJson(res, 401, { message: "Requires authentication" });
    return;
  }

  if (path === "/api/v3" || path.startsWith("/api/v3/")) {
    await handleRest(req, res);
    return;
  }
  if (path === "/api/graphql") {
    await handleGraphql(req, res);
    return;
  }
  if (path === "/mcp") {
    await handleMcp(req, res);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const action = gitMatch[3];
    if (action === "info/refs" && method === "GET") {
      await handleInfoRefs(req, res, owner, repoName, url.searchParams.get("service"));
      return;
    }
    if (action === "git-upload-pack" && method === "POST") {
      await handleUploadPack(req, res, owner, repoName);
      return;
    }
    if (action === "git-receive-pack" && method === "POST") {
      await handleReceivePack(req, res, owner, repoName);
      return;
    }
    sendJson(res, 404, { message: "Not Found" });
    return;
  }

  sendJson(res, 404, { message: "Not Found" });
}
