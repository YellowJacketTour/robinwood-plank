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
 * WHY A HARD-SEEDED BLUE-CHIP LIST EXISTS ALONGSIDE THE DISCOVERY SCANNER
 * -------------------------------------------------------------------------
 * lib/market/multichain/discovery/evm-log-scan.ts finds real, currently-
 * active collections by watching raw chain activity — but it only ever
 * scans a narrow (10-block) recent window each tick. A blue-chip collection
 * that simply hasn't had a transfer in that exact slice won't appear that
 * tick, purely by chance, even though it's unambiguously a top collection.
 * The 9 Ethereum entries below close that gap: hand-picked, well-known
 * collections, each one INDIVIDUALLY VERIFIED live on 2026-08-17 (not
 * trusted from training-data memory) against getContractMetadata +
 * getFloorPrice, confirming both a real floor price AND that the returned
 * OpenSea collectionUrl matches the intended collection exactly (catches
 * a wrong-but-valid contract address, not just a dead one). This is an
 * honest "known blue-chips, confirmed live" list, not a claim of
 * mathematically-exact top-10-by-volume-today ranking — no free API
 * confirms that ranking for EVM chains as of this date (see
 * lib/market/multichain/types.ts's ChainAdapter.discoverTopCollections doc).
 * Solana does NOT need an equivalent hard-seeded list: magiceden-solana's
 * discoverTopCollections is a REAL ranked API (confirmed live), so
 * scripts/discover-multichain-collections.ts already guarantees accurate
 * top-N coverage there without hand-curation.
 */
import { upsertTrackedCollection, hasMultichainStore } from "../lib/market/multichain/store";

const SEED_COLLECTIONS = [
  {
    chainSlug: "eth-mainnet",
    chainId: 1,
    contractAddress: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d",
    adapter: "alchemy-nft",
    label: "Bored Ape Yacht Club",
  },
  {
    chainSlug: "eth-mainnet",
    chainId: 1,
    contractAddress: "0xed5af388653567af2f388e6224dc7c4b3241c544",
    adapter: "alchemy-nft",
    label: "Azuki",
  },
  {
    chainSlug: "eth-mainnet",
    chainId: 1,
    contractAddress: "0x8a90cab2b38dba80c64b7734e58ee1db38b8992e",
    adapter: "alchemy-nft",
    label: "Doodles",
  },
  {
    chainSlug: "eth-mainnet",
    chainId: 1,
    contractAddress: "0xbd3531da5cf5857e7cfaa92426877b022e612cf8",
    adapter: "alchemy-nft",
    label: "Pudgy Penguins",
  },
  {
    chainSlug: "eth-mainnet",
    chainId: 1,
    contractAddress: "0x23581767a106ae21c074b2276d25e5c3e136a68b",
    adapter: "alchemy-nft",
    label: "Moonbirds",
  },
  {
    chainSlug: "eth-mainnet",
    chainId: 1,
    contractAddress: "0x49cf6f5d44e70224e2e23fdcdd2c053f30ada28b",
    adapter: "alchemy-nft",
    label: "CloneX",
  },
  {
    chainSlug: "eth-mainnet",
    chainId: 1,
    contractAddress: "0x60e4d786628fea6478f785a6d7e704777c86a7c6",
    adapter: "alchemy-nft",
    label: "Mutant Ape Yacht Club",
  },
  {
    chainSlug: "eth-mainnet",
    chainId: 1,
    contractAddress: "0x1a92f7381b9f03921564a437210bb9396471050c",
    adapter: "alchemy-nft",
    label: "Cool Cats",
  },
  {
    chainSlug: "eth-mainnet",
    chainId: 1,
    contractAddress: "0x306b1ea3ecdf94aB739F1910bbda052Ed4A9f949",
    adapter: "alchemy-nft",
    label: "BEANZ",
  },
  {
    chainSlug: "solana-mainnet",
    chainId: null,
    // Magic Eden's collection SYMBOL, not a contract address — see
    // adapters/magiceden-solana.ts's header for why Solana has no ERC-721-
    // style single contract address to key on. (Solana's own top-10 is
    // already guaranteed by discover-multichain-collections.ts's real
    // ranked API — this single entry just seeds a known-good starting
    // point before that script's first run.)
    contractAddress: "degods",
    adapter: "magiceden-solana",
    label: "DeGods",
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
