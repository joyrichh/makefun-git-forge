// graphql.ts — GraphQL v4 at /api/graphql (the shapes gh and
// github-mcp-server send). A small tokenizer + recursive-descent parser and
// a resolver-based executor over the same store the REST surface uses.
// Supports variables, aliases, inline fragments, input objects, enums,
// nulls, operation names and JSON-array batching. Unknown fields produce a
// 200 with an `errors` array naming the field (the suite's invalid-field
// check); an unknown repository is `data.repository: null` with no errors.

import type { IncomingMessage, ServerResponse } from "node:http";
import { store, type Repo, type Issue, type Pull } from "./store.ts";
import { VIEWER } from "./scenario.ts";

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: "name"; value: string }
  | { kind: "int"; value: string }
  | { kind: "float"; value: string }
  | { kind: "string"; value: string }
  | { kind: "punct"; value: string }
  | { kind: "eof" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string) => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "." && src.slice(i, i + 3) === "...") {
      tokens.push({ kind: "punct", value: "..." });
      i += 3;
      continue;
    }
    if ("{}()[]:!=$@&|".includes(c)) {
      tokens.push({ kind: "punct", value: c });
      i++;
      continue;
    }
    if (c === '"') {
      // String (supports \" and \\ escapes; block strings are not used).
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          const e = src[j + 1];
          if (e === "n") out += "\n";
          else if (e === "t") out += "\t";
          else if (e === "r") out += "\r";
          else out += e;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ kind: "string", value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === "-") j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      let isFloat = false;
      if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) {
        isFloat = true;
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      if (src[j] === "e" || src[j] === "E") {
        isFloat = true;
        j++;
        if (src[j] === "+" || src[j] === "-") j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const text = src.slice(i, j);
      tokens.push(isFloat ? { kind: "float", value: text } : { kind: "int", value: text });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j])) j++;
      tokens.push({ kind: "name", value: src.slice(i, j) });
      i = j;
      continue;
    }
    // Unknown character: skip it.
    i++;
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: "variable"; name: string }
  | { kind: "string"; value: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "enum"; value: string }
  | { kind: "list"; values: Value[] }
  | { kind: "object"; fields: { name: string; value: Value }[] };

interface FieldNode {
  kind: "field";
  alias: string | null;
  name: string;
  args: { name: string; value: Value }[];
  selection: SelectionNode[];
}

interface FragmentNode {
  kind: "fragment";
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  kind: "query" | "mutation";
  name: string | null;
  variableValues: Record<string, unknown>;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== "punct" || t.value !== v) throw new Error(`expected ${v}`);
  }

  private acceptPunct(v: string): boolean {
    const t = this.peek();
    if (t.kind === "punct" && t.value === v) {
      this.pos++;
      return true;
    }
    return false;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek().kind !== "eof") {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): Operation {
    let kind: "query" | "mutation" = "query";
    let name: string | null = null;
    let variableValues: Record<string, unknown> = {};
    const t = this.peek();
    if (t.kind === "name" && (t.value === "query" || t.value === "mutation" || t.value === "subscription")) {
      kind = t.value === "mutation" ? "mutation" : "query";
      this.next();
      const n = this.peek();
      if (n.kind === "name") {
        name = n.value;
        this.next();
      }
      if (this.acceptPunct("(")) {
        variableValues = this.parseVariableDefinitions();
        this.expectPunct(")");
      }
    } else if (t.kind === "punct" && t.value === "{") {
      // Anonymous shorthand.
    } else {
      throw new Error("unsupported operation");
    }
    const selection = this.parseSelectionSet();
    return { kind, name, variableValues, selection };
  }

  private parseVariableDefinitions(): Record<string, unknown> {
    // We only need the variable names; values come from the request body.
    const defs: Record<string, unknown> = {};
    while (!(this.peek().kind === "punct" && this.peek().value === ")")) {
      const dollar = this.next();
      if (dollar.kind !== "punct" || dollar.value !== "$") throw new Error("expected $ in variable definition");
      const nameTok = this.next();
      if (nameTok.kind !== "name") throw new Error("expected variable name");
      defs[nameTok.value] = null;
      this.expectPunct(":");
      // Type: a name, possibly wrapped in [ ] and suffixed with !.
      this.parseType();
      if (this.acceptPunct("=")) this.parseValue();
    }
    return defs;
  }

  private parseType(): void {
    if (this.acceptPunct("[")) {
      this.parseType();
      this.expectPunct("]");
    } else {
      const t = this.next();
      if (t.kind !== "name") throw new Error("expected type name");
    }
    this.acceptPunct("!");
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct("{");
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === "punct" && this.peek().value === "}")) {
      selections.push(this.parseSelection());
    }
    this.expectPunct("}");
    return selections;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === "punct" && t.value === "...") {
      this.next();
      const n = this.peek();
      if (n.kind === "name" && n.value === "on") {
        this.next();
        const typeTok = this.next();
        if (typeTok.kind !== "name") throw new Error("expected type condition");
        return { kind: "fragment", typeCondition: typeTok.value, selection: this.parseSelectionSet() };
      }
      if (n.kind === "name") {
        // Named fragment spread (not used by the suite); treat as a fragment
        // with no type condition and skip its selection set if present.
        this.next();
        return { kind: "fragment", typeCondition: null, selection: [] };
      }
      return { kind: "fragment", typeCondition: null, selection: this.parseSelectionSet() };
    }
    if (t.kind !== "name") throw new Error("expected field name");
    const first = this.next() as { kind: "name"; value: string };
    let alias: string | null = null;
    let name = first.value;
    if (this.acceptPunct(":")) {
      alias = name;
      const n = this.next();
      if (n.kind !== "name") throw new Error("expected field name after alias");
      name = n.value;
    }
    const args: { name: string; value: Value }[] = [];
    if (this.acceptPunct("(")) {
      while (!(this.peek().kind === "punct" && this.peek().value === ")")) {
        const argName = this.next();
        if (argName.kind !== "name") throw new Error("expected argument name");
        this.expectPunct(":");
        args.push({ name: argName.value, value: this.parseValue() });
      }
      this.expectPunct(")");
    }
    let selection: SelectionNode[] = [];
    if (this.peek().kind === "punct" && this.peek().value === "{") {
      selection = this.parseSelectionSet();
    }
    return { kind: "field", alias, name, args, selection };
  }

  private parseValue(): Value {
    const t = this.next();
    if (t.kind === "punct" && t.value === "$") {
      const n = this.next();
      if (n.kind !== "name") throw new Error("expected variable name");
      return { kind: "variable", name: n.value };
    }
    if (t.kind === "string") return { kind: "string", value: t.value };
    if (t.kind === "int") return { kind: "int", value: parseInt(t.value, 10) };
    if (t.kind === "float") return { kind: "float", value: parseFloat(t.value) };
    if (t.kind === "name") {
      if (t.value === "true") return { kind: "boolean", value: true };
      if (t.value === "false") return { kind: "boolean", value: false };
      if (t.value === "null") return { kind: "null" };
      return { kind: "enum", value: t.value };
    }
    if (t.kind === "punct" && t.value === "[") {
      const values: Value[] = [];
      while (!(this.peek().kind === "punct" && this.peek().value === "]")) {
        values.push(this.parseValue());
      }
      this.expectPunct("]");
      return { kind: "list", values };
    }
    if (t.kind === "punct" && t.value === "{") {
      const fields: { name: string; value: Value }[] = [];
      while (!(this.peek().kind === "punct" && this.peek().value === "}")) {
        const nameTok = this.next();
        if (nameTok.kind !== "name") throw new Error("expected object field name");
        this.expectPunct(":");
        fields.push({ name: nameTok.value, value: this.parseValue() });
      }
      this.expectPunct("}");
      return { kind: "object", fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

// ---------------------------------------------------------------- execution

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

interface ExecContext {
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function resolveValue(v: Value, ctx: ExecContext): unknown {
  switch (v.kind) {
    case "variable":
      return ctx.variables[v.name];
    case "string":
    case "int":
    case "float":
    case "boolean":
      return v.value;
    case "null":
      return null;
    case "enum":
      return v.value;
    case "list":
      return v.values.map((x) => resolveValue(x, ctx));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = resolveValue(f.value, ctx);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, ctx: ExecContext): unknown {
  const arg = field.args.find((a) => a.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, ctx);
}

function inputField(obj: unknown, name: string): unknown {
  if (obj && typeof obj === "object") return (obj as Record<string, unknown>)[name];
  return undefined;
}

// --- object builders (GraphQL views over the store) ---

function userObject(): GqlObject {
  return { __typename: "User", login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function repoObject(repo: Repo): GqlObject {
  return {
    __typename: "Repository",
    _repo: repo,
    id: store.globalId("repo", repo.name, repo.name),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.ownerLogin}/${repo.name}`,
    viewerPermission: "ADMIN",
    hasIssuesEnabled: true,
  };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return {
    __typename: "Issue",
    _repo: repo,
    _issue: issue,
    id: store.globalId("issue", repo.name, String(issue.number)),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === "open" ? "OPEN" : "CLOSED",
  };
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  const state = pull.merged ? "MERGED" : pull.state === "open" ? "OPEN" : "CLOSED";
  return {
    __typename: "PullRequest",
    _repo: repo,
    _pull: pull,
    id: store.globalId("pull", repo.name, String(pull.number)),
    number: pull.number,
    title: pull.title,
    state,
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: store.pullMergeable(repo, pull),
  };
}

function commentObject(repo: Repo, issue: Issue, comment: { id: number; body: string }): GqlObject {
  return {
    __typename: "IssueComment",
    id: store.globalId("comment", repo.name, `${issue.number}:${comment.id}`),
    body: comment.body,
  };
}

// Cursor: base64url of "cursor:<number>" (opaque, stable).
function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    if (!text.startsWith("cursor:")) return null;
    const n = parseInt(text.slice("cursor:".length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function issueConnection(repo: Repo, field: FieldNode, ctx: ExecContext): GqlObject {
  const first = (argValue(field, "first", ctx) as number | undefined) ?? undefined;
  const after = (argValue(field, "after", ctx) as string | undefined) ?? undefined;
  const states = (argValue(field, "states", ctx) as string[] | undefined) ?? undefined;
  const orderBy = (argValue(field, "orderBy", ctx) as Record<string, unknown> | undefined) ?? undefined;

  let issues = [...repo.issues.values()];
  if (states && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  const orderField = String(orderBy?.field ?? "CREATED_AT");
  const direction = String(orderBy?.direction ?? "ASC");
  const key = orderField === "UPDATED_AT" ? (i: Issue) => i.updatedSeq : (i: Issue) => i.createdSeq;
  issues.sort((a, b) => (direction === "DESC" ? key(b) - key(a) : key(a) - key(b)));

  let start = 0;
  if (after) {
    const cursorNum = decodeCursor(after);
    if (cursorNum !== null) {
      const idx = issues.findIndex((i) => i.number === cursorNum);
      if (idx >= 0) start = idx + 1;
    }
  }
  const page = first !== undefined ? issues.slice(start, start + first) : issues.slice(start);
  const hasNextPage = start + page.length < issues.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  return {
    __typename: "IssueConnection",
    nodes: page.map((i) => issueObject(repo, i)),
    totalCount: issues.length,
    pageInfo: {
      __typename: "PageInfo",
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? encodeCursor(page[0].number) : null,
      endCursor,
    },
  };
}

function pullConnection(repo: Repo, field: FieldNode, ctx: ExecContext): GqlObject {
  const first = (argValue(field, "first", ctx) as number | undefined) ?? undefined;
  let pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  if (first !== undefined) pulls = pulls.slice(0, first);
  return {
    __typename: "PullRequestConnection",
    nodes: pulls.map((p) => pullObject(repo, p)),
    totalCount: repo.pulls.size,
    pageInfo: {
      __typename: "PageInfo",
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    },
  };
}

function pullFilesConnection(repo: Repo, pull: Pull, field: FieldNode, ctx: ExecContext): GqlObject {
  const first = (argValue(field, "first", ctx) as number | undefined) ?? undefined;
  let files = store.pullFiles(repo, pull).map((f) => ({
    __typename: "PullRequestChangedFile",
    path: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    changeType: f.status === "added" ? "ADDED" : "MODIFIED",
  }));
  if (first !== undefined) files = files.slice(0, first);
  return {
    __typename: "PullRequestChangedFileConnection",
    nodes: files,
    totalCount: files.length,
  };
}

// --- schema metadata for __type introspection ---

const SCHEMA_TYPES: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Query: {
    kind: "OBJECT",
    fields: ["viewer", "repository", "node", "__type", "__schema"],
    enumValues: [],
  },
  Mutation: {
    kind: "OBJECT",
    fields: ["createIssue", "closeIssue", "createPullRequest", "mergePullRequest", "addComment"],
    enumValues: [],
  },
  Repository: {
    kind: "OBJECT",
    fields: ["id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest"],
    enumValues: [],
  },
  Issue: {
    kind: "OBJECT",
    fields: ["id", "number", "title", "state", "body", "repository", "comments", "author"],
    enumValues: [],
  },
  IssueConnection: {
    kind: "OBJECT",
    fields: ["nodes", "edges", "pageInfo", "totalCount"],
    enumValues: [],
  },
  IssueEdge: {
    kind: "OBJECT",
    fields: ["node", "cursor"],
    enumValues: [],
  },
  PageInfo: {
    kind: "OBJECT",
    fields: ["hasNextPage", "hasPreviousPage", "startCursor", "endCursor"],
    enumValues: [],
  },
  PullRequest: {
    kind: "OBJECT",
    fields: ["id", "number", "title", "body", "state", "merged", "headRefName", "baseRefName", "mergeable", "files", "repository", "author"],
    enumValues: [],
  },
  PullRequestConnection: {
    kind: "OBJECT",
    fields: ["nodes", "edges", "pageInfo", "totalCount"],
    enumValues: [],
  },
  PullRequestChangedFile: {
    kind: "OBJECT",
    fields: ["path", "additions", "deletions", "changeType"],
    enumValues: [],
  },
  PullRequestChangedFileConnection: {
    kind: "OBJECT",
    fields: ["nodes", "edges", "pageInfo", "totalCount"],
    enumValues: [],
  },
  User: {
    kind: "OBJECT",
    fields: ["login", "id", "name", "email"],
    enumValues: [],
  },
  IssueComment: {
    kind: "OBJECT",
    fields: ["id", "body", "author"],
    enumValues: [],
  },
  IssueState: { kind: "ENUM", fields: [], enumValues: ["OPEN", "CLOSED"] },
  MergeableState: { kind: "ENUM", fields: [], enumValues: ["MERGEABLE", "CONFLICTING", "UNKNOWN"] },
  PullRequestState: { kind: "ENUM", fields: [], enumValues: ["OPEN", "CLOSED", "MERGED"] },
  PullRequestMergeMethod: { kind: "ENUM", fields: [], enumValues: ["MERGE", "SQUASH", "REBASE"] },
  RepositoryPermission: { kind: "ENUM", fields: [], enumValues: ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"] },
  SearchType: { kind: "ENUM", fields: [], enumValues: ["ISSUE", "REPOSITORY", "USER", "DISCUSSION"] },
  IssueOrderField: { kind: "ENUM", fields: [], enumValues: ["CREATED_AT", "UPDATED_AT", "COMMENTS"] },
  OrderDirection: { kind: "ENUM", fields: [], enumValues: ["ASC", "DESC"] },
  Node: { kind: "INTERFACE", fields: ["id"], enumValues: [] },
  __Type: { kind: "OBJECT", fields: ["name", "kind", "fields", "enumValues"], enumValues: [] },
  __Field: { kind: "OBJECT", fields: ["name", "description", "args", "type"], enumValues: [] },
  __EnumValue: { kind: "OBJECT", fields: ["name", "description"], enumValues: [] },
  __Schema: { kind: "OBJECT", fields: ["types", "queryType", "mutationType"], enumValues: [] },
};

function typeObject(name: string): GqlObject | null {
  const meta = SCHEMA_TYPES[name];
  if (!meta) return null;
  return {
    __typename: "__Type",
    name,
    kind: meta.kind,
    _fields: meta.fields,
    _enumValues: meta.enumValues,
  };
}

// --- field resolution ---

function resolveField(obj: GqlObject, field: FieldNode, ctx: ExecContext): unknown {
  const typeName = obj.__typename;
  const name = field.name;

  // Introspection pseudo-fields on any type.
  if (name === "__typename") return typeName;

  switch (typeName) {
    case "Query": {
      if (name === "viewer") return userObject();
      if (name === "repository") {
        const owner = String(argValue(field, "owner", ctx) ?? "");
        const repoName = String(argValue(field, "name", ctx) ?? "");
        if (owner !== VIEWER.login) return null;
        const repo = store.getRepo(repoName);
        return repo ? repoObject(repo) : null;
      }
      if (name === "node") {
        const id = String(argValue(field, "id", ctx) ?? "");
        const decoded = store.decodeGlobalId(id);
        if (!decoded) return null;
        const repo = store.getRepo(decoded.repo);
        if (!repo) return null;
        if (decoded.kind === "repo") return repoObject(repo);
        if (decoded.kind === "issue") {
          const issue = repo.issues.get(parseInt(decoded.local, 10));
          return issue ? issueObject(repo, issue) : null;
        }
        if (decoded.kind === "pull") {
          const pull = repo.pulls.get(parseInt(decoded.local, 10));
          return pull ? pullObject(repo, pull) : null;
        }
        return null;
      }
      if (name === "__type") {
        const typeNameArg = String(argValue(field, "name", ctx) ?? "");
        return typeObject(typeNameArg);
      }
      if (name === "__schema") {
        return {
          __typename: "__Schema",
          _types: Object.keys(SCHEMA_TYPES),
          queryType: { __typename: "__Type", name: "Query", kind: "OBJECT", _fields: SCHEMA_TYPES.Query.fields, _enumValues: [] },
          mutationType: { __typename: "__Type", name: "Mutation", kind: "OBJECT", _fields: SCHEMA_TYPES.Mutation.fields, _enumValues: [] },
        };
      }
      break;
    }
    case "Mutation": {
      if (name === "createIssue") {
        const input = argValue(field, "input", ctx) as Record<string, unknown> | undefined;
        const repoId = String(inputField(input, "repositoryId") ?? "");
        const decoded = store.decodeGlobalId(repoId);
        const repo = decoded ? store.getRepo(decoded.repo) : undefined;
        if (!repo) return { __typename: "CreateIssuePayload", issue: null };
        const issue = store.createIssue(
          repo,
          String(inputField(input, "title") ?? ""),
          String(inputField(input, "body") ?? ""),
          [],
        );
        return { __typename: "CreateIssuePayload", issue: issueObject(repo, issue) };
      }
      if (name === "closeIssue") {
        const input = argValue(field, "input", ctx) as Record<string, unknown> | undefined;
        const issueId = String(inputField(input, "issueId") ?? "");
        const decoded = store.decodeGlobalId(issueId);
        const repo = decoded ? store.getRepo(decoded.repo) : undefined;
        const issue = repo ? repo.issues.get(parseInt(decoded.local, 10)) : undefined;
        if (!issue || !repo) return { __typename: "CloseIssuePayload", issue: null };
        issue.state = "closed";
        issue.updatedSeq = store.nextSeq();
        return { __typename: "CloseIssuePayload", issue: issueObject(repo, issue) };
      }
      if (name === "createPullRequest") {
        const input = argValue(field, "input", ctx) as Record<string, unknown> | undefined;
        const repoId = String(inputField(input, "repositoryId") ?? "");
        const decoded = store.decodeGlobalId(repoId);
        const repo = decoded ? store.getRepo(decoded.repo) : undefined;
        if (!repo) return { __typename: "CreatePullRequestPayload", pullRequest: null };
        const head = String(inputField(input, "headRefName") ?? "");
        const base = String(inputField(input, "baseRefName") ?? "");
        if (!store.branchTip(repo, head) || !store.branchTip(repo, base)) {
          return { __typename: "CreatePullRequestPayload", pullRequest: null };
        }
        const pull = store.createPull(repo, String(inputField(input, "title") ?? ""), "", head, base);
        return { __typename: "CreatePullRequestPayload", pullRequest: pullObject(repo, pull) };
      }
      if (name === "mergePullRequest") {
        const input = argValue(field, "input", ctx) as Record<string, unknown> | undefined;
        const prId = String(inputField(input, "pullRequestId") ?? "");
        const decoded = store.decodeGlobalId(prId);
        const repo = decoded ? store.getRepo(decoded.repo) : undefined;
        const pull = repo ? repo.pulls.get(parseInt(decoded.local, 10)) : undefined;
        if (!pull || !repo) return { __typename: "MergePullRequestPayload", pullRequest: null };
        const method = String(inputField(input, "mergeMethod") ?? "MERGE");
        if (!pull.merged) store.mergePull(repo, pull, method === "SQUASH" ? "squash" : "merge");
        return { __typename: "MergePullRequestPayload", pullRequest: pullObject(repo, pull) };
      }
      if (name === "addComment") {
        const input = argValue(field, "input", ctx) as Record<string, unknown> | undefined;
        const subjectId = String(inputField(input, "subjectId") ?? "");
        const decoded = store.decodeGlobalId(subjectId);
        const repo = decoded ? store.getRepo(decoded.repo) : undefined;
        const issue = repo ? repo.issues.get(parseInt(decoded.local, 10)) : undefined;
        if (!issue || !repo) return { __typename: "AddCommentPayload", commentEdge: null };
        const comment = store.addComment(repo, issue, String(inputField(input, "body") ?? ""));
        return {
          __typename: "AddCommentPayload",
          commentEdge: {
            __typename: "IssueCommentEdge",
            node: commentObject(repo, issue, comment),
            cursor: encodeCursor(issue.number),
          },
        };
      }
      break;
    }
    case "Repository": {
      const repo = obj._repo as Repo;
      if (name === "id" || name === "databaseId" || name === "name" || name === "nameWithOwner" || name === "viewerPermission" || name === "hasIssuesEnabled") {
        return obj[name];
      }
      if (name === "owner") return userObject();
      if (name === "defaultBranchRef") {
        const tip = store.headTip(repo);
        if (!tip) return null;
        return { __typename: "Ref", name: repo.defaultBranch, target: { __typename: "Commit", oid: tip } };
      }
      if (name === "issue") {
        const num = argValue(field, "number", ctx) as number | undefined;
        const issue = num !== undefined ? repo.issues.get(num) : undefined;
        return issue ? issueObject(repo, issue) : null;
      }
      if (name === "issues") return issueConnection(repo, field, ctx);
      if (name === "pullRequests") return pullConnection(repo, field, ctx);
      if (name === "pullRequest") {
        const num = argValue(field, "number", ctx) as number | undefined;
        const pull = num !== undefined ? repo.pulls.get(num) : undefined;
        return pull ? pullObject(repo, pull) : null;
      }
      break;
    }
    case "PullRequest": {
      if (name === "files") {
        const repo = obj._repo as Repo;
        const pull = obj._pull as Pull;
        return pullFilesConnection(repo, pull, field, ctx);
      }
      if (name in obj) return obj[name];
      break;
    }
    case "Issue":
    case "User":
    case "IssueComment":
    case "Ref":
    case "Commit": {
      if (name in obj) return obj[name];
      break;
    }
    case "IssueConnection":
    case "PullRequestConnection":
    case "PullRequestChangedFileConnection": {
      if (name === "nodes" || name === "totalCount") return obj[name];
      if (name === "pageInfo") return obj.pageInfo;
      if (name === "edges") {
        const nodes = (obj.nodes as GqlObject[]) ?? [];
        return nodes.map((n, i) => ({ __typename: "Edge", node: n, cursor: encodeCursor(i) }));
      }
      break;
    }
    case "PageInfo": {
      if (name in obj) return obj[name];
      break;
    }
    case "PullRequestChangedFile": {
      if (name in obj) return obj[name];
      break;
    }
    case "__Type": {
      if (name === "name" || name === "kind") return obj[name];
      if (name === "fields") {
        const fields = (obj._fields as string[]) ?? [];
        return fields.map((f) => ({ __typename: "__Field", name: f, description: null, args: [] }));
      }
      if (name === "enumValues") {
        const values = (obj._enumValues as string[]) ?? [];
        return values.map((v) => ({ __typename: "__EnumValue", name: v, description: null }));
      }
      break;
    }
    case "__Schema": {
      if (name === "queryType") return obj.queryType;
      if (name === "mutationType") return obj.mutationType;
      if (name === "types") {
        return (obj._types as string[]).map((t) => typeObject(t)).filter((t) => t !== null);
      }
      break;
    }
    case "__Field":
    case "__EnumValue": {
      if (name in obj) return obj[name];
      break;
    }
    case "CreateIssuePayload":
    case "CloseIssuePayload":
    case "CreatePullRequestPayload":
    case "MergePullRequestPayload":
    case "AddCommentPayload": {
      if (name in obj) return obj[name];
      break;
    }
    case "IssueCommentEdge": {
      if (name in obj) return obj[name];
      break;
    }
    case "Edge": {
      if (name in obj) return obj[name];
      break;
    }
  }

  ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
  return undefined; // unknown field -> null in the response, error recorded
}

function executeSelection(obj: GqlObject, selection: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === "fragment") {
      if (sel.typeCondition && sel.typeCondition !== obj.__typename) continue;
      Object.assign(out, executeSelection(obj, sel.selection, ctx));
      continue;
    }
    const key = sel.alias ?? sel.name;
    const value = resolveField(obj, sel, ctx);
    if (value === undefined) {
      out[key] = null;
      continue;
    }
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (sel.selection.length === 0) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item && typeof item === "object" && "__typename" in (item as Record<string, unknown>)
          ? executeSelection(item as GqlObject, sel.selection, ctx)
          : item,
      );
      continue;
    }
    if (typeof value === "object" && "__typename" in (value as Record<string, unknown>)) {
      out[key] = executeSelection(value as GqlObject, sel.selection, ctx);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function executeOperation(op: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: { message: string }[] } {
  const ctx: ExecContext = { variables, errors: [] };
  const root: GqlObject = { __typename: op.kind === "mutation" ? "Mutation" : "Query" };
  const data = executeSelection(root, op.selection, ctx);
  const result: { data: Record<string, unknown>; errors?: { message: string }[] } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// ---------------------------------------------------------------- HTTP

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

export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "POST") {
    sendJson(res, 405, { errors: [{ message: "Method not allowed" }] });
    return true;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    sendJson(res, 400, { errors: [{ message: "Request body must be JSON" }] });
    return true;
  }

  const runOne = (doc: unknown): unknown => {
    if (!doc || typeof doc !== "object") return { errors: [{ message: "Invalid GraphQL request" }] };
    const d = doc as Record<string, unknown>;
    const query = typeof d.query === "string" ? d.query : "";
    const variables = (d.variables && typeof d.variables === "object" ? (d.variables as Record<string, unknown>) : {}) as Record<string, unknown>;
    const operationName = typeof d.operationName === "string" ? d.operationName : null;
    let ops: Operation[];
    try {
      ops = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: (err as Error).message }] };
    }
    let op = ops[0];
    if (operationName) {
      op = ops.find((o) => o.name === operationName) ?? ops[0];
    }
    if (!op) return { errors: [{ message: "No operation" }] };
    return executeOperation(op, variables);
  };

  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((d) => runOne(d)));
    return true;
  }
  sendJson(res, 200, runOne(parsed));
  return true;
}
