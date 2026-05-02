import * as crypto from "node:crypto";
import nacl from "tweetnacl";

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(
      `Hex string must have an even number of characters (got ${hex.length})`,
    );
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("Hex string contains non-hex characters");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const [key, ...rest] = pair.split("=");
    const decode = (value: string) =>
      decodeURIComponent(value.replace(/\+/g, " "));
    params[decode(key)] = decode(rest.join("="));
  }
  return params;
}

export function removePkcs7Padding(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data;
  const padLen = data[data.length - 1];
  if (padLen < 1 || padLen > 255) return data;
  return data.slice(0, data.length - padLen);
}

export function verifyMac(
  params: {
    from: string;
    to: string;
    messageId: string;
    date: string;
    nonce: string;
    box: string;
    mac: string;
  },
  secret: string,
): boolean {
  const data =
    params.from +
    params.to +
    params.messageId +
    params.date +
    params.nonce +
    params.box;
  const hmac = crypto.createHmac("sha256", secret).update(data).digest("hex");
  const expected = Buffer.from(hmac, "utf8");
  const received = Buffer.from((params.mac || "").toLowerCase(), "utf8");

  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

export function computeMac(
  params: {
    from: string;
    to: string;
    messageId: string;
    date: string;
    nonce: string;
    box: string;
  },
  secret: string,
): string {
  const data =
    params.from +
    params.to +
    params.messageId +
    params.date +
    params.nonce +
    params.box;
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

export function naclBox(
  plaintext: Uint8Array,
  nonce: Uint8Array,
  recipientPublicKey: Uint8Array,
  senderPrivateKey: Uint8Array,
): Uint8Array {
  return nacl.box(plaintext, nonce, recipientPublicKey, senderPrivateKey);
}

export function naclBoxOpen(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  senderPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): Uint8Array {
  const opened = nacl.box.open(
    ciphertext,
    nonce,
    senderPublicKey,
    recipientPrivateKey,
  );
  if (opened === null) {
    throw new Error("Failed to decrypt message — authentication failed");
  }
  return opened;
}

export function x25519PublicKey(privateKey: Uint8Array): Uint8Array {
  return nacl.box.keyPair.fromSecretKey(privateKey).publicKey;
}

export function decryptMessage(
  boxHex: string,
  nonceHex: string,
  senderPublicKey: Uint8Array,
  privateKey: Uint8Array,
): string {
  const box = hexToBytes(boxHex);
  const nonce = hexToBytes(nonceHex);

  const decrypted = naclBoxOpen(box, nonce, senderPublicKey, privateKey);
  const unpadded = removePkcs7Padding(decrypted);

  const messageType = unpadded[0];
  if (messageType !== 0x01) {
    throw new Error(
      `Unsupported message type: 0x${messageType.toString(16).padStart(2, "0")} (only text messages supported)`,
    );
  }

  return new TextDecoder().decode(unpadded.slice(1));
}

function pkcs7Pad(data: Uint8Array): Uint8Array {
  let padLen = crypto.randomInt(1, 256);
  if (data.length + padLen < 32) {
    padLen = 32 - data.length;
  }

  const padded = new Uint8Array(data.length + padLen);
  padded.set(data);
  padded.fill(padLen, data.length);
  return padded;
}

export function buildThreemaTextPayload(text: string): Uint8Array {
  const textBytes = new TextEncoder().encode(text);
  const paddedText = pkcs7Pad(textBytes);
  const payload = new Uint8Array(1 + paddedText.length);
  payload[0] = 0x01; // text message type
  payload.set(paddedText, 1);
  return payload;
}
