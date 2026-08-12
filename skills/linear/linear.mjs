#!/usr/bin/env node
// Zero-dependency Linear GraphQL CLI. Requires Node 18+ and LINEAR_API_KEY.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const DEFAULT_API_URL = "https://api.linear.app/graphql";

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  priorityLabel
  dueDate
  url
  createdAt
  updatedAt
  team { id key name }
  state { id name type }
  assignee { id name email }
  project { id name }
  labels { nodes { id name color } }
`;

const operations = {
  viewer: `query Viewer { viewer { id name displayName email active } }`,
  teams: `query Teams($first: Int!, $after: String) {
    teams(first: $first, after: $after) {
      nodes { id key name }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  users: `query Users($first: Int!, $after: String) {
    users(first: $first, after: $after) {
      nodes { id name displayName email active }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  projects: `query Projects($first: Int!, $after: String) {
    projects(first: $first, after: $after) {
      nodes { id name description url progress targetDate lead { id name } teams { nodes { id key name } } }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  states: `query WorkflowStates($first: Int!, $after: String) {
    workflowStates(first: $first, after: $after) {
      nodes { id name type color position team { id key name } }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  labels: `query IssueLabels($first: Int!, $after: String) {
    issueLabels(first: $first, after: $after) {
      nodes { id name description color team { id key name } }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  issues: `query Issues($first: Int!, $after: String) {
    issues(first: $first, after: $after) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  teamIssues: `query TeamIssues($teamId: String!, $first: Int!, $after: String) {
    team(id: $teamId) {
      id key name
      issues(first: $first, after: $after) {
        nodes { ${ISSUE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`,
  issue: `query Issue($id: String!) {
    issue(id: $id) {
      ${ISSUE_FIELDS}
      comments(first: 50) {
        nodes { id body createdAt updatedAt user { id name email } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`,
  createIssue: `mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
  }`,
  updateIssue: `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
  }`,
  comment: `mutation CreateComment($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id body createdAt updatedAt user { id name email } issue { id identifier title } }
    }
  }`,
};

export async function requestLinear({
  query,
  variables = {},
  mutationRoot,
  apiKey = process.env.LINEAR_API_KEY,
  apiUrl = process.env.LINEAR_API_URL || DEFAULT_API_URL,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new CliError("LINEAR_API_KEY is not set. Create a personal API key in Linear under Settings → Security & access.");

  let response;
  try {
    response = await fetchImpl(apiUrl, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (error) {
    throw new CliError(redact(`Linear API request failed: ${error.message}`, apiKey));
  }

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const preview = text.trim().slice(0, 500);
    throw new CliError(redact(`Linear API returned ${response.status} ${response.statusText} with a non-JSON response${preview ? `: ${preview}` : ""}`, apiKey));
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    throw new CliError("Linear API returned an invalid JSON envelope");
  }
  if (!response.ok) {
    throw new CliError(redact(`Linear API error ${response.status} ${response.statusText}${formatErrors(payload.errors)}`, apiKey));
  }
  if (payload.errors?.length) {
    throw new CliError(redact(`Linear GraphQL error${formatErrors(payload.errors)}`, apiKey));
  }
  if (!Object.hasOwn(payload, "data")) throw new CliError("Linear API response is missing data");
  if (mutationRoot && payload.data?.[mutationRoot]?.success !== true) {
    throw new CliError(`Linear mutation ${mutationRoot} was not successful`);
  }
  return payload.data;
}

export async function buildOperation(argv, readFileImpl = readFile) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { help: true };
  }

  const options = parseOptions(rest);
  const pagination = () => ({ first: parseLimit(options.limit), after: options.after });

  switch (command) {
    case "viewer":
      assertNoArguments(options, command);
      return { query: operations.viewer, variables: {} };
    case "teams":
    case "users":
    case "projects":
    case "states":
    case "labels":
      assertOptions(options, ["limit", "after"], command);
      return { query: operations[command], variables: pagination() };
    case "issues": {
      assertOptions(options, ["limit", "after", "team"], command);
      const variables = pagination();
      if (options.team !== undefined) {
        return { query: operations.teamIssues, variables: { teamId: stringValue(options.team, "--team"), ...variables } };
      }
      return { query: operations.issues, variables };
    }
    case "issue": {
      assertOptions(options, ["_"], command);
      return { query: operations.issue, variables: { id: onePositional(options, "issue <id>") } };
    }
    case "create-issue": {
      assertOptions(options, issueOptionNames(true), command);
      const input = parseInput(options.input);
      assignIssueFields(input, options);
      if (!input.teamId) throw new CliError("create-issue requires --team <uuid> or teamId in --input");
      if (!input.title) throw new CliError("create-issue requires --title <text> or title in --input");
      input.teamId = stringValue(input.teamId, "teamId");
      input.title = stringValue(input.title, "title");
      return { query: operations.createIssue, variables: { input }, mutationRoot: "issueCreate" };
    }
    case "update-issue": {
      assertOptions(options, issueOptionNames(false), command);
      const id = onePositional(options, "update-issue <id>");
      const input = parseInput(options.input);
      assignIssueFields(input, options);
      if (Object.keys(input).length === 0) throw new CliError("update-issue requires at least one field to update");
      return { query: operations.updateIssue, variables: { id, input }, mutationRoot: "issueUpdate" };
    }
    case "comment": {
      assertOptions(options, ["_", "body"], command);
      const issueId = onePositional(options, "comment <issue-uuid>");
      const body = stringValue(options.body, "--body");
      return { query: operations.comment, variables: { input: { issueId, body } }, mutationRoot: "commentCreate" };
    }
    case "graphql": {
      assertOptions(options, ["query", "file", "variables", "variables-file"], command);
      if (options.query && options.file) throw new CliError("graphql accepts either --query or --file, not both");
      if (options.variables && options["variables-file"]) throw new CliError("graphql accepts either --variables or --variables-file, not both");
      const query = options.file ? await readFileImpl(stringValue(options.file, "--file"), "utf8") : stringValue(options.query, "--query");
      const variablesText = options["variables-file"]
        ? await readFileImpl(stringValue(options["variables-file"], "--variables-file"), "utf8")
        : options.variables;
      return { query, variables: parseJsonObject(variablesText, "variables") };
    }
    default:
      throw new CliError(`unknown command: ${command}`);
  }
}

function parseOptions(args) {
  const options = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      options._.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    const name = arg.slice(2, equal === -1 ? undefined : equal);
    if (!name) throw new CliError(`invalid option: ${arg}`);
    if (Object.hasOwn(options, name)) throw new CliError(`option --${name} was provided more than once`);
    if (equal !== -1) {
      options[name] = arg.slice(equal + 1);
    } else {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new CliError(`--${name} requires a value`);
      options[name] = value;
    }
  }
  return options;
}

function assignIssueFields(input, options) {
  const fields = {
    team: "teamId",
    title: "title",
    description: "description",
    state: "stateId",
    assignee: "assigneeId",
    project: "projectId",
    "due-date": "dueDate",
  };
  for (const [option, field] of Object.entries(fields)) {
    if (options[option] !== undefined) input[field] = stringValue(options[option], `--${option}`);
  }
  if (options.priority !== undefined) {
    const priority = Number(options.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 4) throw new CliError("--priority must be an integer from 0 to 4");
    input.priority = priority;
  }
  if (options.labels !== undefined) {
    input.labelIds = stringValue(options.labels, "--labels").split(",").map((value) => value.trim()).filter(Boolean);
    if (input.labelIds.length === 0) throw new CliError("--labels requires at least one UUID");
  }
}

function issueOptionNames(includeTeam) {
  return ["input", "title", "description", "state", "assignee", "project", "priority", "due-date", "labels", ...(includeTeam ? ["team"] : ["_"])];
}

function parseLimit(value) {
  if (value === undefined) return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) throw new CliError("--limit must be an integer from 1 to 250");
  return limit;
}

function parseInput(value) {
  return parseJsonObject(value, "--input");
}

function parseJsonObject(value, label) {
  if (value === undefined) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new CliError(`${label} must be valid JSON: ${error.message}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new CliError(`${label} must be a JSON object`);
  return parsed;
}

function onePositional(options, usage) {
  if (options._.length !== 1) throw new CliError(`usage: linear.mjs ${usage}`);
  return options._[0];
}

function stringValue(value, option) {
  if (typeof value !== "string" || !value.trim()) throw new CliError(`${option} requires a non-empty value`);
  return value;
}

function assertNoArguments(options, command) {
  assertOptions(options, [], command);
}

function assertOptions(options, allowed, command) {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(options).filter((name) => !allowedSet.has(name) && (name !== "_" || options._.length > 0));
  if (unexpected.length) throw new CliError(`${command} does not accept ${unexpected.map((name) => name === "_" ? "positional arguments" : `--${name}`).join(", ")}`);
}

function formatErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return "";
  return `: ${errors.map((error) => error?.message || JSON.stringify(error)).join("; ")}`;
}

function redact(message, secret) {
  return secret ? message.split(secret).join("[REDACTED]") : message;
}

export class CliError extends Error {}

export const HELP = `Usage: node linear.mjs <command> [options]

Read commands:
  viewer
  teams|users|projects|states|labels [--limit N] [--after CURSOR]
  issues [--team TEAM_UUID] [--limit N] [--after CURSOR]
  issue <ID>

Write commands:
  create-issue --team UUID --title TEXT [issue fields]
  update-issue <ID> [issue fields]
  comment <ISSUE_UUID> --body TEXT

Custom GraphQL:
  graphql (--query TEXT | --file PATH) [--variables JSON | --variables-file PATH]

Issue fields: --description, --state, --assignee, --project, --priority,
              --due-date, --labels UUID,UUID, or --input JSON

Environment: LINEAR_API_KEY (required), LINEAR_API_URL (optional)`;

export async function main(argv = process.argv.slice(2)) {
  const operation = await buildOperation(argv);
  if (operation.help) {
    console.log(HELP);
    return;
  }
  const data = await requestLinear(operation);
  console.log(JSON.stringify(data, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof CliError ? error.message : `Unexpected error: ${error.message}`);
    process.exitCode = 1;
  });
}
