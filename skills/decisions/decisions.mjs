#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PROVIDERS = {
  jev: {
    name: "JEV",
    url: "https://api.typesafe.ai/v1/systemone",
    keyEnv: "TYPESAFE_API_KEY",
    model: "jev-latest",
    inputField: "state",
  },
  openai: {
    name: "OpenAI Decisions",
    url: "https://api.openai.com/v1/decisions",
    keyEnv: "OPENAI_API_KEY",
    model: "gpt-6-luna",
    inputField: "input",
  },
};

function selectProvider(explicitProvider) {
  const preferred = explicitProvider ?? (process.env.DECISIONS_PROVIDER || undefined);
  if (preferred !== undefined) {
    if (!Object.hasOwn(PROVIDERS, preferred)) {
      throw new Error("Provider must be jev or openai; check the explicit choice or DECISIONS_PROVIDER");
    }
    const { keyEnv } = PROVIDERS[preferred];
    if (!process.env[keyEnv]) throw new Error(`Missing ${keyEnv} environment variable`);
    return preferred;
  }

  const available = Object.keys(PROVIDERS).filter((provider) => process.env[PROVIDERS[provider].keyEnv]);
  if (available.length === 1) return available[0];
  if (available.length === 0) {
    throw new Error("No provider is configured. Set TYPESAFE_API_KEY for jev or OPENAI_API_KEY for openai");
  }
  throw new Error("Both providers are configured. Ask the user to choose jev or openai, or set DECISIONS_PROVIDER");
}

export async function evaluate(request, {
  provider,
  apiKey,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw new Error("Provider must be jev or openai");
  const config = PROVIDERS[provider];
  const key = apiKey ?? process.env[config.keyEnv];
  if (!key) throw new Error(`Missing ${config.keyEnv} environment variable`);
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Request must be a JSON object");
  }
  if (
    !Object.hasOwn(request, config.inputField) ||
    !request.questions || typeof request.questions !== "object" ||
    Array.isArray(request.questions) !== (provider === "openai")
  ) {
    throw new Error(`${config.name} requires ${config.inputField} and a questions ${provider === "openai" ? "array" : "map"}`);
  }

  try {
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: config.model, ...request }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      throw new Error(`${config.name} HTTP ${response.status}${retryAfter ? ` (Retry-After: ${retryAfter})` : ""}: ${await response.text()}`);
    }
    return await response.json();
  } catch (error) {
    throw new Error(String(error.message).replaceAll(key, "[REDACTED]"));
  }
}

if (
  process.argv[1] &&
  await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))
) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "provider") {
      if (args.length > 2) throw new Error("Usage: node decisions.mjs provider [jev | openai]");
      console.log(selectProvider(args[1]));
    } else {
      if (args.length !== 2 || !Object.hasOwn(PROVIDERS, args[0])) {
        throw new Error("Usage: node decisions.mjs <jev | openai> <request.json | ->, or node decisions.mjs provider [jev | openai]");
      }
      const [provider, source] = args;
      let input;
      if (source === "-") {
        input = "";
        process.stdin.setEncoding("utf8");
        for await (const chunk of process.stdin) input += chunk;
      } else {
        input = await readFile(source, "utf8");
      }
      let request;
      try {
        request = JSON.parse(input);
      } catch {
        throw new Error("Request must be valid JSON");
      }
      console.log(JSON.stringify(await evaluate(request, { provider }), null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
