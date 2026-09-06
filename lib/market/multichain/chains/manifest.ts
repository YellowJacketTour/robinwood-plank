/**
 * ONE MANIFEST PER CHAIN -- the source of truth every per-chain registry is
 * DERIVED from.
 *
 * docs/marketplank/FABLE-ONESHOT-marketplank-all-chains-peak-2026-09-05.md
 * §3.7: "Adding a chain is O(files). chain-plugin.ts is a derived view, not
 * the source of truth; a new chain touches registries, EVM_CHAIN_ID maps,
 * hydrationJobSources, adapters, matrix, vines."
 *
 * After this file: FOREIGN_CHAINS (trading/foreign-chain-registry.ts),
 * EVM_CHAIN_ID (discovery/evm-log-scan.ts), ALCHEMY_NETWORK_SUBDOMAIN
 * (adapters/alchemy-network.ts), the chain lists in mesh/matrix.ts, the
 * display name / brand color / glyph maps and chain-plugin.ts all read
 * from CHAIN_MANIFESTS. test/market/chain-manifest.test.ts fails if any of
 * those registries lists a chain this file does not (manual wiring) or
 * omits one it does.
 *
 * Every fact below was already live-verified in the module it came from
 * (dates cited there); this file moves them, it does not re-derive them.
 * hydrationJobSources' per-source completion gating is deliberately NOT
 * derived from here -- see chain-plugin.ts's header for why.
 */

export type ChainKind = "evm" | "custom-evm" | "solana" | "ordinals";

export type ChainManifest = {
  /** This app's own join key across every table/route/component. */
  chainSlug: string;
  kind: ChainKind;
  displayName: string;
  /** Real EVM chainId; null for non-EVM. */
  chainId: number | null;
  /** Published brand color (chain's own brand kit; Robinhood = this app's gold token). */
  brandColor: string;
  glyph: string;
  nativeCurrencySymbol: string;
  blockExplorerUrl: string | null;
  /** Display symbol prices on this chain are denominated in (wrapped gas token for EVM). */
  offerCurrencySymbol: string;
  /** Canonical wrapped-gas-token address Seaport offers are denominated in; null when no Seaport. */
  offerCurrencyAddress: string | null;
  /** OpenSea's own chain identifier (Polygon = "matic", BNB = "bsc"); null = no OpenSea orderbook. */
  openSeaChain: string | null;
  /** Alchemy subdomain for NFT API + raw JSON-RPC; null = not on Alchemy. */
  alchemySubdomain: string | null;
  /** CoinGecko NFT asset-platform id; null = not on CoinGecko. */
  coingeckoPlatform: string | null;
  /** True when Envio HyperSync serves `https://${chainId}.hypersync.xyz` (live-verified per chain). */
  hypersync: boolean;
  /** Seaport 1.6 at the canonical CREATE2 address (live-verified via eth_getCode). */
  seaport: boolean;
  /** Whether this chain is part of FOREIGN_CHAINS (foreign Seaport trading registry). Robinhood is its own path. */
  foreignSeaportTrading: boolean;
  /** Membership / metadata / book sources, for chain-plugin.ts. */
  sources: {
    l1: Array<"hypersync" | "helius-das" | "unisat" | "own-scan">;
    l2: Array<"opensea-rest" | "magiceden" | "unisat" | "native-robinwood">;
    l3l4: Array<"onchain-multicall" | "ipfs" | "opensea-fallback" | "helius-das" | "unisat">;
  };
  /** Free-form art rules that render code consults (pixel inscriptions, etc.). */
  art: { pixelated?: boolean };
};

const EVM_L3L4 = ["onchain-multicall", "ipfs", "opensea-fallback"] as const;

export const CHAIN_MANIFESTS: readonly ChainManifest[] = [
  {
    chainSlug: "eth-mainnet", kind: "evm", displayName: "Ethereum", chainId: 1, brandColor: "#627EEA", glyph: "Ξ",
    nativeCurrencySymbol: "ETH", blockExplorerUrl: "https://etherscan.io", offerCurrencySymbol: "WETH",
    offerCurrencyAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", openSeaChain: "ethereum", alchemySubdomain: "eth-mainnet",
    coingeckoPlatform: "ethereum", hypersync: true, seaport: true, foreignSeaportTrading: true,
    sources: { l1: ["hypersync"], l2: ["opensea-rest"], l3l4: [...EVM_L3L4] }, art: {},
  },
  {
    chainSlug: "polygon-mainnet", kind: "evm", displayName: "Polygon", chainId: 137, brandColor: "#8247E5", glyph: "P",
    nativeCurrencySymbol: "POL", blockExplorerUrl: "https://polygonscan.com", offerCurrencySymbol: "WETH",
    offerCurrencyAddress: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", openSeaChain: "matic", alchemySubdomain: "polygon-mainnet",
    coingeckoPlatform: "polygon-pos", hypersync: true, seaport: true, foreignSeaportTrading: true,
    sources: { l1: ["hypersync"], l2: ["opensea-rest"], l3l4: [...EVM_L3L4] }, art: {},
  },
  {
    chainSlug: "arb-mainnet", kind: "evm", displayName: "Arbitrum", chainId: 42161, brandColor: "#28A0F0", glyph: "A",
    nativeCurrencySymbol: "ETH", blockExplorerUrl: "https://arbiscan.io", offerCurrencySymbol: "WETH",
    offerCurrencyAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", openSeaChain: "arbitrum", alchemySubdomain: "arb-mainnet",
    coingeckoPlatform: "arbitrum-one", hypersync: true, seaport: true, foreignSeaportTrading: true,
    sources: { l1: ["hypersync"], l2: ["opensea-rest"], l3l4: [...EVM_L3L4] }, art: {},
  },
  {
    chainSlug: "base-mainnet", kind: "evm", displayName: "Base", chainId: 8453, brandColor: "#0052FF", glyph: "B",
    nativeCurrencySymbol: "ETH", blockExplorerUrl: "https://basescan.org", offerCurrencySymbol: "WETH",
    offerCurrencyAddress: "0x4200000000000000000000000000000000000006", openSeaChain: "base", alchemySubdomain: "base-mainnet",
    coingeckoPlatform: "base", hypersync: true, seaport: true, foreignSeaportTrading: true,
    sources: { l1: ["hypersync"], l2: ["opensea-rest"], l3l4: [...EVM_L3L4] }, art: {},
  },
  {
    chainSlug: "opt-mainnet", kind: "evm", displayName: "Optimism", chainId: 10, brandColor: "#FF0420", glyph: "O",
    nativeCurrencySymbol: "ETH", blockExplorerUrl: "https://optimistic.etherscan.io", offerCurrencySymbol: "WETH",
    offerCurrencyAddress: "0x4200000000000000000000000000000000000006", openSeaChain: "optimism", alchemySubdomain: "opt-mainnet",
    coingeckoPlatform: "optimistic-ethereum", hypersync: true, seaport: true, foreignSeaportTrading: true,
    sources: { l1: ["hypersync"], l2: ["opensea-rest"], l3l4: [...EVM_L3L4] }, art: {},
  },
  {
    chainSlug: "bnb-mainnet", kind: "evm", displayName: "BNB Chain", chainId: 56, brandColor: "#F0B90B", glyph: "BNB",
    nativeCurrencySymbol: "BNB", blockExplorerUrl: "https://bscscan.com", offerCurrencySymbol: "WBNB",
    offerCurrencyAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", openSeaChain: "bsc", alchemySubdomain: "bnb-mainnet",
    coingeckoPlatform: "binance-smart-chain", hypersync: true, seaport: true, foreignSeaportTrading: true,
    sources: { l1: ["hypersync"], l2: ["opensea-rest"], l3l4: [...EVM_L3L4] }, art: {},
  },
  {
    chainSlug: "avax-mainnet", kind: "evm", displayName: "Avalanche", chainId: 43114, brandColor: "#E84142", glyph: "AVAX",
    nativeCurrencySymbol: "AVAX", blockExplorerUrl: "https://snowtrace.io", offerCurrencySymbol: "WAVAX",
    offerCurrencyAddress: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", openSeaChain: "avalanche", alchemySubdomain: "avax-mainnet",
    coingeckoPlatform: "avalanche", hypersync: true, seaport: true, foreignSeaportTrading: true,
    sources: { l1: ["hypersync"], l2: ["opensea-rest"], l3l4: [...EVM_L3L4] }, art: {},
  },
  {
    chainSlug: "zksync-mainnet", kind: "evm", displayName: "zkSync", chainId: 324, brandColor: "#8C8DFC", glyph: "ZK",
    nativeCurrencySymbol: "ETH", blockExplorerUrl: "https://explorer.zksync.io", offerCurrencySymbol: "WETH",
    offerCurrencyAddress: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91", openSeaChain: null, alchemySubdomain: "zksync-mainnet",
    coingeckoPlatform: null, hypersync: true, seaport: true, foreignSeaportTrading: true,
    sources: { l1: ["hypersync"], l2: [], l3l4: ["onchain-multicall", "ipfs"] }, art: {},
  },
  {
    chainSlug: "robinhood", kind: "custom-evm", displayName: "Robinhood Chain", chainId: 4663, brandColor: "#eec164", glyph: "RW",
    nativeCurrencySymbol: "ETH", blockExplorerUrl: "https://robinhoodchain.blockscout.com", offerCurrencySymbol: "WETH",
    offerCurrencyAddress: null, openSeaChain: "robinhood", alchemySubdomain: null, coingeckoPlatform: null,
    hypersync: true, seaport: true, foreignSeaportTrading: false,
    sources: { l1: ["own-scan", "hypersync"], l2: ["native-robinwood", "opensea-rest"], l3l4: [...EVM_L3L4] }, art: {},
  },
  {
    chainSlug: "solana-mainnet", kind: "solana", displayName: "Solana", chainId: null, brandColor: "#9945FF", glyph: "S",
    nativeCurrencySymbol: "SOL", blockExplorerUrl: "https://solscan.io", offerCurrencySymbol: "SOL", offerCurrencyAddress: null,
    openSeaChain: null, alchemySubdomain: null, coingeckoPlatform: "solana", hypersync: false, seaport: false, foreignSeaportTrading: false,
    sources: { l1: ["helius-das"], l2: ["magiceden"], l3l4: ["helius-das"] }, art: {},
  },
  {
    chainSlug: "bitcoin-mainnet", kind: "ordinals", displayName: "Bitcoin (Ordinals)", chainId: null, brandColor: "#F7931A", glyph: "₿",
    nativeCurrencySymbol: "BTC", blockExplorerUrl: "https://mempool.space", offerCurrencySymbol: "BTC", offerCurrencyAddress: null,
    openSeaChain: null, alchemySubdomain: null, coingeckoPlatform: "ordinals", hypersync: false, seaport: false, foreignSeaportTrading: false,
    sources: { l1: ["unisat"], l2: ["unisat"], l3l4: ["unisat"] }, art: { pixelated: true },
  },
];

const BY_SLUG = new Map(CHAIN_MANIFESTS.map((m) => [m.chainSlug, m]));

/** Bare-slug aliases kept so old links resolve (see foreign-chain-registry's history). */
const ALIASES: Record<string, string> = { solana: "solana-mainnet", bitcoin: "bitcoin-mainnet" };

export function chainManifest(chainSlug: string): ChainManifest | null {
  return BY_SLUG.get(chainSlug) ?? BY_SLUG.get(ALIASES[chainSlug] ?? "") ?? null;
}

export function evmManifests(): ChainManifest[] {
  return CHAIN_MANIFESTS.filter((m) => m.chainId != null);
}

export function manifestsWhere(pred: (m: ChainManifest) => boolean): ChainManifest[] {
  return CHAIN_MANIFESTS.filter(pred);
}

/** Derived maps -- registries import these instead of restating them. */
export function deriveEvmChainIds(): Record<string, number> {
  return Object.fromEntries(evmManifests().map((m) => [m.chainSlug, m.chainId as number]));
}

export function deriveAlchemySubdomains(): Record<string, string> {
  return Object.fromEntries(CHAIN_MANIFESTS.filter((m) => m.alchemySubdomain).map((m) => [m.chainSlug, m.alchemySubdomain as string]));
}

export function deriveCoingeckoPlatforms(): Record<string, string> {
  return Object.fromEntries(CHAIN_MANIFESTS.filter((m) => m.coingeckoPlatform).map((m) => [m.chainSlug, m.coingeckoPlatform as string]));
}

export function deriveOfferCurrencies(): Record<string, string> {
  return Object.fromEntries(CHAIN_MANIFESTS.filter((m) => m.offerCurrencyAddress).map((m) => [m.chainSlug, m.offerCurrencyAddress as string]));
}

export function deriveForeignChains(): Array<{ chainSlug: string; chainId: number; openSeaChain: string | null; nativeCurrencySymbol: string; blockExplorerUrl: string }> {
  return CHAIN_MANIFESTS.filter((m) => m.foreignSeaportTrading && m.chainId != null).map((m) => ({
    chainSlug: m.chainSlug,
    chainId: m.chainId as number,
    openSeaChain: m.openSeaChain,
    nativeCurrencySymbol: m.nativeCurrencySymbol,
    blockExplorerUrl: m.blockExplorerUrl ?? "",
  }));
}

/** Chains with an OpenSea orderbook AND foreign trading (mesh opensea-stats / opensea-membership lanes). */
export function openSeaEvmSlugs(): string[] {
  return CHAIN_MANIFESTS.filter((m) => m.foreignSeaportTrading && m.openSeaChain).map((m) => m.chainSlug);
}

/** Foreign EVM chains with HyperSync coverage (mesh hypersync-*, evm-metadata, seaport-fills lanes). */
export function hypersyncEvmSlugs(): string[] {
  return CHAIN_MANIFESTS.filter((m) => m.foreignSeaportTrading && m.hypersync).map((m) => m.chainSlug);
}

/** Chains with a CoinGecko NFT platform (mesh coingecko-nft lanes). */
export function coingeckoSlugs(): string[] {
  return CHAIN_MANIFESTS.filter((m) => m.coingeckoPlatform).map((m) => m.chainSlug);
}
