import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { ThreemaConfig } from "./config.ts";
import {
  buildThreemaTextPayload,
  bytesToHex,
  computeMac,
  naclBox,
  x25519PublicKey,
} from "./lib.ts";
import { createWebhookServer } from "./webhook.ts";

test("webhook rejects unauthorized senders and delivers an authenticated message", async () => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-threema-webhook-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const senderPrivateKey = new Uint8Array(crypto.randomBytes(32));
  const senderPublicKey = x25519PublicKey(senderPrivateKey);
  const gatewayPrivateKey = new Uint8Array(crypto.randomBytes(32));
  const port = await unusedPort();
  const config: ThreemaConfig = {
    apiId: "*GATEWY1",
    apiSecret: "gateway-secret",
    privateKey: gatewayPrivateKey,
    recipientId: "SENDER01",
    webhookPort: port,
    allowedSenders: new Set(["SENDER01"]),
    mode: "e2e",
  };
  const entries: unknown[] = [];
  const messages: Array<{ text: string; options?: unknown }> = [];
  const pi = {
    appendEntry(_type: string, entry: unknown) {
      entries.push(entry);
    },
    sendUserMessage(text: string, options?: unknown) {
      messages.push({ text, options });
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("https://msgapi.threema.ch/pubkeys/")) {
      return new Response(bytesToHex(senderPublicKey));
    }
    return originalFetch(input, init);
  };
  const webhook = createWebhookServer({
    pi: pi as any,
    config,
    isAgentBusy: () => true,
  });

  try {
    webhook.start();
    await waitUntil(() => webhook.isListening());

    const rejected = signedBody({
      from: "EVIL0001",
      to: config.apiId,
      messageId: "rejected-1",
      nonce: "00".repeat(24),
      box: "00",
    }, config.apiSecret);
    const rejectedResponse = await originalFetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      body: rejected,
    });
    assert.equal(rejectedResponse.status, 403);
    assert.equal(messages.length, 0);

    const nonce = new Uint8Array(crypto.randomBytes(24));
    const payload = buildThreemaTextPayload("Run the focused tests");
    const box = naclBox(
      payload,
      nonce,
      x25519PublicKey(gatewayPrivateKey),
      senderPrivateKey,
    );
    const accepted = signedBody({
      from: "SENDER01",
      to: config.apiId,
      messageId: "accepted-1",
      nonce: bytesToHex(nonce),
      box: bytesToHex(box),
    }, config.apiSecret);
    const acceptedResponse = await originalFetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      body: accepted,
    });

    assert.equal(acceptedResponse.status, 200);
    assert.equal(await acceptedResponse.text(), "queued");
    assert.deepEqual(messages, [{
      text: "[Threema message from SENDER01]: Run the focused tests",
      options: { deliverAs: "followUp" },
    }]);
    assert.equal(entries.length, 1);
    await webhook.flushSeen();
  } finally {
    webhook.stop();
    globalThis.fetch = originalFetch;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

function signedBody(
  fields: { from: string; to: string; messageId: string; nonce: string; box: string },
  secret: string,
) {
  const params = { ...fields, date: "1800000000" };
  return new URLSearchParams({
    ...params,
    mac: computeMac(params, secret),
  });
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
  return address.port;
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("webhook server did not start");
}
