/**
 * Auto-populates the multichain registry from each adapter's top-N-by-volume
 * and top-N-by-floor-price rankings, deduped per chain, instead of requiring
 * every collection to be hand-listed in seed-multichain-collections.ts.
 *
 * Only adapters that implement discoverTopCollections (see
 * lib/market/multichain/types.ts's doc comment on that optional method) can
 * participate — an adapter without it is reported as skipped, not silently
 * ignored, so a real coverage gap (e.g. no confirmed free EVM ranking source
 * as of 2026-08-17) stays visible rather than looking like zero collections
 * exist on that chain.
 *
 * Usage:
 *   tsx scripts/discover-multichain-collections.ts [--limit=500]
 *
 * --limit applies to EACH metric (volume and floor) independently — the
 * actual number of newly-registered collections per chain is at most
 * 2×limit and typically less, since the two rankings overlap heavily for
 * any real market (a top-volume collection is very often ALSO a top-floor
 * one). That overlap is exactly what "remove dupes" resolves, per
 * contractAddress within a chain.
 */
import { magicEdenSolanaAdapter } from "../lib/market/multichain/adapters/magiceden-solana";
import { defillamaNftAdapter } from "../lib/market/multichain/adapters/defillama-nft";
import { hasMultichainStore, upsertTrackedCollection, updateCollectionDisplay } from "../lib/market/multichain/store";
import type { ChainAdapter, DiscoveredCollection } from "../lib/market/multichain/types";

/**
 * Which chains this script tries to discover into. chainId is null for
 * non-EVM chains, matching plank_multichain_collections' schema.
 *
 * eth-mainnet appears TWICE, once per adapter, on purpose: alchemy-nft has
 * no discoverTopCollections (no confirmed free EVM ranking source there),
 * while defillama-nft does (see that adapter's header for why -- free,
 * proven, no-auth, floor-price-only). Registering both means a discovered
 * collection's `adapter` column ends up as whichever adapter discovered it
 * first per contract; upsertTrackedCollection dedupes by (chainSlug,
 * contractAddress) regardless of which adapter's sync it then uses.
 */
const DISCOVERY_TARGETS: Array<{ chainSlug: string; chainId: number | null; adapter: ChainAdapter }> = [
  { chainSlug: "eth-mainnet", chainId: 1, adapter: defillamaNftAdapter },
  { chainSlug: "solana-mainnet", chainId: null, adapter: magicEdenSolanaAdapter },
];

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Math.max(1, Number(limitArg.slice("--limit=".length))) : 500;

/** contractAddress is lowercased for EVM chains (checksum-insensitive), left as-is for others (e.g. Solana symbols are already canonical lowercase-ish slugs, not addresses). */
function normalizeKey(chainSlug: string, contractAddress: string): string {
  return chainSlug.startsWith("solana") ? contractAddress : contractAddress.toLowerCase();
}

async function main() {
  if (!hasMultichainStore()) {
    throw new Error(
      "Set PGHOST/PGDATABASE/PGUSER/PGPASSWORD before discovering — this writes where the app reads."
    );
  }

  for (const target of DISCOVERY_TARGETS) {
    if (!target.adapter.discoverTopCollections) {
      console.log(
        `[discover] ${target.chainSlug}: SKIPPED — adapter "${target.adapter.name}" has no confirmed free ranking source yet`
      );
      continue;
    }

    const [byVolume, byFloor] = await Promise.all([
      target.adapter.discoverTopCollections({ chainSlug: target.chainSlug, metric: "volume", limit: LIMIT }),
      target.adapter.discoverTopCollections({ chainSlug: target.chainSlug, metric: "floorPrice", limit: LIMIT }),
    ]);

    // Dedupe by normalized contract key, merging rank info when a
    // collection appears in both lists rather than keeping two rows.
    // SKIP composite "address:startTokenId:endTokenId" ids -- DeFiLlama's
    // real format for Art Blocks-style shared-contract sub-projects
    // (confirmed live: e.g. Fidenza by Tyler Hobbs is
    // "0xa7d8...:78000000:78999999" on the actual Art Blocks contract).
    // Every downstream integration this app has (Alchemy metadata,
    // OpenSea listings/offers, Seaport fulfillment) assumes contractAddress
    // is a real standalone ERC-721 address -- a token-range id breaks all
    // of them (confirmed: rarity-index-runner.ts's slug resolution already
    // fails closed on these). Tracking it anyway just means a permanently
    // broken row (no art, no trading), which is worse than not tracking it
    // -- real sub-project support would mean real schema work (a token-id
    // range column, filtered everywhere), not a half-fix here.
    const merged = new Map<string, DiscoveredCollection>();
    for (const entry of [...byVolume, ...byFloor]) {
      if (entry.contractAddress.includes(":")) continue;
      const key = normalizeKey(target.chainSlug, entry.contractAddress);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, entry);
      } else {
        merged.set(key, {
          ...existing,
          volumeRank: existing.volumeRank ?? entry.volumeRank,
          floorPriceRank: existing.floorPriceRank ?? entry.floorPriceRank,
        });
      }
    }

    let registered = 0;
    for (const entry of merged.values()) {
      await upsertTrackedCollection({
        chainSlug: target.chainSlug,
        chainId: target.chainId,
        contractAddress: entry.contractAddress,
        adapter: target.adapter.name,
        isVaultBacked: false,
      });
      // Real name/image discoverTopCollections already fetched (e.g.
      // Magic Eden's live ranked endpoint) was being thrown away here --
      // upsertTrackedCollection only writes chain/address/adapter. Fixed:
      // persist it immediately so a Solana row isn't stuck at "?" until
      // some other pass happens to backfill it (nothing currently does
      // for Solana -- EVM has rarity-index-runner.ts's OpenSea backfill,
      // Solana has no equivalent pass yet).
      //
      // NEVER persist a known-dead image domain, though (confirmed live,
      // repeatedly, this session: img.reservoir.tools no longer resolves
      // at all -- Reservoir shut down in 2025). defillamaNftAdapter's own
      // `image` field is sourced from that same dead CDN (see its header),
      // so an eth-mainnet discovery pass here was silently clobbering the
      // REAL OpenSea art rarity-index-runner.ts had just backfilled with
      // DeFiLlama's dead one on every re-run -- caught live via a real
      // browser regression (25 fresh img.reservoir.tools 404s right after
      // this fix's first deploy).
      const deadImageHosts = ["img.reservoir.tools"];
      const isDeadImage = entry.imageUrl ? deadImageHosts.some((h) => entry.imageUrl!.includes(h)) : false;
      if (entry.name || (entry.imageUrl && !isDeadImage)) {
        await updateCollectionDisplay(target.chainSlug, entry.contractAddress, {
          name: entry.name ?? null,
          imageUrl: isDeadImage ? null : (entry.imageUrl ?? null),
        });
      }
      registered += 1;
    }

    console.log(
      `[discover] ${target.chainSlug}: ${byVolume.length} by volume + ${byFloor.length} by floor -> ` +
        `${merged.size} unique (${byVolume.length + byFloor.length - merged.size} dupes removed) -> ${registered} registered`
    );
  }
}

main()
  .then(async () => {
    const { hasPostgresConfig, postgresPool } = await import("../lib/postgres");
    if (hasPostgresConfig()) await postgresPool().end();
    process.exit(0);
  })
  .catch((error) => {
    console.error("[discover-multichain] fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
