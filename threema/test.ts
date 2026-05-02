import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  hexToBytes,
  bytesToHex,
  parseFormBody,
  removePkcs7Padding,
  verifyMac,
  naclBox,
  naclBoxOpen,
  x25519PublicKey,
  decryptMessage,
  buildThreemaTextPayload,
  computeMac,
} from "./lib.ts";

function generateKeyPair() {
  const priv = new Uint8Array(crypto.randomBytes(32));
  const pub = x25519PublicKey(priv);
  return { priv, pub };
}

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
    const input = new Uint8Array(16).fill(16);
    assert.deepStrictEqual(removePkcs7Padding(input), new Uint8Array([]));
  });

  it("handles data where last byte happens to look like padding", () => {
    const input = new Uint8Array([0x10, 0x20, 0x30, 0x03]);
    assert.strictEqual(removePkcs7Padding(input).length, 1);
  });
});

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

    const box = naclBox(msg, nonce, bob.pub, alice.priv);
    const opened = naclBoxOpen(box, nonce, alice.pub, bob.priv);
    assert.deepStrictEqual(opened, msg);

    const box2 = naclBox(msg, nonce, alice.pub, bob.priv);
    const opened2 = naclBoxOpen(box2, nonce, bob.pub, alice.priv);
    assert.deepStrictEqual(opened2, msg);
  });
});

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

    box[0] ^= 0xff;
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

    box[16] ^= 0xff;
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
      () => naclBoxOpen(box, nonce, eve.pub, bob.priv),
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
      () => naclBoxOpen(box, nonce, alice.pub, eve.priv),
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

describe("buildThreemaTextPayload", () => {
  it("starts with 0x01 type byte", () => {
    const payload = buildThreemaTextPayload("hi");
    assert.strictEqual(payload[0], 0x01);
  });

  it("contains the text after the type byte", () => {
    const payload = buildThreemaTextPayload("hi");
    assert.strictEqual(payload[1], "h".charCodeAt(0));
    assert.strictEqual(payload[2], "i".charCodeAt(0));
  });

  it("pads the inner message data to at least 32 bytes", () => {
    const payload = buildThreemaTextPayload("hi");
    assert.ok(payload.slice(1).length >= 32);
  });

  it("applies PKCS#7 padding", () => {
    const payload = buildThreemaTextPayload("hi");
    const paddedData = payload.slice(1);
    const padLen = payload[payload.length - 1];
    assert.ok(padLen >= 1 && padLen <= 255);
    assert.ok(paddedData.length >= 32);
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
    assert.ok(payload.slice(1).length >= 32);
    const unpadded = removePkcs7Padding(payload);
    assert.strictEqual(unpadded.length, 1);
  });

  it("handles UTF-8 multibyte text", () => {
    const payload = buildThreemaTextPayload("🔐");
    const unpadded = removePkcs7Padding(payload);
    assert.strictEqual(new TextDecoder().decode(unpadded.slice(1)), "🔐");
  });
});

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

    const fakePayload = new Uint8Array(32);
    fakePayload[0] = 0x10; // location type
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
    const tampered = boxHex.slice(0, 40) + "ff" + boxHex.slice(42);
    assert.throws(
      () =>
        decryptMessage(tampered, bytesToHex(nonce), sender.pub, recipient.priv),
      /authentication failed/,
    );
  });
});

describe("end-to-end webhook payload simulation", () => {
  it("simulates a complete incoming Threema webhook message", () => {
    const senderKeyPair = generateKeyPair();
    const gatewayKeyPair = generateKeyPair();

    const apiSecret = "myGatewaySecret123";
    const nonce = new Uint8Array(crypto.randomBytes(24));
    const messageText = "Please run the tests for me";

    const payload = buildThreemaTextPayload(messageText);
    const box = naclBox(payload, nonce, gatewayKeyPair.pub, senderKeyPair.priv);

    const nonceHex = bytesToHex(nonce);
    const boxHex = bytesToHex(box);

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

    assert.ok(verifyMac(webhookParams, apiSecret));

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
