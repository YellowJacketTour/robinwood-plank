import { TRANSFER_TOPIC, rpcCall } from "@/lib/market/multichain/discovery/evm-log-scan";

const MAX_ENUMERATED_TOKENS = 200;
const ACTIVITY_SCAN_BLOCKS = 50_000;

function encodeUint(value: bigint): string { return value.toString(16).padStart(64, "0"); }
function encodeAddress(address: string): string { return address.toLowerCase().replace(/^0x/, "").padStart(64, "0"); }

/** Bounded ERC-721 ownership resolver for Robinhood Chain. */
export async function resolveOwnedTokenIds(rpcUrl: string, contractAddress: string, owner: string): Promise<string[]> {
  try {
    const balanceHex = await rpcCall<string>(rpcUrl, "eth_call", [{ to: contractAddress, data: "0x70a08231" + encodeAddress(owner) }, "latest"]);
    const balance = BigInt(balanceHex);
    if (balance > 0n && balance <= BigInt(MAX_ENUMERATED_TOKENS)) {
      const ids: string[] = [];
      for (let index = 0n; index < balance; index += 1n) {
        const tokenHex = await rpcCall<string>(rpcUrl, "eth_call", [{ to: contractAddress, data: "0x2f745c59" + encodeAddress(owner) + encodeUint(index) }, "latest"]);
        ids.push(BigInt(tokenHex).toString());
      }
      return ids;
    }
    if (balance === 0n) return [];
  } catch { /* Non-enumerable contracts fall through to bounded logs. */ }

  const latestHex = await rpcCall<string>(rpcUrl, "eth_blockNumber", []);
  const latest = Number.parseInt(latestHex, 16);
  const fromBlock = Math.max(0, latest - ACTIVITY_SCAN_BLOCKS);
  const ownerTopic = "0x" + encodeAddress(owner);
  type RawLog = { topics: string[]; blockNumber: string; logIndex: string };
  const [incoming, outgoing] = await Promise.all([
    rpcCall<RawLog[]>(rpcUrl, "eth_getLogs", [{ address: contractAddress, fromBlock: "0x" + fromBlock.toString(16), toBlock: "0x" + latest.toString(16), topics: [TRANSFER_TOPIC, null, ownerTopic] }]),
    rpcCall<RawLog[]>(rpcUrl, "eth_getLogs", [{ address: contractAddress, fromBlock: "0x" + fromBlock.toString(16), toBlock: "0x" + latest.toString(16), topics: [TRANSFER_TOPIC, ownerTopic] }]),
  ]);
  const rank = (log: RawLog) => Number.parseInt(log.blockNumber, 16) * 1_000_000 + Number.parseInt(log.logIndex ?? "0x0", 16);
  const latestByToken = new Map<string, { direction: "in" | "out"; rank: number }>();
  for (const [direction, logs] of [["in", incoming], ["out", outgoing]] as const) {
    for (const log of logs) {
      if (log.topics.length !== 4) continue;
      const tokenId = BigInt(log.topics[3]).toString();
      const eventRank = rank(log);
      const prior = latestByToken.get(tokenId);
      if (!prior || eventRank > prior.rank) latestByToken.set(tokenId, { direction, rank: eventRank });
    }
  }
  return [...latestByToken.entries()].filter(([, value]) => value.direction === "in").map(([tokenId]) => tokenId).slice(0, MAX_ENUMERATED_TOKENS);
}
