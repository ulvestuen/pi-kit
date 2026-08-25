#!/usr/bin/env node
// Jira Cloud REST CLI. No dependencies (Node 18+).

import { readFile } from "node:fs/promises";

const REQUEST_TIMEOUT_MS = 30_000;

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
  --fields <names>                    Search fields, comma-separated
  --fields <json|@file>               Create/update fields
  --limit <n>                         Search page size (default 50)
  --next-page-token <token>           Search page token
  --data <json|@file>                 Body for request
  --help                              Show this help

Environment:
  JIRA_BASE_URL       Jira Cloud API base URL (required)
  JIRA_EMAIL          Atlassian account email (required)
  JIRA_AUTH_TOKEN     Atlassian API token (required)`;

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

  const api = (path) => `/rest/api/3${path}`;

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
      const nextPageToken = takeOption(args, "--next-page-token");
      const fieldsValue = takeOption(args, "--fields");
      const [jql] = takePositionals(args, 1, "search requires <jql>");
      rejectExtra(args);
      const fields = fieldsValue?.split(",").map((field) => field.trim()).filter(Boolean);
      const body = { jql, maxResults: limit };
      if (fields?.length) body.fields = fields;
      if (nextPageToken) body.nextPageToken = nextPageToken;
      printResult(await request(config, api("/search/jql"), { method: "POST", body }));
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
      if (description !== undefined) fields.description = adf(description);
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
      const body = { body: adf(text) };
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
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_AUTH_TOKEN;
  if (!configuredBaseUrl) fail("JIRA_BASE_URL is not set");
  if (!email) fail("JIRA_EMAIL is not set");
  if (!token) fail("JIRA_AUTH_TOKEN is not set");
  let url;
  try {
    url = new URL(configuredBaseUrl);
  } catch {
    fail("JIRA_BASE_URL must be a valid URL");
  }
  if (url.protocol !== "https:") {
    fail("JIRA_BASE_URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    fail("JIRA_BASE_URL must not contain credentials, a query, or a fragment");
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  const gatewayPath = /^\/ex\/jira\/[^/]+$/.test(basePath);
  const validCloudUrl = (
    !basePath && url.hostname.endsWith(".atlassian.net")
    || gatewayPath && url.hostname === "api.atlassian.com"
  );
  if (!validCloudUrl) {
    fail("JIRA_BASE_URL must be https://<site>.atlassian.net or https://api.atlassian.com/ex/jira/<cloudId>");
  }
  const authorization = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  return { baseUrl: `${url.origin}${basePath}`, basePath, authorization };
}

async function request(config, path, { method = "GET", body } = {}) {
  if (path.includes("#")) fail("Jira request path must not contain a fragment");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const targetUrl = new URL(`${config.baseUrl}${normalizedPath}`);
  if (config.basePath && !targetUrl.pathname.startsWith(`${config.basePath}/`)) {
    fail("Jira request path must remain under JIRA_BASE_URL");
  }
  const headers = {
    Accept: "application/json",
    Authorization: config.authorization,
  };
  const init = {
    method,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response;
  let text;
  try {
    response = await fetch(targetUrl, init);
    text = await response.text();
  } catch (error) {
    fail(`Jira request failed: ${error.message}`);
  }
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
