import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { getConfigPath, loadConfig, type ExaConfig } from "./config.ts";
import { exaSearch, formatResults } from "./search.ts";

function buildSystemPrompt(config: ExaConfig): string {
  return [
    "You have an Exa web search integration.",
    "Use the exa_search tool to search the live web for up-to-date information, documentation, news, or facts that may have changed since training.",
    `Searches return up to ${config.numResults} results by default; prefer it over guessing when a question depends on current or external information.`,
  ].join("\n");
}

function buildSearchTool(config: ExaConfig) {
  return defineTool({
    name: "exa_search",
    label: "Exa Web Search",
    description:
      "Search the web with Exa and return ranked results with page contents. Use this to look up current information, documentation, news, or anything not in your training data.",
    promptSnippet:
      "exa_search: search the live web via Exa and get back ranked results with text snippets.",
    promptGuidelines: [
      "Use exa_search when a question depends on current, external, or fast-changing information rather than answering from memory.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The web search query" }),
      numResults: Type.Optional(
        Type.Number({
          description: `Number of results to return (1-100). Defaults to ${config.numResults}.`,
        }),
      ),
      category: Type.Optional(
        Type.String({
          description:
            "Optional Exa category filter, e.g. 'news', 'research paper', 'github', 'company', 'pdf'.",
        }),
      ),
      includeDomains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Only return results from these domains.",
        }),
      ),
      excludeDomains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Never return results from these domains.",
        }),
      ),
      startPublishedDate: Type.Optional(
        Type.String({
          description: "Only results published on/after this ISO 8601 date.",
        }),
      ),
      endPublishedDate: Type.Optional(
        Type.String({
          description: "Only results published on/before this ISO 8601 date.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const response = await exaSearch(params, config);
      return {
        content: [
          {
            type: "text" as const,
            text: formatResults(response, params.query),
          },
        ],
        details: {
          requestId: response.requestId,
          count: response.results?.length ?? 0,
          costDollars: response.costDollars?.total,
        },
      };
    },
  });
}

export default function (pi: ExtensionAPI) {
  let config: ExaConfig;
  try {
    config = loadConfig();
  } catch (e: any) {
    console.error(`[exa] ${e.message}`);
    console.error(
      `[exa] Extension disabled. Create ${getConfigPath()} (chmod 600) or set EXA_API_KEY, then /reload.`,
    );
    return;
  }

  pi.registerTool(buildSearchTool(config));

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildSystemPrompt(config)}`,
    };
  });

  pi.registerCommand("exa", {
    description: "Exa web search status",
    handler: async (_args, ctx) => {
      const lines = [
        `Exa Extension Status`,
        `  Base URL:     ${config.baseUrl}`,
        `  Search type:  ${config.searchType}`,
        `  Num results:  ${config.numResults}`,
        `  Include text: ${config.includeText ? "yes" : "no"}`,
        `  Max chars:    ${config.maxCharacters || "uncapped"}`,
        `  Category:     ${config.category ?? "(none)"}`,
        `  API key:      ${"*".repeat(Math.max(0, config.apiKey.length - 4))}${config.apiKey.slice(-4)}`,
        `  Config file:  ${config.configPath ?? "environment variables"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
