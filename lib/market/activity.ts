import { Interface, JsonRpcProvider, formatEther, getAddress } from "ethers";
import {
  NFT_CONTRACT_ADDRESS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_RPC_URLS,
} from "@/lib/mint-contract";
import { MARKET_OFFER_CURRENCY, SEAPORT_ADDRESS } from "@/lib/constants";
import { resolveTokenImage } from "@/lib/market/token-image";
import { wasOrderServedByUs } from "@/lib/market/served-orders";

// Canonical Seaport 1.6 OrderFulfilled event, copied from
// @opensea/seaport-js's own compiled artifact (src/artifacts/seaport/...),
// not hand-typed — orderHash is the ONLY field that matters here, but the
// SpentItem/ReceivedItem shapes must match exactly for decoding to succeed.
const ORDER_FULFILLED_IFACE = new Interface([
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)",
]);

/**
 * On-chain activity for the collection.
 *
 * Source of truth is the collection's own ERC-721 Transfer log, not our relay:
 * the relay only knows about orders it was told about, so a feed built from it
 * would miss every sale made anywhere else and could be poisoned by anyone who
 * can write to the book. Transfer logs cannot be forged.
 *
 * Seaport's OrderFulfilled event is deliberately NOT the primary source. It
 * carries the collection only in its data payload, not in an indexed topic, so
 * it cannot be filtered server-side; an unfiltered query against this chain
 * returns "logs matched by query exceeds limit of 10000" (observed). We
 * classify a transfer as a sale by checking whether Seaport executed the
 * transaction instead.
 */

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";

/** The node rejects wide ranges, so walk backwards in bounded windows. */
const CHUNK_BLOCKS = 50_000;
const MAX_CHUNKS = 8;

export type ActivityKind = "mint" | "sale" | "transfer";

export type ActivityEvent = {
  kind: ActivityKind;
  tokenId: string;
  from: string;
  to: string;
  /** Sale price in wei, when this transfer was a Seaport fill paid in ETH. */
  priceWei: string | null;
  priceEth: string | null;
  txHash: string;
  blockNumber: number;
  /** ISO timestamp, or null when the block header could not be read. */
  timestamp: string | null;
  /** The token's own artwork, resolved server-side and cached — null if resolution failed. */
  imageUrl: string | null;
  /**
   * Which contract executed this trade, and whether we have POSITIVE proof
   * it was actually listed through Marketplank — never inferred from the
   * executing contract address alone.
   *
   * "marketplank" — the fill's on-chain Seaport orderHash matches an order
   *   THIS relay actually stored (lib/market/served-orders.ts). This is the
   *   only basis for this label. Seaport is shared protocol infrastructure:
   *   OpenSea, any other Seaport-based marketplace, or a raw script can
   *   fulfill through the exact same contract address we use, and a sale
   *   that predates this marketplace's own launch obviously wasn't ours no
   *   matter which contract executed it — both would be silently
   *   mislabeled by a naive "went through our Seaport address" check, which
   *   is exactly the bug this field's design avoids.
   * "seaport" — executed via the Seaport protocol contract, but NOT matched
   *   to anything we served. Most likely another Seaport-based frontend, a
   *   pre-launch fill, or a direct script — we deliberately do not guess a
   *   brand name (OpenSea, Magic Eden, etc.) we have no evidence for.
   * "other" — some OTHER contract entirely executed it — a real signal that
   *   a different marketplace/router/bot is active on this chain, which we
   *   could never see from our own relay alone.
   * null — a plain wallet-to-wallet transfer, no contract intermediary.
   *
   * NOTE ON SCOPE: this only ever sees activity that happens ON THIS CHAIN
   * (Robinhood Chain, id 4663). It cannot and does not claim to see trades
   * on OpenSea/Blur/Magic Eden/etc. on OTHER chains — those platforms would
   * need to explicitly index this custom chain (they do not today, per
   * research: Reservoir/NFTGo-style aggregators cover 60+ established chains
   * but not a brand-new bespoke L3 unless they explicitly add it). That is a
   * business-outreach question, not a code gap.
   */
  venue: { kind: "marketplank" | "seaport" | "other"; contract: string } | null;
};

function topicToAddress(topic: string): string {
  return getAddress("0x" + topic.slice(26));
}

/**
 * Pure classification, pulled out so it's testable without an RPC: given who
 * a Transfer moved a token from and which contract (if any) the enclosing
 * transaction called, decide the event kind and which venue executed it.
 */
export function classifyTransfer(input: {
  from: string;
  /** The transaction's own `to` field, or null if unreadable. */
  txTo: string | null;
  seaportAddress: string;
  nftContractAddress: string;
}): { kind: ActivityKind; venue: ActivityEvent["venue"] } {
  const nftContract = input.nftContractAddress.toLowerCase();
  const seaport = input.seaportAddress.toLowerCase();
  const txTo = input.txTo?.toLowerCase() ?? null;

  // A plain wallet-to-wallet transfer calls the NFT contract directly — `to`
  // on the transaction IS the collection. Anything else means some OTHER
  // contract executed the call and then moved the token internally: that's
  // the signature of a marketplace, router, or any other intermediary,
  // ours or not.
  const executedViaContract = txTo != null && txTo !== nftContract;

  if (input.from === ZERO) {
    return { kind: "mint", venue: null };
  }
  if (!executedViaContract) {
    return { kind: "transfer", venue: null };
  }
  // NOTE: "seaport" here is provisional, never "marketplank" — attribution
  // to us requires a positive orderHash match, applied as a later async
  // upgrade step in fetchActivity (see upgradeMarketplankAttribution). This
  // function stays pure and synchronous on purpose so it's fully testable
  // without an RPC.
  return {
    kind: "sale",
    venue:
      txTo === seaport
        ? { kind: "seaport", contract: input.txTo! }
        : { kind: "other", contract: input.txTo! },
  };
}

type RawLog = {
  topics: string[];
  transactionHash: string;
  blockNumber: string;
};

async function firstHealthyProvider(): Promise<JsonRpcProvider> {
  let lastError: unknown = null;
  for (const url of ROBINHOOD_RPC_URLS) {
    const provider = new JsonRpcProvider(url, ROBINHOOD_CHAIN_ID, {
      staticNetwork: true,
      batchMaxCount: 1,
    });
    try {
      await provider.getBlockNumber();
      return provider;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`No healthy Robinhood RPC: ${String(lastError)}`);
}

// Artwork is immutable once minted — cache resolved images across calls
// (not just within one fetchActivity run), so a token that keeps
// reappearing across the route's 60s response-cache refreshes never gets
// re-resolved from IPFS.
const imageCache = new Map<string, string | undefined>();

// A fill's on-chain outcome never changes — cache the marketplank-or-not
// verdict per "txHash:tokenId" permanently, same reasoning as imageCache.
const attributionCache = new Map<string, boolean>();
// WETH-denominated sale price per "txHash:tokenId", also permanent — the
// total the buyer actually paid, summed across every consideration item
// (seller proceeds + marketplace fee + any royalty), same convention every
// Seaport frontend uses to display "sale price."
const priceCache = new Map<string, bigint>();
// Which transactions we've already decoded receipts for, so a tx with no
// matching order (nothing added to attributionCache) doesn't get its
// receipt re-fetched on every subsequent request.
const attributionResolvedTxs = new Set<string>();

/**
 * Decode every OrderFulfilled log in a transaction: check each one's
 * orderHash against what we served (populates attributionCache) AND extract
 * its WETH sale price (populates priceCache) — regardless of who served the
 * order, since price display shouldn't depend on attribution. Both are
 * keyed "txHash:tokenId" so the classification loop can do a plain lookup.
 *
 * Fails closed in the sense that matters: any failure here just leaves the
 * event unattributed/unpriced rather than guessing.
 */
async function resolveMarketplankAttribution(
  provider: JsonRpcProvider,
  txHash: string
): Promise<void> {
  if (attributionResolvedTxs.has(txHash)) return;
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return;
    attributionResolvedTxs.add(txHash);

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== SEAPORT_ADDRESS.toLowerCase()) continue;
      if (log.topics[0] !== ORDER_FULFILLED_IFACE.getEvent("OrderFulfilled")!.topicHash) continue;

      let parsed;
      try {
        parsed = ORDER_FULFILLED_IFACE.parseLog({ topics: [...log.topics], data: log.data });
      } catch {
        continue;
      }
      if (!parsed) continue;

      const orderHash: string = parsed.args.orderHash;
      const isOurs = await wasOrderServedByUs(orderHash);

      // Total the buyer paid in WETH — every consideration leg that's the
      // WETH token, summed (proceeds + marketplace fee + royalty, if any).
      let weiPaid = BigInt(0);
      for (const item of parsed.args.consideration) {
        if (String(item.token).toLowerCase() !== MARKET_OFFER_CURRENCY.toLowerCase()) continue;
        weiPaid += item.amount as bigint;
      }

      // Attribute (and, if priced, price) every token this specific order
      // actually moved — an order's offer items name the NFT(s) it settled.
      for (const item of parsed.args.offer) {
        if (String(item.token).toLowerCase() !== NFT_CONTRACT_ADDRESS.toLowerCase()) continue;
        const tokenId = (item.identifier as bigint).toString();
        const key = `${txHash}:${tokenId}`;
        if (isOurs) attributionCache.set(key, true);
        if (weiPaid > BigInt(0)) priceCache.set(key, weiPaid);
      }
    }
  } catch {
    // RPC failure — leave whatever was already cached; new lookups stay
    // unattributed/unpriced for this run and can be retried on a future
    // refresh.
  }
}

/**
 * Read recent Transfer logs for the collection, newest first.
 *
 * Fails closed: any RPC error propagates rather than returning a short list
 * that would render as "no activity" and read as a dead marketplace.
 */
export async function fetchActivity(limit = 40): Promise<ActivityEvent[]> {
  const provider = await firstHealthyProvider();
  const latest = await provider.getBlockNumber();

  const logs: RawLog[] = [];
  let toBlock = latest;

  for (let chunk = 0; chunk < MAX_CHUNKS && logs.length < limit && toBlock > 0; chunk += 1) {
    const fromBlock = Math.max(0, toBlock - CHUNK_BLOCKS);
    const found = (await provider.send("eth_getLogs", [
      {
        address: NFT_CONTRACT_ADDRESS,
        topics: [TRANSFER_TOPIC],
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + toBlock.toString(16),
      },
    ])) as RawLog[];

    logs.push(...found);
    if (fromBlock === 0) break;
    toBlock = fromBlock - 1;
  }

  // ERC-721 Transfer indexes all three args; a log with fewer topics is an
  // ERC-20 Transfer sharing the same signature and is not ours.
  const transfers = logs
    .filter((log) => log.topics.length === 4)
    .sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)))
    .slice(0, limit);

  const blockCache = new Map<string, number | null>();
  const txCache = new Map<string, { to: string | null; value: bigint } | null>();

  // Enrich in parallel. Done serially this is ~2 round-trips per row and the
  // feed visibly hangs; the distinct tx/block sets are far smaller than the
  // row count because a batch transfer shares one transaction.
  const uniqueTxs = [...new Set(transfers.map((l) => l.transactionHash))];
  const uniqueBlocks = [...new Set(transfers.map((l) => l.blockNumber))];
  const uniqueTokenIds = [
    ...new Set(transfers.map((l) => BigInt(l.topics[3]).toString())),
  ].filter((id) => !imageCache.has(id));

  await Promise.all([
    ...uniqueTxs.map(async (hash) => {
      try {
        const fetched = await provider.getTransaction(hash);
        txCache.set(hash, fetched ? { to: fetched.to, value: fetched.value } : null);
      } catch {
        txCache.set(hash, null);
      }
    }),
    ...uniqueBlocks.map(async (blockNumber) => {
      try {
        const block = await provider.getBlock(Number(BigInt(blockNumber)));
        blockCache.set(blockNumber, block ? block.timestamp : null);
      } catch {
        blockCache.set(blockNumber, null);
      }
    }),
    ...uniqueTokenIds.map(async (tokenId) => {
      const image = await resolveTokenImage(NFT_CONTRACT_ADDRESS, tokenId);
      imageCache.set(tokenId, image);
    }),
  ]);

  // Second pass, only now that we know which transactions actually went
  // through Seaport: decode each one's OrderFulfilled log(s) and check the
  // resulting orderHash against what we served. A batch fill (e.g. our own
  // Sweep feature) can carry MULTIPLE OrderFulfilled events in one tx, so
  // each is matched to the specific tokenId it actually delivered — never
  // just "the tx touched Seaport, so attribute the whole tx to us."
  const seaportTxs = uniqueTxs.filter(
    (hash) => txCache.get(hash)?.to?.toLowerCase() === SEAPORT_ADDRESS.toLowerCase()
  );
  await Promise.all(
    seaportTxs.map(async (hash) => {
      await resolveMarketplankAttribution(provider, hash);
    })
  );

  const events: ActivityEvent[] = [];
  for (const log of transfers) {
    const from = topicToAddress(log.topics[1]);
    const to = topicToAddress(log.topics[2]);
    const tokenId = BigInt(log.topics[3]).toString();

    const tx = txCache.get(log.transactionHash) ?? null;
    const timestamp = blockCache.get(log.blockNumber) ?? null;

    const { kind, venue } = classifyTransfer({
      from,
      txTo: tx?.to ?? null,
      seaportAddress: SEAPORT_ADDRESS,
      nftContractAddress: NFT_CONTRACT_ADDRESS,
    });

    // Upgrade "seaport" (unattributed) to "marketplank" ONLY on a positive
    // orderHash match for THIS specific token within THIS transaction.
    if (venue?.kind === "seaport") {
      const attributed = attributionCache.get(`${log.transactionHash}:${tokenId}`);
      if (attributed) venue.kind = "marketplank";
    }

    // Price comes from whichever leg of the sale actually moved value: a
    // plain native-ETH fill moves it via tx.value; a WETH-denominated fill
    // (the common case here — Seaport can't pull native ETH from an
    // offerer, so every bid/offer is WETH) moves it as an ERC-20
    // consideration leg instead, decoded into priceCache above. Anything
    // else genuinely has no readable price rather than a misleading zero.
    const nativeWei = kind === "sale" && tx != null && tx.value > BigInt(0) ? tx.value : null;
    const wethWei = kind === "sale" ? priceCache.get(`${log.transactionHash}:${tokenId}`) ?? null : null;
    const priceWei = nativeWei ?? wethWei;

    events.push({
      kind,
      tokenId,
      from,
      to,
      priceWei: priceWei != null ? priceWei.toString() : null,
      priceEth: priceWei != null ? formatEther(priceWei) : null,
      txHash: log.transactionHash,
      blockNumber: Number(BigInt(log.blockNumber)),
      timestamp: timestamp == null ? null : new Date(timestamp * 1000).toISOString(),
      venue,
      imageUrl: imageCache.get(tokenId) ?? null,
    });
  }

  return events;
}
