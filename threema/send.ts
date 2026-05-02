import * as crypto from "node:crypto";
import { assertValidThreemaId, type ThreemaConfig } from "./config.ts";
import { buildThreemaTextPayload, bytesToHex, naclBox } from "./lib.ts";
import { lookupPublicKey } from "./pubkeys.ts";

async function postSendRequest(
  endpoint: "send_simple" | "send_e2e",
  body: URLSearchParams,
  recipient: string,
): Promise<string> {
  const resp = await fetch(`https://msgapi.threema.ch/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const errText = (await resp.text()).trim();
    const suffix = errText ? `: ${errText}` : "";
    throw new Error(
      `Threema API error ${resp.status} ${resp.statusText} sending to ${recipient}${suffix}`,
    );
  }

  return (await resp.text()).trim();
}

export async function sendThreemaMessage(
  text: string,
  recipientId: string,
  config: ThreemaConfig,
): Promise<string> {
  const message = text.trim();
  if (!message) {
    throw new Error("Threema message must not be empty");
  }

  const to = assertValidThreemaId("recipient", recipientId);

  if (config.mode === "basic") {
    const body = new URLSearchParams({
      from: config.apiId,
      secret: config.apiSecret,
      to,
      text: message,
    });
    return postSendRequest("send_simple", body, to);
  }

  if (!config.privateKey) {
    throw new Error("E2E mode requires a privateKey");
  }
  const recipientPublicKey = await lookupPublicKey(to, config);
  const nonce = crypto.randomBytes(24);
  const payload = buildThreemaTextPayload(message);
  const box = naclBox(payload, nonce, recipientPublicKey, config.privateKey);

  const body = new URLSearchParams({
    from: config.apiId,
    secret: config.apiSecret,
    to,
    nonce: bytesToHex(nonce),
    box: bytesToHex(box),
  });

  return postSendRequest("send_e2e", body, to);
}
