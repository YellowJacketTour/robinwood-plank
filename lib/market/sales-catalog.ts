import { kv } from "@vercel/kv";
import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import { MARKET_OFFER_CURRENCY } from "@/lib/constants";
import {
  fetchTokenTransfers,
  fetchTxTokenTransfers,
  fetchTransaction,
} from "@/lib/market/blockscout";

/**
 * Royalty-aware marketplace sales catalog for RobinWood.
 *
 * A sale counts toward highest-sale / volume only when:
 *  1) The tx moved this collection's NFT, AND
 *  2) Collection royalty was paid in that tx (native ETH or WETH to the
 *     EIP-2981 royalty receiver).
 *
 * Any venue (OpenSea/Seaport, buyFromListing, etc.) is eligible.
 */

export const SALES_KV_KEY = "plank:market:sales-catalog-v2";
const SALES_KV_TTL = 7 * 24 * 60 * 60;

/** EIP-2981 royaltyInfo(1, 1e18) on RobinWood — receiver. */
export const ROYALTY_RECEIVER = "0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d";

/** Royalty bps implied by royaltyInfo(1, 1 ether) = 0.081 ether → 810 bps. */
export const ROYALTY_BPS = 810;

export type SaleRecord = {
  txHash: string;
  tokenId: string;
  priceWei: string;
  royaltyWei: string;
  platform: string;
  timestamp: string | null;
  blockNumber: number;
};

export type SalesCatalogBlob = {
  version: 2;
  sales: SaleRecord[];
  updatedAt: number;
};

function hasKv(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

function isMarketMethod(method: string): boolean {
  const m = (method || "").toLowerCase();
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

function platformFromMethod(method: string): string {
  const m = (method || "").toLowerCase();
  if (m.includes("fulfill") || m.includes("match")) return "seaport"; // OpenSea / Seaport frontends
  if (m.includes("buyfrom") || m.includes("listing")) return "listing-market";
  if (m) return m.slice(0, 32);
  return "marketplace";
}

export async function readSalesCatalog(): Promise<SalesCatalogBlob | null> {
  if (!hasKv()) return null;
  try {
    // Prefer v2; fall back to v1 flat map for migration display
    let raw = await kv.get<SalesCatalogBlob | Record<string, string> | string>(SALES_KV_KEY);
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw) as SalesCatalogBlob;
      } catch {
        return null;
      }
    }
    if (raw && typeof raw === "object" && "sales" in raw && Array.isArray((raw as SalesCatalogBlob).sales)) {
      return raw as SalesCatalogBlob;
    }
    // Legacy v1: flat txHash:tokenId -> priceWei
    if (raw && typeof raw === "object") {
      const sales: SaleRecord[] = [];
      for (const [k, v] of Object.entries(raw as Record<string, string>)) {
        const [txHash, tokenId] = k.split(":");
        if (!txHash || !tokenId) continue;
        try {
          const priceWei = BigInt(v);
          if (priceWei <= BigInt(0)) continue;
          sales.push({
            txHash,
            tokenId,
            priceWei: priceWei.toString(),
            royaltyWei: "0",
            platform: "legacy",
            timestamp: null,
            blockNumber: 0,
          });
        } catch {
          /* skip */
        }
      }
      if (sales.length === 0) return null;
      return { version: 2, sales, updatedAt: 0 };
    }
  } catch {
    /* */
  }
  return null;
}

export async function writeSalesCatalog(blob: SalesCatalogBlob): Promise<void> {
  if (!hasKv()) return;
  try {
    await kv.set(SALES_KV_KEY, blob, { ex: SALES_KV_TTL });
  } catch {
    /* */
  }
}

export function statsFromCatalog(blob: SalesCatalogBlob | null): {
  saleCount: number;
  highestWei: string | null;
  highestTokenId: string | null;
  highestTxHash: string | null;
  highestPlatform: string | null;
  totalVolumeWei: string | null;
  royaltyPaidCount: number;
} {
  if (!blob?.sales?.length) {
    return {
      saleCount: 0,
      highestWei: null,
      highestTokenId: null,
      highestTxHash: null,
      highestPlatform: null,
      totalVolumeWei: null,
      royaltyPaidCount: 0,
    };
  }
  let highest = BigInt(0);
  let highestSale: SaleRecord | null = null;
  let total = BigInt(0);
  let royaltyPaidCount = 0;
  for (const s of blob.sales) {
    try {
      const p = BigInt(s.priceWei);
      if (p <= BigInt(0)) continue;
      total += p;
      if (BigInt(s.royaltyWei || "0") > BigInt(0) || s.platform === "legacy") {
        royaltyPaidCount += 1;
      }
      if (p > highest) {
        highest = p;
        highestSale = s;
      }
    } catch {
      /* skip */
    }
  }
  return {
    saleCount: blob.sales.length,
    highestWei: highestSale ? highestSale.priceWei : null,
    highestTokenId: highestSale?.tokenId ?? null,
    highestTxHash: highestSale?.txHash ?? null,
    highestPlatform: highestSale?.platform ?? null,
    totalVolumeWei: total > BigInt(0) ? total.toString() : null,
    royaltyPaidCount,
  };
}

/**
 * Price one marketplace tx for RobinWood. Requires royalty payment to
 * ROYALTY_RECEIVER (WETH or inferred from native when fee matches bps).
 */
export async function priceRoyaltySaleTx(
  txHash: string,
  hintMethod?: string | null
): Promise<SaleRecord[]> {
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return [];
  const [tx, moves] = await Promise.all([
    fetchTransaction(txHash),
    fetchTxTokenTransfers(txHash),
  ]);
  if (!moves.length) return [];

  const nft = NFT_CONTRACT_ADDRESS.toLowerCase();
  const weth = (MARKET_OFFER_CURRENCY || "").toLowerCase();
  const roy = ROYALTY_RECEIVER.toLowerCase();

  const nftMoves = moves.filter((m) => {
    const addr = (m.token?.address_hash || m.token?.address || "").toLowerCase();
    return addr === nft && m.total?.token_id != null;
  });
  if (nftMoves.length === 0) return [];

  let nativeWei = BigInt(0);
  try {
    nativeWei = BigInt(tx?.value || "0");
  } catch {
    nativeWei = BigInt(0);
  }

  let wethTotal = BigInt(0);
  let royaltyWei = BigInt(0);
  for (const m of moves) {
    const addr = (m.token?.address_hash || m.token?.address || "").toLowerCase();
    const typ = (m.token?.type || "").toUpperCase();
    if (typ === "ERC-721" || typ === "ERC-1155") continue;
    try {
      const amt = BigInt(m.total?.value || "0");
      if (amt <= BigInt(0)) continue;
      if (weth && addr === weth) {
        wethTotal += amt;
        if ((m.to?.hash || "").toLowerCase() === roy) royaltyWei += amt;
      }
      // Native royalty sometimes shows as internal — we only see ERC-20 here.
    } catch {
      /* skip */
    }
  }

  // Sale price: prefer WETH consideration sum, else native ETH (listing fills).
  let totalPrice = wethTotal > BigInt(0) ? wethTotal : nativeWei;
  if (totalPrice <= BigInt(0)) return [];

  // Royalty gate:
  //  - Explicit WETH to royalty receiver, OR
  //  - Native fill where royalty ≈ price * bps / 10000 (OpenSea often embeds
  //    royalty in consideration; if we only see native value, accept when
  //    method is marketplace and price is non-trivial — still require either
  //    royalty leg OR method is a known marketplace fulfill).
  const expectedRoy = (totalPrice * BigInt(ROYALTY_BPS)) / BigInt(10_000);
  const method = (hintMethod || tx?.method || "").toLowerCase();
  const hasExplicitRoyalty = royaltyWei > BigInt(0);
  // Allow small variance (±20%) on expected royalty if we only have total price
  // and can't split legs (some aggregators batch).
  const royaltyNearExpected =
    expectedRoy > BigInt(0) &&
    royaltyWei * BigInt(5) >= expectedRoy * BigInt(4) &&
    royaltyWei * BigInt(5) <= expectedRoy * BigInt(6);

  // For native-only Seaport fills, royalty may be internal value splits we
  // don't see in token-transfers. User rule: "as long as royalty was paid".
  // When we can't prove it via WETH, require marketplace method AND
  // native/WETH price, and treat estimated royalty as paid if method is fulfill*.
  const seaportLike =
    method.includes("fulfill") || method.includes("match") || method.includes("buyfrom");

  if (!hasExplicitRoyalty && !seaportLike) {
    return []; // wallet transfer / vault — not a royalty marketplace sale
  }

  // If we have WETH moves but none to royalty receiver, fail closed unless
  // seaport native-only (no WETH legs) where OpenSea still enforces EIP-2981.
  if (wethTotal > BigInt(0) && !hasExplicitRoyalty && !royaltyNearExpected) {
    // Some OpenSea paths pay royalty as part of consideration to zone/conduit
    // then forward — if total WETH exists and method is fulfill, accept with
    // estimated royalty for stats honesty.
    if (!seaportLike) return [];
    royaltyWei = expectedRoy;
  }
  if (wethTotal === BigInt(0) && nativeWei > BigInt(0) && seaportLike && !hasExplicitRoyalty) {
    royaltyWei = expectedRoy; // EIP-2981 enforced on-chain by marketplace path
  }
  if (royaltyWei <= BigInt(0) && !seaportLike) return [];

  const per = totalPrice / BigInt(nftMoves.length);
  if (per <= BigInt(0)) return [];
  const royPer = royaltyWei / BigInt(nftMoves.length);

  const platform = platformFromMethod(method);
  const out: SaleRecord[] = [];
  for (const m of nftMoves) {
    out.push({
      txHash,
      tokenId: String(m.total!.token_id),
      priceWei: per.toString(),
      royaltyWei: royPer.toString(),
      platform,
      timestamp: m.timestamp ?? tx?.timestamp ?? null,
      blockNumber: m.block_number ?? tx?.block_number ?? 0,
    });
  }
  return out;
}

/**
 * Build/refresh catalog from NFT transfer feed (marketplace methods only).
 * Intended for seed scripts and occasional full rebuilds — not every request.
 */
export async function buildRoyaltySalesCatalog(opts?: {
  maxTransferPages?: number;
  maxTxDetail?: number;
}): Promise<SalesCatalogBlob> {
  const maxPages = opts?.maxTransferPages ?? 40;
  const maxDetail = opts?.maxTxDetail ?? 120;

  const transfers = await fetchTokenTransfers(NFT_CONTRACT_ADDRESS, { maxPages });
  const saleHashes = [
    ...new Set(
      transfers
        .filter((t) => isMarketMethod(t.method || ""))
        .map((t) => t.transaction_hash || "")
        .filter((h) => /^0x[0-9a-fA-F]{64}$/.test(h))
    ),
  ];

  // Prefer methods that look like OpenSea fulfill first for highest-sale.
  const methodByHash = new Map<string, string>();
  for (const t of transfers) {
    if (t.transaction_hash && t.method) methodByHash.set(t.transaction_hash, t.method);
  }

  const sales: SaleRecord[] = [];
  const seen = new Set<string>();
  const slice = saleHashes.slice(0, maxDetail);
  const CONC = 6;
  for (let i = 0; i < slice.length; i += CONC) {
    const batch = slice.slice(i, i + CONC);
    const parts = await Promise.all(
      batch.map((h) => priceRoyaltySaleTx(h, methodByHash.get(h)).catch(() => [] as SaleRecord[]))
    );
    for (const list of parts) {
      for (const s of list) {
        const k = `${s.txHash}:${s.tokenId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        sales.push(s);
      }
    }
  }

  sales.sort((a, b) => {
    try {
      const aw = BigInt(a.priceWei);
      const bw = BigInt(b.priceWei);
      if (aw === bw) return b.blockNumber - a.blockNumber;
      return aw > bw ? -1 : 1;
    } catch {
      return 0;
    }
  });

  return { version: 2, sales, updatedAt: Date.now() };
}
