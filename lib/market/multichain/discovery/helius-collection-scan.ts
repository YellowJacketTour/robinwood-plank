/**
 * Exhaustive Solana collection discovery via Helius DAS -- see
 * lib/market/multichain/adapters/helius-solana.ts's own header for the
 * full real API constraints this was built around (owner_address
 * requirement quirk, the real limit=1000 server timeout, no grand-total
 * field, and the honest MplCoreCollection-only scope).
 *
 * Cursor-paginated, resumable via the same discovery cursor table every
 * other scanner in this directory uses (own key, no migration needed).
 * "done" is a page returning fewer items than PAGE_SIZE -- there is no
 * reliable total count to compare against, confirmed live.
 */
import { durableKv } from "@/lib/market/durable-kv";
import { upsertTrackedCollection } from "@/lib/market/multichain/store";
import { reserveDasSlot, settleDasSlot } from "@/lib/market/multichain/discovery/solana-das-pool";

const PAGE_SIZE = 100; // real, confirmed-safe live 2026-08-20 -- limit=1000 times out server-side
const CHAIN_SLUG = "solana-mainnet";
// Not plank_multichain_discovery_cursor (that table's last_scanned_block
// is a real BIGINT column -- Helius's cursor is an opaque base58-ish
// string, not a block number, so it doesn't fit there). durableKv is the
// same general-purpose store rarity-snapshot.ts and others already use
// for non-numeric state -- no migration needed.
const CURSOR_KEY = "plank:market:helius-collection-scan-cursor";

export type HeliusSearchItem = {
  id: string;
  content?: {
    metadata?: { name?: string | null };
    links?: { image?: string | null };
  };
  /** Real, live-verified field (2026-08-20, a direct searchAssets call against Helius mainnet) -- Metaplex Core's own collection struct fields, surfaced by Helius under this exact key for every MplCoreCollection-interface item. num_minted is the real, honest quality floor: a collection with zero minted members structurally can never produce a real floor/volume/listed signal, so registering it was pure dead weight, not "coverage." */
  mpl_core_info?: { num_minted?: number; current_size?: number };
};

/**
 * A confirmed zero-member collection cannot contain a marketable piece.
 * Small non-zero collections remain valid: activity/ranking can demote spam,
 * but discovery must not silently erase legitimate editions.
 */
export const MIN_REAL_MEMBER_COUNT = 1;

export function shouldSkipZeroMemberCollection(item: HeliusSearchItem): boolean {
  const n = item.mpl_core_info?.num_minted;
  return typeof n === "number" && n < MIN_REAL_MEMBER_COUNT;
}

/** Background discovery lane -- reserves+settles a FRESH pool key per page fetched. */
async function fetchPage(cursor: string | null): Promise<{ items: HeliusSearchItem[]; nextCursor: string | null }> {
  const params: Record<string, unknown> = { interface: "MplCoreCollection", limit: PAGE_SIZE };
  if (cursor) params.cursor = cursor;
  const slot = await reserveDasSlot(1, { priority: "background" });
  if (!slot) throw new Error("helius-collection-scan: no Solana DAS provider available (pool exhausted/jailed, or none configured)");
  let ok = false;
  try {
    const res = await fetch(slot.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "plank", method: "searchAssets", params }),
    });
    if (!res.ok) throw new Error(`helius-collection-scan: HTTP ${res.status} via ${slot.provider}`);
    const body = (await res.json()) as {
      result?: { items: HeliusSearchItem[]; cursor?: string | null };
      error?: { code: number; message: string };
    };
    if (body.error) throw new Error(`helius-collection-scan: ${body.error.code} ${body.error.message} via ${slot.provider}`);
    const items = body.result?.items ?? [];
    ok = true;
    return { items, nextCursor: items.length === PAGE_SIZE ? (body.result?.cursor ?? null) : null };
  } finally {
    await settleDasSlot(slot, 1, ok);
  }
}

type StoredCursor = { cursor: string | null; done: boolean; doneAt?: number };

/**
 * REAL BUG FIXED 2026-08-23: once a full walk reached `done: true`, this
 * scanner returned immediately forever (line ~96 below) and never looked
 * for newly-minted MplCore collections again -- confirmed live, the stored
 * cursor row's `updated_at` was 2026-08-20 and hadn't moved since, even
 * with the supervisor loop running continuously. Helius's searchAssets has
 * no "since" filter to do an incremental catch-up scan, so the only real
 * option is a periodic full re-walk. 6 hours is arbitrary pacing (no
 * documented Helius limit says otherwise), chosen so new collections are
 * caught same-day without re-walking the whole catalog on every single
 * supervisor tick.
 */
const RESCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function readCursor(): Promise<StoredCursor> {
  const stored = await durableKv.get<StoredCursor>(CURSOR_KEY);
  if (!stored) return { cursor: null, done: false };
  if (stored.done && (Date.now() - (stored.doneAt ?? 0)) > RESCAN_INTERVAL_MS) {
    return { cursor: null, done: false };
  }
  return stored;
}

async function writeCursorValue(cursor: string | null, done: boolean): Promise<void> {
  await durableKv.set(CURSOR_KEY, { cursor, done, doneAt: done ? Date.now() : undefined } satisfies StoredCursor);
}

export type HeliusCollectionScanResult = {
  pagesWalked: number;
  registered: number;
  done: boolean;
  error?: string;
};

export async function runHeliusCollectionScan(input: { maxPages?: number } = {}): Promise<HeliusCollectionScanResult> {
  // No documented Helius per-minute limit is cited in this file (only the
  // real per-page size=1000 server timeout above, unrelated to page count).
  // Raised 10x from the arbitrary cron-pacing default of 10.
  const maxPages = input.maxPages ?? 100;
  const stored = await readCursor();
  if (stored.done) {
    return { pagesWalked: 0, registered: 0, done: true };
  }

  let cursor = stored.cursor;
  let pagesWalked = 0;
  let registered = 0;
  let done = false;

  for (; pagesWalked < maxPages; pagesWalked++) {
    const page = await fetchPage(cursor);
    for (const item of page.items) {
      if (!item.content?.metadata?.name && !item.content?.links?.image) continue; // no real signal at all
      if (shouldSkipZeroMemberCollection(item)) continue;
      await upsertTrackedCollection({
        chainSlug: CHAIN_SLUG,
        chainId: null,
        contractAddress: item.id,
        adapter: "helius-solana",
        isVaultBacked: false,
      });
      registered += 1;
    }
    cursor = page.nextCursor;
    if (!cursor) {
      done = true;
      break;
    }
  }

  await writeCursorValue(cursor, done);
  return { pagesWalked, registered, done };
}
