import { ZERO_ADDR, TOPICS } from "../shared/topics.ts";
import { asHex, pad32, type Hex } from "../shared/hex.ts";
import type { ChainEvent, ChainId, EventKind } from "../shared/types.ts";

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
  transactionHash: string;
  blockHash: string;
  blockNumber: number;
}

export function topic0Of(log: RawLog): string {
  return (log.topics[0] ?? "").toLowerCase();
}

export function isWatchedLog(log: RawLog, watched: readonly string[]): boolean {
  return watched.includes(topic0Of(log));
}

export function decodeLog(chain: ChainId, log: RawLog): ChainEvent | undefined {
  const t0 = topic0Of(log);
  if (t0 === TOPICS.ERC721_TRANSFER) return decode721(chain, log);
  if (t0 === TOPICS.ERC1155_TRANSFER_SINGLE) return decode1155single(chain, log);
  if (t0 === TOPICS.ERC1155_TRANSFER_BATCH) return decode1155batch(chain, log);
  if (t0 === TOPICS.SEAPORT_ORDER_FULFILLED) return decodeSeaport(chain, log);
  return undefined;
}

function addrFromTopic(topic: string): string {
  return asHex(topic.slice(-40).padStart(40, "0"));
}

function decode721(chain: ChainId, log: RawLog): ChainEvent | undefined {
  if (log.topics.length < 4) return undefined;
  const from = addrFromTopic(log.topics[1]!);
  const to = addrFromTopic(log.topics[2]!);
  const tokenId = BigInt(log.topics[3]!).toString();
  return base(chain, log, "transfer721", log.address, tokenId, from, to, {
    standard: "erc721",
    mint: from.toLowerCase() === ZERO_ADDR,
  });
}

function decode1155single(chain: ChainId, log: RawLog): ChainEvent | undefined {
  if (log.topics.length < 4) return undefined;
  const from = addrFromTopic(log.topics[2]!);
  const to = addrFromTopic(log.topics[3]!);
  const data = log.data.replace(/^0x/, "");
  const id = BigInt(asHex(data.slice(0, 64) || "0")).toString();
  const value = BigInt(asHex(data.slice(64, 128) || "0")).toString();
  return base(chain, log, "transfer1155", log.address, id, from, to, {
    standard: "erc1155",
    value,
    mint: from.toLowerCase() === ZERO_ADDR,
  });
}

function decode1155batch(chain: ChainId, log: RawLog): ChainEvent | undefined {
  if (log.topics.length < 4) return undefined;
  const from = addrFromTopic(log.topics[2]!);
  const to = addrFromTopic(log.topics[3]!);
  return base(chain, log, "transfer1155_batch", log.address, "*", from, to, {
    standard: "erc1155",
    data: log.data,
    mint: from.toLowerCase() === ZERO_ADDR,
  });
}

function decodeSeaport(chain: ChainId, log: RawLog): ChainEvent {
  return base(chain, log, "seaport_fill", log.address, "", "", "", {
    venue: "seaport",
    data: log.data,
    topics: log.topics,
  });
}

function base(
  chain: ChainId,
  log: RawLog,
  kind: EventKind,
  contract: string,
  token: string,
  from: string,
  to: string,
  raw: Record<string, unknown>,
): ChainEvent {
  return {
    chain,
    blockHash: asHex(log.blockHash),
    height: Number(log.blockNumber),
    loc: Number(log.logIndex),
    txHash: asHex(log.transactionHash),
    kind,
    contractOrProgram: contract.toLowerCase(),
    tokenOrInscription: token,
    fromAddr: from.toLowerCase(),
    toAddr: to.toLowerCase(),
    raw,
  };
}

export function isMint(ev: ChainEvent): boolean {
  return ev.fromAddr === ZERO_ADDR && (ev.kind === "transfer721" || ev.kind === "transfer1155" || ev.kind === "transfer1155_batch");
}

export function topic0ListForGetLogs(watched: readonly Hex[]): Hex[] {
  return [...watched];
}

export { pad32 };
