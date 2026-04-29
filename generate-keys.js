import { generateKeyPairSync } from "crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

// Raw 32-byte keys without ASN.1 wrapping
const pubRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const secRaw = privateKey
  .export({ type: "pkcs8", format: "der" })
  .subarray(-32);

console.log("public:", Buffer.from(pubRaw).toString("hex"));
console.log("secret:", Buffer.from(secRaw).toString("hex"));
