/**
 * Canonical marketplace/protocol registry.
 *
 * This is deliberately a coverage registry, not a marketing claim. A venue is
 * only `indexed` when its adapter writes normalized rows into the canonical
 * ledger. `planned` and `unavailable` remain visible gaps and MUST NOT be
 * converted into zero sales, zero listings, or complete-history claims.
 */
export type MarketFamily = "evm" | "solana" | "bitcoin";
export type MarketCoverage = "indexed" | "partial" | "planned" | "unavailable";
export type MarketCapability = "sales" | "transfers" | "listings" | "bids";

export type MarketVenue = {
  id: string;
  label: string;
  family: MarketFamily;
  protocol: string;
  versions: readonly string[];
  capabilities: readonly MarketCapability[];
  coverage: MarketCoverage;
  /** Empty means the adapter is intended to be chain-discovered. */
  chainSlugs: readonly string[];
  notes: string;
};

export const MARKET_VENUES = [
  { id: "marketplank", label: "Marketplank", family: "evm", protocol: "seaport", versions: ["1.6"], capabilities: ["sales", "listings", "bids"], coverage: "indexed", chainSlugs: [], notes: "First-party signed orders and on-chain fills." },
  { id: "opensea-seaport-1.6", label: "OpenSea / Seaport 1.6", family: "evm", protocol: "seaport", versions: ["1.6"], capabilities: ["sales", "transfers", "listings", "bids"], coverage: "partial", chainSlugs: [], notes: "Block-0 history is the HyperSync lane; RPC is an all-deployment live fallback. Current orders also come from venue APIs." },
  { id: "opensea-seaport-legacy", label: "OpenSea / legacy Seaport", family: "evm", protocol: "seaport", versions: ["1.1", "1.2", "1.3", "1.4", "1.5"], capabilities: ["sales", "transfers"], coverage: "partial", chainSlugs: [], notes: "Canonical 1.1-1.5 deployments use a block-0-to-head HyperSync lane plus an all-deployment live RPC fallback; partial until each deployed chain/version cell proves tip coverage." },
  { id: "opensea-wyvern", label: "OpenSea / Wyvern", family: "evm", protocol: "wyvern", versions: ["1", "2"], capabilities: ["sales"], coverage: "partial", chainSlugs: ["eth-mainnet"], notes: "Real v1 (0x7Be8...) + v2/bulk-cancellations (0x7f26...) OrdersMatched dual-cursor HyperSync scan is wired (plank_wyvern_fills). Partial, not indexed: OrdersMatched carries maker/taker/price but not NFT contract/token id, which only exist in atomicMatch_ calldata (not decoded here) -- fee-leg normalization also remains open." },
  { id: "cryptopunks-native", label: "CryptoPunks native market", family: "evm", protocol: "cryptopunks-native", versions: ["original"], capabilities: ["sales", "transfers", "listings", "bids"], coverage: "partial", chainSlugs: ["eth-mainnet"], notes: "Current punksOfferedForSale state is indexed; full event history and bid state are the remaining lanes." },
  { id: "blur", label: "Blur", family: "evm", protocol: "blur", versions: ["v1", "v2"], capabilities: ["sales"], coverage: "partial", chainSlugs: ["eth-mainnet"], notes: "BlurExchange OrdersMatched direct fills are indexed on eth-mainnet via a dual-cursor HyperSync lane (plank_blur_fills + shared plank_market_event_assets/payments legs), address 0x000000000000Ad05Ccc4F10045630fb830B95127 confirmed via Sourcify exact-match verification. Partial, not indexed: Blend pooled-bid/lending-financed purchases are a structurally different loan-origination event, not a simple fill, and are not normalized here -- see blur-fill-indexer.ts. Blast-mainnet Blur deployment not independently verified this pass, left out rather than guessed." },
  { id: "looksrare", label: "LooksRare", family: "evm", protocol: "looksrare", versions: ["v1", "v2"], capabilities: ["sales"], coverage: "partial", chainSlugs: ["eth-mainnet"], notes: "v1 TakerAsk/TakerBid fills are indexed on eth-mainnet via a dual-cursor HyperSync lane (plank_looksrare_fills + shared plank_market_event_assets/payments legs); v2 (multi-chain LooksRareProtocol, different event shape) remains planned/unverified." },
  { id: "x2y2", label: "X2Y2", family: "evm", protocol: "x2y2", versions: ["v1"], capabilities: ["sales"], coverage: "partial", chainSlugs: ["eth-mainnet"], notes: "EvInventory direct fills (COMPLETE_SELL_OFFER/COMPLETE_BUY_OFFER only) are indexed on eth-mainnet via a dual-cursor HyperSync lane (plank_x2y2_fills + shared plank_market_event_assets/payments legs), scanning the real live-traffic X2Y2 Exchange proxy 0x74312363e45DCaBA76c59ec49a7Aa8A65a67EeD3 (Sourcify exact-match verified, 901,846 real txs) using the real ABI from its X2Y2_r1 implementation 0x6D7812d41A08BC2a910B562d8B56411964A4eD88 (also Sourcify exact-match verified) -- live-smoke-tested with 5,069 real decoded fills found in its first 100k blocks. Partial, not indexed: NFT identity (nft_contract/token_id) is only decoded for the confirmed ERC721Delegate item.data shape; other delegateTypes and auction/bid/cancel/refund lifecycle events sharing the same EvInventory name are left out rather than guessed -- see x2y2-fill-indexer.ts." },
  {
    id: "foundation",
    label: "Foundation",
    family: "evm",
    protocol: "foundation",
    versions: ["v2"],
    capabilities: ["sales"],
    coverage: "partial",
    chainSlugs: ["eth-mainnet"],
    notes:
      "FNDNFTMarket 0xcDA72070E455bb31C7690a170224Ce43623d0B6f (eth-mainnet) -- Foundation's own official " +
      "repo https://github.com/f8n/fnd-protocol, addresses.js prod[1].nftMarket, cross-confirmed by " +
      "Etherscan's 'Foundation: Market' label at the identical address. BuyPriceAccepted, OfferAccepted, " +
      "and ReserveAuctionFinalized (contracts/mixins/nftMarket/*.sol, verbatim event signatures) are " +
      "indexed via a dual-cursor HyperSync lane (plank_foundation_fills + shared " +
      "plank_market_event_assets/payments legs). Partial, not indexed: ReserveAuctionFinalized does not " +
      "itself carry nftContract/tokenId, only auctionId -- resolved via a genesis-forward " +
      "ReserveAuctionCreated lookup table; a finalize log seen before its creation row (only possible in " +
      "the live-forward lane ahead of a completed genesis backfill) is written with nft_contract/token_id " +
      "left NULL rather than guessed. Older FNDNFTMarket v1/private-sale mechanics predating this proxy " +
      "were not independently re-verified this pass.",
  },
  {
    id: "rarible",
    label: "Rarible",
    family: "evm",
    protocol: "rarible",
    versions: ["exchange-v2"],
    capabilities: ["sales"],
    coverage: "planned",
    chainSlugs: ["eth-mainnet"],
    notes:
      "CONFIRMED BLOCKED 2026-08-23, NOT A GAP -- researched via Rarible's own real source, " +
      "https://github.com/rarible/protocol-contracts, projects/exchange-v2/contracts/ExchangeV2Core.sol. " +
      "Rarible's legacy standalone RaribleExchange (v1) is retired; today's real Rarible-originated " +
      "on-chain settlement is ExchangeV2 (mainnet 0x9757F2d2b135150BBeb65308D4a91804107cd8D6 per Rarible's " +
      "own docs.rarible.org/reference/contract-addresses), a genuinely distinct contract from Seaport -- " +
      "NOT a case of Rarible's UI merely wrapping Seaport, so this is real missing coverage, not double- " +
      "counting an already-indexed Seaport fill under a second label. However, directly fetched " +
      "ExchangeV2Core.sol and confirmed by exact line match that its only completed-trade event is " +
      "`event Match(bytes32 leftHash, bytes32 rightHash, uint newLeftFill, uint newRightFill);` -- two " +
      "order hashes and two fill amounts, with NO nftContract/tokenId/price/party fields at all. Real " +
      "asset/price/party data only exists inside the internal _doTransfers ERC721/ERC20/ETH Transfer legs " +
      "emitted by the token contracts themselves within the same tx, which would have to be correlated by " +
      "tx hash after the fact -- the same materially-different, non-log-self-contained data-access pattern " +
      "documented as the Sudoswap blocker above, not the single-log decode this app's HyperSync scanners " +
      "are built around. Left planned, not guessed.",
  },
  {
    id: "sudoswap",
    label: "Sudoswap",
    family: "evm",
    protocol: "sudoswap",
    versions: ["v1", "v2"],
    capabilities: ["sales", "listings", "bids"],
    coverage: "planned",
    chainSlugs: ["eth-mainnet"],
    notes:
      "CONFIRMED BLOCKED 2026-08-23, NOT A GAP -- researched via sudoswap's own real source, " +
      "https://github.com/sudoswap/lssvm, src/LSSVMPair.sol. LSSVMPairFactory (real mainnet address " +
      "0xb16c1342e617a5b6e4b631eb114483fdb289c0a4, Etherscan-confirmed) deploys minimal-proxy LSSVMPair " +
      "instances per collection. Directly fetched src/LSSVMPair.sol and confirmed by exact line match: " +
      "`event SwapNFTInPair();` and `event SwapNFTOutPair();` are REAL, VERIFIED, PARAMETERLESS -- no " +
      "tokenId, no ETH amount, no direction beyond which of the two fires. This is architecturally " +
      "different from every other venue this app indexes: those all decode a fill entirely from one " +
      "log's topics+data (the established HyperSync log-scan pattern this app uses everywhere else). A " +
      "Sudoswap swap has NO such self-contained log -- reconstructing pool/tokenId/ETH-amount/direction " +
      "requires correlating the parameterless event with sibling ERC721 Transfer logs AND the ETH value " +
      "moved in the same tx (trace_call or balance-delta, not log data) in the same transaction, which is " +
      "a materially different data-access pattern (full receipt+trace fetching per swap, not bulk log " +
      "scanning) than every other indexer in this app and was not built this pass rather than force a " +
      "guessed/partial normalization. Left planned, not guessed.",
  },
  { id: "magiceden-solana", label: "Magic Eden", family: "solana", protocol: "magiceden", versions: ["current"], capabilities: ["sales", "transfers", "listings", "bids"], coverage: "partial", chainSlugs: ["solana-mainnet"], notes: "Recent API activity exists; program-history and complete book ingestion remain incomplete." },
  { id: "tensor-solana", label: "Tensor", family: "solana", protocol: "tensor", versions: ["current"], capabilities: ["sales", "listings", "bids"], coverage: "planned", chainSlugs: ["solana-mainnet"], notes: "Program/account decoder and compressed-NFT support required." },
  { id: "metaplex-solana", label: "Metaplex programs", family: "solana", protocol: "metaplex", versions: ["auction-house", "bubblegum", "core"], capabilities: ["sales", "transfers"], coverage: "planned", chainSlugs: ["solana-mainnet"], notes: "Program-family provenance including compressed and Core assets." },
  { id: "unisat-bitcoin", label: "UniSat", family: "bitcoin", protocol: "ordinals-market", versions: ["current"], capabilities: ["listings"], coverage: "partial", chainSlugs: ["bitcoin-mainnet"], notes: "Membership/listing evidence exists; complete sale history is not yet indexed." },
  { id: "ord-core-bitcoin", label: "Bitcoin Core + ord", family: "bitcoin", protocol: "ord", versions: ["current"], capabilities: ["transfers"], coverage: "planned", chainSlugs: ["bitcoin-mainnet"], notes: "Canonical inscription, satpoint, parent/child, delegate, content, metadata, and transfer foundation. Requires a fully synced txindex Bitcoin Core node plus ord index; it does not define marketplace collections or off-chain books." },
  { id: "ordiscan-bitcoin", label: "Ordiscan", family: "bitcoin", protocol: "ordinals-indexer", versions: ["v1"], capabilities: ["transfers", "listings"], coverage: "partial", chainSlugs: ["bitcoin-mainnet"], notes: "Collection discovery and per-collection market snapshots are wired; low API allowance prevents treating it as the sole exhaustive inscription lane." },
  { id: "ordinalswallet-bitcoin", label: "Ordinals Wallet", family: "bitcoin", protocol: "ordinals-market", versions: ["current"], capabilities: ["listings"], coverage: "partial", chainSlugs: ["bitcoin-mainnet"], notes: "Keyless exact-slug membership/art catalog is wired. Complete book, offer, and historical execution ingestion are not proven." },
  { id: "bestinslot-bitcoin", label: "Best in Slot", family: "bitcoin", protocol: "ordinals-aggregator", versions: ["v3"], capabilities: ["sales", "transfers", "listings"], coverage: "planned", chainSlugs: ["bitcoin-mainnet"], notes: "Official API exposes collections, inscriptions, holders, activity, and venue-specific listing prices. Listings/sales/activity require Pro or Dedicated access and therefore cannot be represented as free coverage." },
  { id: "ordnet-bitcoin", label: "ORD.NET", family: "bitcoin", protocol: "ordinals-market", versions: ["v1"], capabilities: ["sales", "listings", "bids"], coverage: "partial", chainSlugs: ["bitcoin-mainnet"], notes: "Authenticated, cursor-exhaustive listings adapter is wired. Sales, membership, offers, and PSBT execution remain explicit capability gaps until their durable lanes are enabled. Authentication requires a wallet challenge and a payment address holding 0.01 BTC." },
  {
    id: "gamma-bitcoin",
    label: "Gamma Ordinals",
    family: "bitcoin",
    protocol: "ordinals-market",
    versions: ["historical", "current"],
    capabilities: ["sales", "listings"],
    coverage: "planned",
    chainSlugs: ["bitcoin-mainnet"],
    notes:
      "GAMMA'S ORDINALS API COULD NOT BE VERIFIED -- CONFIRMED BLOCKED 2026-08-23, NOT A GAP. " +
      "developers.gamma.app is Gamma's UNRELATED presentation-software product -- a different company/product entirely; " +
      "do not confuse it with the real Bitcoin Ordinals marketplace at gamma.io/ordinals. " +
      "Direct probes of every plausible real endpoint during this pass: https://api.gamma.io/ (and every path tried under it, " +
      "e.g. /collections/bitcoin-frogs, /v1/collections/bitcoin-frogs, /health) returned a uniform generic 503 'Service Temporarily " +
      "Unavailable' from an nginx-style origin (not Cloudflare's per-request 503), i.e. the subdomain resolves but has no live " +
      "backend behind it. https://gamma.io/api/v1/collections/bitcoin-frogs 301-redirects to https://stacks.gamma.io/api/v1/... " +
      "(the old Stacks-era app) which itself 404s -- a dead legacy route, not a live API. The live gamma.io/ordinals collection " +
      "pages (e.g. /ordinals/collections/bitcoin-frogs, HTTP 200) are a client-rendered SPA: fetched and downloaded the full HTML " +
      "plus all 44 JS chunks referenced from it and grepped every one for hostnames/'/api/' literals -- the only Gamma hosts found " +
      "anywhere in the shipped client code are blog.gamma.io, create.gamma.io, discord.gamma.io, info.gamma.io, support.gamma.io, " +
      "images.gamma.io (a Cloudflare image-resize CDN, not a data API), and the window.__GAMMA_ENV runtime config, which exposes " +
      "only ord_content_server_url/ord_api_server_url = https://ord-mainnet.gamma.io (a raw ord/inscription-content indexer, not a " +
      "marketplace listings/floor API) and stacks_blockchain_api_url. No marketplace listings, floor-price, or order-book endpoint " +
      "is referenced anywhere in the delivered client bundle, meaning collection/listing data is fetched from a private, " +
      "same-origin, non-public backend at request time -- there is no discoverable public REST/GraphQL contract to integrate " +
      "against. No public developer docs for the ordinals marketplace exist either (support.gamma.io covers creator/seller how-tos " +
      "only; there is no API reference). Conclusion: same outcome as OKX in unisat-ordinals-trade.ts -- a real, evidenced blocker, " +
      "not a search-effort gap. Gamma may still be real and buildable, but needs direct contact with Gamma dev support or a " +
      "rendered-browser network capture of an authenticated/partner session before any code is written against it -- never scrape " +
      "UI HTML into canonical evidence, and never guess at a private API's schema from memory.",
  },
  { id: "ordzaar-bitcoin", label: "Ordzaar", family: "bitcoin", protocol: "ordinals-market", versions: ["historical", "current"], capabilities: ["sales", "listings", "bids"], coverage: "planned", chainSlugs: ["bitcoin-mainnet"], notes: "Distinct PSBT marketplace lane. No verified public server API contract is currently wired; data must retain venue and order identity." },
  { id: "magiceden-bitcoin", label: "Magic Eden Ordinals (historical)", family: "bitcoin", protocol: "ordinals-market", versions: ["retired-2026-06-30"], capabilities: ["sales", "listings", "bids"], coverage: "unavailable", chainSlugs: ["bitcoin-mainnet"], notes: "Historical decoder target only. Magic Eden discontinued its Bitcoin marketplace and Bitcoin API on 2026-06-30; never use it as a live-book dependency." },
  { id: "okx-bitcoin", label: "OKX Ordinals", family: "bitcoin", protocol: "ordinals-market", versions: ["current"], capabilities: ["sales", "listings"], coverage: "planned", chainSlugs: ["bitcoin-mainnet"], notes: "External venue coverage; never inferred from a different marketplace." },
] as const satisfies readonly MarketVenue[];

export function venuesForChain(chainSlug: string): readonly MarketVenue[] {
  const family: MarketFamily = chainSlug.startsWith("solana") ? "solana" : chainSlug.startsWith("bitcoin") ? "bitcoin" : "evm";
  return MARKET_VENUES.filter((venue) => venue.family === family && (venue.chainSlugs.length === 0 || venue.chainSlugs.includes(chainSlug as never)));
}

export function isCompleteVenueCoverage(venues: readonly MarketVenue[]): boolean {
  return venues.length > 0 && venues.every((venue) => venue.coverage === "indexed");
}

const NATIVE_BOOK_COLLECTIONS = new Set([
  "eth-mainnet:0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb", // CryptoPunks
]);

/** True when generic order adapters cannot prove the collection's live book. */
export function hasUnindexedNativeBook(chainSlug: string, collectionKey: string): boolean {
  return NATIVE_BOOK_COLLECTIONS.has(`${chainSlug}:${collectionKey.toLowerCase()}`);
}
