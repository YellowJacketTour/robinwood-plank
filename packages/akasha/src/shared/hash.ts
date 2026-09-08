import { createHash, createHmac } from "node:crypto";
import { strip0x, type Hex, asHex } from "./hex.ts";

export function sha256(data: Uint8Array | string): Hex {
  const h = createHash("sha256");
  h.update(typeof data === "string" ? data : Buffer.from(data));
  return asHex(h.digest("hex"));
}

export function sha256Bytes(data: Uint8Array | Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

export function keccakTopicPlaceholder(): never {
  throw new Error("use TOPICS constants; do not hash event names at runtime");
}

export function hmacHex(key: string, msg: string): Hex {
  return asHex(createHmac("sha256", key).update(msg).digest("hex"));
}

export function digestCanonical(parts: unknown[]): Hex {
  return sha256(JSON.stringify(parts));
}

export function hexToBuf(hex: string): Buffer {
  return Buffer.from(strip0x(hex), "hex");
}
