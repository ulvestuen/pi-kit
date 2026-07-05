/**
 * fleet agent registry — pure, dependency-free parsing and merging of
 * agent definitions.
 *
 * Agents are markdown files with YAML frontmatter; the body is the system
 * prompt. This module has no pi or Node dependencies: it parses and validates
 * definitions from (path, content) pairs handed to it. The file-system walk
 * lives in the wiring layer (host.ts / index.ts).
 */

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentDefinition {
  /** Unique registry name, e.g. "implementer". */
  name: string;
  /** One-line description shown in /fleet listings and to the model. */
  description: string;
  /** The markdown body — the child agent's system prompt. */
  systemPrompt: string;
  /** Optional model override; defaults to the parent's model. */
  model?: string;
  /** Optional thinking level override. */
  thinkingLevel?: ThinkingLevel;
  /** Optional tool allowlist; omit to inherit the parent's tools. */
  tools?: string[];
  /** File path the definition was parsed from, for listings and errors. */
  source: string;
}

interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

/**
 * Split a markdown document into YAML-ish frontmatter fields and body.
 * Only the simple `key: value` subset is supported — by design, agent
 * definitions stay flat.
 */
function splitFrontmatter(path: string, content: string): Frontmatter {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new Error(
      `${path}: agent definition must start with a "---" frontmatter block`,
    );
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new Error(`${path}: unterminated frontmatter (missing closing ---)`);
  }

  const fields: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(
        `${path}: invalid frontmatter line (expected "key: value"): ${line.trim()}`,
      );
    }
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // Strip an inline comment ("model: foo  # comment") and paired quotes.
    const hash = value.search(/\s#/);
    if (hash !== -1) value = value.slice(0, hash).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key) {
      throw new Error(`${path}: frontmatter key must not be empty`);
    }
    fields[key] = value;
  }

  return { fields, body: lines.slice(end + 1).join("\n").trim() };
}

/**
 * Parse and validate one agent definition from its file path and content.
 * Throws with the path in the message on any validation failure.
 */
export function parseAgentDefinition(
  path: string,
  content: string,
): AgentDefinition {
  const { fields, body } = splitFrontmatter(path, content);

  const name = (fields.name ?? "").trim();
  if (!name) {
    throw new Error(`${path}: agent "name" is required in frontmatter`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(
      `${path}: agent name "${name}" must be alphanumeric with - or _`,
    );
  }

  const description = (fields.description ?? "").trim();
  if (!description) {
    throw new Error(`${path}: agent "description" is required in frontmatter`);
  }

  if (!body) {
    throw new Error(`${path}: agent body (system prompt) must not be empty`);
  }

  const definition: AgentDefinition = {
    name,
    description,
    systemPrompt: body,
    source: path,
  };

  if (fields.model) definition.model = fields.model;

  if (fields.thinkingLevel) {
    const level = fields.thinkingLevel as ThinkingLevel;
    if (!THINKING_LEVELS.includes(level)) {
      throw new Error(
        `${path}: thinkingLevel "${fields.thinkingLevel}" must be one of: ${THINKING_LEVELS.join(", ")}`,
      );
    }
    definition.thinkingLevel = level;
  }

  if (fields.tools !== undefined) {
    const tools = fields.tools
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (tools.length === 0) {
      throw new Error(`${path}: "tools" must list at least one tool name`);
    }
    definition.tools = tools;
  }

  return definition;
}

/**
 * Merge discovery layers into one registry. Later layers win on name
 * collision (kit defaults < user < project). Names are case-insensitive.
 */
export function mergeRegistries(
  ...layers: AgentDefinition[][]
): Map<string, AgentDefinition> {
  const registry = new Map<string, AgentDefinition>();
  for (const layer of layers) {
    for (const def of layer) {
      registry.set(def.name.toLowerCase(), def);
    }
  }
  return registry;
}

/** Look up an agent by name, case-insensitively. */
export function getAgent(
  registry: Map<string, AgentDefinition>,
  name: string,
): AgentDefinition | undefined {
  return registry.get(name.trim().toLowerCase());
}
