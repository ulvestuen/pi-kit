#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const REQUIREMENTS = [
  ["exa-search", ["EXA_API_KEY"]],
  ["jira", ["JIRA_BASE_URL", "JIRA_AUTH_TOKEN"]],
  ["kagi-search", ["KAGI_API_KEY"]],
  ["linear", ["LINEAR_API_KEY"]],
  ["pdca", []],
  ["subagents", []],
];

export function renderHealthCheck(env = process.env) {
  const rows = REQUIREMENTS.map(([skill, variables]) => {
    const missing = variables.filter((name) => !env[name]);
    return [
      skill,
      variables.join(", ") || "—",
      missing.length ? `missing ${missing.join(", ")}` : "ready",
    ];
  });
  const widths = ["Skill", "Required environment", "Status"].map((heading, column) =>
    Math.max(heading.length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join(" | ");
  return [
    line(["Skill", "Required environment", "Status"]),
    widths.map((width) => "-".repeat(width)).join("-|-"),
    ...rows.map(line),
  ].join("\n");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.log(renderHealthCheck());
}
