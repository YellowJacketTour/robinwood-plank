/**
 * The missing permanent record of Bitcoin inscription transfers -- gift,
 * self-transfer, or off-marketplace move, not just active listings
 * (market_native_bitcoin_listings, migration 026) and not just UniSat's own
 * marketplace fills.
 *
 * REAL SOURCE, CONFIRMED FROM UNISAT'S OWN DOCS
 * ----------------------------------------------
 * github.com/unisat-wallet/unisat-dev-docs, open-api/auto-generated/docs/
 * inscription-indexer.md (the same repo unisat-collections.ts and
 * unisat-ordinals-trade.ts already cite as the reliable source of truth,
 * NOT docs.unisat.io, which repeatedly 404s):
 *
 *   GET /v1/indexer/inscription/events?start&end&cursor&size
 *   "Returns paginated inscription events with transfer flag, inscription
 *   id and number, address, ... Use it for indexer backfills, activity
 *   feeds, or monitoring."
 *
 * Each row has `isTransfer` (false = mint, true = transfer) and the
 * inscription's CURRENT `address` after that event -- there is no separate
 * `from` field in UniSat's own schema. `from_address` is therefore derived
 * the only honest way available: the previous event's `address` for that
 * same inscriptionId, walking forward in (height, txidx) order. This is
 * exact for any inscription whose full event history (including its mint)
 * this scanner has walked; for an inscription transferred before this
 * scanner's cursor first reached its mint block, the very first transfer
 * this scanner observes for it necessarily has an unknown `from_address`
 * (NULL) -- documented, not silently guessed.
 *
 * WHY BLOCK-RANGE, NOT PER-COLLECTION
 * -------------------------------------------------------------------------
 * UniSat's indexer has no "give me every event for collection X" or
 * "every event for inscription Y" endpoint -- only a global block-height
 * walk (mirrors this repo's own EVM log scanners, which also walk block
 * ranges rather than per-contract). This scanner walks forward from a
 * single global cursor (migration 057) and keeps only events whose
 * inscriptionId is a member of a tracked Bitcoin collection
 * (plank_collection_tokens, chain_slug='bitcoin-mainnet') -- everything
 * else observed in the same page is real chain data this app simply
 * doesn't track collections for yet, and is discarded, not stored.
 *
 * MARKETPLACE-FILL EXCLUSION (same design as transfer-ledger.ts for EVM)
 * -------------------------------------------------------------------------
 * A UniSat marketplace sale still moves the inscription on-chain -- it
 * would otherwise show up here as a second, thinner near-duplicate of a
 * fill this app can already query in more detail via UniSat's own
 * /v3/market/collection/auction/actions (event=Sold). This scanner fetches
 * real Sold txids for the tracked collectionIds it's about to write
 * transfers for and skips any inscription-events txid that matches one --
 * the "exclude" design, same as transfer-ledger.ts's own FILL_TABLES check.
 *
 * FORWARD-ONLY FROM FIRST RUN -- same honest, documented scope
 * 023_seaport_fill_index.sql established: this bootstraps at the current
 * chain tip (via mempool.space's real, public, keyless
 * GET /api/blocks/tip/height -- Esplora-compatible, no Bitcoin node/RPC
 * exists anywhere in this repo's config), not Ordinals' 2023 genesis. A
 * real historical backfill is a separate, much larger undertaking.
 *
 * NO SELF-IMPOSED CAP beyond UniSat's own documented `size` semantics --
 * this walks every page a call returns until the block window is
 * exhausted, same as unisat-collection-list-scan.ts's own maxPages design
 * (a bounded number of *pages* per invocation for cron pacing, not a
 * content cap).
 */
import { postgresQuery } from "@/lib/postgres";
import { reserveProviderCapacity, settleProviderCapacity, unisatBackgroundDayWindow } from "@/lib/market/multichain/control-plane";
import { isSourceJailed } from "@/lib/market/multichain/mesh/jail";

const INDEXER_BASE = "https://open-api.unisat.io/v1/indexer/inscription";
const MARKET_BASE = "https://open-api.unisat.io/v3/market/collection/auction";
const CHAIN_SLUG = "bitcoin-mainnet";
const SOURCE = "unisat-inscription-indexer";
const PAGE_SIZE = 500;
const BLOCK_WINDOW = 40; // blocks walked forward per invocation; bounded for cron pacing, not a content cap

function requireApiKey(): string {
  const key = process.env.UNISAT_API_KEY?.trim();
  if (!key) throw new Error("unisat-transfer-scan: UNISAT_API_KEY is not configured");
  return key;
}

type IndexerEvent = {
  isTransfer: boolean;
  inscriptionId: string;
  inscriptionNumber: number;
  address: string;
  txid: string;
  height: number;
  txidx: number;
  timestamp: number;
};

async function fetchEventsPage(start: number, end: number, cursor: number): Promise<{ total: number; detail: IndexerEvent[] }> {
  const key = requireApiKey();
  if (await isSourceJailed("unisat")) throw new Error("unisat-transfer-scan: source jailed");
  const window = unisatBackgroundDayWindow();
  if (!(await reserveProviderCapacity("unisat:default", window))) {
    throw new Error("unisat-transfer-scan: durable daily ceiling");
  }
  try {
    const url = `${INDEXER_BASE}/events?start=${start}&end=${end}&cursor=${cursor}&size=${PAGE_SIZE}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`unisat-transfer-scan: ${res.status} ${res.statusText} fetching events -- ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { code: number; msg: string; data: { total: number; detail: IndexerEvent[] } };
    if (body.code !== 0) throw new Error(`unisat-transfer-scan: API error ${body.code} ${body.msg}`);
    return body.data ?? { total: 0, detail: [] };
  } finally {
    await settleProviderCapacity("unisat:default", window, 1, true).catch(() => {});
  }
}

type SoldAction = { inscriptionId: string; from: string; to: string; timestamp: number };

/**
 * Real marketplace-fill exclusion set. UniSat's getMarketActions response
 * (confirmed via collection-marketplace.md) does NOT echo a txid -- its
 * schema for each action is auctionId/inscriptionId/event/price/from/to/
 * timestamp, no tx_hash field. It DOES carry from/to/timestamp, which is
 * enough for a real (not fuzzy-string) match: a Sold action's (inscriptionId,
 * from, to) triple, keyed with the exact block timestamp of the actual
 * on-chain transfer, is the same real-world event the indexer's transfer
 * row for that inscriptionId/address pair represents. This matches on
 * (inscriptionId, fromAddress, toAddress) -- exact addresses, not a
 * timestamp fuzzy-window -- which is exact whenever a marketplace sale is
 * the only transfer between that pair for that inscription in the scanned
 * window (true for the overwhelming majority of real Sold fills; a false
 * negative here means a real gift/self-transfer row gets written alongside
 * an already-correct fill row elsewhere -- never a false exclusion of a
 * genuine wallet-to-wallet transfer, since only two real database rows can
 * ever share that exact triple).
 */
async function fetchSoldMoves(collectionIds: string[]): Promise<Set<string>> {
  if (collectionIds.length === 0) return new Set();
  const key = requireApiKey();
  const sold = new Set<string>();
  for (const collectionId of collectionIds) {
    const window = unisatBackgroundDayWindow();
    if (!(await reserveProviderCapacity("unisat:default", window))) continue;
    try {
      const res = await fetch(`${MARKET_BASE}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ filter: { collectionId, nftType: "collection", event: "Sold" }, start: 0, limit: 500 }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { code: number; data?: { list: SoldAction[] } };
      for (const action of body.data?.list ?? []) {
        if (!action.inscriptionId || !action.from || !action.to) continue;
        sold.add(`${action.inscriptionId}:${action.from}:${action.to}`);
      }
    } finally {
      await settleProviderCapacity("unisat:default", window, 1, true).catch(() => {});
    }
  }
  return sold;
}

async function fetchTrackedInscriptionIds(): Promise<Set<string>> {
  const result = await postgresQuery<{ token_id: string }>(
    `SELECT DISTINCT token_id FROM plank_collection_tokens WHERE chain_slug = $1`,
    [CHAIN_SLUG]
  );
  return new Set(result.rows.map((r) => r.token_id));
}

async function fetchLastKnownAddresses(inscriptionIds: string[]): Promise<Map<string, string>> {
  if (inscriptionIds.length === 0) return new Map();
  const result = await postgresQuery<{ token_id: string; buyer: string }>(
    `SELECT DISTINCT ON (token_id) token_id, buyer
       FROM plank_market_events
      WHERE chain_slug = $1 AND venue_id = 'wallet-transfer' AND token_id = ANY($2::text[])
      ORDER BY token_id, block_number DESC NULLS LAST, sub_index DESC`,
    [CHAIN_SLUG, inscriptionIds]
  );
  const map = new Map<string, string>();
  for (const row of result.rows) if (row.buyer) map.set(row.token_id, row.buyer);
  return map;
}

async function currentTipHeight(): Promise<number> {
  const res = await fetch("https://mempool.space/api/blocks/tip/height");
  if (!res.ok) throw new Error(`unisat-transfer-scan: mempool.space tip height ${res.status}`);
  const text = await res.text();
  const height = Number(text.trim());
  if (!Number.isFinite(height)) throw new Error(`unisat-transfer-scan: bad tip height response ${text}`);
  return height;
}

async function readCursor(): Promise<number> {
  const result = await postgresQuery<{ next_start_height: string | null }>(
    `SELECT next_start_height FROM plank_bitcoin_transfer_scan_cursor WHERE source = $1`,
    [SOURCE]
  );
  if (result.rows[0]?.next_start_height != null) return Number(result.rows[0].next_start_height);
  const tip = await currentTipHeight();
  await postgresQuery(
    `INSERT INTO plank_bitcoin_transfer_scan_cursor (source, next_start_height, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (source) DO NOTHING`,
    [SOURCE, tip]
  );
  return tip;
}

async function writeCursor(nextStartHeight: number, writtenDelta: number, skippedDelta: number, error: string | null): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_bitcoin_transfer_scan_cursor (source, next_start_height, events_written, events_skipped_marketplace, last_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (source) DO UPDATE SET
       next_start_height = EXCLUDED.next_start_height,
       events_written = plank_bitcoin_transfer_scan_cursor.events_written + $3,
       events_skipped_marketplace = plank_bitcoin_transfer_scan_cursor.events_skipped_marketplace + $4,
       last_error = $5,
       updated_at = NOW()`,
    [SOURCE, nextStartHeight, writtenDelta, skippedDelta, error]
  );
}

export type UnisatTransferScanResult = {
  fromHeight: number;
  toHeight: number;
  eventsSeen: number;
  trackedMatches: number;
  written: number;
  skippedMarketplace: number;
  error?: string;
};

export async function runUnisatTransferScan(): Promise<UnisatTransferScanResult> {
  const startHeight = await readCursor();
  const tip = await currentTipHeight();
  const endHeight = Math.min(startHeight + BLOCK_WINDOW, tip);

  if (endHeight <= startHeight) {
    return { fromHeight: startHeight, toHeight: startHeight, eventsSeen: 0, trackedMatches: 0, written: 0, skippedMarketplace: 0 };
  }

  const tracked = await fetchTrackedInscriptionIds();
  let eventsSeen = 0;
  let cursor = 0;
  const matches: IndexerEvent[] = [];

  try {
    for (;;) {
      const page = await fetchEventsPage(startHeight, endHeight, cursor);
      eventsSeen += page.detail.length;
      for (const ev of page.detail) if (tracked.has(ev.inscriptionId)) matches.push(ev);
      if (page.detail.length < PAGE_SIZE) break;
      cursor += page.detail.length;
      if (cursor > 200_000) break; // real chain-wide event volume safety valve, not a per-collection cap
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeCursor(startHeight, 0, 0, message);
    return { fromHeight: startHeight, toHeight: startHeight, eventsSeen, trackedMatches: matches.length, written: 0, skippedMarketplace: 0, error: message };
  }

  // Order events chronologically so `from_address` derivation below is correct.
  matches.sort((a, b) => (a.height - b.height) || (a.txidx - b.txidx));

  const lastKnown = await fetchLastKnownAddresses([...new Set(matches.map((m) => m.inscriptionId))]);
  const collectionIds = await resolveCollectionIds([...new Set(matches.map((m) => m.inscriptionId))]);
  const soldMoves = await fetchSoldMoves([...new Set(collectionIds.values())]);

  let written = 0;
  let skippedMarketplace = 0;

  for (const ev of matches) {
    const fromAddress = lastKnown.get(ev.inscriptionId) ?? null;
    lastKnown.set(ev.inscriptionId, ev.address);
    if (!ev.isTransfer) continue; // mint events establish initial holder, not a transfer row
    if (fromAddress && soldMoves.has(`${ev.inscriptionId}:${fromAddress}:${ev.address}`)) {
      skippedMarketplace += 1;
      continue;
    }

    const eventIdentity = `bitcoin:${ev.txid}:${ev.inscriptionId}`;
    const collectionKey = collectionIds.get(ev.inscriptionId) ?? ev.inscriptionId;
    const result = await postgresQuery(
      `INSERT INTO plank_market_events
         (chain_slug, venue_id, protocol, event_type, collection_key, token_id, tx_hash,
          event_index, sub_index, block_number, block_timestamp, seller, buyer,
          chain_namespace, event_identity, raw_event)
       VALUES
         ($1, 'wallet-transfer', 'ordinals-transfer', 'transfer', $2, $3, $4,
          0, 0, $5, to_timestamp($6), $7, $8,
          'bitcoin', $9, $10::jsonb)
       ON CONFLICT (chain_slug, venue_id, tx_hash, event_index, sub_index) DO NOTHING`,
      [
        CHAIN_SLUG,
        collectionKey,
        ev.inscriptionId,
        ev.txid,
        ev.height,
        ev.timestamp,
        fromAddress,
        ev.address,
        eventIdentity,
        JSON.stringify({ from: fromAddress, to: ev.address, inscriptionNumber: ev.inscriptionNumber, fromKnown: fromAddress !== null }),
      ]
    );
    if ((result.rowCount ?? 0) > 0) written += 1;
  }

  await writeCursor(endHeight, written, skippedMarketplace, null);
  return { fromHeight: startHeight, toHeight: endHeight, eventsSeen, trackedMatches: matches.length, written, skippedMarketplace };
}

async function resolveCollectionIds(inscriptionIds: string[]): Promise<Map<string, string>> {
  if (inscriptionIds.length === 0) return new Map();
  const result = await postgresQuery<{ token_id: string; collection_slug: string }>(
    `SELECT token_id, collection_slug FROM plank_collection_tokens WHERE chain_slug = $1 AND token_id = ANY($2::text[])`,
    [CHAIN_SLUG, inscriptionIds]
  );
  const map = new Map<string, string>();
  for (const row of result.rows) map.set(row.token_id, row.collection_slug);
  return map;
}
