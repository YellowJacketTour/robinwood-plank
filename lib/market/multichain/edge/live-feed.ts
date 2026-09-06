import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";

/**
 * Push instead of poll, at the user edge.
 *
 * The mesh lanes already own every vendor subscription (HyperSync cursors,
 * Helius/UniSat transfer scans, Seaport/Blur/... fill indexers) and write
 * what they see into plank_market_events. Before this file, N browsers
 * that wanted "what just happened" each polled an App Router route, and
 * each poll re-read Postgres. This module is ONE in-process tailer of
 * plank_market_events (a single cheap indexed read every TICK_MS, keyed by
 * the last seen id) fanned out to every attached SSE subscriber -- so live
 * data flows vendor -> one lane -> one Postgres row -> one tail -> N
 * browsers, never N browsers -> vendor.
 *
 * Honest scope: this pushes what the ledgers have actually written. It is
 * not a claim that every venue is indexed to the tip -- the per-venue
 * coverage registry (venue-registry.ts) still says what is and is not.
 */

export type LiveMarketEvent = {
  id: number;
  chainSlug: string;
  collectionKey: string;
  venueId: string;
  eventType: string;
  tokenId: string | null;
  txHash: string;
  blockNumber: string | null;
  timestamp: string | null;
  seller: string | null;
  buyer: string | null;
  amountAtomic: string | null;
  currencySymbol: string | null;
  amountUsd: number | null;
};

type Subscriber = {
  chainSlug: string | null;
  collectionKey: string | null;
  send: (event: LiveMarketEvent) => void;
};

type FeedGlobal = typeof globalThis & {
  __plankLiveFeed?: {
    subscribers: Set<Subscriber>;
    lastId: number | null;
    timer: NodeJS.Timeout | null;
    ticking: boolean;
    pushed: number;
    ticks: number;
  };
};

const TICK_MS = 2_500;
const MAX_PER_TICK = 200;

function state() {
  const g = globalThis as FeedGlobal;
  if (!g.__plankLiveFeed) {
    g.__plankLiveFeed = { subscribers: new Set(), lastId: null, timer: null, ticking: false, pushed: 0, ticks: 0 };
  }
  return g.__plankLiveFeed;
}

async function readNewest(afterId: number): Promise<LiveMarketEvent[]> {
  const rows = await postgresQuery<{
    id: string; chain_slug: string; collection_key: string; venue_id: string; event_type: string; token_id: string | null;
    tx_hash: string; block_number: string | null; block_timestamp: Date | null; seller: string | null; buyer: string | null;
    amount_atomic: string | null; currency_symbol: string | null; amount_usd: string | null;
  }>(
    `SELECT id::text, chain_slug, collection_key, venue_id, event_type, token_id, tx_hash, block_number::text, block_timestamp,
            seller, buyer, amount_atomic::text, currency_symbol, amount_usd::text
       FROM plank_market_events WHERE id > $1 ORDER BY id ASC LIMIT ${MAX_PER_TICK}`,
    [afterId]
  );
  return rows.rows.map((r) => ({
    id: Number(r.id),
    chainSlug: r.chain_slug,
    collectionKey: r.collection_key,
    venueId: r.venue_id,
    eventType: r.event_type,
    tokenId: r.token_id,
    txHash: r.tx_hash,
    blockNumber: r.block_number,
    timestamp: r.block_timestamp ? new Date(r.block_timestamp).toISOString() : null,
    seller: r.seller,
    buyer: r.buyer,
    amountAtomic: r.amount_atomic,
    currencySymbol: r.currency_symbol,
    amountUsd: r.amount_usd != null ? Number(r.amount_usd) : null,
  }));
}

async function tick(): Promise<void> {
  const s = state();
  if (s.ticking || s.subscribers.size === 0) return;
  s.ticking = true;
  try {
    s.ticks += 1;
    if (s.lastId == null) {
      // Start at the tip: a subscriber wants what happens next, not history.
      // Measured live 2026-09-05: `ORDER BY id DESC LIMIT 1` on the real
      // 58M-row table took 12.5s (a backward index scan over a deleted id
      // range's dead entries) and blew the 15s statement timeout on the
      // next tick; the id sequence is the same tip for our purpose and is
      // a single-row read.
      const seq = await postgresQuery<{ last_value: string }>(`SELECT last_value::text FROM plank_market_events_id_seq`);
      s.lastId = Number(seq.rows[0]?.last_value ?? 0);
      return;
    }
    const events = await readNewest(s.lastId);
    for (const event of events) {
      s.lastId = event.id;
      for (const sub of s.subscribers) {
        if (sub.chainSlug && sub.chainSlug !== event.chainSlug) continue;
        if (sub.collectionKey && sub.collectionKey.toLowerCase() !== event.collectionKey.toLowerCase()) continue;
        try {
          sub.send(event);
          s.pushed += 1;
        } catch {
          s.subscribers.delete(sub);
        }
      }
    }
  } catch (error) {
    // transient Postgres error: next tick retries; subscribers just wait.
    // Logged (rate-limited) rather than swallowed -- a silent tail is
    // indistinguishable from a quiet market.
    if (s.ticks % 20 === 1) console.error("[live-feed] tick failed:", error instanceof Error ? error.message : error);
  } finally {
    s.ticking = false;
  }
}

function ensureTimer(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => void tick(), TICK_MS);
  s.timer.unref?.();
}

/** Attach one SSE subscriber. Returns a detach function. */
export function subscribeLiveFeed(filter: { chainSlug?: string | null; collectionKey?: string | null }, send: Subscriber["send"]): () => void {
  if (!hasPostgresConfig()) return () => undefined;
  const s = state();
  const sub: Subscriber = { chainSlug: filter.chainSlug ?? null, collectionKey: filter.collectionKey ?? null, send };
  s.subscribers.add(sub);
  ensureTimer();
  void tick();
  return () => {
    s.subscribers.delete(sub);
    if (s.subscribers.size === 0 && s.timer) {
      clearInterval(s.timer);
      s.timer = null;
    }
  };
}

export function readLiveFeedStats() {
  const s = state();
  return { subscribers: s.subscribers.size, lastId: s.lastId, ticks: s.ticks, pushed: s.pushed, tickMs: TICK_MS };
}
