// Loaded explicitly by managed Pi workers instead of unrestricted built-in file tools.
import { constants, lstatSync, realpathSync } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createEditToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_WRITE_DENIED } from "./worker.ts";

export default function workflowTools(pi: ExtensionAPI) {
  const root = process.cwd();
  const canonicalRoot = realpathSync(root);
  // The Pi SDK passes the already-normalized absolute path to each filesystem operation.
  const check = (path: string, kind: "file" | "directory" | "entry", writing = false) => {
    const deny = () => { throw new Error(writing ? PI_WRITE_DENIED : "Swarm permission denied: only regular task files and directories inside the assigned workspace are readable."); };
    const rel = relative(root, path);
    if (isAbsolute(rel) || (!rel && kind === "file")) deny();
    if (!rel) return canonicalRoot;
    const parts = rel.split(sep);
    let current = canonicalRoot;
    for (const [i, part] of parts.entries()) {
      if (part === ".." || part.toLowerCase() === ".git" || (process.platform === "win32" && /[:]|[. ]$/.test(part))) deny();
      current = join(current, part);
      const stat = lstatSync(current, { throwIfNoEntry: false });
      if (!stat) continue;
      const expected = i < parts.length - 1 ? "directory" : kind;
      if (!((expected !== "file" && stat.isDirectory()) || (expected !== "directory" && stat.isFile() && stat.nlink === 1)) || realpathSync(current) !== current) deny();
    }
    return current;
  };
  // Use distinct names so a failed extension load cannot expose a stock tool instead.
  pi.registerTool({ ...createReadToolDefinition(root, { operations: {
    access: async (path) => access(check(path, "file"), constants.R_OK),
    readFile: async (path) => readFile(check(path, "file")),
  } }), name: "task_read", description: "Read a text file in the assigned workspace. Use offset and limit to continue reading long files.", promptGuidelines: [] });
  pi.registerTool({ ...createLsToolDefinition(root, { operations: {
    exists: async (path) => { await access(check(path, "directory")); return true; },
    stat: (path) => lstatSync(check(path, "entry")),
    readdir: (path) => readdir(check(path, "directory")),
  } }), name: "task_ls" });
  if (process.env.PI_SWARM_WORKFLOW_WRITE !== "1") return;
  const checkedWrite = (path: string) => check(path, "file", true);
  const write = (path: string, content: string) => writeFile(checkedWrite(path), content, "utf8");
  pi.registerTool({ ...createEditToolDefinition(root, { operations: {
    access: async (path) => access(checkedWrite(path), constants.R_OK | constants.W_OK),
    readFile: async (path) => readFile(checkedWrite(path)),
    writeFile: async (path, content) => write(path, content),
  } }), name: "task_edit" });
  pi.registerTool({ ...createWriteToolDefinition(root, { operations: {
    mkdir: async (path) => { await mkdir(check(path, "directory", true), { recursive: true }); },
    writeFile: async (path, content) => write(path, content),
  } }), name: "task_write" });
}
