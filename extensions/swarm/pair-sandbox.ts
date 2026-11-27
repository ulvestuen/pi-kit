import { constants, accessSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PiCommand } from "./driver.ts";
import { probe, type Harness } from "./worker.ts";

const HOME = "/home/swarm";
const WORKSPACE = "/workspace";
const BIN = "/opt/swarm/bin";
const SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/nix/store", "/etc/ssl/certs", "/etc/pki",
  "/etc/ca-certificates", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ld.so.cache"];

function executable(command: string, env: NodeJS.ProcessEnv) {
  const paths = command.includes("/") ? [command] : (env.PATH ?? "/usr/bin:/bin").split(":").map((dir) => resolve(dir, command));
  for (const path of paths) {
    try {
      const real = realpathSync(path);
      accessSync(real, constants.X_OK);
      if (lstatSync(real).isFile()) return real;
    } catch { /* try the next PATH entry */ }
  }
  return undefined;
}

function contains(dir: string, path: string) {
  const rel = relative(dir, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** The workspace is the only host mount the agent may write, apart from its disposable CLI home. */
function workspaceArgs(path: string, policy: "read" | "write", protectedPaths: string[]) {
  const root = realpathSync(path);
  if (protectedPaths.some((entry) => contains(root, entry)) || SYSTEM.some((entry) => existsSync(entry) && contains(realpathSync(entry), root))) {
    throw new Error("The task directory overlaps the host home, Swarm state, or a native runtime path.");
  }
  // Recursive binds also import submounts (which can alias host data). Only import an ordinary tree.
  const mounts = readFileSync("/proc/self/mountinfo", "utf8").split("\n").filter(Boolean).map((line) =>
    line.split(" ")[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8))));
  if (mounts.some((mount) => mount !== root && contains(root, mount))) throw new Error("The task directory contains a nested filesystem mount.");
  const args = [policy === "write" ? "--bind" : "--ro-bind", root, WORKSPACE];
  const dirs = [""];
  while (dirs.length) {
    const dir = dirs.pop()!;
    for (const name of readdirSync(join(root, dir))) {
      const entry = join(dir, name);
      const stat = lstatSync(join(root, entry));
      const dest = join(WORKSPACE, entry);
      if (name === ".git" || name === ".swarm") {
        if (stat.isDirectory()) args.push("--tmpfs", dest, "--remount-ro", dest);
        else if (stat.isFile()) args.push("--ro-bind", "/dev/null", dest);
        else throw new Error(`Cannot hide task metadata at ${JSON.stringify(entry)}.`);
      } else if (stat.isDirectory()) dirs.push(entry);
      else if (!(stat.isSymbolicLink() || (stat.isFile() && stat.nlink === 1))) {
        throw new Error(`The task contains a hard-linked or special file at ${JSON.stringify(entry)}.`);
      }
    }
  }
  return args;
}

export function pairSandbox({ cli, cwd, env, harness, policy, stateDir }: {
  cli: PiCommand; cwd: string; env: NodeJS.ProcessEnv; harness: Exclude<Harness, "pi">; policy: "read" | "write"; stateDir: string;
}) {
  let home: string | undefined;
  let wrap: ((args: string[], mounts: string[], privateHome?: string, command?: string) => PiCommand) | undefined;
  const hostHome = env.HOME ?? homedir();
  let protectedPaths: string[];
  const processEnv: NodeJS.ProcessEnv = { PATH: `${BIN}:/usr/local/bin:/usr/bin:/bin`, HOME, LANG: "C.UTF-8", TERM: "dumb", TMPDIR: "/tmp", PI_SWARM_NAME: env.PI_SWARM_NAME };
  const keys = harness === "claude" ? ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"]
    : harness === "codex" ? ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"] : [];
  for (const key of keys) if (env[key] !== undefined) processEnv[key] = env[key];

  const cleanup = () => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  };

  return {
    cwd: WORKSPACE,
    async preflight(args: string[]) {
      if (process.platform !== "linux") throw new Error("Native pair roles require Linux with Bubblewrap; no native CLI was launched.");
      const bwrap = executable(env.SWARM_BWRAP_BIN ?? "bwrap", env);
      if (!bwrap) throw new Error("Native pair roles require Bubblewrap (bwrap on PATH or SWARM_BWRAP_BIN).");
      const bin = executable(cli.command, env);
      if (!bin) return { ok: false, code: "ENOENT", output: "" };
      const script = cli.args[0];
      if (script && !existsSync(script)) return { ok: false, code: "ENOENT", output: "" };
      const system = SYSTEM.filter(existsSync);
      const runtime = system.flatMap((path) => ["--ro-bind", path, path]);
      const protectedSources = [hostHome, stateDir, bwrap, bin, ...system];
      const sandboxBin = join(BIN, basename(bin));
      const programs = ["--ro-bind", bin, sandboxBin];
      // The portable Codex distribution keeps its helper and Bubblewrap next to bin/.
      if (harness === "codex" && !script) {
        for (const source of [join(dirname(bin), "codex-code-mode-host"), join(dirname(bin), "../codex-resources/bwrap")]) {
          if (!existsSync(source)) continue;
          protectedSources.push(source);
          programs.push("--ro-bind", source, source.endsWith("/bwrap") ? "/opt/swarm/codex-resources/bwrap" : join(BIN, basename(source)));
        }
      }
      const sandboxScript = script && join(BIN, basename(script));
      if (script) {
        protectedSources.push(script);
        programs.push("--ro-bind", script, sandboxScript!);
      }
      protectedPaths = protectedSources.filter(existsSync).map((path) => realpathSync(path));
      const invoke = (args: string[], mounts: string[], privateHome?: string, command?: string) => ({ command: bwrap, args: [
        // Map the host user to a non-root identity so nested command sandboxes can map it without CAP_SETFCAP.
        "--unshare-all", "--share-net", "--unshare-user", "--uid", "1000", "--gid", "1000", "--cap-drop", "ALL", "--die-with-parent", ...runtime,
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", HOME,
        ...(privateHome ? ["--bind", privateHome, HOME] : []), ...mounts, ...programs,
        "--chdir", WORKSPACE, "--", command ?? sandboxBin, ...(!command && sandboxScript ? [sandboxScript] : []), ...args,
      ] });
      // Check real mounts before invoking even --help on the native CLI. Use disposable data, never the checkout.
      const test = mkdtempSync(join(stateDir, "sandbox-check-"));
      try {
        writeFileSync(join(test, "marker"), "sandbox\n");
        const result = await probe(invoke(["-c", `test ! -e "$1" && test -w "$HOME" && test "$(cat ./marker)" = sandbox && ${policy === "write" ? ": > ./ok" : "! ( : > ./ok )"} && printf checked`, "probe", stateDir],
          [policy === "write" ? "--bind" : "--ro-bind", test, WORKSPACE], undefined, "/bin/sh"), [], "/", { PATH: processEnv.PATH, HOME });
        if (!result.ok || !result.output.startsWith("checked\n") || existsSync(join(test, "ok")) !== (policy === "write")) throw new Error("Bubblewrap did not enforce the pair filesystem policy. Check Linux user namespace support and the bwrap installation.");
      } finally { rmSync(test, { recursive: true, force: true }); }
      if (existsSync(cwd)) workspaceArgs(cwd, policy, protectedPaths);
      wrap = invoke;
      return probe(invoke(args, ["--dir", WORKSPACE]), [], "/", { PATH: processEnv.PATH, HOME, LANG: processEnv.LANG, TERM: processEnv.TERM });
    },
    launch(args: string[]) {
      if (!wrap) throw new Error("The native pair filesystem sandbox was not checked.");
      const mounts = workspaceArgs(cwd, policy, protectedPaths);
      if (!home) {
        home = mkdtempSync(join(stateDir, `native-${harness}-`));
        const credential = harness === "claude" ? [env.CLAUDE_CONFIG_DIR ?? join(hostHome, ".claude"), ".credentials.json", ".claude"]
          : harness === "codex" ? [env.CODEX_HOME ?? join(hostHome, ".codex"), "auth.json", ".codex"]
          : [join(hostHome, ".gemini/antigravity-cli"), "antigravity-oauth-token", ".gemini/antigravity-cli"];
        const source = join(credential[0], credential[1]);
        if (existsSync(source) && lstatSync(source).isFile()) {
          mkdirSync(join(home, credential[2]), { recursive: true, mode: 0o700 });
          copyFileSync(source, join(home, credential[2], credential[1]));
        }
      }
      return { cli: wrap(args, mounts, home), cwd: "/", env: processEnv };
    },
    cleanup,
  };
}

export type PairSandbox = ReturnType<typeof pairSandbox>;
