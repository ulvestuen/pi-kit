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
//   --stream                Stream live activity to stderr while keeping the
//                           final answer as the only stdout output

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
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
    case "--stream": opts.stream = true; break;
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

let stderr = "";
let lastAssistant = null;
let timedOut = false;
let stdoutEnded = false;
let stderrEnded = false;
let stdoutBuffer = "";
const stdoutDecoder = new StringDecoder("utf8");
const stderrDecoder = new StringDecoder("utf8");
const live = createLiveRenderer(opts.stream ? process.stderr : null);

const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, opts.timeout * 1000);

function processJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return;
  try {
    const event = JSON.parse(trimmed);
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      lastAssistant = event.message;
    }
    live.render(event);
  } catch {}
}

function finishStdout() {
  if (stdoutEnded) return;
  stdoutEnded = true;
  stdoutBuffer += stdoutDecoder.end();
  if (stdoutBuffer.trim()) processJsonLine(stdoutBuffer);
  stdoutBuffer = "";
}

function finishStderr() {
  if (stderrEnded) return;
  stderrEnded = true;
  stderr += stderrDecoder.end();
}

child.stdout.on("data", (chunk) => {
  stdoutBuffer += stdoutDecoder.write(chunk);
  while (true) {
    const newlineIndex = stdoutBuffer.indexOf("\n");
    if (newlineIndex === -1) break;
    let line = stdoutBuffer.slice(0, newlineIndex);
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    processJsonLine(line);
  }
});
child.stdout.on("end", finishStdout);
child.stderr.on("data", (chunk) => {
  stderr += stderrDecoder.write(chunk);
  if (opts.stream) process.stderr.write(chunk);
});
child.stderr.on("end", finishStderr);

child.on("close", (exitCode) => {
  clearTimeout(timer);
  finishStdout();
  finishStderr();
  live.finish();

  if (timedOut) fail(`sub-agent timed out after ${opts.timeout}s`);
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

function createLiveRenderer(output) {
  let openSection = null;
  const partialToolOutput = new Map();

  const write = (text) => {
    if (output) output.write(text);
  };
  const closeSection = () => {
    if (!openSection) return;
    write("\n");
    openSection = null;
  };
  const open = (section) => {
    if (!output || openSection === section) return;
    closeSection();
    write(`[sub-agent:${section}] `);
    openSection = section;
  };

  return {
    render(event) {
      if (!output) return;

      if (event?.type === "agent_start") {
        closeSection();
        write("[sub-agent] started\n");
        return;
      }

      if (event?.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update?.type === "thinking_start") open("thinking");
        else if (update?.type === "thinking_delta") {
          open("thinking");
          write(update.delta ?? "");
        } else if (update?.type === "thinking_end") closeSection();
        else if (update?.type === "text_start") open("assistant");
        else if (update?.type === "text_delta") {
          open("assistant");
          write(update.delta ?? "");
        } else if (update?.type === "text_end") closeSection();
        return;
      }

      if (event?.type === "tool_execution_start") {
        closeSection();
        partialToolOutput.set(event.toolCallId, "");
        write(`[sub-agent:tool] ${formatToolCall(event.toolName, event.args)}\n`);
        return;
      }

      if (event?.type === "tool_execution_update") {
        const current = extractText(event.partialResult?.content);
        if (!current) return;
        const previous = partialToolOutput.get(event.toolCallId) ?? "";
        writeToolDelta(event.toolName, getAppendedDelta(previous, current));
        partialToolOutput.set(event.toolCallId, current);
        return;
      }

      if (event?.type === "tool_execution_end") {
        const previous = partialToolOutput.get(event.toolCallId) ?? "";
        const current = extractText(event.result?.content);
        writeToolDelta(event.toolName, getAppendedDelta(previous, current));
        closeSection();
        partialToolOutput.delete(event.toolCallId);
        write(`[sub-agent:tool] ${event.toolName ?? "tool"} ${event.isError ? "failed" : "finished"}\n`);
        return;
      }

      if (event?.type === "auto_retry_start") {
        closeSection();
        write(`[sub-agent] retry ${event.attempt ?? "?"}/${event.maxAttempts ?? "?"} in ${event.delayMs ?? 0}ms\n`);
        return;
      }

      if (event?.type === "agent_settled") {
        closeSection();
        write("[sub-agent] completed\n");
      }
    },
    finish() {
      closeSection();
    },
  };

  function writeToolDelta(toolName, delta) {
    if (!delta) return;
    closeSection();
    write(`[sub-agent:${toolName ?? "tool"}] ${indentContinuation(delta)}`);
    if (!delta.endsWith("\n")) write("\n");
  }
}

function extractText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function formatToolCall(name = "tool", args = {}) {
  if (name === "bash" && typeof args?.command === "string") {
    return `$ ${truncate(args.command.replace(/\s+/g, " "), 300)}`;
  }
  const target = args?.path ?? args?.file_path;
  if (typeof target === "string") return `${name} ${truncate(target, 300)}`;
  let rendered;
  try {
    rendered = JSON.stringify(args);
  } catch {
    rendered = "[unserializable arguments]";
  }
  return `${name} ${truncate(rendered || "{}", 300)}`;
}

function getAppendedDelta(previous, current) {
  if (!current || !previous) return current;
  if (current.startsWith(previous)) return current.slice(previous.length);

  // Tool updates are cumulative, but bounded tools may drop an old prefix as
  // their rolling output is truncated. Find the longest suffix of the previous
  // snapshot that is also a prefix of the current snapshot, then print only
  // what follows it. KMP keeps this linear for large tool outputs.
  const prefix = new Uint32Array(current.length);
  for (let i = 1, matched = 0; i < current.length; i++) {
    while (matched > 0 && current[i] !== current[matched]) matched = prefix[matched - 1];
    if (current[i] === current[matched]) matched++;
    prefix[i] = matched;
  }

  let matched = 0;
  for (let i = 0; i < previous.length; i++) {
    while (matched > 0 && previous[i] !== current[matched]) matched = prefix[matched - 1];
    if (previous[i] === current[matched]) matched++;
    if (matched === current.length && i < previous.length - 1) matched = prefix[matched - 1];
  }
  return current.slice(matched);
}

function indentContinuation(text) {
  return text.replace(/\n(?!$)/g, "\n  ");
}

function truncate(text, maxLength) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
