/** Minimal assertion helpers over node:assert, so tests read as claims. */
import assert from "node:assert/strict";

export function eq<T>(actual: T, expected: T, msg?: string): void {
  assert.deepStrictEqual(actual, expected, msg);
}

export function ok(value: unknown, msg?: string): void {
  assert.ok(value, msg);
}

export function throws(fn: () => unknown, match: RegExp, msg?: string): void {
  assert.throws(fn, match, msg);
}

export function sha256Stub(): (b: Uint8Array) => `0x${string}` {
  // Deterministic, collision-resistant enough for tests: FNV-1a over bytes,
  // widened to 32 bytes. Never used outside tests.
  return (b: Uint8Array) => {
    let h = 0x811c9dc5;
    for (const byte of b) {
      h ^= byte;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `0x${h.toString(16).padStart(8, "0").repeat(8)}` as `0x${string}`;
  };
}
