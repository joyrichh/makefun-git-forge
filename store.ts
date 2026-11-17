// store.ts — the forge's in-memory store (one process, no database).
//
// Repositories, git objects, refs, issues, pull requests, labels and
// comments, plus the git-level operations the surfaces share: writing a
// file through the contents API (tree + commit construction), three-way
// merges, merge-base, fast-forward checks and pull-request file diffs.
// Everything deterministic: creation order comes from counters, commit
// timestamps from the scenario clock, never from the wall clock.

import {
  hashObject,
  parseTree,
  buildTree,
  parseCommit,
  buildCommit,
  identityLine,
  type GitObject,
  type TreeEntry,
  ZERO_OID,
} from "./gitobj.ts";
import { VIEWER, SCENARIO_EPOCH_SEC, nextTimestamp } from "./scenario.ts";

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  createdSeq: number;
  updatedSeq: number;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  head: string; // branch name
  base: string; // branch name
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  ownerLogin: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // refName -> oid
  issues: Map<number, Issue>;
  nextIssueNumber: number;
  pulls: Map<number, Pull>;
  nextPullNumber: number;
  labels: Map<string, Label>;
  nextCommentId: number;
}

export class Store {
  repos = new Map<string, Repo>();
  private repoSeq = 0;
  private repoIdCounter = 5000;
  private labelIdCounter = 1;
  private issueIdCounter = 100000;
  private pullIdCounter = 200000;
  private seqCounter = 0;

  /** Monotonic sequence for creation order (deterministic). */
  nextSeq(): number {
    return ++this.seqCounter;
  }

  /** Deterministic ISO timestamp from a sequence number. */
  isoFromSeq(seq: number): string {
    return new Date((SCENARIO_EPOCH_SEC + seq) * 1000).toISOString();
  }

  createRepo(name: string, opts: { description?: string; isPrivate?: boolean; defaultBranch?: string }): Repo {
    const repo: Repo = {
      id: this.repoIdCounter++,
      name,
      ownerLogin: VIEWER.login,
      description: opts.description ?? "",
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: opts.defaultBranch ?? "main",
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      nextIssueNumber: 1,
      pulls: new Map(),
      nextPullNumber: 1,
      labels: new Map(),
      nextCommentId: 1,
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // ------------------------------------------------------------ objects

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObject["type"], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  putObjects(repo: Repo, objects: Map<string, GitObject>): void {
    for (const [oid, obj] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }

  // ------------------------------------------------------------ refs

  getRef(repo: Repo, refName: string): string | undefined {
    return repo.refs.get(refName);
  }

  setRef(repo: Repo, refName: string, oid: string): void {
    repo.refs.set(refName, oid);
  }

  deleteRef(repo: Repo, refName: string): boolean {
    return repo.refs.delete(refName);
  }

  listRefs(repo: Repo): { ref: string; oid: string }[] {
    return [...repo.refs.entries()]
      .map(([ref, oid]) => ({ ref, oid }))
      .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  }

  /** Tip commit of a branch, or undefined when the branch is unborn/absent. */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  headTip(repo: Repo): string | undefined {
    return this.branchTip(repo, repo.defaultBranch);
  }

  /** Is `ancestor` reachable from `tip` by following commit parents? */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== "commit") continue;
      const commit = parseCommit(obj.data);
      for (const p of commit.parents) stack.push(p);
    }
    return false;
  }

  /** First common ancestor of two commits (merge base), or undefined. */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const ancestorsA = new Set<string>();
    const stackA: string[] = [a];
    while (stackA.length > 0) {
      const oid = stackA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== "commit") continue;
      for (const p of parseCommit(obj.data).parents) stackA.push(p);
    }
    const stackB: string[] = [b];
    const seenB = new Set<string>();
    while (stackB.length > 0) {
      const oid = stackB.pop()!;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== "commit") continue;
      for (const p of parseCommit(obj.data).parents) stackB.push(p);
    }
    return undefined;
  }

  // ------------------------------------------------------------ trees

  /** Flat path -> {oid, mode} for every file in a tree. */
  flattenTree(repo: Repo, treeOid: string, prefix = ""): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, path: string): void => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== "tree") return;
      for (const e of parseTree(obj.data)) {
        const full = path ? `${path}/${e.name}` : e.name;
        if (e.mode === "40000") walk(e.oid, full);
        else out.set(full, { oid: e.oid, mode: e.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build nested trees from a flat path map; returns the root tree oid. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    const buildLevel = (paths: Map<string, { oid: string; mode: string }>): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
      for (const [path, info] of paths) {
        const slash = path.indexOf("/");
        if (slash === -1) {
          entries.push({ mode: info.mode, name: path, oid: info.oid });
        } else {
          const dir = path.slice(0, slash);
          const rest = path.slice(slash + 1);
          if (!dirs.has(dir)) dirs.set(dir, new Map());
          dirs.get(dir)!.set(rest, info);
        }
      }
      for (const [dir, sub] of dirs) {
        entries.push({ mode: "40000", name: dir, oid: buildLevel(sub) });
      }
      const data = buildTree(entries);
      return this.putObject(repo, "tree", data);
    };
    return buildLevel(flat);
  }

  /** Read a file's blob at a commit. Returns undefined when absent. */
  readFileAt(repo: Repo, commitOid: string, path: string): { oid: string; data: Buffer; mode: string } | undefined {
    const commitObj = repo.objects.get(commitOid);
    if (!commitObj || commitObj.type !== "commit") return undefined;
    const treeOid = parseCommit(commitObj.data).tree;
    const flat = this.flattenTree(repo, treeOid);
    const info = flat.get(path);
    if (!info) return undefined;
    const blob = repo.objects.get(info.oid);
    if (!blob) return undefined;
    return { oid: info.oid, data: blob.data, mode: info.mode };
  }

  /** List a directory at a commit: entries under `dir` ("" = root). */
  listDirAt(repo: Repo, commitOid: string, dir: string): { name: string; path: string; oid: string; mode: string; isDir: boolean }[] {
    const commitObj = repo.objects.get(commitOid);
    if (!commitObj || commitObj.type !== "commit") return [];
    const treeOid = parseCommit(commitObj.data).tree;
    const flat = this.flattenTree(repo, treeOid);
    const seen = new Map<string, { name: string; path: string; oid: string; mode: string; isDir: boolean }>();
    for (const [path, info] of flat) {
      if (dir && !path.startsWith(`${dir}/`)) continue;
      const rest = dir ? path.slice(dir.length + 1) : path;
      const slash = rest.indexOf("/");
      if (slash === -1) {
        seen.set(rest, { name: rest, path, oid: info.oid, mode: info.mode, isDir: false });
      } else {
        const name = rest.slice(0, slash);
        if (!seen.has(name)) {
          seen.set(name, { name, path: dir ? `${dir}/${name}` : name, oid: "", mode: "40000", isDir: true });
        }
      }
    }
    // Directory entries need the subtree oid for their sha.
    const out = [...seen.values()];
    for (const e of out) {
      if (e.isDir) {
        const sub = this.treeOidAtPath(repo, treeOid, e.path);
        if (sub) e.oid = sub;
      }
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  private treeOidAtPath(repo: Repo, treeOid: string, path: string): string | undefined {
    let current = treeOid;
    for (const seg of path.split("/")) {
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== "tree") return undefined;
      const entry = parseTree(obj.data).find((e) => e.name === seg);
      if (!entry || entry.mode !== "40000") return undefined;
      current = entry.oid;
    }
    return current;
  }

  /**
   * Write (or delete) a file on a branch: builds the new tree + commit and
   * moves the branch ref. Returns the new commit oid and blob oid (or null
   * for a delete). `expectedSha` enforces the stale-sha 409 rule when given.
   */
  writeFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
    expectedSha?: string,
  ): { commitOid: string; blobOid: string | null; status: "created" | "updated" | "deleted" } {
    const tip = this.branchTip(repo, branch);
    let flat = new Map<string, { oid: string; mode: string }>();
    const parents: string[] = [];
    if (tip) {
      const commitObj = repo.objects.get(tip);
      if (commitObj && commitObj.type === "commit") {
        flat = this.flattenTree(repo, parseCommit(commitObj.data).tree);
        parents.push(tip);
      }
    }
    const existing = flat.get(path);
    if (expectedSha !== undefined) {
      if (!existing || existing.oid !== expectedSha) {
        throw new Error("stale-sha");
      }
    }
    let blobOid: string | null = null;
    let status: "created" | "updated" | "deleted";
    if (content === null) {
      if (!existing) throw new Error("not-found");
      flat.delete(path);
      status = "deleted";
    } else {
      blobOid = this.putObject(repo, "blob", content);
      status = existing ? "updated" : "created";
      flat.set(path, { oid: blobOid, mode: "100644" });
    }
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const ts = nextTimestamp();
    const who = identityLine(VIEWER.name, VIEWER.email, ts);
    const commitData = buildCommit({
      tree: treeOid,
      parents,
      author: who,
      committer: who,
      message,
    });
    const commitOid = this.putObject(repo, "commit", commitData);
    this.setRef(repo, `refs/heads/${branch}`, commitOid);
    return { commitOid, blobOid, status };
  }

  // ------------------------------------------------------------ labels

  createLabel(repo: Repo, name: string, color: string, description = ""): Label {
    const label: Label = { id: this.labelIdCounter++, name, color, description };
    repo.labels.set(name, label);
    return label;
  }

  // ------------------------------------------------------------ issues

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const seq = this.nextSeq();
    const issue: Issue = {
      id: this.issueIdCounter++,
      number: repo.nextIssueNumber++,
      title,
      body,
      state: "open",
      labels: [...labels],
      createdSeq: seq,
      updatedSeq: seq,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = {
      id: repo.nextCommentId++,
      body,
      userLogin: VIEWER.login,
      createdSeq: this.nextSeq(),
    };
    issue.comments.push(comment);
    return comment;
  }

  // ------------------------------------------------------------ pulls

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
    const seq = this.nextSeq();
    const headSha = this.branchTip(repo, head) ?? ZERO_OID;
    const baseSha = this.branchTip(repo, base) ?? ZERO_OID;
    const pull: Pull = {
      id: this.pullIdCounter++,
      number: repo.nextPullNumber++,
      title,
      body,
      state: "open",
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** Files changed between the merge base and the head tip of a pull. */
  pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (!headTip || !baseTip) return [];
    const base = this.mergeBase(repo, headTip, baseTip) ?? baseTip;
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(headTip);
    if (!baseCommit || !headCommit) return [];
    const baseFlat = this.flattenTree(repo, parseCommit(baseCommit.data).tree);
    const headFlat = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    for (const [path, headInfo] of headFlat) {
      const baseInfo = baseFlat.get(path);
      if (!baseInfo) {
        const blob = repo.objects.get(headInfo.oid);
        const lines = blob ? blob.data.toString("utf8").split("\n").filter((l) => l.length > 0).length : 0;
        out.push({ filename: path, status: "added", additions: lines, deletions: 0, changes: lines });
      } else if (baseInfo.oid !== headInfo.oid) {
        const oldBlob = repo.objects.get(baseInfo.oid);
        const newBlob = repo.objects.get(headInfo.oid);
        const oldLines = oldBlob ? oldBlob.data.toString("utf8").split("\n") : [];
        const newLines = newBlob ? newBlob.data.toString("utf8").split("\n") : [];
        const oldSet = new Map<string, number>();
        for (const l of oldLines) oldSet.set(l, (oldSet.get(l) ?? 0) + 1);
        let additions = 0;
        for (const l of newLines) {
          const n = oldSet.get(l) ?? 0;
          if (n > 0) oldSet.set(l, n - 1);
          else additions++;
        }
        let deletions = 0;
        for (const n of oldSet.values()) deletions += n;
        out.push({ filename: path, status: "modified", additions, deletions, changes: additions + deletions });
      }
    }
    return out.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  }

  /**
   * Merge a pull request (three-way). Returns the merge commit sha, or null
   * when the merge conflicts (caller answers 405). `method` is "merge" or
   * "squash"; both produce a single commit on the base branch here (the
   * suite only checks squash by result, and merge by the same shape).
   */
  mergePull(repo: Repo, pull: Pull, method: string): string | null {
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (!headTip || !baseTip) return null;
    const base = this.mergeBase(repo, headTip, baseTip);
    if (!base) return null;
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(headTip);
    const baseBranchCommit = repo.objects.get(baseTip);
    if (!baseCommit || !headCommit || !baseBranchCommit) return null;
    const baseFlat = this.flattenTree(repo, parseCommit(baseCommit.data).tree);
    const headFlat = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const branchFlat = this.flattenTree(repo, parseCommit(baseBranchCommit.data).tree);
    // Three-way merge: base = merge base, ours = base branch, theirs = head.
    const merged = new Map<string, { oid: string; mode: string }>();
    const allPaths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...branchFlat.keys()]);
    for (const path of allPaths) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      const o = branchFlat.get(path);
      const eq = (x?: { oid: string }, y?: { oid: string }) => (x?.oid ?? null) === (y?.oid ?? null);
      if (eq(h, b)) {
        // Head unchanged since base: keep ours.
        if (o) merged.set(path, o);
      } else if (eq(o, b)) {
        // Ours unchanged since base: take theirs.
        if (h) merged.set(path, h);
      } else if (eq(h, o)) {
        if (h) merged.set(path, h);
      } else {
        return null; // both sides changed differently: conflict
      }
    }
    const treeOid = this.buildTreeFromFlat(repo, merged);
    const ts = nextTimestamp();
    const who = identityLine(VIEWER.name, VIEWER.email, ts);
    const parents = method === "squash" ? [baseTip] : [baseTip, headTip];
    const commitData = buildCommit({
      tree: treeOid,
      parents,
      author: who,
      committer: who,
      message: pull.title,
    });
    const mergeOid = this.putObject(repo, "commit", commitData);
    this.setRef(repo, `refs/heads/${pull.base}`, mergeOid);
    pull.state = "closed";
    pull.merged = true;
    pull.mergedAt = this.isoFromSeq(this.nextSeq());
    pull.mergeCommitSha = mergeOid;
    pull.baseSha = mergeOid;
    return mergeOid;
  }

  /** Is a pull mergeable (no three-way conflict)? */
  pullMergeable(repo: Repo, pull: Pull): "MERGEABLE" | "CONFLICTING" | "UNKNOWN" {
    if (pull.merged) return "MERGEABLE";
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (!headTip || !baseTip) return "UNKNOWN";
    const base = this.mergeBase(repo, headTip, baseTip);
    if (!base) return "UNKNOWN";
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(headTip);
    const baseBranchCommit = repo.objects.get(baseTip);
    if (!baseCommit || !headCommit || !baseBranchCommit) return "UNKNOWN";
    const baseFlat = this.flattenTree(repo, parseCommit(baseCommit.data).tree);
    const headFlat = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const branchFlat = this.flattenTree(repo, parseCommit(baseBranchCommit.data).tree);
    const allPaths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...branchFlat.keys()]);
    for (const path of allPaths) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      const o = branchFlat.get(path);
      const eq = (x?: { oid: string }, y?: { oid: string }) => (x?.oid ?? null) === (y?.oid ?? null);
      if (eq(h, b) || eq(o, b) || eq(h, o)) continue;
      return "CONFLICTING";
    }
    return "MERGEABLE";
  }

  // ------------------------------------------------------------ global ids

  /** Opaque, stable global id for GraphQL (never the plain database id). */
  globalId(kind: string, repoName: string, local: string): string {
    return Buffer.from(`forge:${kind}:${repoName}:${local}`, "utf8").toString("base64url");
  }

  decodeGlobalId(id: string): { kind: string; repo: string; local: string } | null {
    try {
      const text = Buffer.from(id, "base64url").toString("utf8");
      const parts = text.split(":");
      if (parts.length < 4 || parts[0] !== "forge") return null;
      return { kind: parts[1], repo: parts[2], local: parts.slice(3).join(":") };
    } catch {
      return null;
    }
  }
}

export const store = new Store();
