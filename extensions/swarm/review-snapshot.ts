import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { evidenceText, gitBytes, visibleIndexPaths } from "./worktree.ts";

/** Capture the requested source and hand both roles the same independent checkout copy. */
export async function reviewSnapshot(root: string, target: string, dest: string): Promise<string> {
  const run = async (...args: string[]) => {
    const result = await gitBytes(["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], root);
    if (result.code) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
    return evidenceText(result.stdout);
  };
  const commit = async (ref: string) => (await run("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`)).trim();
  const tree = join(dest, "tree");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  const diff = ["diff", "--no-ext-diff", "--no-textconv", "--binary"];
  const head = await commit("HEAD");
  let patch: string;
  let label: string;
  if (target === "working tree") {
    const capture = () => Promise.all([
      run(...diff, "--cached", head, "--"), run(...diff, "--"),
      run("ls-files", "-z", "--others", "--exclude-standard"),
      run("ls-files", "-v", "-z", "--cached"),
    ]);
    const changes = await capture();
    const [staged, unstaged, untracked, index] = changes;
    const tracked = visibleIndexPaths(index);
    if (!staged && !unstaged && !untracked) throw new Error("No working-tree changes. Choose HEAD, a commit, or a revision range to review committed work.");
    const source = realpathSync(root);
    const statFile = (path: string) => {
      const src = join(source, path);
      const stat = lstatSync(src, { bigint: true, throwIfNoEntry: false });
      if (stat && (!stat.isFile() || realpathSync(src) !== src)) throw new Error(`Cannot capture ${path}: working-tree snapshots only support regular files, not symlinks or submodules.`);
      return stat && `${stat.dev}:${stat.ino}:${stat.size}:${stat.mode}:${stat.mtimeNs}:${stat.ctimeNs}`;
    };
    const files = [...new Set([...tracked, ...untracked.split("\0").filter(Boolean)])].map((path) => ({ path, before: statFile(path) }));
    for (const { path, before } of files) {
      if (!before) continue; // Deleted from the working tree; represented in the patch.
      const dst = join(tree, path);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(join(source, path), dst);
    }
    const changed = () => new Error("The working tree changed during capture; try again when it is idle.");
    // Git only inventories untracked names. Compare contents after all copies, not one file at a time during copying.
    for (const { path, before } of files) {
      if (statFile(path) !== before) throw changed();
      if (!before) continue;
      const [live, saved] = await Promise.all([hashFile(join(source, path)), hashFile(join(tree, path))]);
      if (live !== saved) throw changed();
    }
    const after = await capture();
    if (after.some((value, i) => value !== changes[i]) || head !== await commit("HEAD") || files.some(({ path, before }) => statFile(path) !== before)) throw changed();
    patch = `Base: ${head}\n\nStaged changes:\n${staged}\nUnstaged changes:\n${unstaged}\nUntracked files in tree/:\n${untracked.split("\0").filter(Boolean).map((path) => JSON.stringify(path)).join("\n")}\n`;
    label = `Working tree captured over ${head}`;
  } else {
    const range = /^([^\s]+?)(\.{2,3})([^\s]+)$/.exec(target);
    const tip = await commit(range ? range[3] : target);
    let base = range ? await commit(range[1]) : (await run("rev-list", "--parents", "-n", "1", tip)).trim().split(" ")[1];
    if (base && range?.[2] === "...") base = (await run("merge-base", base, tip)).trim();
    patch = base ? await run(...diff, base, tip, "--") : await run("show", "--no-ext-diff", "--no-textconv", "--format=", "--binary", tip, "--");
    // Use blob bytes instead of git archive: export-ignore and export-subst must not change the reviewed tree.
    const blobs = (await run("ls-tree", "-rz", tip)).split("\0").filter(Boolean);
    for (const entry of blobs) {
      const tab = entry.indexOf("\t");
      const [mode, kind, oid] = entry.slice(0, tab).split(" ");
      const path = entry.slice(tab + 1);
      if (kind !== "blob" || mode === "120000") throw new Error(`Cannot capture ${path}: revision snapshots only support regular files.`);
      const dst = join(tree, path);
      mkdirSync(dirname(dst), { recursive: true });
      await gitBlob(root, oid, dst, mode === "100755" ? 0o755 : 0o644);
    }
    label = base ? `${base}..${tip}` : tip;
  }
  writeFileSync(join(dest, "review.patch"), patch);
  return label;
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function gitBlob(cwd: string, oid: string, path: string, mode: number) {
  return new Promise<void>((resolve, reject) => {
    execFile("git", ["cat-file", "blob", oid], { cwd, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(new Error(`Could not read Git blob ${oid}.`)); return; }
      try { writeFileSync(path, stdout, { mode }); resolve(); } catch (error) { reject(error); }
    });
  });
}
