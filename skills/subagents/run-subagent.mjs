#!/usr/bin/env node
// Run one pi sub-agent as a child process and print its final answer.
// No dependencies (Node 18+).
//
// Usage:
//   node run-subagent.mjs --role <name> "task text..."
//   node run-subagent.mjs --system-prompt "You are ..." --tools read,grep "task text..."
//
// Roles are markdown files in ./roles/<name>.md with YAML frontmatter
// (name, description, tools); the body becomes the child's system prompt.
//
// Options:
//   --role <name>           Role file to load from ./roles/
//   --system-prompt <text>  Ad-hoc system prompt (instead of --role)
//   --tools <a,b,c>         Override the role's tool list
//   --model <model>         Model for the child (default: pi's default)
//   --cwd <dir>             Working directory for the child (default: current)
//   --timeout <seconds>     Kill the child after this long (default 600)
//   --inherit               Let the child load extensions and skills
//                           (default: isolated with --no-extensions --no-skills)

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rolesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "roles");

const args = process.argv.slice(2);
const opts = { timeout: 600, inherit: false };
const positional = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  switch (a) {
    case "--role": opts.role = args[++i]; break;
    case "--system-prompt": opts.systemPrompt = args[++i]; break;
    case "--tools": opts.tools = args[++i]; break;
    case "--model": opts.model = args[++i]; break;
    case "--cwd": opts.cwd = args[++i]; break;
    case "--timeout": opts.timeout = Number(args[++i]); break;
    case "--inherit": opts.inherit = true; break;
    default: positional.push(a);
  }
}

const task = positional.join(" ").trim();
if (!task) fail('usage: node run-subagent.mjs --role scout "question or task"');
if (!opts.role && !opts.systemPrompt) fail("pass --role <name> or --system-prompt <text>");

let systemPrompt = opts.systemPrompt;
let tools = opts.tools;
if (opts.role) {
  let raw;
  try {
    raw = readFileSync(path.join(rolesDir, `${opts.role}.md`), "utf8");
  } catch {
    fail(`unknown role "${opts.role}" — expected ${rolesDir}/${opts.role}.md`);
  }
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (match) {
    const toolsLine = match[1].match(/^tools:\s*(.+)$/m);
    if (toolsLine && !tools) tools = toolsLine[1].split(",").map((t) => t.trim()).filter(Boolean).join(",");
    raw = raw.slice(match[0].length);
  }
  systemPrompt = raw.trim();
}

// The child-process contract with pi's non-interactive mode: --mode json is
// single-shot print mode with a JSONL event stream, --no-session keeps the
// child out of the session directory.
const piArgs = ["--mode", "json", "--no-session"];
if (!opts.inherit) piArgs.push("--no-extensions", "--no-skills");
piArgs.push("--system-prompt", systemPrompt);
if (opts.model) piArgs.push("--model", opts.model);
if (tools) piArgs.push("--tools", tools);
piArgs.push(task);

const child = spawn(process.env.PI_BINARY || "pi", piArgs, {
  cwd: opts.cwd || process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, opts.timeout * 1000);

child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));

child.on("close", (exitCode) => {
  clearTimeout(timer);
  if (timedOut) fail(`sub-agent timed out after ${opts.timeout}s`);

  // The last assistant message_end event in the JSONL stream is the answer.
  let lastAssistant = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event?.type === "message_end" && event.message?.role === "assistant") {
        lastAssistant = event.message;
      }
    } catch {}
  }

  if (exitCode !== 0 || !lastAssistant) {
    fail(`sub-agent failed (exit ${exitCode}): ${stderr.trim() || "no assistant message in output"}`);
  }
  if (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
    fail(`sub-agent ${lastAssistant.stopReason}: ${lastAssistant.errorMessage || ""}`.trim());
  }

  const text = (lastAssistant.content ?? [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text)
    .join("\n");
  console.log(text);
});

child.on("error", (e) => {
  clearTimeout(timer);
  fail(`failed to spawn pi: ${e.message}`);
});

function fail(message) {
  console.error(message);
  process.exit(1);
}
