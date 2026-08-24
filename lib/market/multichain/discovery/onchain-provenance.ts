/**
 * Event-log-derived provenance/holder-analytics for EVM NFT contracts --
 * see docs/AUDIT-onchain-data-extraction-2026-08-24.md section 1.6, flagged
 * there as the single highest-leverage build item in the whole audit: one
 * paginated `eth_getLogs` scan over the Transfer/TransferSingle/TransferBatch
 * topics every ERC721/ERC1155 contract MUST emit replaces what would
 * otherwise need a paid indexer for ownership, provenance, mint-order, and
 * holder-concentration analytics all at once, using only the existing free
 * keyless `rpcCall` pool (rpc-provider-pool.ts).
 *
 * Distinct from evm-log-scan.ts: that module scans UNFILTERED across an
 * entire chain to *discover* which contracts are active. This module scans
 * ONE already-known contractAddress to reconstruct its full provenance.
 * Also distinct from source: evm-log-scan.ts's own CHUNK_BLOCKS=10 was
 * measured against Alchemy's specific free-tier eth_getLogs cap; the public
 * providers in rpc-provider-pool.ts (publicnode/drpc) are generally more
 * permissive, so this module starts at a larger 2000-block chunk and
 * shrinks adaptively on a real "range too large"-shaped RPC error instead
 * of assuming one fixed ceiling applies to every provider/chain pair.
 */
import { rpcCall } from "@/lib/market/multichain/discovery/rpc-provider-pool";

/** keccak256("Transfer(address,address,uint256)") -- ERC-721. */
export const ERC721_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** keccak256("TransferSingle(address,address,address,uint256,uint256)") -- ERC-1155. */
export const ERC1155_TRANSFER_SINGLE_TOPIC = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
/** keccak256("TransferBatch(address,address,address,uint256[],uint256[])") -- ERC-1155. */
export const ERC1155_TRANSFER_BATCH_TOPIC = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type TransferEvent = {
  tokenId: string;
  from: string;
  to: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
};

export type Transfer1155Event = {
  /** "single" events have exactly one id/value pair; "batch" events may unpack into several with the same log identity. */
  kind: "single" | "batch";
  operator: string;
  from: string;
  to: string;
  tokenId: string;
  value: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
};

type RawLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
};

export type ScanOpts = { fromBlock: number; toBlock: number | "latest" };

const DEFAULT_CHUNK_BLOCKS = 2000;
const MIN_CHUNK_BLOCKS = 25;

/** A 32-byte topic holding a left-padded address -- last 20 bytes are the real address. */
function decodeAddressTopic(topic: string): string {
  const hex = topic.replace(/^0x/, "");
  return "0x" + hex.slice(hex.length - 40);
}

function decodeUint256Topic(topic: string): string {
  return BigInt(topic).toString();
}

/** Splits a 0x-prefixed hex data blob (no 0x, already stripped) into 32-byte words. */
function splitWords(dataHexNo0x: string): string[] {
  const words: string[] = [];
  for (let i = 0; i < dataHexNo0x.length; i += 64) {
    words.push(dataHexNo0x.slice(i, i + 64));
  }
  return words;
}

/** Real "the requested range is too wide for this provider" error text, observed across public EVM RPC vendors (message wording varies by vendor, hence the broad match). */
function isRangeTooLargeError(message: string): boolean {
  return /block range|too (many|large)|limit exceeded|query returned more than|exceeds the range|range is too wide|10,?000 results|response size/i.test(message);
}

/**
 * Resolves a `toBlock: number | "latest"` against the real chain head once
 * per scan call, so a caller passing "latest" still gets a stable numeric
 * upper bound to paginate against (re-querying the head every chunk would
 * risk the window growing while paginating on a fast chain).
 */
async function resolveToBlock(chainSlug: string, toBlock: number | "latest"): Promise<number> {
  if (toBlock !== "latest") return toBlock;
  const { result } = await rpcCall<string>(chainSlug, "eth_blockNumber", []);
  return Number.parseInt(result, 16);
}

/**
 * Generic paginated eth_getLogs walker shared by both scanners below.
 * Starts at `DEFAULT_CHUNK_BLOCKS`-wide windows; on a real "range too
 * large" RPC error, halves the chunk size and retries the SAME window
 * (never throws immediately -- free public providers commonly cap
 * eth_getLogs range and this is a known, expected condition, not a
 * failure) down to `MIN_CHUNK_BLOCKS`, at which point a real error is
 * finally surfaced (something else is wrong).
 */
async function scanLogsPaginated(
  chainSlug: string,
  contractAddress: string,
  topics: (string | string[] | null)[],
  opts: ScanOpts
): Promise<RawLog[]> {
  const endBlock = await resolveToBlock(chainSlug, opts.toBlock);
  const out: RawLog[] = [];
  let cursor = opts.fromBlock;
  let chunk = DEFAULT_CHUNK_BLOCKS;

  while (cursor <= endBlock) {
    const windowEnd = Math.min(endBlock, cursor + chunk - 1);
    try {
      const { result } = await rpcCall<RawLog[]>(chainSlug, "eth_getLogs", [
        {
          address: contractAddress,
          fromBlock: "0x" + cursor.toString(16),
          toBlock: "0x" + windowEnd.toString(16),
          topics,
        },
      ]);
      out.push(...result);
      cursor = windowEnd + 1;
      // A shrunk chunk stays shrunk for the rest of this scan rather than
      // growing back -- the provider already told us its real ceiling for
      // this contract/topic combination; growing back would just re-trigger
      // the same error on the next window.
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRangeTooLargeError(message) && chunk > MIN_CHUNK_BLOCKS) {
        chunk = Math.max(MIN_CHUNK_BLOCKS, Math.floor(chunk / 2));
        continue; // retry the same cursor with the smaller window
      }
      throw error; // real failure (not a range-size condition, or already at the floor) -- honest, not swallowed
    }
  }
  return out;
}

/**
 * Scans ERC-721 `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)`
 * logs for one contract across a block range, paginating in
 * provider-safe chunks and merging results. All three params are
 * `indexed`, so the full event is reconstructed from topics alone --
 * `data` is empty for a spec-conformant ERC-721 Transfer.
 */
export async function scanTransferLogs(
  chainSlug: string,
  contractAddress: string,
  opts: ScanOpts
): Promise<TransferEvent[]> {
  const logs = await scanLogsPaginated(chainSlug, contractAddress, [ERC721_TRANSFER_TOPIC], opts);
  const events: TransferEvent[] = [];
  for (const log of logs) {
    // A real ERC-20 Transfer shares this exact topic0 but only has 3 topics
    // (tokenId/value is NOT indexed for ERC-20) -- skip anything that isn't
    // shaped like the 4-topic ERC-721 event rather than mis-decoding it.
    if (log.topics.length !== 4) continue;
    events.push({
      from: decodeAddressTopic(log.topics[1]),
      to: decodeAddressTopic(log.topics[2]),
      tokenId: decodeUint256Topic(log.topics[3]),
      blockNumber: Number.parseInt(log.blockNumber, 16),
      transactionHash: log.transactionHash,
      logIndex: Number.parseInt(log.logIndex, 16),
    });
  }
  return events;
}

/**
 * Scans ERC-1155 `TransferSingle(operator, from, to, id, value)` and
 * `TransferBatch(operator, from, to, ids[], values[])` logs for one
 * contract. TransferSingle has operator/from/to indexed (id, value in
 * data); TransferBatch has operator/from/to indexed too, with both
 * dynamic arrays ABI-encoded in data (offset word, length word, then N
 * words each) -- each id/value pair unpacks into one `Transfer1155Event`
 * with `kind: "batch"` sharing the same tx/log identity.
 */
export async function scanTransferSingleBatchLogs(
  chainSlug: string,
  contractAddress: string,
  opts: ScanOpts
): Promise<Transfer1155Event[]> {
  const logs = await scanLogsPaginated(
    chainSlug,
    contractAddress,
    [[ERC1155_TRANSFER_SINGLE_TOPIC, ERC1155_TRANSFER_BATCH_TOPIC]],
    opts
  );
  const events: Transfer1155Event[] = [];
  for (const log of logs) {
    if (log.topics.length !== 4) continue; // malformed/non-conformant -- skip rather than guess
    const topic0 = log.topics[0]?.toLowerCase();
    const operator = decodeAddressTopic(log.topics[1]);
    const from = decodeAddressTopic(log.topics[2]);
    const to = decodeAddressTopic(log.topics[3]);
    const dataHex = log.data.replace(/^0x/, "");
    const blockNumber = Number.parseInt(log.blockNumber, 16);
    const logIndex = Number.parseInt(log.logIndex, 16);

    if (topic0 === ERC1155_TRANSFER_SINGLE_TOPIC) {
      const words = splitWords(dataHex);
      if (words.length < 2) continue;
      events.push({
        kind: "single",
        operator,
        from,
        to,
        tokenId: BigInt("0x" + words[0]).toString(),
        value: BigInt("0x" + words[1]).toString(),
        blockNumber,
        transactionHash: log.transactionHash,
        logIndex,
      });
    } else if (topic0 === ERC1155_TRANSFER_BATCH_TOPIC) {
      // ABI layout for (uint256[] ids, uint256[] values): word0 = offset to
      // ids array, word1 = offset to values array, then at each offset:
      // [length, ...elements].
      const words = splitWords(dataHex);
      if (words.length < 2) continue;
      const idsOffsetWords = Number(BigInt("0x" + words[0])) / 32;
      const valuesOffsetWords = Number(BigInt("0x" + words[1])) / 32;
      const idsLenWord = words[idsOffsetWords];
      const valuesLenWord = words[valuesOffsetWords];
      if (idsLenWord === undefined || valuesLenWord === undefined) continue;
      const idsLen = Number(BigInt("0x" + idsLenWord));
      const valuesLen = Number(BigInt("0x" + valuesLenWord));
      const len = Math.min(idsLen, valuesLen);
      for (let i = 0; i < len; i++) {
        const idWord = words[idsOffsetWords + 1 + i];
        const valueWord = words[valuesOffsetWords + 1 + i];
        if (idWord === undefined || valueWord === undefined) break;
        events.push({
          kind: "batch",
          operator,
          from,
          to,
          tokenId: BigInt("0x" + idWord).toString(),
          value: BigInt("0x" + valueWord).toString(),
          blockNumber,
          transactionHash: log.transactionHash,
          logIndex,
        });
      }
    }
  }
  return events;
}

export type HolderDistribution = {
  holderCount: number;
  topHolders: Array<{ address: string; count: number }>;
  tokenOwner: Map<string, string>;
};

/**
 * Pure replay of already-fetched Transfer events -- no RPC calls here.
 * Sorts by (blockNumber, logIndex) to guarantee correct ordering even if a
 * caller merged results from multiple paginated calls out of sequence, then
 * walks forward tracking current owner per tokenId (mint = from is the zero
 * address, burn = to is the zero address, which simply removes that token
 * from the live ownership map -- a burned token holds no current holder).
 */
export function deriveHolderDistribution(transfers: TransferEvent[]): HolderDistribution {
  const ordered = [...transfers].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const tokenOwner = new Map<string, string>();
  for (const t of ordered) {
    const to = t.to.toLowerCase();
    if (to === ZERO_ADDRESS) {
      tokenOwner.delete(t.tokenId); // burn -- no live holder for this tokenId anymore
    } else {
      tokenOwner.set(t.tokenId, to);
    }
  }

  const countByHolder = new Map<string, number>();
  for (const owner of tokenOwner.values()) {
    countByHolder.set(owner, (countByHolder.get(owner) ?? 0) + 1);
  }
  const topHolders = [...countByHolder.entries()]
    .map(([address, count]) => ({ address, count }))
    .sort((a, b) => b.count - a.count);

  return { holderCount: countByHolder.size, topHolders, tokenOwner };
}

export type MintEvent = { tokenId: string; blockNumber: number; mintedTo: string };

/**
 * Pure filter+sort of already-fetched transfers -- every `from == zero
 * address` Transfer IS a mint by definition of the ERC-721 standard, so
 * ordering these by block number reconstructs real, verifiable on-chain
 * mint order ("OG" order) with no off-chain trust required at all.
 */
export function detectMintOrder(transfers: TransferEvent[]): MintEvent[] {
  return transfers
    .filter((t) => t.from.toLowerCase() === ZERO_ADDRESS)
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    .map((t) => ({ tokenId: t.tokenId, blockNumber: t.blockNumber, mintedTo: t.to }));
}

export type PossibleWashTrade = {
  tokenId: string;
  addressA: string;
  addressB: string;
  roundTrips: number;
};

/**
 * HEURISTIC ONLY -- NOT A CERTAINTY. Flags tokenIds that bounced back and
 * forth between the same two addresses (A->B then B->A, repeated) within
 * `windowBlocks` of each other. This pattern is also produced by entirely
 * legitimate activity -- e.g. two real collectors repeatedly trading with
 * each other, a wallet moving a token to a marketplace-escrow address and
 * back, or a failed/relisted sale -- so a match here means "worth a closer
 * look," never "proven wash trading." Do not present `roundTrips` or any
 * other field from this function as proof of manipulation.
 */
export function detectPossibleWashTrade(transfers: TransferEvent[], windowBlocks: number): PossibleWashTrade[] {
  const byToken = new Map<string, TransferEvent[]>();
  for (const t of transfers) {
    const arr = byToken.get(t.tokenId) ?? [];
    arr.push(t);
    byToken.set(t.tokenId, arr);
  }

  const out: PossibleWashTrade[] = [];
  for (const [tokenId, events] of byToken) {
    const ordered = [...events].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    // pairKey -> count of A->B legs seen so far within an open window, keyed
    // by the unordered {from,to} pair so an A->B followed later by a B->A
    // counts as one "round trip" candidate for that pair.
    const pairCounts = new Map<string, { addressA: string; addressB: string; roundTrips: number; lastBlock: number }>();
    for (const t of ordered) {
      const from = t.from.toLowerCase();
      const to = t.to.toLowerCase();
      if (from === ZERO_ADDRESS || to === ZERO_ADDRESS) continue; // mint/burn are never a "round trip" leg
      const pairKey = [from, to].sort().join(":");
      const existing = pairCounts.get(pairKey);
      if (existing && t.blockNumber - existing.lastBlock <= windowBlocks) {
        existing.roundTrips += 1;
        existing.lastBlock = t.blockNumber;
      } else {
        pairCounts.set(pairKey, { addressA: from, addressB: to, roundTrips: existing ? existing.roundTrips : 0, lastBlock: t.blockNumber });
      }
    }
    for (const entry of pairCounts.values()) {
      if (entry.roundTrips > 0) {
        out.push({ tokenId, addressA: entry.addressA, addressB: entry.addressB, roundTrips: entry.roundTrips });
      }
    }
  }
  return out;
}
