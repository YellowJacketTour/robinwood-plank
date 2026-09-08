import type { Hex } from "./hex.ts";

/**
 * Closed protocol surface. Not a collection catalog.
 * Adding a topic is a protocol change and needs a test.
 */
export const TOPICS = {
  ERC721_TRANSFER:
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex,
  ERC1155_TRANSFER_SINGLE:
    "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62" as Hex,
  ERC1155_TRANSFER_BATCH:
    "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb" as Hex,
  SEAPORT_ORDER_FULFILLED:
    "0x9d9af8e38d66c62e2c12f0225249fd9d721c70b66e27a8da8c70216359c7d2d4" as Hex,
} as const;

export const DISCOVERY_TOPICS: Hex[] = [
  TOPICS.ERC721_TRANSFER,
  TOPICS.ERC1155_TRANSFER_SINGLE,
  TOPICS.ERC1155_TRANSFER_BATCH,
];

export const WITNESS_TOPICS: Hex[] = [
  TOPICS.SEAPORT_ORDER_FULFILLED,
];

export const ALL_WATCHED_TOPICS: Hex[] = [...DISCOVERY_TOPICS, ...WITNESS_TOPICS];

export const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export function topicIndex(topic0: string): number {
  const t = topic0.toLowerCase();
  return ALL_WATCHED_TOPICS.findIndex((x) => x === t);
}

/** 256-bit bloom: two-bit pair per topic, yellow-paper style simplified for tests. */
export function topicBloomBitpair(topic: Hex): [number, number] {
  const buf = Buffer.from(topic.slice(2), "hex");
  const a = buf[0]! + ((buf[1]! & 7) << 8);
  const b = buf[2]! + ((buf[3]! & 7) << 8);
  return [a % 2048, b % 2048];
}

export function bloomMayContain(bloomHex: string, topics: Hex[]): boolean {
  if (!bloomHex || bloomHex === "0x" + "0".repeat(512)) return false;
  const bloom = Buffer.from(bloomHex.replace(/^0x/, ""), "hex");
  if (bloom.length !== 256) return true;
  return topics.some((topic) => {
    const [x, y] = topicBloomBitpair(topic);
    return bitSet(bloom, x) && bitSet(bloom, y);
  });
}

function bitSet(bloom: Buffer, bit: number): boolean {
  const byte = Math.floor(bit / 8);
  const mask = 1 << (bit % 8);
  return ((bloom[byte] ?? 0) & mask) !== 0;
}

export function setBloomBits(bloom: Buffer, topic: Hex): void {
  const [x, y] = topicBloomBitpair(topic);
  setBit(bloom, x);
  setBit(bloom, y);
}

function setBit(bloom: Buffer, bit: number): void {
  const byte = Math.floor(bit / 8);
  const mask = 1 << (bit % 8);
  bloom[byte] = (bloom[byte] ?? 0) | mask;
}
