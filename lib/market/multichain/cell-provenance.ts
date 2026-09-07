import { durableKv } from "@/lib/market/durable-kv";
import { postgresQuery } from "@/lib/postgres";
import { updateCollectionFloorOnly } from "@/lib/market/multichain/store";
import { chainManifest } from "@/lib/market/multichain/chains/manifest";

/**
 * Cell provenance with a truth rank (FAILURES-AND-INVENTIONS failure 6).
 *
 * Several writers own the same stats cell today (opensea-stream,
 * opensea-stats, coingecko, chain adapters, the canonical fallback); the
 * last one to run wins, which is why a floor can alternate between two
 * values. From here on a cell write goes through writeCell(): it lands
 * only if the writer's rank for that cell is at least the current
 * source's rank, OR the current value is older than the current source's
 * TTL. Provenance (value, source, observedAt) is kept per cell in
 * plank_kv_values -- no migration -- so the hub can show where a number
 * came from and how old it is.
 *
 * Ranks, highest first: our own order book > chain-derived (program
 * accounts, logs, settlements) > venue stream > venue REST > aggregator.
 */
export type CellName = "floor" | "listed" | "holders" | "sales24h" | "volume24h";

export type CellSource =
  | "own-book"
  | "chain-derived"
  | "hunter-evm"
  | "hunter-solana"
  | "hunter-bitcoin"
  | "opensea-stream"
  | "opensea-stats"
  | "magiceden"
  | "unisat"
  | "coingecko"
  | "canonical-fallback"
  | "unknown";

const RANK: Record<CellSource, number> = {
  "own-book": 100,
  "chain-derived": 90,
  "hunter-evm": 90,
  "hunter-solana": 90,
  "hunter-bitcoin": 90,
  "opensea-stream": 70,
  "opensea-stats": 60,
  magiceden: 60,
  unisat: 60,
  coingecko: 40,
  "canonical-fallback": 20,
  unknown: 0,
};

/** How long a source's value stays authoritative before a lower-ranked source may replace it. */
const TTL_MS: Record<CellSource, number> = {
  "own-book": 10 * 60_000,
  "chain-derived": 30 * 60_000,
  "hunter-evm": 30 * 60_000,
  "hunter-solana": 30 * 60_000,
  "hunter-bitcoin": 60 * 60_000,
  "opensea-stream": 15 * 60_000,
  "opensea-stats": 60 * 60_000,
  magiceden: 60 * 60_000,
  unisat: 60 * 60_000,
  coingecko: 6 * 60 * 60_000,
  "canonical-fallback": 5 * 60_000,
  unknown: 0,
};

export type CellProvenance = { value: string | number | null; source: CellSource; observedAt: string };

export function rankOf(source: CellSource): number {
  return RANK[source] ?? 0;
}

/** Pure decision, unit-tested: may `incoming` replace `current` now? */
export function mayOverwrite(current: CellProvenance | null, incoming: { source: CellSource; observedAt: string }, now = Date.now()): boolean {
  if (!current) return true;
  if (rankOf(incoming.source) >= rankOf(current.source)) return true;
  const age = now - Date.parse(current.observedAt);
  return Number.isFinite(age) && age > (TTL_MS[current.source] ?? 0);
}

const provKey = (chainSlug: string, collectionKey: string, cell: CellName) => `plank:cell:${chainSlug}:${collectionKey.toLowerCase()}:${cell}`;

export async function readCellProvenance(chainSlug: string, collectionKey: string, cell: CellName): Promise<CellProvenance | null> {
  return (await durableKv.get<CellProvenance>(provKey(chainSlug, collectionKey, cell))) ?? null;
}

/**
 * Write floor and/or listed for a collection under provenance rules.
 * Returns which cells actually landed. Other cells (sales, volume) keep
 * their existing single owner (the ledger aggregator) and are not routed
 * here yet.
 */
export async function writeCells(input: {
  chainSlug: string;
  collectionKey: string;
  source: CellSource;
  observedAt?: string;
  floorAtomic?: string | null;
  listedCount?: number | null;
}): Promise<{ floor: boolean; listed: boolean }> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const incoming = { source: input.source, observedAt };
  const out = { floor: false, listed: false };
  if (input.floorAtomic !== undefined) {
    const cur = await readCellProvenance(input.chainSlug, input.collectionKey, "floor");
    // Review M1: provenance is recorded only when the value actually landed.
    const positive = input.floorAtomic != null && /^[0-9]+$/.test(input.floorAtomic) && BigInt(input.floorAtomic) > 0n;
    if (positive && mayOverwrite(cur, incoming)) {
      const exists = await postgresQuery<{ id: number }>(`SELECT id FROM plank_multichain_collections WHERE chain_slug = $1 AND lower(contract_address) = lower($2)`, [input.chainSlug, input.collectionKey]);
      if (exists.rows[0]) {
        await updateCollectionFloorOnly(input.chainSlug, input.collectionKey, {
          floorPriceWei: input.floorAtomic,
          floorPriceCurrency: chainManifest(input.chainSlug)?.nativeCurrencySymbol ?? null,
          floorPriceMarketplace: input.source,
        });
        await durableKv.set(provKey(input.chainSlug, input.collectionKey, "floor"), { value: input.floorAtomic, source: input.source, observedAt } satisfies CellProvenance);
        out.floor = true;
      }
    }
  }
  if (input.listedCount !== undefined) {
    const cur = await readCellProvenance(input.chainSlug, input.collectionKey, "listed");
    if (mayOverwrite(cur, incoming)) {
      // Upsert so a collection without a snapshot row still gets its listed count (review M1);
      // synced_at is left alone so the floor-change window is not reset by a listed-only write (L4).
      const r = await postgresQuery(
        `INSERT INTO plank_multichain_snapshots (collection_id, listed_count, synced_at)
         SELECT c.id, $3, NOW() FROM plank_multichain_collections c
          WHERE c.chain_slug = $1 AND lower(c.contract_address) = lower($2)
         ON CONFLICT (collection_id) DO UPDATE SET listed_count = EXCLUDED.listed_count`,
        [input.chainSlug, input.collectionKey, input.listedCount]
      );
      if ((r.rowCount ?? 0) > 0) {
        await durableKv.set(provKey(input.chainSlug, input.collectionKey, "listed"), { value: input.listedCount, source: input.source, observedAt } satisfies CellProvenance);
        out.listed = true;
      }
    }
  }
  return out;
}
