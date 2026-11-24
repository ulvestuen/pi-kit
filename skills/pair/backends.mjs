// Worker CLI backends for pair, pair-review, and pair-work:
// dispatches model specs by provider prefix across Pi (default), Antigravity (`agy/*`),
// Claude Code (`claude/*`), and Codex (`codex/*`).
// Zero dependencies; Node.js 22+.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export const EXTERNAL_BACKENDS = ["agy", "claude", "codex"];
const EXTERNAL_SET = new Set(EXTERNAL_BACKENDS);

export const BACKEND_BIN_ENV = {
  agy: "PAIR_AGY_BIN",
  claude: "PAIR_CLAUDE_BIN",
  codex: "PAIR_CODEX_BIN",
};

export const AGY_EFFORTS = ["low", "medium", "high", "xhigh"];
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"];

export const CLAUDE_MODELS = [
  { id: "opus", name: "Claude Opus (latest)", levels: CLAUDE_EFFORTS },
  { id: "sonnet", name: "Claude Sonnet (latest)", levels: CLAUDE_EFFORTS },
  { id: "haiku", name: "Claude Haiku (latest)", levels: CLAUDE_EFFORTS },
  { id: "fable", name: "Claude Fable (latest)", levels: CLAUDE_EFFORTS },
];

export const CODEX_MODELS = [
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", levels: CODEX_EFFORTS },
  { id: "gpt-5.4", name: "GPT-5.4", levels: CODEX_EFFORTS },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", levels: CODEX_EFFORTS },
];

export const BACKEND_DEFAULT_LEVELS = {
  agy: AGY_EFFORTS,
  claude: CLAUDE_EFFORTS,
  codex: CODEX_EFFORTS,
};

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const BATCH_FILE = /\.(?:cmd|bat)$/i;
const NODE_SCRIPT = /\.(?:c?js|mjs|mts)$/i;
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

const pathOf = (platform = process.platform) => (platform === "win32" ? win32 : posix);
const absoluteFrom = (value, cwd, platform = process.platform) =>
  pathOf(platform).isAbsolute(value) ? value : pathOf(platform).resolve(cwd, value);

function envGet(env, name, { platform = process.platform } = {}) {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  if (platform !== "win32") return undefined;
  const wanted = String(name).toUpperCase();
  for (const key of Object.keys(env)) if (key.toUpperCase() === wanted) return env[key];
  return undefined;
}

function executableNames(name, { platform = process.platform, pathext } = {}) {
  if (platform !== "win32" || /\.[^\\/]+$/.test(name)) return [name];
  const exts = String(pathext || DEFAULT_PATHEXT)
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));
  const names = [];
  for (const ext of exts) for (const variant of [ext.toLowerCase(), ext.toUpperCase()]) names.push(name + variant);
  return [...new Set(names)];
}

function onPathFrom(name, path = "", cwd = process.cwd(), exists = existsSync, { platform = process.platform, pathext } = {}) {
  const p = pathOf(platform);
  const names = executableNames(name, { platform, pathext });
  for (const dir of String(path).split(p.delimiter).filter(Boolean)) {
    for (const candidate of names) {
      const file = p.join(absoluteFrom(dir, cwd, platform), candidate);
      if (exists(file)) return file;
    }
  }
  return null;
}

const DP0 = /%~?dp0%?/i;
function shimParts(shim, { exists = existsSync, readFile = readFileSync, platform = process.platform } = {}) {
  if (platform !== "win32" || !BATCH_FILE.test(String(shim)) || !exists(shim)) return null;
  let text;
  try {
    text = String(readFile(shim, "utf8"));
  } catch {
    return null;
  }
  const folder = win32.dirname(shim);
  const resolveQuoted = (quoted) => win32.normalize(quoted.replace(DP0, () => `${folder}\\`));
  let entry = null;
  let node = null;
  for (const match of text.matchAll(/"([^"\r\n]+)"/g)) {
    const quoted = match[1];
    if (!DP0.test(quoted)) continue;
    const absolute = resolveQuoted(quoted);
    if (!exists(absolute) || absolute === shim) continue;
    if (!entry && NODE_SCRIPT.test(absolute)) entry = absolute;
    else if (!node && /(?:^|[\\/])node(?:\.exe)?$/i.test(absolute)) node = absolute;
  }
  return entry ? { entry, node } : null;
}

/** Which worker backend owns this `provider/id[:thinking]` spec: `"agy"`, `"claude"`, `"codex"`, or `"pi"`. */
export function backendOf(spec) {
  const text = String(spec ?? "").trim();
  const slash = text.indexOf("/");
  if (slash <= 0) return "pi";
  const prefix = text.slice(0, slash).toLowerCase();
  return EXTERNAL_SET.has(prefix) ? prefix : "pi";
}

export function isExternalBackend(spec) {
  return backendOf(spec) !== "pi";
}

/**
 * Resolve an external CLI binary (`agy`, `claude`, `codex`) in the caller's environment.
 * Returns `{ bin, entry, node, command }` or `null` when not installed.
 */
export function resolveBackendBin(
  backend,
  { env = process.env, cwd = process.cwd(), execPath = process.execPath, exists = existsSync, readFile = readFileSync, platform = process.platform, pathext } = {},
) {
  const envVar = BACKEND_BIN_ENV[backend];
  if (!envVar) return null;
  const extensions = pathext ?? envGet(env, "PATHEXT", { platform });
  const given = envGet(env, envVar, { platform });
  const name = given || backend;
  let bin = null;
  if (/[\\/]/.test(name)) {
    const file = absoluteFrom(name, cwd, platform);
    if (exists(file)) bin = file;
  } else {
    bin = onPathFrom(name, envGet(env, "PATH", { platform }), cwd, exists, { platform, pathext: extensions });
  }
  if (!bin) return null;

  const shim = platform === "win32" && BATCH_FILE.test(bin) ? shimParts(bin, { exists, readFile, platform }) : null;
  const entry = shim ? shim.entry : NODE_SCRIPT.test(bin) ? bin : null;
  const node = shim?.node ?? (entry ? execPath : null);
  if (platform === "win32" && BATCH_FILE.test(bin) && !(entry && node)) return null;
  const command = entry && node ? [node, entry] : [bin];
  return { backend, bin, entry, node, command };
}

/**
 * Parse `agy models` output (stripping carriage-return spinner frames and ANSI codes)
 * into clean base models with per-model supported effort levels and concrete IDs.
 */
export function parseAgyModels(raw) {
  const rawModels = [];
  for (const rawLine of String(raw ?? "").split("\n")) {
    const cleaned = rawLine.split("\r").pop().replace(ANSI_RE, "").trim();
    if (!cleaned || cleaned.startsWith("Fetching available models")) continue;
    const match = /^(\S+)\s+(.+)$/.exec(cleaned);
    if (!match) continue;
    rawModels.push({ id: match[1], name: match[2].trim() });
  }

  const grouped = new Map();
  const concreteIds = new Set();
  for (const entry of rawModels) {
    concreteIds.add(entry.id);
    const suffix = /^(.*)-(low|medium|high|xhigh)$/.exec(entry.id);
    const baseId = suffix ? suffix[1] : entry.id;
    const level = suffix ? suffix[2] : null;
    // Keep single-tier IDs like `gpt-oss-120b-medium` as their own entry if no other tiers exist;
    // we normalize after scanning all rows.
    let bucket = grouped.get(baseId);
    if (!bucket) {
      const cleanName = entry.name.replace(/\s*\((Low|Medium|High|XHigh|Extra)\)\s*$/i, "").trim() || baseId;
      bucket = { baseId, name: cleanName, levels: new Set(), rawIds: [] };
      grouped.set(baseId, bucket);
    }
    if (level) bucket.levels.add(level);
    bucket.rawIds.push(entry.id);
  }

  const baseModels = [];
  for (const bucket of grouped.values()) {
    // If a model only appeared once with a baked-in tier (e.g. `gpt-oss-120b-medium`), keep its exact id
    // so `--model gpt-oss-120b-medium` always matches what `agy` advertises.
    const singleBaked = bucket.rawIds.length === 1 && bucket.levels.size === 1;
    const id = singleBaked ? bucket.rawIds[0] : bucket.baseId;
    const levels =
      bucket.levels.size > 0
        ? AGY_EFFORTS.filter((lvl) => bucket.levels.has(lvl))
        : ["low", "medium", "high"];
    baseModels.push({ id, baseId: bucket.baseId, name: bucket.name, levels });
  }
  return { baseModels, concreteIds, rawModels };
}

/** Read only the top-level `model = "..."` setting from Codex's `config.toml`, never secrets. */
export function readCodexConfiguredModel({ env = process.env, exists = existsSync, readFile = readFileSync, platform = process.platform } = {}) {
  const p = pathOf(platform);
  const home = envGet(env, "CODEX_HOME", { platform }) || p.join(envGet(env, "HOME", { platform }) || envGet(env, "USERPROFILE", { platform }) || homedir(), ".codex");
  const configPath = p.join(home, "config.toml");
  if (!exists(configPath)) return null;
  try {
    const text = String(readFile(configPath, "utf8"));
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) break; // Stop at first TOML table header.
      const match = /^model\s*=\s*["']([^"']+)["']/.exec(trimmed);
      if (match) return match[1].trim();
    }
  } catch {
    return null;
  }
  return null;
}

function parseJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Interactive CLI launch arguments for a worker pane.
 * Uses unrestricted auto-approve flags so pair workers run unattended without blocking on tool prompts,
 * and passes `--add-dir <runDir>` so every worker can read `.turn.md` and write `.report.md`.
 */
export function backendLaunchArgs(backend, { spec, id, thinking, prompt, runDir }) {
  if (backend === "pi") {
    return ["--model", spec, prompt];
  }
  if (backend === "agy") {
    const args = ["--model", id];
    if (thinking && AGY_EFFORTS.includes(thinking)) args.push("--effort", thinking);
    args.push("--dangerously-skip-permissions");
    if (runDir) args.push("--add-dir", runDir);
    args.push("--prompt-interactive", prompt);
    return args;
  }
  if (backend === "claude") {
    const args = ["--model", id];
    if (thinking && CLAUDE_EFFORTS.includes(thinking)) args.push("--effort", thinking);
    args.push("--dangerously-skip-permissions");
    if (runDir) args.push("--add-dir", runDir);
    args.push("--", prompt);
    return args;
  }
  if (backend === "codex") {
    const args = ["-m", id];
    if (thinking && CODEX_EFFORTS.includes(thinking)) {
      args.push("-c", `model_reasoning_effort="${thinking}"`);
    }
    args.push("--dangerously-bypass-approvals-and-sandbox", "--no-alt-screen");
    if (runDir) args.push("--add-dir", runDir);
    args.push("--", prompt);
    return args;
  }
  throw new Error(`Unsupported worker backend: ${backend}`);
}

const errorText = (error) => String(error?.stderr || error?.message || error || "").trim().split(/\r?\n/)[0] || "failed";

/**
 * Readiness checker and model catalog for external CLI backends (`agy`, `claude`, `codex`).
 * Probed lazily per backend and cached for the lifetime of the checker.
 */
export function createExternalChecker({ env = process.env, cwd = process.cwd(), callerCwd = cwd, exec, exists = existsSync, readFile = readFileSync, platform = process.platform, pathext, timeout = 15_000 }) {
  const backendState = new Map();

  const inspectBackend = async (backend) => {
    if (backendState.has(backend)) return backendState.get(backend);
    const resolved = resolveBackendBin(backend, { env, cwd: callerCwd, exists, readFile, platform, pathext });
    if (!resolved) {
      const envVar = BACKEND_BIN_ENV[backend];
      const state = {
        backend,
        installed: false,
        loggedIn: false,
        detail: `${backend} CLI not found on PATH (install ${backend} or set ${envVar})`,
        models: [],
        concreteIds: new Set(),
      };
      backendState.set(backend, state);
      return state;
    }

    const [cmd, ...prefix] = resolved.command;
    const runCmd = (args) => exec(cmd, [...prefix, ...args], { cwd, env, timeout, platform });

    let state;
    if (backend === "agy") {
      try {
        const out = await runCmd(["models"]);
        const { baseModels, concreteIds } = parseAgyModels(out);
        state = {
          backend,
          installed: true,
          loggedIn: baseModels.length > 0,
          bin: resolved.bin,
          detail: baseModels.length > 0 ? "ready (agy CLI)" : "agy models returned no models (run `agy` to sign in)",
          models: baseModels.map((m) => ({ spec: `agy/${m.id}`, id: m.id, baseId: m.baseId, name: m.name, levels: m.levels })),
          concreteIds,
        };
      } catch (err) {
        state = {
          backend,
          installed: true,
          loggedIn: false,
          bin: resolved.bin,
          detail: `agy not ready (${errorText(err)}; run \`agy\` or \`agy acp --login\`)`,
          models: [],
          concreteIds: new Set(),
        };
      }
    } else if (backend === "claude") {
      try {
        const out = await runCmd(["auth", "status"]);
        const parsed = parseJsonObject(out);
        const ok = Boolean(parsed?.loggedIn);
        const plan = parsed?.subscriptionType || parsed?.planTier || parsed?.authMethod;
        state = {
          backend,
          installed: true,
          loggedIn: ok,
          bin: resolved.bin,
          detail: ok ? `ready (claude ${plan ?? "logged in"})` : "claude is not logged in (run `claude auth login`)",
          models: ok ? CLAUDE_MODELS.map((m) => ({ spec: `claude/${m.id}`, id: m.id, name: m.name, levels: m.levels })) : [],
          concreteIds: new Set(CLAUDE_MODELS.map((m) => m.id)),
        };
      } catch (err) {
        const parsed = parseJsonObject(err?.stdout);
        const detail = parsed?.loggedIn === false
          ? "claude is not logged in (run `claude auth login`)"
          : `claude auth status failed (${errorText(err)})`;
        state = {
          backend,
          installed: true,
          loggedIn: false,
          bin: resolved.bin,
          detail,
          models: [],
          concreteIds: new Set(),
        };
      }
    } else if (backend === "codex") {
      try {
        const out = await runCmd(["login", "status"]);
        const text = String(out ?? "").trim();
        // `codex login status` writes "Logged in ..." to stderr on macOS/Linux and exits 0 when logged in.
        const ok = !/not logged in/i.test(text);
        const configured = readCodexConfiguredModel({ env, exists, readFile, platform });
        const list = [];
        const seen = new Set();
        const add = (id, name) => {
          if (!id || seen.has(id)) return;
          seen.add(id);
          list.push({ spec: `codex/${id}`, id, name: name || id, levels: CODEX_EFFORTS });
        };
        if (configured) add(configured, `${configured} (configured)`);
        for (const m of CODEX_MODELS) add(m.id, m.name);
        const summary = /logged in/i.test(text) ? text.split(/\r?\n/)[0] : "logged in";
        state = {
          backend,
          installed: true,
          loggedIn: ok,
          bin: resolved.bin,
          detail: ok ? `ready (codex: ${summary})` : "codex is not logged in (run `codex login`)",
          models: ok ? list : [],
          concreteIds: seen,
        };
      } catch (err) {
        state = {
          backend,
          installed: true,
          loggedIn: false,
          bin: resolved.bin,
          detail: `codex is not logged in (${errorText(err)}; run \`codex login\`)`,
          models: [],
          concreteIds: new Set(),
        };
      }
    } else {
      state = { backend, installed: false, loggedIn: false, detail: `unknown backend ${backend}`, models: [], concreteIds: new Set() };
    }

    backendState.set(backend, state);
    return state;
  };

  /** Check one external model spec (`{ spec, model, provider, id, thinking }`). */
  const check = async (parts) => {
    const backend = parts.provider?.toLowerCase();
    const status = { spec: parts.spec, model: parts.model, thinking: parts.thinking };
    const state = await inspectBackend(backend);
    if (!state.installed || !state.loggedIn) {
      return { ...status, ready: false, verified: false, detail: state.detail };
    }

    if (backend === "agy") {
      const baseMatch = state.models.find((m) => m.id === parts.id || m.baseId === parts.id);
      const concreteMatch = state.concreteIds.has(parts.id);
      if (!baseMatch && !concreteMatch) {
        return { ...status, ready: false, verified: false, detail: `agy does not offer ${parts.id}` };
      }
      if (parts.thinking && !AGY_EFFORTS.includes(parts.thinking)) {
        return { ...status, ready: false, verified: false, detail: `agy does not support effort "${parts.thinking}" (use low, medium, high, xhigh)` };
      }
      if (baseMatch && parts.thinking && !baseMatch.levels.includes(parts.thinking)) {
        return { ...status, ready: false, verified: false, detail: `agy/${parts.id} supports efforts: ${baseMatch.levels.join(", ")}` };
      }
      return { ...status, ready: true, verified: true, detail: state.detail };
    }

    if (backend === "claude") {
      if (parts.thinking && !CLAUDE_EFFORTS.includes(parts.thinking)) {
        return { ...status, ready: false, verified: false, detail: `claude does not support effort "${parts.thinking}" (use low, medium, high, xhigh, max)` };
      }
      return { ...status, ready: true, verified: true, detail: state.detail };
    }

    if (backend === "codex") {
      if (parts.thinking && !CODEX_EFFORTS.includes(parts.thinking)) {
        return { ...status, ready: false, verified: false, detail: `codex does not support effort "${parts.thinking}" (use low, medium, high, xhigh)` };
      }
      return { ...status, ready: true, verified: true, detail: state.detail };
    }

    return { ...status, ready: false, verified: false, detail: `unknown backend ${backend}` };
  };

  /** Discover all ready models across installed external CLI backends (`agy`, `claude`, `codex`). */
  const discoverAll = async () => {
    const results = await Promise.all(EXTERNAL_BACKENDS.map((b) => inspectBackend(b)));
    return results.flatMap((state) => (state.installed && state.loggedIn ? state.models : []));
  };

  return { inspectBackend, check, discoverAll };
}
