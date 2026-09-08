/**
 * Topic constants, recomputed rather than eyeballed.
 *
 * A wrong topic hash is the worst kind of bug this package can have: the log
 * filter simply never matches, so the chain looks quiet, coverage looks
 * complete, and the archive reports a healthy empty stream forever. Nothing
 * errors. SEAPORT_ORDER_FULFILLED was wrong exactly this way -- it shared its
 * first 18 hex digits with the real hash and diverged after, which no reviewer
 * catches by reading.
 *
 * keccak256 is implemented here rather than imported so the check does not
 * depend on the same library that produced the constant.
 */
import { test } from "node:test";
import { eq, ok } from "./_expect.ts";
import {
  TOPICS,
  TOPIC_SIGNATURES,
  DISCOVERY_TOPICS,
  WITNESS_TOPICS,
  ALL_WATCHED_TOPICS,
  topicIndex,
  bloomMayContain,
  setBloomBits,
} from "../src/shared/topics.ts";

// --- a self-contained keccak-256 (FIPS-202 Keccak-f[1600], 0x01 padding) ---

const RC = [
  0x00000001n, 0x00008082n, 0x800000000000808An, 0x8000000080008000n,
  0x000000000000808Bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
  0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800An, 0x800000008000000An,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];
const M = (1n << 64n) - 1n;
const rotl = (x: bigint, n: number) =>
  n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M;

function keccakF(a: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => a[x]! ^ a[x + 5]! ^ a[x + 10]! ^ a[x + 15]! ^ a[x + 20]!);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 5; y++) a[x + 5 * y] = a[x + 5 * y]! ^ d;
    }
    const b: bigint[] = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y]!, ROT[x]![y]!);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        a[x + 5 * y] = b[x + 5 * y]! ^ (~b[((x + 1) % 5) + 5 * y]! & M & b[((x + 2) % 5) + 5 * y]!);
      }
    }
    a[0] = a[0]! ^ RC[round]!;
  }
}

function keccak256(msg: Uint8Array): string {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((msg.length + 1) / rate) * rate);
  padded.set(msg);
  padded[msg.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] as number) | 0x80;

  const state: bigint[] = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b] as number);
      state[i] = state[i]! ^ lane;
    }
    keccakF(state);
  }
  let out = "";
  for (let i = 0; i < 4; i++) {
    let lane = state[i]!;
    for (let b = 0; b < 8; b++) {
      out += (lane & 0xffn).toString(16).padStart(2, "0");
      lane >>= 8n;
    }
  }
  return `0x${out}`;
}

test("the keccak implementation used by this test is itself correct", () => {
  // Known vectors: without these, a broken keccak would "confirm" broken topics.
  eq(
    keccak256(new Uint8Array(0)),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
  );
  eq(
    keccak256(new TextEncoder().encode("Transfer(address,address,uint256)")),
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
  );
});

test("every topic equals keccak256 of its declared event signature", () => {
  for (const [name, sig] of Object.entries(TOPIC_SIGNATURES)) {
    const expected = keccak256(new TextEncoder().encode(sig));
    eq(
      TOPICS[name as keyof typeof TOPICS],
      expected,
      `${name} does not match keccak256("${sig}") -- a wrong topic matches nothing and fails silently`
    );
  }
});

test("the Seaport topic is not the old truncated value", () => {
  const WRONG = "0x9d9af8e38d66c62e2c12f0225249fd9d721c70b66e27a8da8c70216359c7d2d4";
  ok(TOPICS.SEAPORT_ORDER_FULFILLED !== WRONG, "the miss-everything constant is gone");
  // It shared a long prefix, which is why nobody caught it by reading.
  eq(TOPICS.SEAPORT_ORDER_FULFILLED.slice(0, 20), WRONG.slice(0, 20));
});

test("every topic is a distinct 32-byte value", () => {
  const all = Object.values(TOPICS);
  eq(new Set(all).size, all.length, "no duplicates");
  for (const t of all) ok(/^0x[0-9a-f]{64}$/.test(t), `${t} is not 32 lowercase hex bytes`);
});

test("discovery and witness topics are disjoint and together are the watched set", () => {
  for (const t of DISCOVERY_TOPICS) ok(!WITNESS_TOPICS.includes(t));
  eq(ALL_WATCHED_TOPICS.length, DISCOVERY_TOPICS.length + WITNESS_TOPICS.length);
  eq(new Set(ALL_WATCHED_TOPICS).size, ALL_WATCHED_TOPICS.length);
  // Discovery is transfers only: an order fill must never mint a collection.
  ok(!DISCOVERY_TOPICS.includes(TOPICS.SEAPORT_ORDER_FULFILLED));
});

test("topicIndex finds watched topics case-insensitively and rejects others", () => {
  eq(topicIndex(TOPICS.ERC721_TRANSFER), 0);
  eq(topicIndex(TOPICS.ERC721_TRANSFER.toUpperCase().replace("0X", "0x")), 0);
  eq(topicIndex("0x" + "ab".repeat(32)), -1, "an unwatched topic is not in the surface");
});

test("the bloom filter never rejects a block that really contains the topic", () => {
  const bloom = Buffer.alloc(256);
  setBloomBits(bloom, TOPICS.ERC721_TRANSFER);
  const hex = "0x" + bloom.toString("hex");

  ok(bloomMayContain(hex, [TOPICS.ERC721_TRANSFER]), "no false negatives: that would lose blocks");
  ok(!bloomMayContain("0x" + "0".repeat(512), [TOPICS.ERC721_TRANSFER]), "an empty bloom holds nothing");
  ok(bloomMayContain("0xdeadbeef", [TOPICS.ERC721_TRANSFER]), "a malformed bloom must fail OPEN, not skip the block");
});
