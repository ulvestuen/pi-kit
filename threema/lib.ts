import * as crypto from "node:crypto";

// ── Helpers ────────────────────────────────────────────────────────────────────

export function hexToBytes(hex: string): Uint8Array {
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
    const [key, ...rest] = pair.split("=");
    params[decodeURIComponent(key)] = decodeURIComponent(rest.join("="));
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
  params: Record<string, string>,
  secret: string
): boolean {
  const data =
    params.from + params.to + params.messageId + params.date + params.nonce + params.box;
  const hmac = crypto.createHmac("sha256", secret).update(data).digest("hex");
  return hmac === params.mac;
}

// ── NaCl crypto primitives ─────────────────────────────────────────────────────

export function rotl32(x: number, n: number): number {
  return (x << n) | (x >>> (32 - n));
}

export function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

export function salsa20Rounds(s: Int32Array): void {
  for (let i = 0; i < 20; i += 2) {
    // Column round
    s[4] ^= rotl32((s[0] + s[12]) | 0, 7);
    s[8] ^= rotl32((s[4] + s[0]) | 0, 9);
    s[12] ^= rotl32((s[8] + s[4]) | 0, 13);
    s[0] ^= rotl32((s[12] + s[8]) | 0, 18);
    s[9] ^= rotl32((s[5] + s[1]) | 0, 7);
    s[13] ^= rotl32((s[9] + s[5]) | 0, 9);
    s[1] ^= rotl32((s[13] + s[9]) | 0, 13);
    s[5] ^= rotl32((s[1] + s[13]) | 0, 18);
    s[14] ^= rotl32((s[10] + s[6]) | 0, 7);
    s[2] ^= rotl32((s[14] + s[10]) | 0, 9);
    s[6] ^= rotl32((s[2] + s[14]) | 0, 13);
    s[10] ^= rotl32((s[6] + s[2]) | 0, 18);
    s[3] ^= rotl32((s[15] + s[11]) | 0, 7);
    s[7] ^= rotl32((s[3] + s[15]) | 0, 9);
    s[11] ^= rotl32((s[7] + s[3]) | 0, 13);
    s[15] ^= rotl32((s[11] + s[7]) | 0, 18);
    // Row round
    s[1] ^= rotl32((s[0] + s[3]) | 0, 7);
    s[2] ^= rotl32((s[1] + s[0]) | 0, 9);
    s[3] ^= rotl32((s[2] + s[1]) | 0, 13);
    s[0] ^= rotl32((s[3] + s[2]) | 0, 18);
    s[6] ^= rotl32((s[5] + s[4]) | 0, 7);
    s[7] ^= rotl32((s[6] + s[5]) | 0, 9);
    s[4] ^= rotl32((s[7] + s[6]) | 0, 13);
    s[5] ^= rotl32((s[4] + s[7]) | 0, 18);
    s[11] ^= rotl32((s[10] + s[9]) | 0, 7);
    s[8] ^= rotl32((s[11] + s[10]) | 0, 9);
    s[9] ^= rotl32((s[8] + s[11]) | 0, 13);
    s[10] ^= rotl32((s[9] + s[8]) | 0, 18);
    s[12] ^= rotl32((s[15] + s[14]) | 0, 7);
    s[13] ^= rotl32((s[12] + s[15]) | 0, 9);
    s[14] ^= rotl32((s[13] + s[12]) | 0, 13);
    s[15] ^= rotl32((s[14] + s[13]) | 0, 18);
  }
}

export function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    buf[offset] |
    (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16) |
    (buf[offset + 3] << 24)
  );
}

export function writeU32LE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
  buf[offset + 2] = (val >>> 16) & 0xff;
  buf[offset + 3] = (val >>> 24) & 0xff;
}

export function hsalsa20(key: Uint8Array, input: Uint8Array): Uint8Array {
  const s = new Int32Array([
    0x61707865,
    readU32LE(key, 0),
    readU32LE(key, 4),
    readU32LE(key, 8),
    readU32LE(key, 12),
    0x3320646e,
    readU32LE(input, 0),
    readU32LE(input, 4),
    readU32LE(input, 8),
    readU32LE(input, 12),
    0x79622d32,
    readU32LE(key, 16),
    readU32LE(key, 20),
    readU32LE(key, 24),
    readU32LE(key, 28),
    0x6b206574,
  ]);

  salsa20Rounds(s);

  const out = new Uint8Array(32);
  writeU32LE(out, 0, s[0]);
  writeU32LE(out, 4, s[5]);
  writeU32LE(out, 8, s[10]);
  writeU32LE(out, 12, s[15]);
  writeU32LE(out, 16, s[6]);
  writeU32LE(out, 20, s[7]);
  writeU32LE(out, 24, s[8]);
  writeU32LE(out, 28, s[9]);
  return out;
}

export function salsa20Block(key: Uint8Array, nonce8: Uint8Array, counter: number): Uint8Array {
  const s = new Int32Array([
    0x61707865,
    readU32LE(key, 0),
    readU32LE(key, 4),
    readU32LE(key, 8),
    readU32LE(key, 12),
    0x3320646e,
    readU32LE(nonce8, 0),
    readU32LE(nonce8, 4),
    counter | 0,
    0,
    0x79622d32,
    readU32LE(key, 16),
    readU32LE(key, 20),
    readU32LE(key, 24),
    readU32LE(key, 28),
    0x6b206574,
  ]);

  const j = Int32Array.from(s);
  salsa20Rounds(s);

  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    writeU32LE(out, i * 4, (s[i] + j[i]) | 0);
  }
  return out;
}

export function poly1305(data: Uint8Array, key: Uint8Array): Uint8Array {
  const rBytes = new Uint8Array(key.slice(0, 16));
  rBytes[3] &= 15;
  rBytes[7] &= 15;
  rBytes[11] &= 15;
  rBytes[15] &= 15;
  rBytes[4] &= 252;
  rBytes[8] &= 252;
  rBytes[12] &= 252;
  const r = littleEndianToBigInt(rBytes);
  const s = littleEndianToBigInt(key.slice(16, 32));
  const p = (1n << 130n) - 5n;

  let acc = 0n;
  for (let i = 0; i < data.length; i += 16) {
    const end = Math.min(i + 16, data.length);
    const block = new Uint8Array(end - i + 1);
    block.set(data.slice(i, end));
    block[end - i] = 1;
    acc = ((acc + littleEndianToBigInt(block)) * r) % p;
  }
  acc = (acc + s) & ((1n << 128n) - 1n);

  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number((acc >> BigInt(i * 8)) & 0xffn);
  }
  return out;
}

export function naclBoxOpen(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  senderPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array
): Uint8Array {
  const myPrivKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b656e04220420", "hex"),
      recipientPrivateKey,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const theirPubKey = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b656e032100", "hex"),
      senderPublicKey,
    ]),
    format: "der",
    type: "spki",
  });
  const sharedSecret = new Uint8Array(
    crypto.diffieHellman({ privateKey: myPrivKey, publicKey: theirPubKey })
  );

  const subkey = hsalsa20(sharedSecret, nonce.slice(0, 16));
  const subNonce = nonce.slice(16, 24);

  const tag = ciphertext.slice(0, 16);
  const encrypted = ciphertext.slice(16);

  const block0 = salsa20Block(subkey, subNonce, 0);
  const polyKey = block0.slice(0, 32);

  const computedTag = poly1305(encrypted, polyKey);
  if (!crypto.timingSafeEqual(Buffer.from(computedTag), Buffer.from(tag))) {
    throw new Error("Failed to decrypt message — authentication failed");
  }

  const plaintext = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i += 64) {
    const counter = Math.floor(i / 64) + 1;
    const keystream = salsa20Block(subkey, subNonce, counter);
    const end = Math.min(64, encrypted.length - i);
    for (let j = 0; j < end; j++) {
      plaintext[i + j] = encrypted[i + j] ^ keystream[j];
    }
  }

  return plaintext;
}

export function naclBox(
  plaintext: Uint8Array,
  nonce: Uint8Array,
  recipientPublicKey: Uint8Array,
  senderPrivateKey: Uint8Array
): Uint8Array {
  const myPrivKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b656e04220420", "hex"),
      senderPrivateKey,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const theirPubKey = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b656e032100", "hex"),
      recipientPublicKey,
    ]),
    format: "der",
    type: "spki",
  });
  const sharedSecret = new Uint8Array(
    crypto.diffieHellman({ privateKey: myPrivKey, publicKey: theirPubKey })
  );

  const subkey = hsalsa20(sharedSecret, nonce.slice(0, 16));
  const subNonce = nonce.slice(16, 24);

  const encrypted = new Uint8Array(plaintext.length);
  for (let i = 0; i < plaintext.length; i += 64) {
    const counter = Math.floor(i / 64) + 1;
    const keystream = salsa20Block(subkey, subNonce, counter);
    const end = Math.min(64, plaintext.length - i);
    for (let j = 0; j < end; j++) {
      encrypted[i + j] = plaintext[i + j] ^ keystream[j];
    }
  }

  const block0 = salsa20Block(subkey, subNonce, 0);
  const polyKey = block0.slice(0, 32);
  const tag = poly1305(encrypted, polyKey);

  const result = new Uint8Array(16 + encrypted.length);
  result.set(tag);
  result.set(encrypted, 16);
  return result;
}

export function x25519PublicKey(privateKey: Uint8Array): Uint8Array {
  const privKeyObj = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b656e04220420", "hex"),
      privateKey,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const pubKeyDer = crypto.createPublicKey(privKeyObj).export({ format: "der", type: "spki" });
  return new Uint8Array(pubKeyDer.slice(12));
}

export function decryptMessage(
  boxHex: string,
  nonceHex: string,
  senderPublicKey: Uint8Array,
  privateKey: Uint8Array
): string {
  const box = hexToBytes(boxHex);
  const nonce = hexToBytes(nonceHex);

  const decrypted = naclBoxOpen(box, nonce, senderPublicKey, privateKey);
  const unpadded = removePkcs7Padding(decrypted);

  const messageType = unpadded[0];
  if (messageType !== 0x01) {
    throw new Error(
      `Unsupported message type: 0x${messageType.toString(16).padStart(2, "0")} (only text messages supported)`
    );
  }

  return new TextDecoder().decode(unpadded.slice(1));
}

// Build a Threema-format E2E encrypted text message payload (for testing)
export function buildThreemaTextPayload(text: string): Uint8Array {
  const textBytes = new TextEncoder().encode(text);
  const payload = new Uint8Array(1 + textBytes.length);
  payload[0] = 0x01; // text message type
  payload.set(textBytes, 1);
  // PKCS#7 pad to minimum 32 bytes
  const minLen = 32;
  if (payload.length >= minLen) {
    const padLen = 1;
    const padded = new Uint8Array(payload.length + padLen);
    padded.set(payload);
    padded.fill(padLen, payload.length);
    return padded;
  }
  const padLen = minLen - payload.length;
  const padded = new Uint8Array(minLen);
  padded.set(payload);
  padded.fill(padLen, payload.length);
  return padded;
}

export function computeMac(
  params: { from: string; to: string; messageId: string; date: string; nonce: string; box: string },
  secret: string
): string {
  const data = params.from + params.to + params.messageId + params.date + params.nonce + params.box;
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}
