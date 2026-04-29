import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  hexToBytes,
  bytesToHex,
  parseFormBody,
  removePkcs7Padding,
  verifyMac,
  rotl32,
  littleEndianToBigInt,
  readU32LE,
  writeU32LE,
  salsa20Rounds,
  hsalsa20,
  salsa20Block,
  poly1305,
  naclBox,
  naclBoxOpen,
  x25519PublicKey,
  decryptMessage,
  buildThreemaTextPayload,
  computeMac,
} from "./lib.ts";

// ── Helper: generate an X25519 key pair ────────────────────────────────────────

function generateKeyPair() {
  const priv = new Uint8Array(crypto.randomBytes(32));
  const pub = x25519PublicKey(priv);
  return { priv, pub };
}

// ════════════════════════════════════════════════════════════════════════════════
// hexToBytes / bytesToHex
// ════════════════════════════════════════════════════════════════════════════════

describe("hexToBytes", () => {
  it("converts empty string", () => {
    assert.deepStrictEqual(hexToBytes(""), new Uint8Array([]));
  });

  it("converts a single byte", () => {
    assert.deepStrictEqual(hexToBytes("ff"), new Uint8Array([0xff]));
  });

  it("converts multi-byte hex", () => {
    assert.deepStrictEqual(
      hexToBytes("deadbeef"),
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    );
  });

  it("handles leading zeros", () => {
    assert.deepStrictEqual(hexToBytes("000102"), new Uint8Array([0, 1, 2]));
  });

  it("handles uppercase hex", () => {
    assert.deepStrictEqual(hexToBytes("ABCD"), new Uint8Array([0xab, 0xcd]));
  });

  it("round-trips with bytesToHex", () => {
    const original = "0123456789abcdef";
    assert.strictEqual(bytesToHex(hexToBytes(original)), original);
  });

  it("rejects odd-length hex", () => {
    assert.throws(() => hexToBytes("abc"), /even number of characters/);
  });

  it("rejects invalid hex", () => {
    assert.throws(() => hexToBytes("zz"), /non-hex characters/);
  });
});

describe("bytesToHex", () => {
  it("converts empty array", () => {
    assert.strictEqual(bytesToHex(new Uint8Array([])), "");
  });

  it("converts bytes with leading zeros", () => {
    assert.strictEqual(bytesToHex(new Uint8Array([0, 1, 15, 255])), "00010fff");
  });

  it("produces lowercase hex", () => {
    assert.strictEqual(bytesToHex(new Uint8Array([0xab, 0xcd])), "abcd");
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// parseFormBody
// ════════════════════════════════════════════════════════════════════════════════

describe("parseFormBody", () => {
  it("parses simple key=value pairs", () => {
    assert.deepStrictEqual(parseFormBody("a=1&b=2"), { a: "1", b: "2" });
  });

  it("decodes URL-encoded values", () => {
    assert.deepStrictEqual(parseFormBody("msg=hello%20world"), {
      msg: "hello world",
    });
  });

  it("handles values containing '='", () => {
    assert.deepStrictEqual(parseFormBody("data=a%3Db"), { data: "a=b" });
  });

  it("handles empty value", () => {
    assert.deepStrictEqual(parseFormBody("key="), { key: "" });
  });

  it("handles URL-encoded keys", () => {
    assert.deepStrictEqual(parseFormBody("my%20key=val"), { "my key": "val" });
  });

  it("treats '+' as a space", () => {
    assert.deepStrictEqual(parseFormBody("msg=hello+world"), {
      msg: "hello world",
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// removePkcs7Padding
// ════════════════════════════════════════════════════════════════════════════════

describe("removePkcs7Padding", () => {
  it("returns empty for empty input", () => {
    assert.deepStrictEqual(
      removePkcs7Padding(new Uint8Array([])),
      new Uint8Array([]),
    );
  });

  it("removes padding of length 1", () => {
    const input = new Uint8Array([0x41, 0x42, 0x01]);
    assert.deepStrictEqual(
      removePkcs7Padding(input),
      new Uint8Array([0x41, 0x42]),
    );
  });

  it("removes padding of length 4", () => {
    const input = new Uint8Array([0x41, 0x04, 0x04, 0x04, 0x04]);
    assert.deepStrictEqual(removePkcs7Padding(input), new Uint8Array([0x41]));
  });

  it("removes full-block padding", () => {
    // 16 bytes all 0x10 = entire block is padding
    const input = new Uint8Array(16).fill(16);
    assert.deepStrictEqual(removePkcs7Padding(input), new Uint8Array([]));
  });

  it("handles data where last byte happens to look like padding", () => {
    // If last byte is 3, it removes 3 bytes regardless of content
    // This is expected PKCS#7 behavior — the caller ensures valid padding
    const input = new Uint8Array([0x10, 0x20, 0x30, 0x03]);
    assert.strictEqual(removePkcs7Padding(input).length, 1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// verifyMac / computeMac
// ════════════════════════════════════════════════════════════════════════════════

describe("verifyMac", () => {
  const secret = "testSecret123";
  const params = {
    from: "SENDER01",
    to: "*MYAPID",
    messageId: "abcdef01",
    date: "1700000000",
    nonce: "aabbccdd",
    box: "11223344",
  };

  it("verifies a correct MAC", () => {
    const mac = computeMac(params, secret);
    assert.ok(verifyMac({ ...params, mac }, secret));
  });

  it("rejects an incorrect MAC", () => {
    assert.ok(!verifyMac({ ...params, mac: "0000000000000000" }, secret));
  });

  it("rejects when a field is tampered", () => {
    const mac = computeMac(params, secret);
    assert.ok(!verifyMac({ ...params, from: "TAMPERED", mac }, secret));
  });

  it("accepts uppercase MAC hex", () => {
    const mac = computeMac(params, secret).toUpperCase();
    assert.ok(verifyMac({ ...params, mac }, secret));
  });

  it("rejects when secret differs", () => {
    const mac = computeMac(params, secret);
    assert.ok(!verifyMac({ ...params, mac }, "wrongSecret"));
  });

  it("MAC changes when any field changes", () => {
    const mac1 = computeMac(params, secret);
    const mac2 = computeMac({ ...params, date: "1700000001" }, secret);
    assert.notStrictEqual(mac1, mac2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Low-level crypto helpers
// ════════════════════════════════════════════════════════════════════════════════

describe("rotl32", () => {
  it("rotates left by 0", () => {
    assert.strictEqual(rotl32(0x12345678, 0), 0x12345678);
  });

  it("rotates left by 1", () => {
    assert.strictEqual(rotl32(1, 1), 2);
  });

  it("wraps around", () => {
    assert.strictEqual(rotl32(0x80000000, 1) >>> 0, 1);
  });

  it("rotates left by 7", () => {
    // 0x01 << 7 = 0x80
    assert.strictEqual(rotl32(1, 7), 128);
  });

  it("rotates left by 32 is identity", () => {
    assert.strictEqual(rotl32(0xdeadbeef, 32), 0xdeadbeef | 0);
  });
});

describe("readU32LE / writeU32LE", () => {
  it("round-trips a value", () => {
    const buf = new Uint8Array(4);
    writeU32LE(buf, 0, 0x04030201);
    assert.strictEqual(readU32LE(buf, 0), 0x04030201);
  });

  it("stores in little-endian order", () => {
    const buf = new Uint8Array(4);
    writeU32LE(buf, 0, 0x04030201);
    assert.deepStrictEqual(buf, new Uint8Array([0x01, 0x02, 0x03, 0x04]));
  });

  it("works at non-zero offsets", () => {
    const buf = new Uint8Array(8);
    writeU32LE(buf, 4, 0xdeadbeef);
    assert.strictEqual(readU32LE(buf, 4), 0xdeadbeef | 0);
  });

  it("handles zero", () => {
    const buf = new Uint8Array(4);
    writeU32LE(buf, 0, 0);
    assert.strictEqual(readU32LE(buf, 0), 0);
    assert.deepStrictEqual(buf, new Uint8Array([0, 0, 0, 0]));
  });

  it("handles max uint32", () => {
    const buf = new Uint8Array(4);
    writeU32LE(buf, 0, 0xffffffff);
    assert.strictEqual(readU32LE(buf, 0), -1); // signed int32 view
    assert.deepStrictEqual(buf, new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  });
});

describe("littleEndianToBigInt", () => {
  it("converts empty to 0", () => {
    assert.strictEqual(littleEndianToBigInt(new Uint8Array([])), 0n);
  });

  it("converts single byte", () => {
    assert.strictEqual(littleEndianToBigInt(new Uint8Array([0xff])), 255n);
  });

  it("uses little-endian byte order", () => {
    // 0x01 0x02 in LE = 0x0201 = 513
    assert.strictEqual(
      littleEndianToBigInt(new Uint8Array([0x01, 0x02])),
      513n,
    );
  });

  it("handles large values", () => {
    const bytes = new Uint8Array(16).fill(0xff);
    assert.strictEqual(littleEndianToBigInt(bytes), (1n << 128n) - 1n);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// HSalsa20
// ════════════════════════════════════════════════════════════════════════════════

describe("hsalsa20", () => {
  it("produces 32-byte output", () => {
    const key = new Uint8Array(32);
    const input = new Uint8Array(16);
    assert.strictEqual(hsalsa20(key, input).length, 32);
  });

  it("is deterministic", () => {
    const key = crypto.randomBytes(32);
    const input = crypto.randomBytes(16);
    const a = hsalsa20(new Uint8Array(key), new Uint8Array(input));
    const b = hsalsa20(new Uint8Array(key), new Uint8Array(input));
    assert.deepStrictEqual(a, b);
  });

  it("produces non-zero output for zero input", () => {
    const result = hsalsa20(new Uint8Array(32), new Uint8Array(16));
    assert.ok(result.some((b) => b !== 0));
  });

  it("different keys produce different outputs", () => {
    const input = new Uint8Array(16);
    const a = hsalsa20(new Uint8Array(32).fill(0), input);
    const key2 = new Uint8Array(32);
    key2[0] = 1;
    const b = hsalsa20(key2, input);
    assert.notDeepStrictEqual(a, b);
  });

  it("different inputs produce different outputs", () => {
    const key = new Uint8Array(32);
    const a = hsalsa20(key, new Uint8Array(16).fill(0));
    const input2 = new Uint8Array(16);
    input2[0] = 1;
    const b = hsalsa20(key, input2);
    assert.notDeepStrictEqual(a, b);
  });

  // Verify HSalsa20 via a NaCl crypto_box round-trip:
  // If HSalsa20 were wrong, naclBox/naclBoxOpen would fail, but we also verify
  // that the subkey derivation is consistent across encrypt and decrypt.
  it("produces consistent subkeys for encrypt and decrypt", () => {
    const sharedSecret = new Uint8Array(crypto.randomBytes(32));
    const nonce16 = new Uint8Array(crypto.randomBytes(16));
    const subkey1 = hsalsa20(sharedSecret, nonce16);
    const subkey2 = hsalsa20(sharedSecret, nonce16);
    assert.deepStrictEqual(subkey1, subkey2);
    // Changing one byte of input must change the output
    const altered = new Uint8Array(nonce16);
    altered[0] ^= 1;
    const subkey3 = hsalsa20(sharedSecret, altered);
    assert.notDeepStrictEqual(subkey1, subkey3);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Salsa20 block
// ════════════════════════════════════════════════════════════════════════════════

describe("salsa20Block", () => {
  it("produces 64-byte output", () => {
    const key = new Uint8Array(32);
    const nonce = new Uint8Array(8);
    assert.strictEqual(salsa20Block(key, nonce, 0).length, 64);
  });

  it("is deterministic", () => {
    const key = new Uint8Array(crypto.randomBytes(32));
    const nonce = new Uint8Array(crypto.randomBytes(8));
    const a = salsa20Block(key, nonce, 0);
    const b = salsa20Block(key, nonce, 0);
    assert.deepStrictEqual(a, b);
  });

  it("different counters produce different blocks", () => {
    const key = new Uint8Array(32);
    const nonce = new Uint8Array(8);
    const a = salsa20Block(key, nonce, 0);
    const b = salsa20Block(key, nonce, 1);
    assert.notDeepStrictEqual(a, b);
  });

  it("different nonces produce different blocks", () => {
    const key = new Uint8Array(32);
    const n1 = new Uint8Array(8).fill(0);
    const n2 = new Uint8Array(8);
    n2[0] = 1;
    const a = salsa20Block(key, n1, 0);
    const b = salsa20Block(key, n2, 0);
    assert.notDeepStrictEqual(a, b);
  });

  it("different keys produce different blocks", () => {
    const nonce = new Uint8Array(8);
    const k1 = new Uint8Array(32).fill(0);
    const k2 = new Uint8Array(32);
    k2[0] = 1;
    const a = salsa20Block(k1, nonce, 0);
    const b = salsa20Block(k2, nonce, 0);
    assert.notDeepStrictEqual(a, b);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// salsa20Rounds
// ════════════════════════════════════════════════════════════════════════════════

describe("salsa20Rounds", () => {
  it("mutates the state array in place", () => {
    const s = new Int32Array(16).fill(0);
    s[0] = 0x61707865;
    s[5] = 0x3320646e;
    s[10] = 0x79622d32;
    s[15] = 0x6b206574;
    const before = Int32Array.from(s);
    salsa20Rounds(s);
    // After 20 rounds with sigma constants, state should change
    let changed = false;
    for (let i = 0; i < 16; i++) {
      if (s[i] !== before[i]) {
        changed = true;
        break;
      }
    }
    assert.ok(changed, "state should be mutated");
  });

  it("is deterministic", () => {
    const s1 = new Int32Array([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    const s2 = Int32Array.from(s1);
    salsa20Rounds(s1);
    salsa20Rounds(s2);
    assert.deepStrictEqual(s1, s2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Poly1305
// ════════════════════════════════════════════════════════════════════════════════

describe("poly1305", () => {
  it("produces 16-byte output", () => {
    const data = new Uint8Array(32);
    const key = new Uint8Array(32);
    assert.strictEqual(poly1305(data, key).length, 16);
  });

  it("is deterministic", () => {
    const data = new Uint8Array(crypto.randomBytes(64));
    const key = new Uint8Array(crypto.randomBytes(32));
    const a = poly1305(data, key);
    const b = poly1305(data, key);
    assert.deepStrictEqual(a, b);
  });

  it("different data produces different tags", () => {
    const key = new Uint8Array(crypto.randomBytes(32));
    const a = poly1305(new Uint8Array([1, 2, 3]), key);
    const b = poly1305(new Uint8Array([4, 5, 6]), key);
    assert.notDeepStrictEqual(a, b);
  });

  it("handles empty data", () => {
    const key = new Uint8Array(32);
    const tag = poly1305(new Uint8Array([]), key);
    assert.strictEqual(tag.length, 16);
  });

  it("handles data shorter than one block (< 16 bytes)", () => {
    const key = new Uint8Array(crypto.randomBytes(32));
    const tag = poly1305(new Uint8Array([0x01, 0x02, 0x03]), key);
    assert.strictEqual(tag.length, 16);
  });

  it("handles data exactly one block (16 bytes)", () => {
    const key = new Uint8Array(crypto.randomBytes(32));
    const tag = poly1305(new Uint8Array(16).fill(0xaa), key);
    assert.strictEqual(tag.length, 16);
  });

  it("handles multi-block data", () => {
    const key = new Uint8Array(crypto.randomBytes(32));
    const data = new Uint8Array(100).fill(0x42);
    const tag = poly1305(data, key);
    assert.strictEqual(tag.length, 16);
  });

  // RFC 7539 Section 2.5.2 test vector
  it("matches RFC 7539 test vector", () => {
    const msg = new TextEncoder().encode("Cryptographic Forum Research Group");
    const key = hexToBytes(
      "85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b",
    );
    const expected = hexToBytes("a8061dc1305136c6c22b8baf0c0127a9");
    assert.deepStrictEqual(poly1305(msg, key), expected);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// X25519 key pair
// ════════════════════════════════════════════════════════════════════════════════

describe("x25519PublicKey", () => {
  it("produces 32-byte public key", () => {
    const priv = new Uint8Array(crypto.randomBytes(32));
    assert.strictEqual(x25519PublicKey(priv).length, 32);
  });

  it("is deterministic for same private key", () => {
    const priv = new Uint8Array(crypto.randomBytes(32));
    assert.deepStrictEqual(x25519PublicKey(priv), x25519PublicKey(priv));
  });

  it("different private keys give different public keys", () => {
    const a = x25519PublicKey(new Uint8Array(crypto.randomBytes(32)));
    const b = x25519PublicKey(new Uint8Array(crypto.randomBytes(32)));
    assert.notDeepStrictEqual(a, b);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// naclBox / naclBoxOpen — round-trip tests
// ════════════════════════════════════════════════════════════════════════════════

describe("naclBox / naclBoxOpen", () => {
  it("round-trips a short message", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const msg = new TextEncoder().encode("Hello!");

    const box = naclBox(msg, nonce, bob.pub, alice.priv);
    const opened = naclBoxOpen(box, nonce, alice.pub, bob.priv);
    assert.deepStrictEqual(opened, msg);
  });

  it("round-trips an empty message", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const msg = new Uint8Array(0);

    const box = naclBox(msg, nonce, bob.pub, alice.priv);
    assert.strictEqual(box.length, 16); // tag only, no payload
    const opened = naclBoxOpen(box, nonce, alice.pub, bob.priv);
    assert.deepStrictEqual(opened, msg);
  });

  it("round-trips a 1-byte message", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const msg = new Uint8Array([0x42]);

    const box = naclBox(msg, nonce, bob.pub, alice.priv);
    const opened = naclBoxOpen(box, nonce, alice.pub, bob.priv);
    assert.deepStrictEqual(opened, msg);
  });

  it("round-trips exactly 64 bytes (one Salsa20 block boundary)", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const msg = new Uint8Array(64).fill(0xaa);

    const box = naclBox(msg, nonce, bob.pub, alice.priv);
    const opened = naclBoxOpen(box, nonce, alice.pub, bob.priv);
    assert.deepStrictEqual(opened, msg);
  });

  it("round-trips 65 bytes (crosses block boundary)", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const msg = new Uint8Array(65).fill(0xbb);

    const box = naclBox(msg, nonce, bob.pub, alice.priv);
    const opened = naclBoxOpen(box, nonce, alice.pub, bob.priv);
    assert.deepStrictEqual(opened, msg);
  });

  it("round-trips 200 bytes (multi-block)", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const msg = new Uint8Array(crypto.randomBytes(200));

    const box = naclBox(msg, nonce, bob.pub, alice.priv);
    const opened = naclBoxOpen(box, nonce, alice.pub, bob.priv);
    assert.deepStrictEqual(opened, msg);
  });

  it("round-trips 1000 bytes", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const msg = new Uint8Array(crypto.randomBytes(1000));

    const box = naclBox(msg, nonce, bob.pub, alice.priv);
    const opened = naclBoxOpen(box, nonce, alice.pub, bob.priv);
    assert.deepStrictEqual(opened, msg);
  });

  it("round-trips UTF-8 text with multibyte characters", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const msg = new TextEncoder().encode("Héllo wörld! 🎉🔐");

    const box = naclBox(msg, nonce, bob.pub, alice.priv);
    const opened = naclBoxOpen(box, nonce, alice.pub, bob.priv);
    assert.strictEqual(new TextDecoder().decode(opened), "Héllo wörld! 🎉🔐");
  });

  it("ciphertext length is plaintext + 16 (tag)", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const msg = new Uint8Array(42);

    const box = naclBox(msg, nonce, bob.pub, alice.priv);
    assert.strictEqual(box.length, 42 + 16);
  });

  it("same plaintext + same nonce + same keys = same ciphertext", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const msg = new TextEncoder().encode("deterministic");

    const box1 = naclBox(msg, nonce, bob.pub, alice.priv);
    const box2 = naclBox(msg, nonce, bob.pub, alice.priv);
    assert.deepStrictEqual(box1, box2);
  });

  it("different nonces produce different ciphertext", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const msg = new TextEncoder().encode("same message");

    const box1 = naclBox(
      msg,
      new Uint8Array(crypto.randomBytes(24)),
      bob.pub,
      alice.priv,
    );
    const box2 = naclBox(
      msg,
      new Uint8Array(crypto.randomBytes(24)),
      bob.pub,
      alice.priv,
    );
    assert.notDeepStrictEqual(box1, box2);
  });

  it("ECDH is symmetric: alice->bob and bob->alice share secret", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const msg = new TextEncoder().encode("symmetry");

    // Alice encrypts to Bob
    const box = naclBox(msg, nonce, bob.pub, alice.priv);
    // Bob decrypts from Alice
    const opened = naclBoxOpen(box, nonce, alice.pub, bob.priv);
    assert.deepStrictEqual(opened, msg);

    // Bob encrypts to Alice
    const box2 = naclBox(msg, nonce, alice.pub, bob.priv);
    // Alice decrypts from Bob
    const opened2 = naclBoxOpen(box2, nonce, bob.pub, alice.priv);
    assert.deepStrictEqual(opened2, msg);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// naclBoxOpen — authentication / rejection tests
// ════════════════════════════════════════════════════════════════════════════════

describe("naclBoxOpen authentication", () => {
  it("rejects tampered tag", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const box = naclBox(
      new TextEncoder().encode("test"),
      nonce,
      bob.pub,
      alice.priv,
    );

    box[0] ^= 0xff; // flip a bit in the tag
    assert.throws(
      () => naclBoxOpen(box, nonce, alice.pub, bob.priv),
      /authentication failed/,
    );
  });

  it("rejects tampered ciphertext", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const box = naclBox(
      new TextEncoder().encode("test"),
      nonce,
      bob.pub,
      alice.priv,
    );

    box[16] ^= 0xff; // flip a bit in the ciphertext (after the 16-byte tag)
    assert.throws(
      () => naclBoxOpen(box, nonce, alice.pub, bob.priv),
      /authentication failed/,
    );
  });

  it("rejects wrong sender public key", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const eve = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const box = naclBox(
      new TextEncoder().encode("test"),
      nonce,
      bob.pub,
      alice.priv,
    );

    assert.throws(
      () => naclBoxOpen(box, nonce, eve.pub, bob.priv), // wrong sender key
      /authentication failed/,
    );
  });

  it("rejects wrong recipient private key", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const eve = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const box = naclBox(
      new TextEncoder().encode("test"),
      nonce,
      bob.pub,
      alice.priv,
    );

    assert.throws(
      () => naclBoxOpen(box, nonce, alice.pub, eve.priv), // wrong private key
      /authentication failed/,
    );
  });

  it("rejects wrong nonce", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const wrongNonce = new Uint8Array(crypto.randomBytes(24));
    const box = naclBox(
      new TextEncoder().encode("test"),
      nonce,
      bob.pub,
      alice.priv,
    );

    assert.throws(
      () => naclBoxOpen(box, wrongNonce, alice.pub, bob.priv),
      /authentication failed/,
    );
  });

  it("rejects truncated ciphertext", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const box = naclBox(
      new TextEncoder().encode("test message"),
      nonce,
      bob.pub,
      alice.priv,
    );

    // Truncate to just tag + partial ciphertext
    const truncated = box.slice(0, 20);
    assert.throws(
      () => naclBoxOpen(truncated, nonce, alice.pub, bob.priv),
      /authentication failed/,
    );
  });

  it("rejects appended data", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const box = naclBox(
      new TextEncoder().encode("test"),
      nonce,
      bob.pub,
      alice.priv,
    );

    const extended = new Uint8Array(box.length + 1);
    extended.set(box);
    extended[box.length] = 0x42;
    assert.throws(
      () => naclBoxOpen(extended, nonce, alice.pub, bob.priv),
      /authentication failed/,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// buildThreemaTextPayload
// ════════════════════════════════════════════════════════════════════════════════

describe("buildThreemaTextPayload", () => {
  it("starts with 0x01 type byte", () => {
    const payload = buildThreemaTextPayload("hi");
    assert.strictEqual(payload[0], 0x01);
  });

  it("contains the text after the type byte", () => {
    const payload = buildThreemaTextPayload("hi");
    // bytes 1..2 are "hi", rest is padding
    assert.strictEqual(payload[1], "h".charCodeAt(0));
    assert.strictEqual(payload[2], "i".charCodeAt(0));
  });

  it("pads short messages to at least 32 bytes", () => {
    const payload = buildThreemaTextPayload("hi");
    assert.ok(payload.length >= 32);
  });

  it("applies PKCS#7 padding", () => {
    const payload = buildThreemaTextPayload("hi");
    // 1 (type) + 2 (text) = 3 bytes content, pad to 32 = 29 bytes padding
    const padLen = payload[payload.length - 1];
    assert.strictEqual(padLen, 29);
    // All padding bytes should equal padLen
    for (let i = payload.length - padLen; i < payload.length; i++) {
      assert.strictEqual(payload[i], padLen);
    }
  });

  it("round-trips through removePkcs7Padding", () => {
    const payload = buildThreemaTextPayload("hello");
    const unpadded = removePkcs7Padding(payload);
    assert.strictEqual(unpadded[0], 0x01);
    assert.strictEqual(new TextDecoder().decode(unpadded.slice(1)), "hello");
  });

  it("handles long messages (> 31 bytes of text)", () => {
    const longText = "A".repeat(100);
    const payload = buildThreemaTextPayload(longText);
    assert.ok(payload.length > 100);
    const unpadded = removePkcs7Padding(payload);
    assert.strictEqual(new TextDecoder().decode(unpadded.slice(1)), longText);
  });

  it("handles empty text", () => {
    const payload = buildThreemaTextPayload("");
    assert.strictEqual(payload[0], 0x01);
    assert.ok(payload.length >= 32);
    const unpadded = removePkcs7Padding(payload);
    assert.strictEqual(unpadded.length, 1); // just the type byte
  });

  it("handles UTF-8 multibyte text", () => {
    const payload = buildThreemaTextPayload("🔐");
    const unpadded = removePkcs7Padding(payload);
    assert.strictEqual(new TextDecoder().decode(unpadded.slice(1)), "🔐");
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// decryptMessage — full Threema E2E message decryption
// ════════════════════════════════════════════════════════════════════════════════

describe("decryptMessage", () => {
  it("decrypts a valid Threema text message", () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const payload = buildThreemaTextPayload("Hello from Threema");

    const box = naclBox(payload, nonce, recipient.pub, sender.priv);

    const text = decryptMessage(
      bytesToHex(box),
      bytesToHex(nonce),
      sender.pub,
      recipient.priv,
    );
    assert.strictEqual(text, "Hello from Threema");
  });

  it("decrypts a long message", () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const longText = "Testing a longer Threema message. ".repeat(20);
    const payload = buildThreemaTextPayload(longText);

    const box = naclBox(payload, nonce, recipient.pub, sender.priv);
    const text = decryptMessage(
      bytesToHex(box),
      bytesToHex(nonce),
      sender.pub,
      recipient.priv,
    );
    assert.strictEqual(text, longText);
  });

  it("decrypts UTF-8 message with emoji", () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const payload = buildThreemaTextPayload("Hej! 🇸🇪 Tjena!");

    const box = naclBox(payload, nonce, recipient.pub, sender.priv);
    const text = decryptMessage(
      bytesToHex(box),
      bytesToHex(nonce),
      sender.pub,
      recipient.priv,
    );
    assert.strictEqual(text, "Hej! 🇸🇪 Tjena!");
  });

  it("rejects non-text message types", () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));

    // Build a location message (type 0x10) instead of text (0x01)
    const fakePayload = new Uint8Array(32);
    fakePayload[0] = 0x10; // location type
    fakePayload.fill(31, 1); // PKCS#7 padding

    const box = naclBox(fakePayload, nonce, recipient.pub, sender.priv);
    assert.throws(
      () =>
        decryptMessage(
          bytesToHex(box),
          bytesToHex(nonce),
          sender.pub,
          recipient.priv,
        ),
      /Unsupported message type: 0x10/,
    );
  });

  it("rejects delivery receipt type (0x80)", () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));

    const fakePayload = new Uint8Array(32);
    fakePayload[0] = 0x80;
    fakePayload.fill(31, 1);

    const box = naclBox(fakePayload, nonce, recipient.pub, sender.priv);
    assert.throws(
      () =>
        decryptMessage(
          bytesToHex(box),
          bytesToHex(nonce),
          sender.pub,
          recipient.priv,
        ),
      /Unsupported message type: 0x80/,
    );
  });

  it("fails with wrong private key", () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const eve = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const payload = buildThreemaTextPayload("secret");

    const box = naclBox(payload, nonce, recipient.pub, sender.priv);
    assert.throws(
      () =>
        decryptMessage(
          bytesToHex(box),
          bytesToHex(nonce),
          sender.pub,
          eve.priv,
        ),
      /authentication failed/,
    );
  });

  it("fails with tampered box hex", () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const payload = buildThreemaTextPayload("secret");

    const box = naclBox(payload, nonce, recipient.pub, sender.priv);
    const boxHex = bytesToHex(box);
    // Flip a character in the middle of the hex string
    const tampered = boxHex.slice(0, 40) + "ff" + boxHex.slice(42);
    assert.throws(
      () =>
        decryptMessage(tampered, bytesToHex(nonce), sender.pub, recipient.priv),
      /authentication failed/,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// End-to-end webhook simulation
// ════════════════════════════════════════════════════════════════════════════════

describe("end-to-end webhook payload simulation", () => {
  it("simulates a complete incoming Threema webhook message", () => {
    // Simulate: a Threema user sends a message, Gateway POSTs to webhook
    const senderKeyPair = generateKeyPair();
    const gatewayKeyPair = generateKeyPair();

    const apiSecret = "myGatewaySecret123";
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const messageText = "Please run the tests for me";

    // 1. Sender encrypts a Threema text payload
    const payload = buildThreemaTextPayload(messageText);
    const box = naclBox(payload, nonce, gatewayKeyPair.pub, senderKeyPair.priv);

    const nonceHex = bytesToHex(nonce);
    const boxHex = bytesToHex(box);

    // 2. Build the webhook POST params (as Threema Gateway would send)
    const webhookParams: {
      from: string;
      to: string;
      messageId: string;
      date: string;
      nonce: string;
      box: string;
      mac: string;
    } = {
      from: "SENDER01",
      to: "*GATEWAY",
      messageId: bytesToHex(new Uint8Array(crypto.randomBytes(8))),
      date: String(Math.floor(Date.now() / 1000)),
      nonce: nonceHex,
      box: boxHex,
      mac: "",
    };
    webhookParams.mac = computeMac(webhookParams, apiSecret);

    // 3. Verify MAC (as the webhook handler would)
    assert.ok(verifyMac(webhookParams, apiSecret));

    // 4. Decrypt (as the webhook handler would)
    const decrypted = decryptMessage(
      webhookParams.box,
      webhookParams.nonce,
      senderKeyPair.pub,
      gatewayKeyPair.priv,
    );
    assert.strictEqual(decrypted, messageText);
  });

  it("simulates MAC rejection for tampered webhook", () => {
    const apiSecret = "secret";
    const params = {
      from: "SENDER01",
      to: "*GATEWAY",
      messageId: "aabbccdd",
      date: "1700000000",
      nonce: "1234",
      box: "5678",
    };
    const mac = computeMac(params, apiSecret);

    // Tamper with the 'from' field
    assert.ok(
      !verifyMac({ ...params, from: "EVILDOER", mac } as any, apiSecret),
    );
  });

  it("serializes and deserializes webhook form body correctly", () => {
    const params = {
      from: "SENDER01",
      to: "*GATEWAY",
      messageId: "aabb",
      date: "1700000000",
      nonce: "ccdd",
      box: "eeff",
      mac: "0011",
    };

    const formBody = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const parsed = parseFormBody(formBody);
    assert.deepStrictEqual(parsed, params);
  });
});
