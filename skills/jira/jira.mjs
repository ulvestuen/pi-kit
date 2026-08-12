#!/usr/bin/env node
// Jira Cloud and Server/Data Center REST CLI. No dependencies (Node 18+).

import { readFile } from "node:fs/promises";

const HELP = `Usage: node jira.mjs <command> [arguments] [options]

Commands:
  issue <key>                         Get an issue
  search <jql> [--limit n]            Search issues
  projects                            List visible projects
  create <project> <type> <summary>   Create an issue
  update <key> --fields <json>        Update issue fields
  comment <key> <text>                Add a comment
  transitions <key>                   List available transitions
  transition <key> <transition-id>    Perform a transition
  request <method> <path>             Make an arbitrary REST request

Options:
  --description <text>                Description for create
  --fields <json|@file>               Additional/create/update fields
  --limit <n>                         Search result limit (default 50)
  --start-at <n>                      Server/Data Center search offset
  --next-page-token <token>           Jira Cloud search page token
  --data <json|@file>                 Body for request
  --help                              Show this help

Environment:
  JIRA_BASE_URL       Jira site URL (required)
  JIRA_AUTH_TOKEN     Cloud API token or Server/Data Center PAT (required)
  JIRA_EMAIL          Enables Basic auth for Jira Cloud API tokens (optional)
  JIRA_API_VERSION    Force REST API version 2 or 3 (optional)`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
    console.log(HELP);
    return;
  }

  const config = getConfig();
  const command = args.shift();

  if (command === "request") {
    const dataValue = takeOption(args, "--data");
    const [method, path] = takePositionals(args, 2, "request requires <method> <path>");
    rejectExtra(args);
    const body = dataValue === undefined ? undefined : await readJsonValue(dataValue, "--data");
    printResult(await request(config, path, { method: method.toUpperCase(), body }));
    return;
  }

  const apiVersion = await resolveApiVersion(config);
  const api = (path) => `/rest/api/${apiVersion}${path}`;

  switch (command) {
    case "issue": {
      const [key] = takePositionals(args, 1, "issue requires <key>");
      rejectExtra(args);
      printResult(await request(config, api(`/issue/${encodeURIComponent(key)}`)));
      break;
    }
    case "projects": {
      rejectExtra(args);
      printResult(await request(config, api("/project")));
      break;
    }
    case "search": {
      const limit = parseInteger(takeOption(args, "--limit") ?? "50", "--limit", 1, 100);
      const startAt = parseInteger(takeOption(args, "--start-at") ?? "0", "--start-at", 0);
      const nextPageToken = takeOption(args, "--next-page-token");
      const fieldsValue = takeOption(args, "--fields");
      const [jql] = takePositionals(args, 1, "search requires <jql>");
      rejectExtra(args);
      const fields = fieldsValue?.split(",").map((field) => field.trim()).filter(Boolean);
      const body = { jql, maxResults: limit };
      if (fields?.length) body.fields = fields;
      if (apiVersion === 3) {
        if (nextPageToken) body.nextPageToken = nextPageToken;
        printResult(await request(config, api("/search/jql"), { method: "POST", body }));
      } else {
        body.startAt = startAt;
        printResult(await request(config, api("/search"), { method: "POST", body }));
      }
      break;
    }
    case "create": {
      const description = takeOption(args, "--description");
      const fieldsValue = takeOption(args, "--fields");
      const [project, issueType, summary] = takePositionals(args, 3, "create requires <project> <type> <summary>");
      rejectExtra(args);
      const extraFields = fieldsValue === undefined ? {} : await readObject(fieldsValue, "--fields");
      const fields = {
        project: { key: project },
        issuetype: { name: issueType },
        summary,
        ...extraFields,
      };
      if (description !== undefined) fields.description = apiVersion === 3 ? adf(description) : description;
      printResult(await request(config, api("/issue"), { method: "POST", body: { fields } }));
      break;
    }
    case "update": {
      const fieldsValue = takeOption(args, "--fields");
      const [key] = takePositionals(args, 1, "update requires <key> --fields <json>");
      rejectExtra(args);
      if (fieldsValue === undefined) fail("update requires --fields <json>");
      const fields = await readObject(fieldsValue, "--fields");
      printResult(await request(config, api(`/issue/${encodeURIComponent(key)}`), {
        method: "PUT",
        body: { fields },
      }));
      break;
    }
    case "comment": {
      const [key, text] = takePositionals(args, 2, "comment requires <key> <text>");
      rejectExtra(args);
      const body = { body: apiVersion === 3 ? adf(text) : text };
      printResult(await request(config, api(`/issue/${encodeURIComponent(key)}/comment`), { method: "POST", body }));
      break;
    }
    case "transitions": {
      const [key] = takePositionals(args, 1, "transitions requires <key>");
      rejectExtra(args);
      printResult(await request(config, api(`/issue/${encodeURIComponent(key)}/transitions`)));
      break;
    }
    case "transition": {
      const [key, id] = takePositionals(args, 2, "transition requires <key> <transition-id>");
      rejectExtra(args);
      printResult(await request(config, api(`/issue/${encodeURIComponent(key)}/transitions`), {
        method: "POST",
        body: { transition: { id } },
      }));
      break;
    }
    default:
      fail(`unknown command: ${command}\n\n${HELP}`);
  }
}

function getConfig() {
  const configuredBaseUrl = process.env.JIRA_BASE_URL;
  const token = process.env.JIRA_AUTH_TOKEN;
  if (!configuredBaseUrl) fail("JIRA_BASE_URL is not set");
  if (!token) fail("JIRA_AUTH_TOKEN is not set");
  let url;
  try {
    url = new URL(configuredBaseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    fail("JIRA_BASE_URL must be a valid HTTP(S) URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    fail("JIRA_BASE_URL must not contain credentials, a query, or a fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  const baseUrl = url.toString().replace(/\/$/, "");
  const authorization = process.env.JIRA_EMAIL
    ? `Basic ${Buffer.from(`${process.env.JIRA_EMAIL}:${token}`).toString("base64")}`
    : `Bearer ${token}`;
  return { baseUrl, authorization };
}

async function resolveApiVersion(config) {
  const forced = process.env.JIRA_API_VERSION?.trim();
  if (forced) {
    if (forced !== "2" && forced !== "3") fail("JIRA_API_VERSION must be 2 or 3");
    return Number(forced);
  }
  const result = await request(config, "/rest/api/2/serverInfo");
  return String(result.data?.deploymentType ?? "").toLowerCase() === "cloud" ? 3 : 2;
}

async function request(config, path, { method = "GET", body } = {}) {
  if (path.includes("#")) fail("Jira request path must not contain a fragment");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const headers = {
    Accept: "application/json",
    Authorization: config.authorization,
  };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${config.baseUrl}${normalizedPath}`, init);
  } catch (error) {
    fail(`Jira request failed: ${error.message}`);
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const details = typeof data === "string" ? data : JSON.stringify(data);
    fail(`Jira API error ${response.status} ${response.statusText}${details ? `: ${details}` : ""}`);
  }
  return { status: response.status, data };
}

function printResult(result) {
  if (result.data === null) {
    console.log(JSON.stringify({ ok: true, status: result.status }, null, 2));
  } else if (typeof result.data === "string") {
    console.log(result.data);
  } else {
    console.log(JSON.stringify(result.data, null, 2));
  }
}

function takeOption(args, name) {
  const terminator = args.indexOf("--");
  const optionArgs = terminator === -1 ? args : args.slice(0, terminator);
  const index = optionArgs.indexOf(name);
  if (index === -1) return undefined;
  if (index === args.length - 1 || args[index + 1].startsWith("--")) fail(`${name} requires a value`);
  const value = args[index + 1];
  args.splice(index, 2);
  const remainingTerminator = args.indexOf("--");
  const remainingOptionArgs = remainingTerminator === -1 ? args : args.slice(0, remainingTerminator);
  if (remainingOptionArgs.includes(name)) fail(`${name} may only be provided once`);
  return value;
}

function takePositionals(args, count, message) {
  const terminator = args.indexOf("--");
  const positionals = args.filter((arg, index) => (
    index !== terminator && (terminator !== -1 && index > terminator || !arg.startsWith("--"))
  ));
  if (positionals.length < count) fail(message);
  const selected = positionals.slice(0, count);
  for (const value of selected) args.splice(args.indexOf(value), 1);
  const remainingTerminator = args.indexOf("--");
  if (remainingTerminator !== -1) args.splice(remainingTerminator, 1);
  return selected;
}

function rejectExtra(args) {
  if (args.length) fail(`unexpected argument${args.length === 1 ? "" : "s"}: ${args.join(" ")}`);
}

function parseInteger(value, name, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    fail(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

async function readJsonValue(value, name) {
  let source = value;
  if (value.startsWith("@")) {
    try {
      source = await readFile(value.slice(1), "utf8");
    } catch (error) {
      fail(`${name} could not read ${value.slice(1)}: ${error.message}`);
    }
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`${name} must be valid JSON: ${error.message}`);
  }
}

async function readObject(value, name) {
  const parsed = await readJsonValue(value, name);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") fail(`${name} must be a JSON object`);
  return parsed;
}

function adf(text) {
  return {
    type: "doc",
    version: 1,
    content: String(text).split(/\r?\n/).map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

await main();
