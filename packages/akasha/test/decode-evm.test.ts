/**
 * EVM log decoding.
 *
 * The case that matters most is the one that looks like a false alarm: ERC-20
 * emits `Transfer(address,address,uint256)` with the SAME topic0 as ERC-721.
 * The only structural difference is that ERC-721 indexes the tokenId, giving
 * four topics where ERC-20 has three. Decode an ERC-20 transfer as an NFT and
 * the archive fills with "collections" that are stablecoins.
 */
import { test } from "node:test";
import { eq, ok } from "./_expect.ts";
import { decodeLog, isWatchedLog, topic0Of, isMint, type RawLog } from "../src/hose/decode-evm.ts";
import { TOPICS, ALL_WATCHED_TOPICS, ZERO_ADDR } from "../src/shared/topics.ts";

const CHAIN = "ethereum" as const;
const topicAddr = (a: string) => "0x" + "0".repeat(24) + a.replace(/^0x/, "");
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");

function log(over: Partial<RawLog>): RawLog {
  return {
    address: "0x00000000000000000000000000000000000000cc",
    topics: [],
    data: "0x",
    logIndex: 7,
    transactionHash: "0x" + "11".repeat(32),
    blockHash: "0x" + "22".repeat(32),
    blockNumber: 1234,
    ...over,
  };
}

test("an ERC-721 transfer decodes with its indexed tokenId", () => {
  const ev = decodeLog(
    CHAIN,
    log({
      address: "0xAbCdEf0000000000000000000000000000000001",
      topics: [
        TOPICS.ERC721_TRANSFER,
        topicAddr("0x1111111111111111111111111111111111111111"),
        topicAddr("0x2222222222222222222222222222222222222222"),
        "0x" + word(4242),
      ],
    })
  );

  ok(ev, "a 4-topic Transfer is an NFT move");
  eq(ev!.kind, "transfer721");
  eq(ev!.tokenOrInscription, "4242");
  eq(ev!.fromAddr, "0x1111111111111111111111111111111111111111");
  eq(ev!.toAddr, "0x2222222222222222222222222222222222222222");
  eq(ev!.contractOrProgram, "0xabcdef0000000000000000000000000000000001", "addresses are normalised");
  eq(ev!.height, 1234);
  eq(ev!.loc, 7, "logIndex is the intra-block order the holders replay depends on");
});

test("an ERC-20 transfer is NOT decoded as an NFT", () => {
  // Identical topic0, three topics, amount in data. This is most of Ethereum.
  const ev = decodeLog(
    CHAIN,
    log({
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      topics: [
        TOPICS.ERC721_TRANSFER,
        topicAddr("0x1111111111111111111111111111111111111111"),
        topicAddr("0x2222222222222222222222222222222222222222"),
      ],
      data: "0x" + word(1_000_000n),
    })
  );
  eq(ev, undefined, "a 3-topic Transfer is ERC-20 and must be dropped");
});

test("a mint is a transfer out of the zero address, and only for token kinds", () => {
  const minted = decodeLog(
    CHAIN,
    log({
      topics: [
        TOPICS.ERC721_TRANSFER,
        topicAddr(ZERO_ADDR),
        topicAddr("0x2222222222222222222222222222222222222222"),
        "0x" + word(1),
      ],
    })
  )!;
  eq(minted.fromAddr, ZERO_ADDR);
  eq(isMint(minted), true);

  const fill = decodeLog(CHAIN, log({ topics: [TOPICS.SEAPORT_ORDER_FULFILLED], data: "0xabcd" }))!;
  eq(isMint(fill), false, "an order fill is never a mint, whatever its from address");
});

test("ERC-1155 single decodes id and value from data, not from topics", () => {
  const ev = decodeLog(
    CHAIN,
    log({
      topics: [
        TOPICS.ERC1155_TRANSFER_SINGLE,
        topicAddr("0x9999999999999999999999999999999999999999"), // operator
        topicAddr("0x1111111111111111111111111111111111111111"), // from
        topicAddr("0x2222222222222222222222222222222222222222"), // to
      ],
      data: "0x" + word(77) + word(5),
    })
  )!;

  eq(ev.kind, "transfer1155");
  eq(ev.tokenOrInscription, "77", "id is the first data word");
  eq((ev.raw as { value: string }).value, "5", "value is the second");
  eq(ev.fromAddr, "0x1111111111111111111111111111111111111111",
    "from is topic 2: topic 1 is the OPERATOR and is not a party to the move");
});

test("an ERC-1155 batch is kept whole rather than guessed apart", () => {
  const ev = decodeLog(
    CHAIN,
    log({
      topics: [
        TOPICS.ERC1155_TRANSFER_BATCH,
        topicAddr("0x9999999999999999999999999999999999999999"),
        topicAddr(ZERO_ADDR),
        topicAddr("0x2222222222222222222222222222222222222222"),
      ],
      data: "0xdeadbeef",
    })
  )!;
  eq(ev.kind, "transfer1155_batch");
  eq(ev.tokenOrInscription, "*", "the batch is not silently reduced to one id");
  eq(isMint(ev), true);
});

test("a truncated log is dropped rather than decoded into wrong parties", () => {
  for (const topics of [
    [TOPICS.ERC721_TRANSFER],
    [TOPICS.ERC721_TRANSFER, topicAddr("0x1111111111111111111111111111111111111111")],
    [TOPICS.ERC1155_TRANSFER_SINGLE, topicAddr("0x1111111111111111111111111111111111111111"), topicAddr("0x2222222222222222222222222222222222222222")],
    [TOPICS.ERC1155_TRANSFER_BATCH, topicAddr("0x1111111111111111111111111111111111111111")],
  ]) {
    eq(decodeLog(CHAIN, log({ topics })), undefined, `should drop: ${topics.length} topics`);
  }
});

test("an unwatched topic decodes to nothing", () => {
  eq(decodeLog(CHAIN, log({ topics: ["0x" + "ab".repeat(32)] })), undefined);
  eq(decodeLog(CHAIN, log({ topics: [] })), undefined, "a log with no topics is not an event");
});

test("topic0Of and isWatchedLog are case-insensitive on the wire form", () => {
  const upper = TOPICS.ERC721_TRANSFER.toUpperCase().replace("0X", "0x");
  eq(topic0Of(log({ topics: [upper] })), TOPICS.ERC721_TRANSFER);
  ok(isWatchedLog(log({ topics: [upper] }), ALL_WATCHED_TOPICS));
  ok(!isWatchedLog(log({ topics: ["0x" + "cd".repeat(32)] }), ALL_WATCHED_TOPICS));
});
