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
import { alchemyNftAdapter } from "../lib/market/multichain/adapters/alchemy-nft";
import { magicEdenSolanaAdapter } from "../lib/market/multichain/adapters/magiceden-solana";
import { hasMultichainStore, upsertTrackedCollection } from "../lib/market/multichain/store";
import type { ChainAdapter, DiscoveredCollection } from "../lib/market/multichain/types";

/**
 * Which chains this script tries to discover into. chainId is null for
 * non-EVM chains, matching plank_multichain_collections' schema.
 */
const DISCOVERY_TARGETS: Array<{ chainSlug: string; chainId: number | null; adapter: ChainAdapter }> = [
  { chainSlug: "eth-mainnet", chainId: 1, adapter: alchemyNftAdapter },
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
    const merged = new Map<string, DiscoveredCollection>();
    for (const entry of [...byVolume, ...byFloor]) {
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
