import { Interface, formatEther, getAddress } from "ethers";
import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import { MARKET_OFFER_CURRENCY, MARKET_VAULT_ADDRESS, SEAPORT_ADDRESS } from "@/lib/constants";
import { resolveTokenImage } from "@/lib/market/token-image";
import { wasOrderServedByUs } from "@/lib/market/served-orders";
import { ethBlockNumberDisplay, ethGetLogsDisplay, rpcCall } from "@/lib/market/fetch-rpc";
import { SERVER_DISPLAY_RPC_URLS } from "@/lib/server/rpc-urls";
import { logScanBudget } from "@/lib/market/rpc-budget";
import {
  fetchAddressTransactions,
  fetchTokenTransfers,
  fetchTxTokenTransfers,
} from "@/lib/market/blockscout";
import {
  durableKv as kv,
  hasDurableKv,
} from "@/lib/market/durable-kv";
import { readSalesCatalog } from "@/lib/market/sales-catalog";

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

/** The node rejects wide ranges, so walk backwards in bounded windows.
 * On Cloudflare, logScanBudget shrinks this further to survive public RPC limits. */

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
   * "vault" — executed via our own MarketplankVault (deposit/redeem, not a
   *   sale — no listing, no buyer-paid price, so it must never be
   *   classified as "sale" or the UI shows a nonsensical "price
   *   unavailable" on what's actually a vault mechanic already properly
   *   shown, with its real numbers, in VaultTradeHistory). Direction
   *   (deposit vs redeem) is visible from `from`/`to` already on this event.
   * null — a plain wallet-to-wallet transfer, no contract intermediary.
   *
   * NOTE ON SCOPE: this only ever sees activity that happens ON THIS CHAIN.
   * Robinhood Chain is an Arbitrum Layer-2 on Ethereum (chain id 4663, ETH gas,
   * Ethereum blobs for data availability — docs.robinhood.com/chain), mainnet
   * live since July 2026. It cannot and does not claim to see trades on
   * OpenSea/Blur/Magic Eden/etc. on OTHER chains; an NFT aggregator has to index
   * this chain explicitly before its listings could appear here. Verify current
   * coverage before assuming either way — this is a business-outreach question,
   * not a code gap.
   */
  venue: { kind: "marketplank" | "seaport" | "vault" | "other"; contract: string } | null;
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
  /** Null when no vault is deployed for this collection yet. */
  vaultAddress?: string | null;
}): { kind: ActivityKind; venue: ActivityEvent["venue"] } {
  const nftContract = input.nftContractAddress.toLowerCase();
  const seaport = input.seaportAddress.toLowerCase();
  const vault = input.vaultAddress?.toLowerCase() ?? null;
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
  // A deposit or redeem, not a sale — no listing, no buyer-paid price. Must
  // be checked before the generic "any other contract = sale" fallback
  // below, or it gets mislabeled as a sale with no price to show, which is
  // exactly the reported bug (VaultTradeHistory already shows these with
  // their real numbers; this feed just needs to stop double-counting them
  // as broken sales).
  if (vault != null && txTo === vault) {
    return { kind: "transfer", venue: { kind: "vault", contract: input.txTo! } };
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
async function resolveMarketplankAttribution(txHash: string): Promise<void> {
  if (attributionResolvedTxs.has(txHash)) return;
  try {
    const receipt = await rpcCall<{
      logs?: Array<{ address: string; topics: string[]; data: string }>;
    }>("eth_getTransactionReceipt", [txHash], { timeoutMs: 8_000, urls: SERVER_DISPLAY_RPC_URLS });
    if (!receipt) return;
    attributionResolvedTxs.add(txHash);

    for (const log of receipt.logs || []) {
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
/**
 * `full` raises the cap well past the ticker's default 40, for a real
 * "full lineage" price chart — but NOT to true-unbounded. Unlike the
 * vault's own trade log (a handful of events so far), this walks EVERY
 * ERC-721 Transfer on the collection — 1,542 mints alone — and enriches
 * each one with its own getTransaction() call to recover a sale price.
 * Removing the cap entirely here would trade one performance complaint for
 * a much worse one. 300 comfortably covers the collection's real sale
 * history without that blowup; see app/api/market/activity/route.ts for
 * the separate, longer-lived cache this variant gets.
 */
const FULL_LINEAGE_LIMIT = 800;
const SALES_KV_KEY = "plank:market:sales-catalog-v1";
const SALES_KV_TTL = 6 * 60 * 60;

type PricedSaleKey = string; // txHash:tokenId

function hasKv(): boolean {
  return hasDurableKv();
}

function isMarketplaceMethod(method: string): boolean {
  const m = method.toLowerCase();
  return (
    m.includes("fulfill") ||
    m.includes("match") ||
    m.includes("sweep") ||
    m.includes("buyfrom") ||
    m.includes("buy_") ||
    m.includes("take") ||
    m.includes("accept") ||
    m.includes("purchase") ||
    m.includes("order")
  );
}

/**
 * Price a marketplace tx for RobinWood: native ETH (tx.value) and/or WETH
 * ERC-20 transfers inside the same tx. Split across RobinWood NFTs moved.
 * Works for Seaport fulfill/match AND other marketplaces (e.g. buyFromListing).
 */
async function priceTxForRobinWood(
  txHash: string,
  nativeValueWei?: string | null
): Promise<
  Map<PricedSaleKey, { priceWei: bigint; from: string; to: string; ts: string | null; block: number }>
> {
  const out = new Map<
    PricedSaleKey,
    { priceWei: bigint; from: string; to: string; ts: string | null; block: number }
  >();
  const moves = await fetchTxTokenTransfers(txHash);
  const nft = NFT_CONTRACT_ADDRESS.toLowerCase();
  const weth = (MARKET_OFFER_CURRENCY || "").toLowerCase();

  const nftMoves = moves.filter((m) => {
    const addr = (m.token?.address_hash || m.token?.address || "").toLowerCase();
    return addr === nft && m.total?.token_id != null;
  });
  if (nftMoves.length === 0) return out;

  let totalWei = BigInt(0);
  try {
    if (nativeValueWei) totalWei = BigInt(nativeValueWei);
  } catch {
    totalWei = BigInt(0);
  }

  // WETH (and any other ERC-20 consideration) — sum amounts. Prefer WETH when set.
  let wethWei = BigInt(0);
  let otherErc20 = BigInt(0);
  for (const m of moves) {
    const addr = (m.token?.address_hash || m.token?.address || "").toLowerCase();
    const typ = (m.token?.type || "").toUpperCase();
    if (typ === "ERC-721" || typ === "ERC-1155") continue;
    try {
      const amt = BigInt(m.total?.value || "0");
      if (amt <= BigInt(0)) continue;
      if (weth && addr === weth) wethWei += amt;
      else if (addr && addr !== nft) otherErc20 += amt;
    } catch {
      /* skip */
    }
  }
  // Prefer explicit payment leg: native > WETH > other ERC-20
  if (totalWei <= BigInt(0) && wethWei > BigInt(0)) totalWei = wethWei;
  if (totalWei <= BigInt(0) && otherErc20 > BigInt(0)) totalWei = otherErc20;
  if (totalWei <= BigInt(0)) return out;

  const per = totalWei / BigInt(nftMoves.length);
  if (per <= BigInt(0)) return out;

  for (const m of nftMoves) {
    const tokenId = String(m.total!.token_id);
    const key = `${txHash}:${tokenId}`;
    out.set(key, {
      priceWei: per,
      from: m.from?.hash || ZERO,
      to: m.to?.hash || ZERO,
      ts: m.timestamp ?? null,
      block: m.block_number ?? 0,
    });
    priceCache.set(key, per);
  }
  return out;
}

/**
 * Build price map from:
 *  1) Seaport address txs that touch RobinWood (fulfill/match/…)
 *  2) Explicit sale tx hashes already seen on NFT Transfer feed
 *
 * CF-safe Blockscout REST only — no eth_getTransactionReceipt.
 */
async function buildMarketplacePriceMap(opts?: {
  maxSeaportPages?: number;
  maxTxDetail?: number;
  extraTxHashes?: string[];
}): Promise<
  Map<PricedSaleKey, { priceWei: bigint; from: string; to: string; ts: string | null; block: number }>
> {
  const maxPages = opts?.maxSeaportPages ?? 12;
  const maxDetail = opts?.maxTxDetail ?? 100;
  const out = new Map<
    PricedSaleKey,
    { priceWei: bigint; from: string; to: string; ts: string | null; block: number }
  >();

  type Cand = { hash: string; value?: string; priority: number };
  const candidates: Cand[] = [];
  const seenHash = new Set<string>();

  // Priority 0: txs already known to move THIS collection (from Transfer feed).
  // Must be priced first — Seaport is shared with other NFTs and a value-sort
  // would burn the detail budget on unrelated high-ETH fills.
  for (const h of opts?.extraTxHashes ?? []) {
    if (h && /^0x[0-9a-fA-F]{64}$/.test(h) && !seenHash.has(h.toLowerCase())) {
      seenHash.add(h.toLowerCase());
      candidates.push({ hash: h, priority: 0 });
    }
  }

  // Only scan Seaport's global tx list when the NFT transfer feed didn't
  // surface marketplace fills (cold / sparse). Otherwise we burn the Worker
  // subrequest budget on other collections that share Seaport.
  if (candidates.length < 8 && maxPages > 0) {
    try {
      const seaportTxs = await fetchAddressTransactions(SEAPORT_ADDRESS, {
        maxPages: Math.min(maxPages, 4),
      });
      for (const tx of seaportTxs) {
        if (!tx.hash) continue;
        const method = tx.method || "";
        const status = String(tx.status || "ok").toLowerCase();
        if (status && status !== "ok") continue;
        if (method && !isMarketplaceMethod(method) && BigInt(tx.value || "0") === BigInt(0)) {
          if (!tx.value || tx.value === "0") continue;
        }
        if (seenHash.has(tx.hash.toLowerCase())) continue;
        seenHash.add(tx.hash.toLowerCase());
        candidates.push({ hash: tx.hash, value: tx.value, priority: 1 });
      }
    } catch {
      /* transfer-feed hashes only */
    }
  }

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const av = BigInt(a.value || "0");
    const bv = BigInt(b.value || "0");
    return av === bv ? 0 : av > bv ? -1 : 1;
  });

  const slice = candidates.slice(0, maxDetail);
  const CONC = 8;
  for (let i = 0; i < slice.length; i += CONC) {
    const batch = slice.slice(i, i + CONC);
    await Promise.all(
      batch.map(async (c) => {
        try {
          const priced = await priceTxForRobinWood(c.hash, c.value);
          for (const [k, v] of priced) out.set(k, v);
        } catch {
          /* skip */
        }
      })
    );
  }

  if (hasKv() && out.size > 0) {
    try {
      const prev = (await kv.get<Record<string, string>>(SALES_KV_KEY)) || {};
      const merged: Record<string, string> = { ...prev };
      for (const [k, v] of out) merged[k] = v.priceWei.toString();
      const keys = Object.keys(merged);
      if (keys.length > 5_000) {
        for (const k of keys.slice(0, keys.length - 5_000)) delete merged[k];
      }
      await kv.set(SALES_KV_KEY, merged, { ex: SALES_KV_TTL });
    } catch {
      /* best-effort */
    }
  }

  return out;
}

/**
 * Real priced sales, from the royalty-verified catalog (lib/market/
 * sales-catalog.ts, KV key "...-v2") that /api/market/sales-stats and the
 * Activity tab's own aggregate sidebar already rely on and keep current.
 *
 * This function used to read its own separate, never-migrated "...-v1" key
 * instead — nothing has written a usable value there in a long time, so
 * every individual Activity row's price silently came back "Unavailable"
 * while the aggregate stats built from the real (v2) catalog right next to
 * it were correct. Confirmed live: sales-stats reported 72 priced sales and
 * a real highest price, while every row here showed none. Falls through to
 * the legacy v1 key only if the v2 catalog has nothing yet (e.g. its first
 * cold build hasn't completed), so a brand-new deployment never regresses
 * to fully empty.
 */
async function loadSalesKv(): Promise<Map<string, bigint>> {
  const map = new Map<string, bigint>();
  try {
    const catalog = await readSalesCatalog();
    if (catalog) {
      for (const sale of catalog.sales) {
        try {
          const wei = BigInt(sale.priceWei);
          if (wei > BigInt(0)) {
            const key = `${sale.txHash}:${sale.tokenId}`;
            map.set(key, wei);
            priceCache.set(key, wei);
          }
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* fall through to the legacy key below */
  }
  if (map.size > 0) return map;

  if (!hasKv()) return map;
  try {
    const prev = await kv.get<Record<string, string>>(SALES_KV_KEY);
    if (!prev || typeof prev !== "object") return map;
    for (const [k, v] of Object.entries(prev)) {
      try {
        const wei = BigInt(v);
        if (wei > BigInt(0)) {
          map.set(k, wei);
          priceCache.set(k, wei);
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  return map;
}

/** Blockscout REST path — used first on Cloudflare where eth_ RPC is 429'd. */
async function fetchActivityFromBlockscout(
  limit: number,
  opts?: { full?: boolean }
): Promise<ActivityEvent[]> {
  const full = Boolean(opts?.full);
  // CF Workers ~30s wall. Deep sale prices live in KV
  // (scripts/seed-sales-catalog.mjs). Request path only pulls a shallow
  // Blockscout transfer window + merges the catalog.
  const kvPrices = await loadSalesKv();
  const kvWarm = kvPrices.size >= 8;
  const transferPages = full ? (kvWarm ? 4 : 8) : Math.max(2, Math.ceil(limit / 50));

  const transfers = await fetchTokenTransfers(NFT_CONTRACT_ADDRESS, {
    maxPages: transferPages,
  });

  const saleHashesFromFeed = [
    ...new Set(
      transfers
        .filter((t) => isMarketplaceMethod(t.method || ""))
        .map((t) => t.transaction_hash || "")
        .filter(Boolean)
    ),
  ];

  // Live-price at most a few unknown recent fills — never re-scan the whole book.
  const needLive = saleHashesFromFeed
    .filter((h) => ![...kvPrices.keys()].some((k) => k.startsWith(h + ":")))
    .slice(0, kvWarm ? 4 : 12);

  let marketplacePrices = new Map<
    PricedSaleKey,
    { priceWei: bigint; from: string; to: string; ts: string | null; block: number }
  >();
  if (needLive.length > 0) {
    try {
      marketplacePrices = await buildMarketplacePriceMap({
        maxSeaportPages: 0,
        maxTxDetail: needLive.length,
        extraTxHashes: needLive,
      });
    } catch {
      marketplacePrices = new Map();
    }
  }

  for (const [key, wei] of kvPrices) {
    if (marketplacePrices.has(key)) continue;
    const [txHash, tokenId] = key.split(":");
    if (!txHash || !tokenId) continue;
    marketplacePrices.set(key, {
      priceWei: wei,
      from: ZERO,
      to: ZERO,
      ts: null,
      block: 0,
    });
  }

  const vault = MARKET_VAULT_ADDRESS?.toLowerCase() ?? null;
  const events: ActivityEvent[] = [];
  const seen = new Set<string>(); // txHash:tokenId

  for (const t of transfers) {
    if (events.length >= limit) break;
    const fromRaw = t.from?.hash || ZERO;
    const toRaw = t.to?.hash || ZERO;
    const from = fromRaw.toLowerCase();
    const to = toRaw.toLowerCase();
    const tokenId =
      t.total?.token_id != null
        ? String(t.total.token_id)
        : t.total?.token_instance?.id != null
          ? String(t.total.token_instance.id)
          : "";
    if (!tokenId) continue;

    const txHash = t.transaction_hash || "";
    const dedupe = `${txHash}:${tokenId}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const method = (t.method || "").toLowerCase();
    let kind: ActivityKind = "transfer";
    let venue: ActivityEvent["venue"] = null;

    const priced =
      marketplacePrices.get(dedupe) ||
      (priceCache.has(dedupe)
        ? {
            priceWei: priceCache.get(dedupe)!,
            from: fromRaw,
            to: toRaw,
            ts: t.timestamp ?? null,
            block: t.block_number ?? 0,
          }
        : null);

    if (from === ZERO || method.includes("mint")) {
      kind = "mint";
      venue = null;
    } else if (
      vault &&
      (from === vault || to === vault || method.includes("deposit") || method.includes("redeem"))
    ) {
      kind = "transfer";
      venue = { kind: "vault", contract: MARKET_VAULT_ADDRESS! };
    } else if (priced || isMarketplaceMethod(method)) {
      kind = "sale";
      // Seaport methods → seaport venue; anything else → other (still priced).
      venue =
        method.includes("fulfill") || method.includes("match") || method.includes("sweep")
          ? { kind: "seaport", contract: SEAPORT_ADDRESS }
          : { kind: "other", contract: method || "marketplace" };
    } else if (from !== ZERO && to !== ZERO) {
      if (method && method !== "transferfrom" && method !== "safetransferfrom") {
        kind = "sale";
        venue = { kind: "other", contract: method };
      } else {
        kind = "transfer";
        venue = null;
      }
    }

    const inst = t.total?.token_instance;
    const rawImg = inst?.image_url || inst?.media_url || inst?.metadata?.image || null;
    let imageUrl: string | null = imageCache.get(tokenId) ?? null;
    if (!imageUrl && rawImg) {
      try {
        const { resolveIpfsUrl } = await import("@/lib/ipfs");
        imageUrl = resolveIpfsUrl(rawImg);
        if (imageUrl) imageCache.set(tokenId, imageUrl);
      } catch {
        imageUrl = rawImg;
      }
    }

    const priceWei = priced?.priceWei ?? priceCache.get(dedupe) ?? null;

    events.push({
      kind,
      tokenId,
      from: fromRaw.startsWith("0x") ? fromRaw : ZERO,
      to: toRaw.startsWith("0x") ? toRaw : ZERO,
      priceWei: priceWei != null && priceWei > BigInt(0) ? priceWei.toString() : null,
      priceEth: priceWei != null && priceWei > BigInt(0) ? formatEther(priceWei) : null,
      txHash,
      blockNumber: t.block_number ?? 0,
      timestamp: t.timestamp ?? null,
      venue,
      imageUrl,
    });
  }

  // Ensure every marketplace-priced RobinWood move appears even if it fell
  // outside the recent transfer window (critical for "highest sale ever").
  for (const [key, priced] of marketplacePrices) {
    if (seen.has(key)) continue;
    const [txHash, tokenId] = key.split(":");
    if (!txHash || !tokenId) continue;
    seen.add(key);
    events.push({
      kind: "sale",
      tokenId,
      from: priced.from,
      to: priced.to,
      priceWei: priced.priceWei.toString(),
      priceEth: formatEther(priced.priceWei),
      txHash,
      blockNumber: priced.block,
      timestamp: priced.ts,
      venue: { kind: "seaport", contract: SEAPORT_ADDRESS },
      imageUrl: imageCache.get(tokenId) ?? null,
    });
  }

  // Sort newest first
  events.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return b.blockNumber - a.blockNumber;
    return (b.timestamp || "").localeCompare(a.timestamp || "");
  });

  // Skip RPC attribution on Cloudflare cold path — prices already correct from
  // Blockscout WETH/native. Attribution is best-effort only when cheap.
  if (!full) {
    const topPriced = events
      .filter((e) => e.kind === "sale" && e.priceWei && e.txHash)
      .slice(0, 4)
      .map((e) => e.txHash);
    await Promise.all(
      [...new Set(topPriced)].map(async (hash) => {
        try {
          await resolveMarketplankAttribution(hash);
        } catch {
          /* skip */
        }
      })
    );
    for (const e of events) {
      if (e.kind !== "sale" || !e.txHash) continue;
      if (attributionCache.get(`${e.txHash}:${e.tokenId}`) && e.venue) {
        e.venue = { kind: "marketplank", contract: SEAPORT_ADDRESS };
      }
    }
  }

  return events.slice(0, limit);
}

export async function fetchActivity(
  limit = 40,
  opts?: { full?: boolean }
): Promise<ActivityEvent[]> {
  const effectiveLimit = opts?.full ? FULL_LINEAGE_LIMIT : limit;

  // Prefer Blockscout first — public eth_ RPC rate-limits Cloudflare hard.
  try {
    const events = await fetchActivityFromBlockscout(effectiveLimit, {
      full: Boolean(opts?.full),
    });
    if (events.length > 0) return events;
  } catch {
    // fall through to eth_ path
  }

  const latest = await ethBlockNumberDisplay();
  const { chunkBlocks, maxChunks } = logScanBudget();

  const logs: RawLog[] = [];
  let toBlock = latest;

  for (let chunk = 0; chunk < maxChunks && logs.length < effectiveLimit && toBlock > 0; chunk += 1) {
    const fromBlock = Math.max(0, toBlock - chunkBlocks);
    try {
      const found = (await ethGetLogsDisplay({
        address: NFT_CONTRACT_ADDRESS,
        topics: [TRANSFER_TOPIC],
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + toBlock.toString(16),
      })) as RawLog[];
      logs.push(...found);
    } catch {
      break;
    }
    if (fromBlock === 0) break;
    toBlock = fromBlock - 1;
  }

  // ERC-721 Transfer indexes all three args; a log with fewer topics is an
  // ERC-20 Transfer sharing the same signature and is not ours.
  const transfers = logs
    .filter((log) => log.topics.length === 4)
    .sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)))
    .slice(0, effectiveLimit);

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

  // Cap enrichment fan-out on Workers to avoid RPC 429 storms.
  const txSlice = uniqueTxs.slice(0, Math.min(uniqueTxs.length, 40));
  const blockSlice = uniqueBlocks.slice(0, Math.min(uniqueBlocks.length, 40));
  const imageSlice = uniqueTokenIds.slice(0, Math.min(uniqueTokenIds.length, 24));

  await Promise.all([
    ...txSlice.map(async (hash) => {
      try {
        const fetched = await rpcCall<{ to?: string; value?: string }>("eth_getTransactionByHash", [
          hash,
        ], { timeoutMs: 6_000, urls: SERVER_DISPLAY_RPC_URLS });
        txCache.set(
          hash,
          fetched
            ? { to: fetched.to ?? null, value: BigInt(fetched.value || "0x0") }
            : null
        );
      } catch {
        txCache.set(hash, null);
      }
    }),
    ...blockSlice.map(async (blockNumber) => {
      try {
        const block = await rpcCall<{ timestamp?: string }>("eth_getBlockByNumber", [
          blockNumber,
          false,
        ], { timeoutMs: 6_000, urls: SERVER_DISPLAY_RPC_URLS });
        blockCache.set(
          blockNumber,
          block?.timestamp != null ? Number(BigInt(block.timestamp)) : null
        );
      } catch {
        blockCache.set(blockNumber, null);
      }
    }),
    ...imageSlice.map(async (tokenId) => {
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
  const seaportTxs = txSlice.filter(
    (hash) => txCache.get(hash)?.to?.toLowerCase() === SEAPORT_ADDRESS.toLowerCase()
  );
  await Promise.all(
    seaportTxs.slice(0, 15).map(async (hash) => {
      await resolveMarketplankAttribution(hash);
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
      vaultAddress: MARKET_VAULT_ADDRESS,
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
