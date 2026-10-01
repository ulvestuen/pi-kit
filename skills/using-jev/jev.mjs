#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function evaluate(request, {
  apiKey = process.env.TYPESAFE_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error("Missing TYPESAFE_API_KEY environment variable");
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Request must be a JSON object with state and questions");
  }

  try {
    const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "jev-latest", ...request }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      throw new Error(`JEV HTTP ${response.status}${retryAfter ? ` (Retry-After: ${retryAfter})` : ""}: ${await response.text()}`);
    }
    return await response.json();
  } catch (error) {
    throw new Error(String(error.message).replaceAll(apiKey, "[REDACTED]"));
  }
}

if (
  process.argv[1] &&
  await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))
) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw new Error("Usage: node jev.mjs <request.json | ->");
    let input;
    if (args[0] === "-") {
      input = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) input += chunk;
    } else {
      input = await readFile(args[0], "utf8");
    }
    let request;
    try {
      request = JSON.parse(input);
    } catch {
      throw new Error("Request must be valid JSON");
    }
    console.log(JSON.stringify(await evaluate(request), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
