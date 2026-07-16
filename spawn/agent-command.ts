/**
 * The pi child-process contract for detached spawn jobs.
 *
 * Spawn jobs run `pi -p` (non-interactive print mode) with the default
 * *text* output mode — unlike fleet, which uses `--mode json` and parses
 * the stream in the parent. Detached jobs have no parent to parse events,
 * and their logs are read verbatim by humans (tmux windows) and by the
 * model (spawn_output), so plain text is the right shape on both ends.
 * `--no-session` keeps children out of the session directory, and the
 * agent definition supplies system prompt, model, thinking level, tools.
 */

import type { AgentDefinition } from "../fleet/registry.ts";
import { shellQuote } from "../fleet/tmux.ts";

/**
 * Internal fleet/critic children use pi's JSON event mode. Streaming updates
 * contain the whole partial message on every token, so persisting them makes
 * logs grow quadratically. turn_end and agent_end also duplicate messages that
 * are already present in message_end records. The runner only needs the final
 * assistant message_end record, which this filter preserves.
 */
export const JSON_EVENT_LOG_FILTER =
  "awk '/^\\{\"type\":\"(message_update|turn_end|agent_end)\"/ { next } { print; fflush() }'";

/** Optional shell pipeline stage for internal JSON event logs. */
export function buildJsonEventLogFilter(enabled: boolean): string {
  return enabled ? ` | ${JSON_EVENT_LOG_FILTER}` : "";
}

/**
 * Shell commands that atomically cap a completed log before its done marker is
 * published. A zero cap disables compaction. The tail contains the final
 * message_end record for compacted internal JSON streams.
 */
export function buildLogCompactionCommands(
  logPath: string,
  maxBytes: number,
): string[] {
  if (maxBytes <= 0) return [];
  const log = shellQuote(logPath);
  const tmp = shellQuote(`${logPath}.compact`);
  const cap = Math.max(1, Math.floor(maxBytes));
  return [
    `if [ -f ${log} ] && [ \"$(wc -c < ${log})\" -gt ${cap} ]; then tail -c ${cap} ${log} > ${tmp} && mv ${tmp} ${log}; fi`,
  ];
}

/** Build the pi argv (without the binary) for one detached job. */
export function buildJobPiArgs(def: AgentDefinition, task: string): string[] {
  const args = ["-p", "--no-session"];
  args.push("--system-prompt", def.systemPrompt);
  if (def.model) args.push("--model", def.model);
  if (def.thinkingLevel) args.push("--thinking", def.thinkingLevel);
  if (def.tools && def.tools.length > 0) {
    args.push("--tools", def.tools.join(","));
  }
  args.push(task);
  return args;
}

/** Any argv vector as one POSIX-shell-safe command string. */
export function buildShellCommand(command: string, args: string[] = []): string {
  return [command, ...args].map(shellQuote).join(" ");
}

/** The full pi invocation as one POSIX-shell-safe command string. */
export function buildPiShellCommand(
  piBinary: string,
  def: AgentDefinition,
  task: string,
): string {
  return buildShellCommand(piBinary, buildJobPiArgs(def, task));
}

/**
 * `export` lines for forwarding selected host environment variables into a
 * job's run script. Only variables actually set (and non-empty) on the host
 * are forwarded; values are single-quoted for POSIX sh.
 */
export function buildEnvExports(
  names: string[],
  env: Record<string, string | undefined>,
): string[] {
  const lines: string[] = [];
  for (const name of names) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    lines.push(`export ${name}=${shellQuote(value)}`);
  }
  return lines;
}
