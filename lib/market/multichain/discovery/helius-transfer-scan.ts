/**
 * The missing permanent record of Solana NFT transfers -- transfer-ledger.ts's
 * sibling for Solana, same sink (plank_market_events, migration 042 + 046's
 * chain_namespace/event_identity columns), different real event model.
 *
 * WHY NO SEPARATE TABLE
 * ----------------------
 * plank_market_events is already chain-agnostic (migration 046 explicitly
 * branches chain_namespace on `chain_slug LIKE 'solana%'`) and already
 * supports 'transfer'/'sale'/'mint' event_type rows. Building a second
 * Solana-only ledger table would duplicate that schema and drift from it.
 * This module writes into the SAME table transfer-ledger.ts's EVM path
 * writes into, with chain_namespace='solana'.
 *
 * REAL EVENT MODEL, RESEARCHED (not guessed)
 * -------------------------------------------
 * Solana NFTs are either legacy/pNFT SPL tokens (SPL Token Program
 * Transfer/TransferChecked, supply=1 mint) or Metaplex Core assets (a
 * single-account asset with its own Transfer instruction) -- see
 * helius-solana.ts's header for how this app already distinguishes the two
 * standards via DAS `interface`. Decoding either instruction shape RAW,
 * per-standard, per-program-version, off of getSignaturesForAddress +
 * getTransaction, is the fragile path this codebase has already declined
 * once for a harder case (Bitcoin's raw parent-child inscription walk, see
 * helius-collection-scan.ts's header) -- Solana instruction shapes have the
 * same "too many real program variants to decode raw and stay correct"
 * problem (SPL Token, Token-2022, Metaplex Core, and every marketplace's own
 * CPI wrapping the same underlying transfer).
 *
 * Helius's own Enhanced Transactions API
 * (GET /v0/addresses/{address}/transactions, confirmed real 2026-08-23 via
 * docs.helius.dev -> www.helius.dev/docs/api-reference/enhanced-transactions/
 * gettransactionsbyaddress) does exactly this decode server-side and hands
 * back a parsed `type` per transaction (NFT_SALE, NFT_MINT, NFT_LISTING,
 * NFT_CANCEL_LISTING, NFT_BID, TRANSFER, COMPRESSED_NFT_MINT,
 * COMPRESSED_NFT_TRANSFER, ...), a `source` (the real marketplace program
 * family -- MAGIC_EDEN, TENSOR, SOLANART, ...) and, for sale-shaped types, an
 * `events.nft` object (type/source/buyer/seller/amount/nfts[]). This is
 * strictly more reliable than raw instruction decoding for this app's
 * purpose (a real from/to/tx/timestamp ledger, correctly separating
 * marketplace fills from wallet moves) -- confirmed request shape via the
 * real docs page: `limit` (1-100), `before-signature`/`after-signature`
 * cursors, `sort-order` (asc/desc), `source`/`type` filters. The docs page
 * fetched does NOT state any documented historical depth limit or hard
 * pagination cap; genesis-forward pagination here (`sort-order=asc` +
 * advancing `after-signature`) is only bounded by the number of real
 * transactions that exist and Helius's per-RPS plan limits (see
 * helius-key-pool.ts's own header), never a self-imposed page count beyond
 * the per-call `maxPages` batching knob this module exposes (same shape as
 * helius-collection-scan.ts's own `maxPages`).
 *
 * SCOPE, STATED HONESTLY
 * -----------------------
 * The Enhanced Transactions API is walked PER REAL MEMBER MINT (there is no
 * documented collection-wide "every transfer for every member" endpoint) --
 * member mints come from plank_collection_tokens, the same real, already-
 * populated per-token projection helius-rarity-index-runner.ts builds via
 * DAS grouping. A collection whose membership hasn't been indexed yet by
 * that runner has no mints to walk here yet; this module does not
 * duplicate that indexing, it depends on it, exactly like
 * hydrate-solana-membership already gates on the same table elsewhere in
 * this app's refresh pipeline. This covers BOTH legacy/pNFT SPL mints and
 * Metaplex Core assets identically (Helius's parser handles both under the
 * same address/transactions endpoint) -- no per-standard branch needed on
 * this module's side, unlike helius-collection-scan.ts's DAS-search path.
 *
 * MARKETPLACE-FILL TAGGING (task requirement -- distinguish, not silently
 * drop)
 * -------------------------------------------------------------------------
 * Unlike transfer-ledger.ts's EVM path (which EXCLUDES marketplace fills
 * because a real, fuller per-venue fill table already captures them), this
 * app has NO dedicated Solana marketplace-fill table today. Excluding
 * NFT_SALE rows here would silently drop real sale history entirely, not
 * avoid a duplicate. So this module WRITES every real event it observes,
 * tagged honestly: event_type='sale' (venue_id/protocol = Helius's own
 * `source`, e.g. 'magic-eden'/'tensor') for NFT_SALE-shaped transactions,
 * event_type='mint' (venue_id='mint') for NFT_MINT/COMPRESSED_NFT_MINT, and
 * event_type='transfer' (venue_id='wallet-transfer') for a plain TRANSFER
 * with no accompanying sale event -- genuine wallet-to-wallet moves. This
 * still uses the exact 042 UNIQUE key (chain_slug, venue_id, tx_hash,
 * event_index, sub_index), so a signature that is BOTH a sale and, per
 * Helius, also carries a bare TRANSFER row for the same NFT never
 * double-writes: sub_index 0 is reserved for the primary parsed event per
 * signature+mint.
 */
import { postgresQuery } from "@/lib/postgres";
import { amountUsdAtSale } from "@/lib/market/asset-price-hourly";
import { reserveHeliusKey, settleHeliusKey } from "@/lib/market/multichain/discovery/helius-key-pool";

const ENHANCED_TX_BASE = "https://api.helius.xyz/v0/addresses";
const PAGE_SIZE = 100; // real documented max per Helius's own Enhanced Transactions API
const CHAIN_SLUG = "solana-mainnet";
const SOURCE = "helius-enhanced-tx";

type HeliusNftEvent = {
  type?: string | null;
  source?: string | null;
  amount?: number | null;
  buyer?: string | null;
  seller?: string | null;
  nfts?: Array<{ mint?: string | null; tokenStandard?: string | null }>;
};

type HeliusTokenTransfer = {
  fromUserAccount?: string | null;
  toUserAccount?: string | null;
  mint?: string | null;
  tokenAmount?: number | null;
};

type HeliusEnhancedTx = {
  signature: string;
  timestamp?: number | null;
  slot?: number | null;
  type?: string | null;
  source?: string | null;
  events?: { nft?: HeliusNftEvent | null };
  tokenTransfers?: HeliusTokenTransfer[] | null;
};

/** Fetches one real page from Helius's Enhanced Transactions API for one mint address. */
async function fetchPage(mint: string, afterSignature: string | null): Promise<HeliusEnhancedTx[]> {
  const slot = await reserveHeliusKey(1, { priority: "background" });
  if (!slot) throw new Error("helius-transfer-scan: no Helius key available (pool exhausted/jailed, or HELIUS_API_KEY not configured)");
  let ok = false;
  try {
    const params = new URLSearchParams({ "api-key": slot.apiKey, limit: String(PAGE_SIZE), "sort-order": "asc" });
    if (afterSignature) params.set("after-signature", afterSignature);
    const res = await fetch(`${ENHANCED_TX_BASE}/${mint}/transactions?${params.toString()}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`helius-transfer-scan: HTTP ${res.status} fetching ${mint}`);
    const body = (await res.json()) as HeliusEnhancedTx[] | { error?: string };
    if (!Array.isArray(body)) throw new Error(`helius-transfer-scan: ${(body as { error?: string }).error ?? "non-array response"}`);
    ok = true;
    return body;
  } finally {
    await settleHeliusKey(slot, 1, ok);
  }
}

export type DecodedSolanaEvent = {
  mint: string;
  collectionSlug: string;
  signature: string;
  /** Position of `mint` within this tx's own nfts[]/tokenTransfers[] list -- NOT a global index. A single signature can carry several NFTs (bundle sales, batch mints); 042's UNIQUE key is (chain_slug, venue_id, tx_hash, event_index, sub_index) with no token_id column, so this must be included or a second real NFT in the same tx silently loses its row to ON CONFLICT DO NOTHING. */
  subIndex: number;
  blockTimestamp: number | null;
  slot: number | null;
  eventType: "sale" | "mint" | "transfer";
  venueId: string;
  protocol: string;
  fromAddress: string | null;
  toAddress: string | null;
  amountLamports: string | null;
};

const MINT_TYPES = new Set(["NFT_MINT", "COMPRESSED_NFT_MINT"]);
const SALE_TYPES = new Set(["NFT_SALE"]);

/** Normalizes Helius's own `source` enum (e.g. "MAGIC_EDEN") to this app's lowercase-hyphen venue convention. */
function normalizeVenue(source: string | null | undefined): string {
  const s = (source ?? "").trim();
  if (!s) return "unknown-solana-venue";
  return s.toLowerCase().replace(/_/g, "-");
}

/**
 * Decodes one real Helius transaction into zero or one real ledger row for
 * ONE specific mint (a single tx can touch other mints too; the caller
 * scoped this fetch to `mint` already via the address endpoint, but
 * tokenTransfers/nft.nfts[] can still list several -- only rows that
 * actually reference `mint` are kept).
 */
export function decodeSolanaTransferTx(mint: string, collectionSlug: string, tx: HeliusEnhancedTx): DecodedSolanaEvent | null {
  const type = (tx.type ?? "").toUpperCase();
  const nft = tx.events?.nft ?? null;
  const nftIndex = nft?.nfts?.findIndex((n) => n.mint === mint) ?? -1;
  const transferIndex = tx.tokenTransfers?.findIndex((t) => t.mint === mint) ?? -1;
  if (nftIndex < 0 && transferIndex < 0) return null;
  const subIndex = nftIndex >= 0 ? nftIndex : transferIndex;

  const base = {
    mint,
    collectionSlug,
    signature: tx.signature,
    subIndex,
    blockTimestamp: typeof tx.timestamp === "number" ? tx.timestamp : null,
    slot: typeof tx.slot === "number" ? tx.slot : null,
  };

  if (SALE_TYPES.has(type) && nft) {
    return {
      ...base,
      eventType: "sale",
      venueId: normalizeVenue(nft.source ?? tx.source),
      protocol: normalizeVenue(nft.source ?? tx.source),
      fromAddress: nft.seller ?? null,
      toAddress: nft.buyer ?? null,
      amountLamports: typeof nft.amount === "number" ? String(Math.round(nft.amount)) : null,
    };
  }

  if (MINT_TYPES.has(type)) {
    const transfer = tx.tokenTransfers?.find((t) => t.mint === mint);
    return {
      ...base,
      eventType: "mint",
      venueId: "mint",
      protocol: "solana-mint",
      fromAddress: null,
      toAddress: transfer?.toUserAccount ?? null,
      amountLamports: null,
    };
  }

  if (type === "TRANSFER") {
    const transfer = tx.tokenTransfers?.find((t) => t.mint === mint);
    if (!transfer?.fromUserAccount || !transfer?.toUserAccount) return null;
    return {
      ...base,
      eventType: "transfer",
      venueId: "wallet-transfer",
      protocol: "spl-token-transfer",
      fromAddress: transfer.fromUserAccount,
      toAddress: transfer.toUserAccount,
      amountLamports: null,
    };
  }

  // Anything else (NFT_LISTING, NFT_CANCEL_LISTING, NFT_BID, ...) is real
  // marketplace ORDER-BOOK activity, not a real transfer/sale/mint of the
  // NFT itself -- correctly out of scope for a transfer LEDGER.
  return null;
}

export type WriteSolanaLedgerResult = { written: number };

/** Idempotent writer -- ON CONFLICT DO NOTHING against 042's own UNIQUE key, same convention as transfer-ledger.ts. */
export async function writeSolanaTransferLedgerEvents(events: DecodedSolanaEvent[]): Promise<WriteSolanaLedgerResult> {
  let written = 0;
  const seen = new Set<string>();
  const touched = new Set<string>();
  for (const e of events) {
    const dedupeKey = `${e.signature}:${e.venueId}:${e.subIndex}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const eventIdentity = `solana:${e.signature}:0:${e.subIndex}`;
    // AUDIT lens 6 #10 (2026-09-06): sale rows used to carry the lamports
    // only inside raw_event, so every Solana sale was "unpriced" on the
    // buyer board and invisible to the aggregator. Now amount_atomic (SOL,
    // 9 decimals) and amount_usd at the sale hour are real columns.
    const isSale = e.eventType === "sale" && e.amountLamports != null;
    const priced = isSale ? await amountUsdAtSale(CHAIN_SLUG, null, e.amountLamports, e.blockTimestamp).catch(() => ({ amountUsd: null, source: null, asset: null })) : { amountUsd: null, source: null, asset: null };
    const result = await postgresQuery(
      `INSERT INTO plank_market_events
         (chain_slug, venue_id, protocol, event_type, collection_key, token_id, tx_hash,
          event_index, sub_index, block_number, block_timestamp, seller, buyer,
          currency_symbol, currency_decimals, amount_atomic, amount_usd, usd_price_source, finality,
          chain_namespace, event_identity, raw_event)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7,
          0, $8, $9, to_timestamp($10), $11, $12,
          $15, $16, $17::numeric, $18::numeric, $19, 'confirmed',
          'solana', $13, $14::jsonb)
       ON CONFLICT (chain_slug, venue_id, tx_hash, event_index, sub_index) DO NOTHING`,
      [
        CHAIN_SLUG,
        e.venueId,
        e.protocol,
        e.eventType,
        e.collectionSlug,
        e.mint,
        e.signature,
        e.subIndex,
        e.slot,
        e.blockTimestamp,
        e.fromAddress,
        e.toAddress,
        eventIdentity,
        JSON.stringify({ mint: e.mint, from: e.fromAddress, to: e.toAddress, amountLamports: e.amountLamports }),
        isSale ? "SOL" : null,
        isSale ? 9 : null,
        isSale ? e.amountLamports : null,
        priced.amountUsd,
        priced.source,
      ]
    );
    if ((result.rowCount ?? 0) > 0) {
      written += 1;
      if (isSale && e.collectionSlug) touched.add(e.collectionSlug.toLowerCase());
    }
  }
  if (touched.size > 0) {
    const { updateVolumeFromMarketEvents } = await import("@/lib/market/multichain/store");
    await updateVolumeFromMarketEvents(CHAIN_SLUG, [...touched]).catch(() => undefined);
  }
  return { written };
}

type CursorRow = { after_signature: string | null; oldest_reached: boolean };

async function readMintCursor(mint: string): Promise<CursorRow | null> {
  const r = await postgresQuery<CursorRow>(
    `SELECT after_signature, oldest_reached FROM plank_solana_transfer_scan_cursors
     WHERE chain_slug = $1 AND mint = $2 AND source = $3`,
    [CHAIN_SLUG, mint, SOURCE]
  );
  return r.rows[0] ?? null;
}

async function writeMintCursor(input: {
  mint: string; collectionSlug: string; afterSignature: string | null;
  oldestReached: boolean; eventsWritten: number; lastError?: string | null;
}): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_solana_transfer_scan_cursors
       (chain_slug, mint, collection_slug, source, after_signature, oldest_reached, events_written, last_error, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (chain_slug, mint, source) DO UPDATE SET
       after_signature = EXCLUDED.after_signature,
       oldest_reached = EXCLUDED.oldest_reached,
       events_written = plank_solana_transfer_scan_cursors.events_written + EXCLUDED.events_written,
       last_error = EXCLUDED.last_error,
       updated_at = NOW()`,
    [CHAIN_SLUG, input.mint, input.collectionSlug, SOURCE, input.afterSignature, input.oldestReached, input.eventsWritten, input.lastError ?? null]
  );
}

export type MintScanResult = { mint: string; collectionSlug: string; pagesWalked: number; written: number; oldestReached: boolean };

/** Walks one real mint genesis-forward, up to maxPages real Helius calls, resuming from its own durable cursor. */
export async function scanMintTransfers(mint: string, collectionSlug: string, maxPages: number): Promise<MintScanResult> {
  const checkpoint = await readMintCursor(mint);
  if (checkpoint?.oldest_reached) {
    return { mint, collectionSlug, pagesWalked: 0, written: 0, oldestReached: true };
  }
  let after = checkpoint?.after_signature ?? null;
  let pagesWalked = 0;
  let written = 0;
  let oldestReached = false;
  try {
    for (; pagesWalked < maxPages; pagesWalked++) {
      const page = await fetchPage(mint, after);
      if (page.length === 0) {
        oldestReached = true;
        break;
      }
      const decoded = page
        .map((tx) => decodeSolanaTransferTx(mint, collectionSlug, tx))
        .filter((e): e is DecodedSolanaEvent => e !== null);
      const result = await writeSolanaTransferLedgerEvents(decoded);
      written += result.written;
      after = page[page.length - 1]?.signature ?? after;
      if (page.length < PAGE_SIZE) {
        oldestReached = true;
        break;
      }
    }
    await writeMintCursor({ mint, collectionSlug, afterSignature: after, oldestReached, eventsWritten: written });
    return { mint, collectionSlug, pagesWalked, written, oldestReached };
  } catch (error) {
    await writeMintCursor({
      mint, collectionSlug, afterSignature: after, oldestReached: false, eventsWritten: written,
      lastError: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  }
}

/**
 * Fair, durable mint-level work selector -- same "incomplete walks win,
 * completed rotate oldest-first" shape as
 * helius-rarity-index-runner.ts's advanceNextTrackedSolanaMembership.
 * Draws real member mints from plank_collection_tokens (already populated
 * by that same DAS-grouping runner), scoped to tracked Solana collections.
 */
export async function advanceNextSolanaTransferScan(maxPages = 5): Promise<MintScanResult | null> {
  const candidates = await postgresQuery<{ mint: string; collection_slug: string }>(
    `SELECT t.token_id AS mint, t.collection_slug
     FROM plank_collection_tokens t
     JOIN plank_multichain_collections c
       ON c.chain_slug = t.chain_slug AND lower(c.contract_address) = lower(t.collection_slug)
     LEFT JOIN plank_solana_transfer_scan_cursors s
       ON s.chain_slug = t.chain_slug AND s.mint = t.token_id AND s.source = $1
     WHERE t.chain_slug = $2
     ORDER BY (s.oldest_reached IS NOT TRUE) DESC, s.updated_at ASC NULLS FIRST, t.token_id
     LIMIT 1`,
    [SOURCE, CHAIN_SLUG]
  );
  const row = candidates.rows[0];
  if (!row) return null;
  return scanMintTransfers(row.mint, row.collection_slug, maxPages);
}
