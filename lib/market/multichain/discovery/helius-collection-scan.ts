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

const RPC_URL = "https://mainnet.helius-rpc.com";
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
 * Real quality floor, not an arbitrary threshold -- flagged live
 * 2026-08-20 ("solana is now showing 49 thousand collections... something
 * is broken"): this scan is genuinely exhaustive and genuinely not
 * duplicating/looping, but Metaplex Core is permissionless (anyone can
 * create a "collection" for free), and the only prior filter here (has a
 * name or an image) let through every empty/dead/spam collection Core has
 * ever seen. num_minted is Core's own real member-count field
 * (mpl_core_info, confirmed live against Helius mainnet -- a real
 * searchAssets call returned a real collection with num_minted: 1) -- a
 * collection with zero minted members structurally cannot ever have a
 * real floor/volume/listed signal, so registering it was pure dead
 * weight, not coverage. Only skip on a CONFIRMED zero, never on a
 * missing/unparseable field -- absence of data is not evidence of zero.
 */
export function shouldSkipZeroMemberCollection(item: HeliusSearchItem): boolean {
  return item.mpl_core_info?.num_minted === 0;
}

function apiKey(): string {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key) throw new Error("helius-collection-scan: HELIUS_API_KEY is not configured");
  return key;
}

async function fetchPage(cursor: string | null): Promise<{ items: HeliusSearchItem[]; nextCursor: string | null }> {
  const params: Record<string, unknown> = { interface: "MplCoreCollection", limit: PAGE_SIZE };
  if (cursor) params.cursor = cursor;
  const res = await fetch(`${RPC_URL}/?api-key=${apiKey()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "plank", method: "searchAssets", params }),
  });
  if (!res.ok) throw new Error(`helius-collection-scan: HTTP ${res.status}`);
  const body = (await res.json()) as {
    result?: { items: HeliusSearchItem[]; cursor?: string | null };
    error?: { code: number; message: string };
  };
  if (body.error) throw new Error(`helius-collection-scan: ${body.error.code} ${body.error.message}`);
  const items = body.result?.items ?? [];
  return { items, nextCursor: items.length === PAGE_SIZE ? (body.result?.cursor ?? null) : null };
}

type StoredCursor = { cursor: string | null; done: boolean };

async function readCursor(): Promise<StoredCursor> {
  const stored = await durableKv.get<StoredCursor>(CURSOR_KEY);
  return stored ?? { cursor: null, done: false };
}

async function writeCursorValue(cursor: string | null, done: boolean): Promise<void> {
  await durableKv.set(CURSOR_KEY, { cursor, done } satisfies StoredCursor);
}

export type HeliusCollectionScanResult = {
  pagesWalked: number;
  registered: number;
  done: boolean;
  error?: string;
};

export async function runHeliusCollectionScan(input: { maxPages?: number } = {}): Promise<HeliusCollectionScanResult> {
  const maxPages = input.maxPages ?? 10;
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
