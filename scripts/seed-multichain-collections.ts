/**
 * Registers the starter set of non-Robinhood collections for
 * lib/market/multichain/sync.ts to track. Idempotent (upsertTrackedCollection
 * is ON CONFLICT DO UPDATE) — safe to re-run.
 *
 * Only lists collections actually verified against a live adapter call
 * before being added here — see lib/market/multichain/adapters/alchemy-nft.ts's
 * header comment for the 2026-08-17 verification of Bored Ape Yacht Club.
 * Add more once each new (chainSlug, adapter) pairing is similarly confirmed
 * live, not assumed from an API's docs alone.
 *
 * Usage: tsx scripts/seed-multichain-collections.ts
 */
import { upsertTrackedCollection, hasMultichainStore } from "../lib/market/multichain/store";

const SEED_COLLECTIONS = [
  {
    chainSlug: "eth-mainnet",
    chainId: 1,
    contractAddress: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d",
    adapter: "alchemy-nft",
    label: "Bored Ape Yacht Club (proof-of-concept — first non-Robinhood collection wired end-to-end)",
  },
];

async function main() {
  if (!hasMultichainStore()) {
    throw new Error(
      "Set PGHOST/PGDATABASE/PGUSER/PGPASSWORD before seeding — this writes where the app reads."
    );
  }
  for (const seed of SEED_COLLECTIONS) {
    const id = await upsertTrackedCollection({
      chainSlug: seed.chainSlug,
      chainId: seed.chainId,
      contractAddress: seed.contractAddress,
      adapter: seed.adapter,
      isVaultBacked: false,
    });
    console.log(`[seed-multichain] id=${id} ${seed.chainSlug}:${seed.contractAddress} — ${seed.label}`);
  }
}

main()
  .then(async () => {
    const { hasPostgresConfig, postgresPool } = await import("../lib/postgres");
    if (hasPostgresConfig()) await postgresPool().end();
    process.exit(0);
  })
  .catch((error) => {
    console.error("[seed-multichain] fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
