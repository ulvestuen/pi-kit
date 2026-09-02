#!/usr/bin/env node
// Datadog HTTP API CLI. No dependencies (Node 18.18+).

import { readFile } from "node:fs/promises";

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SITE = "datadoghq.com";
const SITES = new Set([
  "datadoghq.com",
  "us3.datadoghq.com",
  "us5.datadoghq.com",
  "datadoghq.eu",
  "ap1.datadoghq.com",
  "ap2.datadoghq.com",
  "uk1.datadoghq.com",
  "ddog-gov.com",
  "us2.ddog-gov.com",
]);

const HELP = `Usage: node datadog.mjs <command> [arguments] [options]

Commands:
  validate                              Validate the API key
  monitor <id>                          Get a monitor
  monitors [options]                    List monitors
  search-monitors <query> [options]     Search monitors
  create-monitor <name> <type> <query>  Create a monitor
  validate-monitor <name> <type> <query> Validate a monitor definition
  update-monitor <id> --data <json>     Update a monitor
  request <method> <path>                Make an arbitrary API request

Options:
  --limit <n>                           Page size (default 50, maximum 1000)
  --page <n>                            Zero-based page (default 0)
  --name <text>                         Filter monitor names
  --tags <csv>                          Monitor scope tags or definition tags
  --monitor-tags <csv>                  Filter monitor definition tags
  --group-states <csv>                  Filter monitor group states
  --with-downtimes <true|false>         Include active downtimes
  --id-offset <id>                      Continue listing after a monitor ID
  --sort <field,direction>              Search sort order
  --message <text>                      Monitor notification message
  --options <json|@file>                Monitor options object
  --data <json|@file>                   Request or monitor fields
  --help                                Show this help

Environment:
  DD_API_KEY     Datadog API key (required)
  DD_APP_KEY     Datadog application key (required)
  DD_SITE        Datadog site parameter (default datadoghq.com)`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
    console.log(HELP);
    return;
  }

  const config = getConfig();
  const command = args.shift();

  switch (command) {
    case "validate": {
      rejectExtra(args);
      printResult(await request(config, "/api/v1/validate"));
      break;
    }
    case "monitor": {
      const [id] = takePositionals(args, 1, "monitor requires <id>");
      rejectExtra(args);
      validateId(id, "monitor ID");
      printResult(await request(config, `/api/v1/monitor/${id}`));
      break;
    }
    case "monitors": {
      const limit = parseInteger(takeOption(args, "--limit") ?? "50", "--limit", 1, 1000);
      const page = parseInteger(takeOption(args, "--page") ?? "0", "--page", 0);
      const name = takeOption(args, "--name");
      const tags = takeOption(args, "--tags");
      const monitorTags = takeOption(args, "--monitor-tags");
      const groupStates = takeOption(args, "--group-states");
      const withDowntimesValue = takeOption(args, "--with-downtimes");
      const idOffset = takeOption(args, "--id-offset");
      rejectExtra(args);
      if (idOffset !== undefined) validateId(idOffset, "--id-offset");
      const withDowntimes = withDowntimesValue === undefined
        ? undefined
        : parseBoolean(withDowntimesValue, "--with-downtimes");
      const path = withQuery("/api/v1/monitor", {
        page,
        page_size: limit,
        name,
        tags,
        monitor_tags: monitorTags,
        group_states: groupStates,
        with_downtimes: withDowntimes,
        id_offset: idOffset,
      });
      printResult(await request(config, path));
      break;
    }
    case "search-monitors": {
      const limit = parseInteger(takeOption(args, "--limit") ?? "50", "--limit", 1, 1000);
      const page = parseInteger(takeOption(args, "--page") ?? "0", "--page", 0);
      const sort = takeOption(args, "--sort");
      const [query] = takePositionals(args, 1, "search-monitors requires <query>");
      rejectExtra(args);
      const path = withQuery("/api/v1/monitor/search", { query, page, per_page: limit, sort });
      printResult(await request(config, path));
      break;
    }
    case "create-monitor":
    case "validate-monitor": {
      const body = await readMonitorDefinition(args, command);
      const path = command === "create-monitor" ? "/api/v1/monitor" : "/api/v1/monitor/validate";
      printResult(await request(config, path, { method: "POST", body }));
      break;
    }
    case "update-monitor": {
      const dataValue = takeOption(args, "--data");
      const [id] = takePositionals(args, 1, "update-monitor requires <id> --data <json>");
      rejectExtra(args);
      validateId(id, "monitor ID");
      if (dataValue === undefined) fail("update-monitor requires --data <json>");
      const body = await readObject(dataValue, "--data");
      if (Object.keys(body).length === 0) fail("--data must contain at least one monitor field");
      printResult(await request(config, `/api/v1/monitor/${id}`, { method: "PUT", body }));
      break;
    }
    case "request": {
      const dataValue = takeOption(args, "--data");
      const [method, path] = takePositionals(args, 2, "request requires <method> <path>");
      rejectExtra(args);
      const body = dataValue === undefined ? undefined : await readJsonValue(dataValue, "--data");
      printResult(await request(config, path, { method: method.toUpperCase(), body }));
      break;
    }
    default:
      fail(`unknown command: ${command}\n\n${HELP}`);
  }
}

function getConfig() {
  const apiKey = process.env.DD_API_KEY;
  const appKey = process.env.DD_APP_KEY;
  const site = process.env.DD_SITE || DEFAULT_SITE;
  if (!apiKey) fail("DD_API_KEY is not set");
  if (!appKey) fail("DD_APP_KEY is not set");
  if (!SITES.has(site)) fail(`DD_SITE must be one of: ${[...SITES].join(", ")}`);
  return { baseUrl: `https://api.${site}`, apiKey, appKey };
}

async function readMonitorDefinition(args, command) {
  const message = takeOption(args, "--message");
  const tagsValue = takeOption(args, "--tags");
  const optionsValue = takeOption(args, "--options");
  const dataValue = takeOption(args, "--data");
  const [name, type, query] = takePositionals(args, 3, `${command} requires <name> <type> <query>`);
  rejectExtra(args);

  const body = dataValue === undefined ? {} : await readObject(dataValue, "--data");
  body.name = name;
  body.type = type;
  body.query = query;
  if (message !== undefined) body.message = message;
  if (tagsValue !== undefined) {
    body.tags = tagsValue.split(",").map((tag) => tag.trim()).filter(Boolean);
    if (body.tags.length === 0) fail("--tags requires at least one tag");
  }
  if (optionsValue !== undefined) body.options = await readObject(optionsValue, "--options");
  return body;
}

async function request(config, path, { method = "GET", body } = {}) {
  if (path.includes("#")) fail("Datadog request path must not contain a fragment");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  let targetUrl;
  try {
    targetUrl = new URL(normalizedPath, `${config.baseUrl}/`);
  } catch {
    fail("Datadog request path is invalid");
  }
  if (targetUrl.origin !== config.baseUrl || targetUrl.username || targetUrl.password) {
    fail("Datadog request path must remain under the configured API origin");
  }

  const headers = {
    Accept: "application/json",
    "DD-API-KEY": config.apiKey,
    "DD-APPLICATION-KEY": config.appKey,
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
    fail(redact(`Datadog request failed: ${error.message}`, config));
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
    fail(redact(`Datadog API error ${response.status} ${response.statusText}${details ? `: ${details}` : ""}`, config));
  }
  return { status: response.status, data };
}

function withQuery(path, values) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) params.set(name, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
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

function validateId(value, name) {
  if (!/^\d+$/.test(value) || BigInt(value) < 1n) fail(`${name} must be a positive integer`);
}

function parseInteger(value, name, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    fail(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function parseBoolean(value, name) {
  if (value === "true") return true;
  if (value === "false") return false;
  fail(`${name} must be true or false`);
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

function redact(message, config) {
  const secrets = [...new Set([config.apiKey, config.appKey])]
    .sort((left, right) => right.length - left.length);
  return secrets.reduce(
    (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
    message,
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

await main();
