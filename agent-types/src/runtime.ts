import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  source: string;
}

export function parseAgentDefinition(source: string, content: string): AgentDefinition {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error(`${source}: agent definition must start with a "---" frontmatter block`);
  const end = lines.slice(1).findIndex((line) => line.trim() === "---") + 1;
  if (end < 1) throw new Error(`${source}: unterminated frontmatter (missing closing ---)`);
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) throw new Error(`${source}: invalid frontmatter line (expected "key: value"): ${line.trim()}`);
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    const hash = value.search(/\s#/);
    if (hash >= 0) value = value.slice(0, hash).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!key) throw new Error(`${source}: frontmatter key must not be empty`);
    fields[key] = value;
  }
  const name = (fields.name ?? "").trim();
  const description = (fields.description ?? "").trim();
  const systemPrompt = lines.slice(end + 1).join("\n").trim();
  if (!name) throw new Error(`${source}: agent "name" is required in frontmatter`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new Error(`${source}: agent name "${name}" must be alphanumeric with - or _`);
  if (!description) throw new Error(`${source}: agent "description" is required in frontmatter`);
  if (!systemPrompt) throw new Error(`${source}: agent body (system prompt) must not be empty`);
  const definition: AgentDefinition = { name, description, systemPrompt, source };
  if (fields.model) definition.model = fields.model;
  if (fields.thinkingLevel) {
    if (!(THINKING_LEVELS as readonly string[]).includes(fields.thinkingLevel)) throw new Error(`${source}: thinkingLevel "${fields.thinkingLevel}" must be one of: ${THINKING_LEVELS.join(", ")}`);
    definition.thinkingLevel = fields.thinkingLevel as ThinkingLevel;
  }
  if (fields.tools !== undefined) {
    const tools = fields.tools.split(",").map((tool) => tool.trim()).filter(Boolean);
    if (!tools.length) throw new Error(`${source}: "tools" must list at least one tool name`);
    definition.tools = tools;
  }
  return definition;
}

export function mergeRegistries(...layers: AgentDefinition[][]): Map<string, AgentDefinition> {
  const registry = new Map<string, AgentDefinition>();
  for (const layer of layers) for (const definition of layer) registry.set(definition.name.toLowerCase(), definition);
  return registry;
}

export function getAgent(registry: Map<string, AgentDefinition>, name: string): AgentDefinition | undefined {
  return registry.get(name.trim().toLowerCase());
}

export interface DiscoveredRegistry { registry: Map<string, AgentDefinition>; errors: string[] }

/** Discover ordered registry layers; later directories override earlier ones. */
export function discoverAgentRegistry(directories: string[]): DiscoveredRegistry {
  const errors: string[] = [];
  const layers = directories.map((directory) => {
    if (!existsSync(directory)) return [];
    return readdirSync(directory).sort().filter((entry) => entry.endsWith(".md")).flatMap((entry) => {
      const file = path.join(directory, entry);
      try { return [parseAgentDefinition(file, readFileSync(file, "utf8"))]; }
      catch (error: any) { errors.push(error?.message ?? String(error)); return []; }
    });
  });
  return { registry: mergeRegistries(...layers), errors };
}

export interface SpawnRequest { command: string; args: string[]; cwd: string; signal: AbortSignal; onOutput?: (chunk: string) => void; label?: string }
export interface SpawnOutcome { exitCode: number | null; stdout: string; stderr: string }
export type SpawnFn = (request: SpawnRequest) => Promise<SpawnOutcome>;
export type ExecutionMode = "local" | "spawn";

export const DEFAULT_TMUX_SESSION = "pi-agents";
export function sanitizeCommandName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
}
export function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

export function parsePiJsonOutput(stdout: string): { text: string; errorMessage?: string } {
  let message: any;
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event?.type === "message_end" && event.message?.role === "assistant") message = event.message;
    } catch { /* tolerate non-JSON output */ }
  }
  if (!message) return { text: "", errorMessage: "no assistant message in child output" };
  if (message.stopReason === "error" || message.stopReason === "aborted") return { text: "", errorMessage: message.errorMessage || `child ${message.stopReason}` };
  return { text: (message.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n") };
}
