import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { getConfigPath, loadConfig, type KagiConfig } from "./config.ts";
import { kagiSearch, formatResults } from "./search.ts";

function buildSystemPrompt(config: KagiConfig): string {
  return [
    "You have a Kagi web search integration.",
    "Use the kagi_search tool to search the live web for up-to-date information, documentation, news, or facts that may have changed since training.",
    `Searches return up to ${config.limit} results by default; prefer it over guessing when a question depends on current or external information.`,
  ].join("\n");
}

function buildSearchTool(config: KagiConfig) {
  return defineTool({
    name: "kagi_search",
    label: "Kagi Web Search",
    description:
      "Search the web with Kagi and return ranked results with titles, URLs, and snippets. Use this to look up current information, documentation, news, or anything not in your training data.",
    promptSnippet:
      "kagi_search: search the live web via Kagi and get back ranked results with snippets.",
    promptGuidelines: [
      "Use kagi_search when a question depends on current, external, or fast-changing information rather than answering from memory.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The web search query" }),
      limit: Type.Optional(
        Type.Number({
          description: `Number of results to return (1-100). Defaults to ${config.limit}.`,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const response = await kagiSearch(params, config);
      const resultCount = (response.data ?? []).filter(
        (item) => item.t === 0,
      ).length;
      return {
        content: [
          {
            type: "text" as const,
            text: formatResults(response, params.query, config.includeRelated),
          },
        ],
        details: {
          requestId: response.meta?.id,
          count: resultCount,
          ms: response.meta?.ms,
          apiBalance: response.meta?.api_balance,
        },
      };
    },
  });
}

export default function (pi: ExtensionAPI) {
  let config: KagiConfig;
  try {
    config = loadConfig();
  } catch (e: any) {
    console.error(`[kagi] ${e.message}`);
    console.error(
      `[kagi] Extension disabled. Create ${getConfigPath()} (chmod 600) or set KAGI_API_KEY, then /reload.`,
    );
    return;
  }

  pi.registerTool(buildSearchTool(config));

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildSystemPrompt(config)}`,
    };
  });

  pi.registerCommand("kagi", {
    description: "Kagi web search status",
    handler: async (_args, ctx) => {
      const lines = [
        `Kagi Extension Status`,
        `  Base URL:         ${config.baseUrl}`,
        `  Limit:            ${config.limit}`,
        `  Include related:  ${config.includeRelated ? "yes" : "no"}`,
        `  API key:          ${"*".repeat(Math.max(0, config.apiKey.length - 4))}${config.apiKey.slice(-4)}`,
        `  Config file:      ${config.configPath ?? "environment variables"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
