import { postgresQuery } from "@/lib/postgres";
import { CHAIN_MANIFESTS } from "@/lib/market/multichain/chains/manifest";
import { enqueueDataJob } from "@/lib/market/multichain/control-plane";
import { recordExternalCall } from "@/lib/market/multichain/edge/provider-ledger";

/**
 * OpenSea Stream API ingest (2026-09-06, "instant max sync"): one WebSocket
 * subscription to `collection:*` delivers every listing, sale, offer,
 * transfer, cancellation and metadata update OpenSea sees on every chain it
 * supports, within seconds of the event. Each event becomes a row in
 * plank_market_events (the same ledger the SSE live feed tails and the
 * activity/volume readers query), so the hub, collection pages and the
 * Biggest Buyer Board move in real time instead of on the 5-minute mesh
 * cadence. Metadata updates enqueue a demand job for the mesh so traits and
 * rarity follow.
 *
 * Protocol: Phoenix channels over WebSocket
 * (wss://stream.openseabeta.com/socket/websocket?token=KEY). Join the topic,
 * answer with a heartbeat every 30 s, reconnect with backoff on close.
 *
 * Honesty rules: every row is finality 'observed' with venue 'opensea-stream';
 * nothing here fabricates a block number, a USD price (only what the payload
 * carries), or a floor. Rows for events this ledger already holds from the
 * on-chain indexers are skipped by the unique key.
 */

export const OPENSEA_STREAM_URL = "wss://stream.openseabeta.com/socket/websocket";
const WANTED_KIND_RE = /"(item_sold|item_listed|item_metadata_updated|phx_reply)"/;

export type StreamEventKind =
  | "item_listed"
  | "item_sold"
  | "item_transferred"
  | "item_received_offer"
  | "item_received_bid"
  | "item_cancelled"
  | "item_metadata_updated"
  | "collection_offer"
  | "trait_offer";

type StreamEnvelope = { event?: string; topic?: string; payload?: unknown; ref?: unknown };

export type MarketEventRow = {
  chainSlug: string;
  eventType: "sale" | "transfer" | "listing-created" | "listing-cancelled" | "bid-created";
  collectionKey: string;
  tokenId: string | null;
  txHash: string;
  subIndex: number;
  blockTimestamp: string | null;
  seller: string | null;
  buyer: string | null;
  maker: string | null;
  taker: string | null;
  currencyAddress: string | null;
  currencySymbol: string | null;
  currencyDecimals: number | null;
  amountAtomic: string | null;
  amountUsd: string | null;
  raw: Record<string, unknown>;
};

const CHAIN_BY_OPENSEA_NAME: Map<string, string> = new Map(
  CHAIN_MANIFESTS.filter((m) => m.openSeaChain).map((m) => [m.openSeaChain as string, m.chainSlug])
);

export function chainSlugForOpenSeaChain(name: string | null | undefined): string | null {
  if (!name) return null;
  return CHAIN_BY_OPENSEA_NAME.get(name.toLowerCase()) ?? null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function addr(v: unknown): string | null {
  const s = str(v);
  return s ? s.toLowerCase() : null;
}

/** Small stable hash so several items in one transaction get distinct sub_index values. */
export function subIndexFor(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2_000_000_000;
}

/** "ethereum/0xabc.../123" -> { chain: "ethereum", contract: "0xabc...", tokenId: "123" } */
export function parseNftId(nftId: string | null | undefined): { chain: string; contract: string; tokenId: string } | null {
  if (!nftId) return null;
  const parts = nftId.split("/");
  if (parts.length < 3) return null;
  return { chain: parts[0], contract: parts[1].toLowerCase(), tokenId: parts.slice(2).join("/") };
}

function usdFor(amountAtomic: string | null, token: Record<string, unknown> | null): string | null {
  if (!amountAtomic || !token) return null;
  const decimals = num(token.decimals);
  const usdPrice = typeof token.usd_price === "string" ? Number(token.usd_price) : num(token.usd_price);
  if (decimals == null || usdPrice == null || !Number.isFinite(usdPrice)) return null;
  try {
    const whole = Number(BigInt(amountAtomic)) / 10 ** decimals;
    if (!Number.isFinite(whole)) return null;
    return (whole * usdPrice).toFixed(6);
  } catch {
    return null;
  }
}

/**
 * Pure mapping from one Stream API event to a ledger row (or null when the
 * event carries nothing this ledger stores, e.g. an unsupported chain).
 */
export function mapStreamEvent(kind: string, payload: unknown): MarketEventRow | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const item = (p.item && typeof p.item === "object" ? p.item : null) as Record<string, unknown> | null;
  const nft = parseNftId(str(item?.nft_id));
  const chainName = str(p.chain) ?? str((item?.chain as Record<string, unknown> | undefined)?.name) ?? nft?.chain ?? null;
  const chainSlug = chainSlugForOpenSeaChain(chainName);
  if (!chainSlug) return null;
  const collectionKey = nft?.contract ?? addr((p.collection as Record<string, unknown> | undefined)?.contract) ?? null;
  if (!collectionKey) return null;
  const token = (p.payment_token && typeof p.payment_token === "object" ? p.payment_token : null) as Record<string, unknown> | null;
  const maker = addr((p.maker as Record<string, unknown> | undefined)?.address);
  const taker = addr((p.taker as Record<string, unknown> | undefined)?.address);
  const tx = (p.transaction && typeof p.transaction === "object" ? p.transaction : null) as Record<string, unknown> | null;
  const ts = str(p.event_timestamp) ?? str(tx?.timestamp) ?? null;
  const base = {
    chainSlug,
    collectionKey,
    tokenId: nft?.tokenId ?? null,
    subIndex: subIndexFor(str(item?.nft_id) ?? collectionKey),
    blockTimestamp: ts,
    maker,
    taker,
    currencyAddress: addr(token?.address),
    currencySymbol: str(token?.symbol),
    currencyDecimals: num(token?.decimals),
    raw: {
      slug: str((p.collection as Record<string, unknown> | undefined)?.slug),
      quantity: p.quantity ?? null,
      order_hash: str(p.order_hash),
      expiration_date: str(p.expiration_date),
      listing_type: str(p.listing_type),
      permalink: str(item?.permalink),
    },
  };
  switch (kind) {
    case "item_sold": {
      const amount = str(p.sale_price);
      const txHash = str(tx?.hash);
      if (!txHash) return null;
      return { ...base, eventType: "sale", txHash, seller: maker, buyer: taker, amountAtomic: amount, amountUsd: usdFor(amount, token) };
    }
    case "item_transferred": {
      const txHash = str(tx?.hash);
      if (!txHash) return null;
      return { ...base, eventType: "transfer", txHash, seller: addr((p.from_account as Record<string, unknown> | undefined)?.address), buyer: addr((p.to_account as Record<string, unknown> | undefined)?.address), amountAtomic: null, amountUsd: null };
    }
    case "item_listed": {
      const amount = str(p.base_price);
      const orderHash = str(p.order_hash);
      if (!orderHash) return null;
      return { ...base, eventType: "listing-created", txHash: orderHash, seller: maker, buyer: null, amountAtomic: amount, amountUsd: usdFor(amount, token) };
    }
    case "item_cancelled": {
      const orderHash = str(p.order_hash);
      if (!orderHash) return null;
      return { ...base, eventType: "listing-cancelled", txHash: orderHash, seller: maker, buyer: null, amountAtomic: str(p.base_price), amountUsd: null };
    }
    case "item_received_offer":
    case "item_received_bid":
    case "collection_offer":
    case "trait_offer": {
      const amount = str(p.base_price);
      const orderHash = str(p.order_hash);
      if (!orderHash) return null;
      return { ...base, eventType: "bid-created", txHash: orderHash, seller: null, buyer: maker, amountAtomic: amount, amountUsd: usdFor(amount, token) };
    }
    default:
      return null;
  }
}

/**
 * Batched writer: one multi-row INSERT per flush instead of one statement per
 * event. Measured live 2026-09-06: the wildcard topic delivers ~3,600 events
 * per second; per-row inserts on a PGPOOL_MAX=4 pool would fall behind within
 * seconds. Returns the number of rows the ledger did not already hold.
 */
export async function writeMarketEventRows(rows: MarketEventRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const cols = 19;
  const values: unknown[] = [];
  const tuples: string[] = [];
  for (const row of rows) {
    const base = values.length;
    values.push(
      row.chainSlug, row.eventType, row.collectionKey, row.tokenId, row.txHash, row.subIndex, row.blockTimestamp,
      row.seller, row.buyer, row.maker, row.taker, row.currencyAddress, row.currencySymbol, row.currencyDecimals,
      row.amountAtomic, row.amountUsd, row.amountUsd ? "opensea-stream-payment-token" : null,
      `${row.chainSlug}:opensea-stream:${row.txHash}:${row.subIndex}`, JSON.stringify(row.raw).slice(0, 4_000)
    );
    const ph = Array.from({ length: cols }, (_, i) => `$${base + i + 1}`);
    tuples.push(`(${ph[0]}, 'opensea-stream', 'opensea', ${ph[1]}, ${ph[2]}, ${ph[3]}, ${ph[4]}, 0, ${ph[5]}, ${ph[6]}::timestamptz, ${ph[7]}, ${ph[8]}, ${ph[9]}, ${ph[10]}, ${ph[11]}, ${ph[12]}, ${ph[13]}, ${ph[14]}::numeric, ${ph[15]}::numeric, ${ph[16]}, 'observed', 'eip155', ${ph[17]}, ${ph[18]}::jsonb)`);
  }
  const result = await postgresQuery(
    `INSERT INTO plank_market_events
       (chain_slug, venue_id, protocol, event_type, collection_key, token_id, tx_hash,
        event_index, sub_index, block_timestamp, seller, buyer, maker, taker,
        currency_address, currency_symbol, currency_decimals, amount_atomic, amount_usd,
        usd_price_source, finality, chain_namespace, event_identity, raw_event)
     VALUES ${tuples.join(",\n")}
     ON CONFLICT (chain_slug, venue_id, tx_hash, event_index, sub_index) DO NOTHING`,
    values
  );
  return result.rowCount ?? 0;
}

export async function writeMarketEventRow(row: MarketEventRow): Promise<boolean> {
  const identity = `${row.chainSlug}:opensea-stream:${row.txHash}:${row.subIndex}`;
  const result = await postgresQuery(
    `INSERT INTO plank_market_events
       (chain_slug, venue_id, protocol, event_type, collection_key, token_id, tx_hash,
        event_index, sub_index, block_timestamp, seller, buyer, maker, taker,
        currency_address, currency_symbol, currency_decimals, amount_atomic, amount_usd,
        usd_price_source, finality, chain_namespace, event_identity, raw_event)
     VALUES ($1, 'opensea-stream', 'opensea', $2, $3, $4, $5,
        0, $6, $7::timestamptz, $8, $9, $10, $11,
        $12, $13, $14, $15::numeric, $16::numeric,
        $17, 'observed', 'eip155', $18, $19::jsonb)
     ON CONFLICT (chain_slug, venue_id, tx_hash, event_index, sub_index) DO NOTHING`,
    [
      row.chainSlug,
      row.eventType,
      row.collectionKey,
      row.tokenId,
      row.txHash,
      row.subIndex,
      row.blockTimestamp,
      row.seller,
      row.buyer,
      row.maker,
      row.taker,
      row.currencyAddress,
      row.currencySymbol,
      row.currencyDecimals,
      row.amountAtomic,
      row.amountUsd,
      row.amountUsd ? "opensea-stream-payment-token" : null,
      identity,
      JSON.stringify(row.raw).slice(0, 20_000),
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Metadata changed on OpenSea's side: ask the mesh to re-read this token's metadata so traits/rarity follow. */
export async function enqueueMetadataRefresh(kind: string, payload: unknown): Promise<boolean> {
  if (kind !== "item_metadata_updated" || !payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  const item = (p.item && typeof p.item === "object" ? p.item : null) as Record<string, unknown> | null;
  const nft = parseNftId(str(item?.nft_id));
  const chainSlug = chainSlugForOpenSeaChain(str(p.chain) ?? str((item?.chain as Record<string, unknown> | undefined)?.name) ?? nft?.chain);
  if (!chainSlug || !nft) return false;
  await enqueueDataJob({
    jobKey: `demand:evm-metadata:${chainSlug}:${nft.contract}`,
    kind: `mesh-lane:${chainSlug}`,
    source: "evm-metadata",
    chainSlug,
    subject: nft.contract,
    payload: { reason: "opensea-stream:item_metadata_updated", tokenId: nft.tokenId },
    priority: 60,
  });
  return true;
}

export type StreamStats = { received: number; written: number; floors: number; skipped: number; metadata: number; reconnects: number; lastEventAt: string | null; byKind: Record<string, number> };

/**
 * Selection policy (state of the art is selective materialization, not
 * "store everything"): sales, listings and cancellations are kept for every
 * collection on a supported chain; offers/bids and metadata updates only for
 * collections this index tracks (bids alone are most of the firehose and
 * mostly on collections nobody here will ever open); raw transfers are
 * skipped because the on-chain indexers already own them with block numbers.
 */
export function selectEvent(kind: string, row: MarketEventRow | null, tracked: Set<string> | null): "row" | "floor" | "skip" {
  if (!row) return "skip";
  switch (row.eventType) {
    case "sale":
      // ~13 per 20 s on the wildcard topic (measured 2026-09-06): cheap, and
      // the one event every reader wants immediately.
      return "row";
    case "listing-created":
      // ~2,400 per 20 s: folded into per-collection floor STATE (lowest ask
      // seen in the flush window, upserted into plank_collection_floor_
      // observations for tracked collections) instead of a row each.
      return tracked && tracked.has(`${row.chainSlug}:${row.collectionKey}`) ? "floor" : "skip";
    case "listing-cancelled":
    case "bid-created":
    case "transfer":
    default:
      // Cancellations (~24k/20 s) and bids (~28k/20 s) are the firehose;
      // the stats lane re-reads real floors and top offers per collection.
      // Transfers belong to the on-chain indexers, which have block numbers.
      return "skip";
  }
}

/** Lowest ask per (chain, collection) in a flush window -> one floor observation each. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * A listing is eligible to move a collection's floor only when it is a
 * plain ask (not an auction), unexpired, and priced in the chain's native
 * token or its wrapped native (1:1). AUDIT lens 2 #7: before this, a
 * 6-decimal USDC ask always "won" the lowest-amount comparison and an
 * English auction's start price was treated as an ask.
 */
export function floorEligible(row: MarketEventRow, now: number = Date.now()): boolean {
  if (!row.amountAtomic || !row.currencySymbol) return false;
  const listingType = typeof row.raw.listing_type === "string" ? row.raw.listing_type.toLowerCase() : null;
  if (listingType && listingType !== "basic") return false;
  const exp = typeof row.raw.expiration_date === "string" ? Date.parse(row.raw.expiration_date) : NaN;
  if (Number.isFinite(exp) && exp < now) return false;
  const wrapped = CHAIN_MANIFESTS.find((m) => m.chainSlug === row.chainSlug)?.offerCurrencyAddress?.toLowerCase() ?? null;
  const addr = row.currencyAddress?.toLowerCase() ?? null;
  if (addr === null || addr === ZERO_ADDRESS) return true;
  return wrapped !== null && addr === wrapped;
}

export async function writeFloorObservations(rows: MarketEventRow[]): Promise<number> {
  const { recordFloorObservation } = await import("@/lib/market/multichain/store");
  const lowest = new Map<string, MarketEventRow>();
  for (const row of rows) {
    if (!floorEligible(row)) continue;
    const key = `${row.chainSlug}:${row.collectionKey}`;
    const cur = lowest.get(key);
    try {
      if (!cur || BigInt(row.amountAtomic as string) < BigInt(cur.amountAtomic as string)) lowest.set(key, row);
    } catch {
      /* non-numeric amount: ignore */
    }
  }
  let written = 0;
  for (const row of lowest.values()) {
    try {
      await recordFloorObservation(row.chainSlug, row.collectionKey, {
        priceAtomic: row.amountAtomic,
        currency: row.currencySymbol,
        marketplace: "opensea",
        listedCount: null,
        source: "opensea-stream",
      });
      written += 1;
    } catch {
      // One untracked or renormalized key must not discard the rest of the window (AUDIT lens 5 stream risks).
    }
  }
  return written;
}

/** All tracked (chain, contract) keys, refreshed every few minutes; ~170k entries fits comfortably in memory. */
export async function loadTrackedSet(): Promise<Set<string>> {
  const result = await postgresQuery<{ chain_slug: string; contract_address: string }>(
    `SELECT chain_slug, lower(contract_address) AS contract_address FROM plank_multichain_collections`
  );
  return new Set(result.rows.map((r) => `${r.chain_slug}:${r.contract_address}`));
}

export type StreamOptions = {
  apiKey: string;
  keyId?: string;
  maxSeconds?: number;
  log?: (line: string) => void;
  /** Test hook: a WebSocket constructor. Defaults to the `ws` package. */
  WebSocketImpl?: new (url: string) => WebSocketLike;
};

export type WebSocketLike = {
  on(event: "open" | "close" | "error" | "message", handler: (...args: unknown[]) => void): unknown;
  send(data: string): void;
  close(): void;
  readyState?: number;
};

/**
 * Run the ingest loop until `maxSeconds` elapses (or forever). Resolves with
 * the final stats. Reconnects on close with capped backoff.
 */
export async function runOpenSeaStream(opts: StreamOptions): Promise<StreamStats> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const stats: StreamStats = { received: 0, written: 0, floors: 0, skipped: 0, metadata: 0, reconnects: 0, lastEventAt: null, byKind: {} };
  let tracked: Set<string> | null = null;
  try {
    tracked = await loadTrackedSet();
    log(`[opensea-stream] tracked set loaded: ${tracked.size} collections`);
  } catch (error) {
    log(`[opensea-stream] tracked set unavailable (${error instanceof Error ? error.message : String(error)}); bids will be skipped`);
  }
  const trackedRefresh = setInterval(() => {
    void loadTrackedSet().then((s) => { tracked = s; }).catch(() => undefined);
  }, 5 * 60_000);
  trackedRefresh.unref();
  // Batching: rows accumulate and flush every 500 ms or at 500 rows; one
  // flush in flight at a time so a slow database backs the buffer up
  // instead of fanning out connections.
  let buffer: MarketEventRow[] = [];
  let floorBuffer: MarketEventRow[] = [];
  let flushing = false;
  const metadataSeen = new Map<string, number>();
  const flush = async () => {
    if (flushing || (buffer.length === 0 && floorBuffer.length === 0)) return;
    flushing = true;
    const batch = buffer;
    const floors = floorBuffer;
    buffer = [];
    floorBuffer = [];
    const t0 = Date.now();
    try {
      const written = batch.length > 0 ? await writeMarketEventRows(batch) : 0;
      stats.written += written;
      stats.skipped += batch.length - written;
      if (floors.length > 0) stats.floors += await writeFloorObservations(floors);
      recordExternalCall({ source: "opensea-stream", keyId: opts.keyId ?? null, chainSlug: null, costUnits: 0, latencyMs: Date.now() - t0, outcome: "ok" });
    } catch (error) {
      recordExternalCall({ source: "opensea-stream", keyId: opts.keyId ?? null, chainSlug: null, costUnits: 0, latencyMs: Date.now() - t0, outcome: "error", error: error instanceof Error ? error.message : String(error) });
      log(`[opensea-stream] batch of ${batch.length} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      flushing = false;
    }
  };
  const flushTimer = setInterval(() => void flush(), 2_000);
  flushTimer.unref();
  const deadline = opts.maxSeconds ? Date.now() + opts.maxSeconds * 1000 : Number.POSITIVE_INFINITY;
  const WS = opts.WebSocketImpl ?? ((await import("ws")).default as unknown as new (url: string) => WebSocketLike);
  let backoffMs = 1_000;
  let stop = false;
  const onSignal = () => {
    stop = true;
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  while (!stop && Date.now() < deadline) {
    const started = Date.now();
    await new Promise<void>((resolve) => {
      let ref = 1;
      let heartbeat: NodeJS.Timeout | null = null;
      let watchdog: NodeJS.Timeout | null = null;
      let lastMessageAt = Date.now();
      const SILENCE_MS = 90_000;
      const ws = new WS(`${OPENSEA_STREAM_URL}?token=${encodeURIComponent(opts.apiKey)}`);
      const finish = () => {
        if (heartbeat) clearInterval(heartbeat);
        if (watchdog) clearInterval(watchdog);
        resolve();
      };
      ws.on("open", () => {
        ws.send(JSON.stringify({ topic: "collection:*", event: "phx_join", payload: {}, ref: ref++ }));
        heartbeat = setInterval(() => {
          try {
            ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: ref++ }));
          } catch {
            /* closing */
          }
        }, 30_000);
        lastMessageAt = Date.now();
        watchdog = setInterval(() => {
          if (stop || Date.now() >= deadline) {
            ws.close();
            return;
          }
          // Liveness (AUDIT lens 5 stream risks): the wildcard topic never
          // goes quiet for long; a socket with no frame for SILENCE_MS is
          // half-open. Close it so the reconnect loop takes over.
          if (Date.now() - lastMessageAt > SILENCE_MS) {
            log(`[opensea-stream] no frames for ${Math.round((Date.now() - lastMessageAt) / 1000)}s, reconnecting`);
            ws.close();
          }
        }, 1_000);
        log(`[opensea-stream] connected, joined collection:*`);
        backoffMs = 1_000;
      });
      ws.on("message", (data: unknown) => {
        lastMessageAt = Date.now();
        const text = String(data);
        // Cheap pre-filter: ~3,600 frames/s on a shared core; only three
        // event kinds can produce a write, so skip JSON.parse for the rest.
        if (!WANTED_KIND_RE.test(text)) {
          stats.received += 1;
          stats.skipped += 1;
          return;
        }
        const env = parseEnvelope(text);
        if (!env) return;
        if (env.event === "phx_reply" && env.topic === "collection:*") {
          const status = (env.payload as Record<string, unknown> | undefined)?.status;
          if (status !== "ok") log(`[opensea-stream] join rejected: ${JSON.stringify(env.payload).slice(0, 200)}`);
          return;
        }
        if (!env.event || env.event.startsWith("phx_")) return;
        const kind = env.event;
        const inner = (env.payload as Record<string, unknown> | undefined)?.payload ?? env.payload;
        stats.received += 1;
        stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
        stats.lastEventAt = new Date().toISOString();
        if (kind === "item_metadata_updated") {
          const p = inner as Record<string, unknown>;
          const nft = parseNftId(str((p.item as Record<string, unknown> | undefined)?.nft_id));
          const chainSlug = chainSlugForOpenSeaChain(str(p.chain) ?? nft?.chain);
          const key = chainSlug && nft ? `${chainSlug}:${nft.contract}` : null;
          const now = Date.now();
          if (key && tracked?.has(key) && (metadataSeen.get(key) ?? 0) < now - 10 * 60_000) {
            metadataSeen.set(key, now);
            void enqueueMetadataRefresh(kind, inner).then((ok) => { if (ok) stats.metadata += 1; }).catch(() => undefined);
          } else {
            stats.skipped += 1;
          }
          return;
        }
        const row = mapStreamEvent(kind, inner);
        const decision = selectEvent(kind, row, tracked);
        if (decision === "skip") {
          stats.skipped += 1;
          return;
        }
        if (decision === "floor") {
          floorBuffer.push(row as MarketEventRow);
          return;
        }
        buffer.push(row as MarketEventRow);
        if (buffer.length >= 500) void flush();
      });
      ws.on("error", (error: unknown) => {
        log(`[opensea-stream] socket error: ${error instanceof Error ? error.message : String(error)}`);
      });
      ws.on("close", () => finish());
    });
    if (stop || Date.now() >= deadline) break;
    stats.reconnects += 1;
    const lived = Date.now() - started;
    const wait = lived > 60_000 ? 1_000 : backoffMs;
    backoffMs = Math.min(backoffMs * 2, 60_000);
    log(`[opensea-stream] disconnected after ${Math.round(lived / 1000)}s, reconnecting in ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }
  clearInterval(flushTimer);
  clearInterval(trackedRefresh);
  await flush();
  process.off("SIGTERM", onSignal);
  process.off("SIGINT", onSignal);
  return stats;
}

/**
 * Phoenix sends either the v1 object form {topic,event,payload,ref} or the
 * v2 array form [joinRef, ref, topic, event, payload]; OpenSea's server
 * answered with arrays even without vsn=2.0.0 (observed 2026-09-06).
 */
export function parseEnvelope(data: string): StreamEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    if (parsed.length < 5) return null;
    return { topic: String(parsed[2]), event: String(parsed[3]), payload: parsed[4], ref: parsed[1] };
  }
  if (parsed && typeof parsed === "object") return parsed as StreamEnvelope;
  return null;
}
