import { assertValidThreemaId, type ThreemaConfig } from "./config.ts";
import { hexToBytes } from "./lib.ts";

const PUBLIC_KEY_TTL_MS = 60 * 60 * 1000;

interface CachedPublicKey {
  key: Uint8Array;
  expiresAt: number;
}

const publicKeyCache = new Map<string, CachedPublicKey>();

export async function lookupPublicKey(
  threemaId: string,
  config: ThreemaConfig,
): Promise<Uint8Array> {
  const normalizedId = assertValidThreemaId("Public key lookup ID", threemaId);
  const cached = publicKeyCache.get(normalizedId);
  if (cached && cached.expiresAt > Date.now()) return cached.key;

  const url = `https://msgapi.threema.ch/pubkeys/${normalizedId}?from=${encodeURIComponent(config.apiId)}&secret=${encodeURIComponent(config.apiSecret)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `Failed to look up public key for ${normalizedId}: ${resp.status} ${resp.statusText}`,
    );
  }
  const hexKey = (await resp.text()).trim();
  const key = hexToBytes(hexKey);
  if (key.length !== 32) {
    throw new Error(
      `Unexpected public key length for ${normalizedId}: ${key.length} bytes`,
    );
  }
  publicKeyCache.set(normalizedId, {
    key,
    expiresAt: Date.now() + PUBLIC_KEY_TTL_MS,
  });
  return key;
}
