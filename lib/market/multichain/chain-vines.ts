/**
 * One vine per hub chain: acquire → harness → express.
 * Hub GET stays read-only. Runners: scripts/run-chain-vines.ts
 */
export type ChainVine = {
  chainSlug: string;
  acquire: string[];
  harness: string[];
  express: string[];
  never: string[];
};

export const CHAIN_VINES: ChainVine[] = [
  {
    chainSlug: "eth-mainnet",
    acquire: ["opensea-bulk-v2 (no Alchemy image gate)", "hypersync transfers (no Alchemy when jailed)", "seaport fills"],
    harness: ["opensea-stats (isolated process)", "slug cache at list time", "CG ethereum exact contract (cron coingecko-eth-stats, missing-floor first)"],
    express: ["floor/vol/sales/listed/holders from OS", "hex shells only if they have cells"],
    never: ["Alchemy NFT API"],
  },
  {
    chainSlug: "polygon-mainnet",
    acquire: ["opensea-bulk chain=matic alias polygon", "hypersync"],
    harness: ["opensea-stats", "slug cache"],
    express: ["named catalog + OS floors (quality bar for EVM list path)"],
    never: ["Alchemy NFT API"],
  },
  {
    chainSlug: "base-mainnet",
    acquire: ["opensea-bulk chain=base", "hypersync"],
    harness: ["opensea-stats isolated", "slug cache"],
    express: ["same cells as ETH"],
    never: ["Alchemy NFT API"],
  },
  {
    chainSlug: "arb-mainnet",
    acquire: ["opensea-bulk arb|arbitrum alias", "hypersync"],
    harness: ["opensea-stats isolated"],
    express: ["floors already present; fill vol/listed/holders from OS"],
    never: ["Alchemy NFT API"],
  },
  {
    chainSlug: "opt-mainnet",
    acquire: ["opensea-bulk optimism|opt, titles without images", "hypersync"],
    harness: ["opensea-stats isolated (was skipped by global id cursor)"],
    express: ["named rows + OS stats; 1/1s may have floor without listed"],
    never: ["Alchemy NFT API"],
  },
  {
    chainSlug: "bnb-mainnet",
    acquire: ["opensea-bulk bsc|bnb", "do not treat inactive OS NFTs as a book"],
    harness: ["opensea-stats only when slug stats 200", "CG binance-smart-chain exact (cron coingecko-bnb-stats)"],
    express: ["OS-listed collections get floors; 1CAKE-class stay dash"],
    never: ["Alchemy NFT API", "invented BNB floors"],
  },
  {
    chainSlug: "avax-mainnet",
    acquire: ["opensea-bulk avalanche", "hypersync Transfer tally as recentActivity"],
    harness: ["opensea-stats", "CG avalanche exact (cron coingecko-avax-stats)", "keep rows with holders or transfers even if hex title"],
    express: ["catalog count includes activity-backed rows; OS names overlay hex"],
    never: ["delete 3k hypersync rows", "Alchemy NFT API"],
  },
  {
    chainSlug: "solana-mainnet",
    acquire: ["magiceden ranked list", "helius MplCore (member floor 50 going forward)"],
    harness: ["ME stats uniqueHolders+listed+floor", "CG solana exact id", "adapter-sync chain=solana skip Alchemy"],
    express: ["ME symbols and Helius ids ARE identity — never title-prune"],
    never: ["Alchemy", "fuzzy name attach"],
  },
  {
    chainSlug: "bitcoin-mainnet",
    acquire: ["unisat collection list (~full registry)", "ordiscan second catalog"],
    harness: ["unisat collection_statistic floor/listed/supply", "indexer holders.total", "CG ordinals exact slug"],
    express: ["collectionId is the collection; thousands stay visible"],
    never: ["Alchemy", "title-prune empty UniSat names"],
  },
  {
    chainSlug: "zksync-mainnet",
    acquire: ["hypersync transfers (chain 324)", "native Seaport book (no OpenSea orderbook: confirmed 2026-08-17)"],
    harness: ["evm-metadata tokenURI multicall + IPFS", "seaport fills"],
    express: ["native listings/offers only; OpenSea cells stay dash"],
    never: ["Alchemy NFT API", "OpenSea slug lookups"],
  },
  {
    chainSlug: "robinhood",
    acquire: ["robinhood-chain-scan", "opensea-robinhood-scan", "native Seaport book + plank.love canonical overlay"],
    harness: ["getListings(robinwood) no chain filter", "owner-index unique wallets", "seaport fills / ledger"],
    express: ["@RobinWoodPlank, 1542 supply, vault/sends in activity, native grade"],
    never: ["fake floor", "Alchemy NFT"],
  },
];

export const VINE_ORDER = CHAIN_VINES.map((v) => v.chainSlug);
