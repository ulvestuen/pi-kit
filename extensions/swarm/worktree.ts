// git worktree lifecycle for `workspace: "worktree"` workers: one branch + directory per worker so parallel editors
// never touch the same checkout. Removal refuses unmerged commits or uncommitted changes unless forced.

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type Git = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export const git: Git = (args, cwd) =>
  new Promise((done) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

async function ok(args: string[], cwd: string, run: Git = git): Promise<string> {
  const r = await run(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

export async function repoRoot(cwd: string, run: Git = git): Promise<string | null> {
  const r = await run(["rev-parse", "--show-toplevel"], cwd);
  return r.code === 0 ? resolve(r.stdout.trim()) : null;
}

/** The branch name to merge into (or "HEAD" when detached). */
export async function baseRef(root: string, run: Git = git): Promise<string> {
  const r = await run(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : "HEAD";
}

/** Keep `.swarm/` out of `git status` without editing the tracked .gitignore. */
export async function excludeDir(root: string, entry: string, run: Git = git): Promise<void> {
  let common = await ok(["rev-parse", "--git-common-dir"], root, run);
  if (!isAbsolute(common)) common = join(root, common);
  const file = join(common, "info", "exclude");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.split(/\r?\n/).includes(entry)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${entry}\n`);
}

export async function addWorktree(root: string, path: string, branch: string, base: string, run: Git = git): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await ok(["worktree", "add", "-b", branch, path, base], root, run);
}

export interface WorktreeStatus {
  path: string;
  branch: string;
  exists: boolean;
  dirty: string[];
  unmergedCommits: number;
  clean: boolean;
}

export async function worktreeStatus(root: string, path: string, branch: string, base: string, run: Git = git): Promise<WorktreeStatus> {
  const exists = existsSync(path);
  const dirty = exists ? (await ok(["status", "--porcelain"], path, run)).split("\n").filter(Boolean) : [];
  const branchExists = (await run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root)).code === 0;
  const unmergedCommits = branchExists ? Number(await ok(["rev-list", "--count", `${base}..${branch}`], root, run)) : 0;
  return { path, branch, exists, dirty, unmergedCommits, clean: dirty.length === 0 && unmergedCommits === 0 };
}

export function describeStatus(s: WorktreeStatus): string {
  const parts = [];
  if (s.unmergedCommits) parts.push(`${s.unmergedCommits} unmerged commit(s) on ${s.branch}`);
  if (s.dirty.length) parts.push(`${s.dirty.length} uncommitted change(s)`);
  return `${s.path}: ${parts.join(", ") || "clean and merged"}`;
}

/** Remove the worktree and its branch. Without force, refuses (returns status) when anything would be lost. */
export async function removeWorktree(root: string, path: string, branch: string, base: string, force = false, run: Git = git): Promise<{ removed: boolean; status: WorktreeStatus }> {
  const status = await worktreeStatus(root, path, branch, base, run);
  if (!status.clean && !force) return { removed: false, status };
  if (status.exists) await ok(["worktree", "remove", ...(force ? ["--force"] : []), path], root, run);
  else await run(["worktree", "prune"], root);
  const branchExists = (await run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root)).code === 0;
  if (branchExists) await ok(["branch", force ? "-D" : "-d", branch], root, run);
  return { removed: true, status };
}
