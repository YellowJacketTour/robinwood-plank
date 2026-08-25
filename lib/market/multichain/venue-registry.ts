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
  { id: "blur", label: "Blur", family: "evm", protocol: "blur", versions: ["v1", "v2"], capabilities: ["sales"], coverage: "partial", chainSlugs: ["eth-mainnet"], notes: "BlurExchange OrdersMatched direct fills are indexed on eth-mainnet via a dual-cursor HyperSync lane (plank_blur_fills + shared plank_market_event_assets/payments legs), address 0x000000000000Ad05Ccc4F10045630fb830B95127 confirmed via Sourcify exact-match verification. Partial, not indexed: Blend pooled-bid/lending-financed purchases are a structurally different loan-origination event, not a simple fill, and are not normalized here -- see blur-fill-indexer.ts. Blast-mainnet Blur deployment not independently verified this pass, left out rather than guessed. LIVE LISTINGS checked 2026-08-24, real: Blur has never published a public listings/orders API -- third-party paid indexers only (Bitquery/SimpleHash/Alchemy). Never add a listings capability here without one. Also confirmed real 2026-08-24: Blur has zero Bitcoin Ordinals coverage (never added it, cited as a real factor in Magic Eden overtaking it on volume) -- not a source for the Bitcoin family, ever." },
  { id: "looksrare", label: "LooksRare", family: "evm", protocol: "looksrare", versions: ["v1", "v2"], capabilities: ["sales"], coverage: "partial", chainSlugs: ["eth-mainnet"], notes: "v1 TakerAsk/TakerBid fills are indexed on eth-mainnet via a dual-cursor HyperSync lane (plank_looksrare_fills + shared plank_market_event_assets/payments legs); v2 (multi-chain LooksRareProtocol, different event shape) remains planned/unverified. LIVE LISTINGS checked 2026-08-24, real: the exact v2 orders endpoint LooksRare's own current docs (looksrare.dev/reference/getorders) describe, https://api.looksrare.org/api/v2/orders, returned a genuine nginx 404 (not a WAF/bot block -- a real 'this route does not exist' response) on every parameter combination tried; looksrare.org itself returned 403. Could not get one real successful response to verify against, so no listings adapter was built -- do not build one against this endpoint without first getting a real 200 by hand." },
  { id: "x2y2", label: "X2Y2", family: "evm", protocol: "x2y2", versions: ["v1"], capabilities: ["sales"], coverage: "unavailable", chainSlugs: ["eth-mainnet"], notes: "EvInventory direct fills (COMPLETE_SELL_OFFER/COMPLETE_BUY_OFFER only) are indexed on eth-mainnet via a dual-cursor HyperSync lane (plank_x2y2_fills + shared plank_market_event_assets/payments legs), scanning the real live-traffic X2Y2 Exchange proxy 0x74312363e45DCaBA76c59ec49a7Aa8A65a67EeD3 (Sourcify exact-match verified, 901,846 real txs) using the real ABI from its X2Y2_r1 implementation 0x6D7812d41A08BC2a910B562d8B56411964A4eD88 (also Sourcify exact-match verified) -- live-smoke-tested with 5,069 real decoded fills found in its first 100k blocks. Partial, not indexed: NFT identity (nft_contract/token_id) is only decoded for the confirmed ERC721Delegate item.data shape; other delegateTypes and auction/bid/cancel/refund lifecycle events sharing the same EvInventory name are left out rather than guessed -- see x2y2-fill-indexer.ts. X2Y2 SHUT DOWN April 2025, confirmed live 2026-08-24 (api.x2y2.org returns a real HTTP 521, server down) -- historical fill indexing above remains a real, valid record of past trades; there is no live order book left anywhere to check. coverage flipped to unavailable for exactly the live-book question -- never use this as a live-listings dependency, same treatment as magiceden-bitcoin's retired entry above." },
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
    coverage: "partial",
    chainSlugs: ["eth-mainnet"],
    notes:
      "BUILT 2026-08-23 -- ExchangeV2 0x9757F2d2b135150BBeb65308D4a91804107cd8D6 (eth-mainnet) Match " +
      "events are indexed via a dual-cursor HyperSync lane (plank_rarible_fills + shared " +
      "plank_market_event_assets/payments legs). The Match log itself really is near-parameterless (`event " +
      "Match(bytes32 leftHash, bytes32 rightHash, uint newLeftFill, uint newRightFill)`, confirmed against " +
      "ExchangeV2Core.sol) -- real nftContract/tokenId/price/party data is recovered instead from the SAME " +
      "transaction's own matchOrders(...) calldata, fetched via HyperSync's transaction field selection in " +
      "the same bulk query (no per-tx RPC fallback), ABI-decoded using the real LibOrder.Order/LibAsset.Asset " +
      "tuple shapes and cross-checked against TransferExecutor.sol's real ERC721/ERC1155/ERC20 asset-data " +
      "encoding -- see rarible-fill-indexer.ts for the full citation. Partial, not indexed: (1) directPurchase " +
      "(a different ExchangeV2Core entry point with a flat LibDirectTransfer.Purchase calldata shape) also " +
      "emits Match but is not decoded, only matchOrders calls are; (2) a genuine partial fill against a " +
      "resting order-book order would report the order's calldata-declared value rather than the Match " +
      "event's own newLeftFill/newRightFill settled amount -- not cross-validated this pass, stated as a " +
      "known limitation rather than silently guessed; (3) the COLLECTION and CRYPTO_PUNKS asset classes " +
      "(LibAsset.sol) leave nft_contract/token_id NULL (undecoded_asset_class records which one) since their " +
      "real data encoding was not independently verified.",
  },
  {
    id: "sudoswap",
    label: "Sudoswap",
    family: "evm",
    protocol: "sudoswap",
    versions: ["v1", "v2"],
    capabilities: ["sales", "listings", "bids"],
    coverage: "partial",
    chainSlugs: ["eth-mainnet"],
    notes:
      "BUILT 2026-08-23 -- LSSVMPairFactory 0xb16c1342e617a5b6e4b631eb114483fdb289c0a4 (eth-mainnet) pool " +
      "swaps are indexed via a dual-cursor HyperSync lane (plank_sudoswap_fills + shared " +
      "plank_market_event_assets/payments legs), topic0-only filtered across all addresses (no single " +
      "'the exchange' contract exists -- every pool is its own minimal-proxy clone). " +
      "`event SwapNFTInPair();`/`event SwapNFTOutPair();` (src/LSSVMPair.sol) really are parameterless, " +
      "confirmed by exact line match -- real pool/tokenId/counterparty/price data is recovered instead by " +
      "correlating the Swap log with its accompanying ERC721/ERC20 Transfer log(s) in the SAME transaction, " +
      "via HyperSync's own JoinMode.JoinAll (documented client behavior: matched-log transactions' sibling " +
      "logs are returned in the same query), not a per-swap trace or receipt RPC call -- see " +
      "sudoswap-fill-indexer.ts for the full citation, including why calldata alone is insufficient " +
      "(swapTokenForAnyNFTs is ID-agnostic; it never states which tokenIds it bought). Partial, not " +
      "indexed: native-ETH-denominated pools leave currency_token/price_wei NULL -- the real amount paid " +
      "is only observable via internal/trace-level ETH transfer visibility (LSSVMPair refunds excess ETH " +
      "internally, an untracked transfer), out of scope for this app's log-only architecture; " +
      "ERC20-denominated pools DO get a real decoded price. Sudoswap v2 (different factory/pair contracts) " +
      "was not independently verified this pass and remains out of scope.",
  },
  { id: "magiceden-solana", label: "Magic Eden", family: "solana", protocol: "magiceden", versions: ["current"], capabilities: ["sales", "transfers", "listings", "bids"], coverage: "partial", chainSlugs: ["solana-mainnet"], notes: "Recent API activity exists; program-history and complete book ingestion remain incomplete." },
  {
    id: "tensor-solana",
    label: "Tensor",
    family: "solana",
    protocol: "tensor",
    versions: ["current"],
    capabilities: ["sales"],
    coverage: "partial",
    chainSlugs: ["solana-mainnet"],
    notes:
      "SETTLEMENT/ACTIVITY DATA ONLY, NO LIVE ORDER BOOK -- 2026-08-24: tensor-settlement-scan.ts reads real, " +
      "settled buy/takeBid instructions directly off Solana chain state against the real, live-verified Tensor " +
      "Marketplace program (TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp), decoded with that program's own " +
      "installed-package instruction discriminators -- no Tensor-hosted API involved. This is READ-ONLY " +
      "settlement/activity history (capabilities: [\"sales\"] only). It captures NO open listings and NO open " +
      "bids -- those remain fully gated behind Tensor's own key-required API (see the still-blocked API note " +
      "below, unchanged). Every fill this scanner writes and every API response that surfaces it carries " +
      "`source: \"onchain_settlement\"` so it is never confused with Tensor's own official book/stats. " +
      "DISCOVERY/STATS SIDE CONFIRMED BLOCKED 2026-08-24, NOT A GAP -- Tensor's real public GraphQL host " +
      "is api.mainnet.tensordev.io/graphql (found by direct DNS/HTTP probing; the historically-cited " +
      "api.tensor.so does not resolve at all -- NXDOMAIN). A live, unauthenticated GET and POST (including " +
      "a trivial `{__typename}` query) against it both returned a real HTTP 403 with body literally " +
      "`required x-tensor-api-key in header` (Express app behind Cloudflare, not a WAF/bot challenge -- " +
      "graphql.tensor.trade, a second candidate host, DID return a Cloudflare bot-challenge 403 instead, " +
      "confirming the tensordev.io host's plain 403 is the real app-level answer, not edge noise). Tensor's " +
      "own current docs (https://docs.tensor.trade/trade/api-and-sdk, fetched live 2026-08-24) confirm there " +
      "is no public/free self-serve key: the page's only instruction is 'Please fill out this form to get " +
      "access: https://airtable.com/apppFpk6Ul9yiI6sw/pagCBazYyAewboZnT/form' (that Airtable form URL was " +
      "itself confirmed live, real HTTP 200, not a dead link) -- i.e. manual, gated approval, not a tier " +
      "this app can obtain and use today. Per this repo's own rule (see looksrare-v2's entry above), no " +
      "adapter was written against this endpoint: a 403 requiring a key this app does not have is not a " +
      "verified 200 response to build a decoder against, and guessing the GraphQL schema from memory/old " +
      "docs would be exactly the fabrication this registry exists to prevent. The existing trading-side file " +
      "(tensor-solana-trade.ts) is unaffected and unrelated -- it builds unsigned transactions locally from " +
      "Tensor's own on-chain program IDL (@tensor-foundation/marketplace, @tensor-foundation/whitelist), " +
      "which needs no hosted API at all, so it was never blocked by this. Remains planned: apply for a real " +
      "Tensor API key via the Airtable form above, then verify a real 200 response with real fields before " +
      "writing a discovery/stats adapter; compressed-NFT (bubblegum) support is a separate, still-open " +
      "requirement noted here regardless of the API-key outcome.",
  },
  { id: "metaplex-solana", label: "Metaplex programs", family: "solana", protocol: "metaplex", versions: ["auction-house", "bubblegum", "core"], capabilities: ["sales", "transfers"], coverage: "planned", chainSlugs: ["solana-mainnet"], notes: "Program-family provenance including compressed and Core assets." },
  { id: "unisat-bitcoin", label: "UniSat", family: "bitcoin", protocol: "ordinals-market", versions: ["current"], capabilities: ["listings"], coverage: "partial", chainSlugs: ["bitcoin-mainnet"], notes: "Membership/listing evidence exists; complete sale history is not yet indexed." },
  { id: "ord-core-bitcoin", label: "Bitcoin Core + ord", family: "bitcoin", protocol: "ord", versions: ["current"], capabilities: ["transfers"], coverage: "planned", chainSlugs: ["bitcoin-mainnet"], notes: "Canonical inscription, satpoint, parent/child, delegate, content, metadata, and transfer foundation. Requires a fully synced txindex Bitcoin Core node plus ord index; it does not define marketplace collections or off-chain books." },
  { id: "ordiscan-bitcoin", label: "Ordiscan", family: "bitcoin", protocol: "ordinals-indexer", versions: ["v1"], capabilities: ["transfers", "listings"], coverage: "partial", chainSlugs: ["bitcoin-mainnet"], notes: "Collection discovery and per-collection market snapshots are wired; low API allowance prevents treating it as the sole exhaustive inscription lane." },
  { id: "ordinalswallet-bitcoin", label: "Ordinals Wallet", family: "bitcoin", protocol: "ordinals-market", versions: ["current"], capabilities: ["listings"], coverage: "partial", chainSlugs: ["bitcoin-mainnet"], notes: "Keyless exact-slug membership/art catalog is wired. Complete book, offer, and historical execution ingestion are not proven." },
  {
    id: "bestinslot-bitcoin",
    label: "Best in Slot",
    family: "bitcoin",
    protocol: "ordinals-aggregator",
    versions: ["v3"],
    capabilities: ["sales", "transfers", "listings"],
    coverage: "planned",
    chainSlugs: ["bitcoin-mainnet"],
    notes:
      "RE-VERIFIED 2026-08-24 -- STATUS WORSENED, NOT JUST STILL PRO-GATED: the Pro/Dedicated-tier gating " +
      "this note previously described no longer applies because the entire hosted API has been retired. " +
      "https://docs.bestinslot.xyz/api-reference/overview (real Mintlify docs, fetched live) states verbatim: " +
      "\"This API has been retired. The hosted endpoints at api.bestinslot.xyz are no longer operated, and new " +
      "API keys are not being issued,\" and directs integrators to \"Run OPI (Open Protocol Indexer) instead " +
      "-- our open-source, self-hosted indexer for BRC-20, Bitmap and SNS, with a REST API per module.\" " +
      "Confirmed by direct request: https://api.bestinslot.xyz/v3/collection/info?slug=bitcoin-frogs returned " +
      "a real HTTP 301 to https://carrier.fleets.eu/... -- the api.bestinslot.xyz hostname has been repointed " +
      "away from Best in Slot entirely, to an unrelated third-party 'Fleet Portal' logistics product (HTTP 200 " +
      "confirmed at that destination, a real live site, just not Best in Slot's). There is therefore no live " +
      "hosted endpoint left to call at any tier, free or paid -- collections/inscriptions/holders are not " +
      "reachable either. OPI is a self-hosted indexer (you run your own Postgres+indexer against your own " +
      "Bitcoin node), not a free hosted API this app could call -- out of scope for a keyless/low-friction " +
      "adapter of this repo's existing pattern. Remains planned, now for a stronger reason than before.",
  },
  {
    id: "ordnet-bitcoin",
    label: "ORD.NET",
    family: "bitcoin",
    protocol: "ordinals-market",
    versions: ["v1"],
    capabilities: ["sales", "listings", "bids"],
    coverage: "partial",
    chainSlugs: ["bitcoin-mainnet"],
    notes:
      "Authenticated, cursor-exhaustive listings adapter is wired (GET /listings). RE-VERIFIED 2026-08-24, " +
      "CONFIRMED BLOCKED, NOT A GAP: sales, membership, offers, and PSBT execution cannot be closed without " +
      "a real, funded mainnet wallet -- checked developers.ord.net's actual OpenAPI 3.1 contract " +
      "(https://developers.ord.net/openapi.json) plus its llms.txt summary and reference/authentication page, " +
      "then confirmed by hand with direct unauthenticated probes against the live API " +
      "(https://ord.net/api/v1): GET /sales and GET /collection-stats/floors -- the two candidate read-only " +
      "endpoints that in principle don't need a live trading session -- both returned a real HTTP 401 " +
      "{\"error\":\"Bearer session token required\"}, identical to every other endpoint. The OpenAPI spec's " +
      "global `security: [{bearerAuth: []}]` confirms this is deliberate and API-wide, not a per-endpoint " +
      "oversight: only POST /auth/challenge and POST /auth/verify are unauthenticated (security: []), and " +
      "per developers.ord.net/reference/authentication/, /auth/verify only issues a bearer token when the " +
      "verified payment address holds 0.01 BTC confirmed (403 otherwise, 503 if the funding check is " +
      "temporarily unavailable); tokens then last 1 hour. So sales history (GET /sales, real and documented -- " +
      "cursor-paginated, saleType internal/external, collectionSlug filter) and offers (per-inscription " +
      "GET /inscriptions/{id}/offers, GET /inscriptions/{id}/offers/history, GET /me/offers, and the full " +
      "buyer/seller/counter-offer PSBT lifecycle under /collection/:slug/offers/* and " +
      "/inscriptions/:id/offers/*) are real, fully documented, already-existing API capabilities -- the gap is " +
      "not a missing/undocumented endpoint, it is that ORD.NET has no keyless or low-balance read lane at all. " +
      "PSBT execution (listing/purchase/offer preflight+submit) additionally requires a wallet able to produce " +
      "real BIP-322 signatures and sign real PSBTs, i.e. genuine live BTC custody, not just an authenticated " +
      "session. Picking this up requires a human operator wallet holding >=0.01 BTC confirmed at its payment " +
      "address (see the auth flow -- POST /auth/challenge then POST /auth/verify with a BIP-322 simple " +
      "signature) -- this cannot be provisioned or worked around from here.",
  },
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
  {
    id: "ordzaar-bitcoin",
    label: "Ordzaar",
    family: "bitcoin",
    protocol: "ordinals-market",
    versions: ["historical", "current"],
    capabilities: ["sales", "listings", "bids"],
    coverage: "planned",
    chainSlugs: ["bitcoin-mainnet"],
    notes:
      "RE-VERIFIED 2026-08-24, STILL BLOCKED: ordzaar.com resolves (HTTP 200, real live site) and describes " +
      "itself as \"The next-generation Bitcoin Ordinals Launchpad\" -- mint/launchpad focused, not the PSBT " +
      "order-book marketplace this entry's capabilities imply. Every plausible API/docs subdomain tried " +
      "(api.ordzaar.com, docs.ordzaar.com, app.ordzaar.com) failed to resolve/connect at all (curl exit 35 / " +
      "connection failure, not even a TLS handshake -- these hosts do not exist). No links to API docs or " +
      "developer resources appear anywhere on the live ordzaar.com page. GitHub org github.com/ordzaar (9 " +
      "public repos checked) has ordit-sdk (a client-side wallet/PSBT-construction SDK, not a server order-" +
      "book API), ord-connect (a React wallet-connect kit), and odinswap-api-docs (empty/placeholder repo, no " +
      "README on main), none of which document a public marketplace listings/sales REST contract. Conclusion " +
      "unchanged from the prior pass: no verified public server API contract exists for Ordzaar's marketplace " +
      "side. Data must retain venue and order identity if this is ever wired via a private/partner API.",
  },
  // Magic Eden's Bitcoin/Ordinals marketplace (retired 2026-06-30) was
  // removed outright 2026-08-25 rather than kept as an "unavailable" entry
  // -- confirmed zero references anywhere else in the codebase (no adapter,
  // no sync path, nothing reads this id), so keeping it around was pure
  // landmine risk for a future venue-iteration refactor that globs by
  // family/chainSlug without checking the coverage flag. If Magic Eden ever
  // relaunches a Bitcoin marketplace, re-add it fresh against real,
  // current API evidence rather than resurrecting this entry.
  {
    id: "okx-bitcoin",
    label: "OKX Ordinals",
    family: "bitcoin",
    protocol: "ordinals-market",
    versions: ["current"],
    capabilities: ["listings"],
    coverage: "planned",
    chainSlugs: ["bitcoin-mainnet"],
    notes:
      "Adapter code (okx-ordinals.ts) and wiring into the listings route are BUILT and already merged on dev, " +
      "key-gated -- returns [] honestly and reports 'credential-missing' in bookCoverage.sources.okx until real " +
      "credentials exist, matching the UniSat/Satflow/ORD.NET pattern. LIVE-VERIFIED 2026-08-24 (direct curl, no " +
      "key, this pass): GET https://web3.okx.com/api/v5/mktplace/nft/ordinals/collections -> real HTTP 401 " +
      "{\"msg\":\"Request header OK-ACCESS-KEY AND OK-ACCESS-TOKEN can not all empty \",\"code\":\"50116\"} -- " +
      "confirms the documented v5 endpoint is real and live (Cloudflare-fronted web3.okx.com, not a dead/404 " +
      "route) and that there is NO public/keyless tier: auth is checked before any business logic. Also probed " +
      "https://web3.okx.com/priapi/v1/nft/ordinals/collections (OKX's undocumented internal frontend API) -- " +
      "real HTTP 200 but a genuinely empty body for every param combination tried; same discipline as the Gamma " +
      "entry above, an undocumented private backend is not used as a keyless substitute. No OKX_API_KEY/" +
      "OKX_API_SECRET/OKX_API_PASSPHRASE exists in .env.local or .env.inmotion.example as of this pass (owner " +
      "reported an API application in progress, not yet issued) -- coverage stays planned, not partial, until a " +
      "real key lets verifyOkxCredentials() (see okx-ordinals.ts) confirm the actual response field names " +
      "against live data; the parsing logic's defensive field-name fallbacks are unit-tested but not yet " +
      "cross-checked against a real 200 body. capabilities is listings-only (not sales) -- no sale/fill history " +
      "endpoint has been found or verified in OKX's docs, only collection stats + active listings.",
  },
] as const satisfies readonly MarketVenue[];

export function venuesForChain(chainSlug: string): readonly MarketVenue[] {
  const family: MarketFamily = chainSlug.startsWith("solana") ? "solana" : chainSlug.startsWith("bitcoin") ? "bitcoin" : "evm";
  return MARKET_VENUES.filter((venue) => venue.family === family && (venue.chainSlugs.length === 0 || venue.chainSlugs.includes(chainSlug as never)));
}

/**
 * Single source of truth for how a coverage level reads to a viewer --
 * label + color. Originally inline in
 * app/market/multichain/known-limitations/page.tsx; pulled up here so the
 * inline per-row/per-collection "source chip" (DataSourceChip.tsx, see
 * Issue 4 of docs/marketplank/GROK-FINDINGS-biggest-issues-unified-
 * vision-2026-08-25.md) uses the EXACT same colors/labels as that page
 * instead of a second, driftable copy.
 */
export const COVERAGE_LABEL: Record<MarketCoverage, string> = {
  indexed: "Indexed",
  partial: "Partial",
  planned: "Planned — not built yet",
  unavailable: "Unavailable",
};

export const COVERAGE_ORDER: Record<MarketCoverage, number> = {
  indexed: 0,
  partial: 1,
  planned: 2,
  unavailable: 3,
};

export const COVERAGE_STYLE: Record<MarketCoverage, string> = {
  indexed: "border-emerald-500/50 bg-emerald-500/10 text-emerald-300",
  partial: "border-amber-500/50 bg-amber-500/10 text-amber-300",
  planned: "border-line-strong bg-panel text-foreground/60",
  unavailable: "border-rose-500/40 bg-rose-500/10 text-rose-300",
};

/** Short, non-alarming label for a partial/planned/unavailable venue's inline chip -- distinct from COVERAGE_LABEL's fuller known-limitations-page copy, which reads fine in a table but is too long for a dense row/chip. */
export const COVERAGE_SHORT_LABEL: Record<MarketCoverage, string> = {
  indexed: "live",
  partial: "partial book",
  planned: "not yet built",
  unavailable: "unavailable",
};

export function venueById(id: string): MarketVenue | null {
  return MARKET_VENUES.find((v) => v.id === id) ?? null;
}

/**
 * The single venue whose coverage best describes what a viewer is actually
 * looking at for one collection's displayed floor/listed numbers --
 * resolution order: (1) an exact venue id match (adapter or
 * floorPriceMarketplace, when the collection row/route already knows which
 * venue produced its numbers), (2) for a chain with exactly one candidate
 * venue, that venue, (3) otherwise the WORST (least-complete) coverage
 * among the chain's real candidate venues -- worst-case, not best-case, is
 * the honest default when this app can't yet name the single exact venue
 * behind a number, since a viewer would rather be warned about the weakest
 * source in the mix than reassured by the strongest. Returns null only when
 * no venue at all is registered for the chain (nothing to report).
 */
export function primaryVenueForCollection(
  chainSlug: string,
  candidateId?: string | null
): MarketVenue | null {
  if (candidateId) {
    const exact = venueById(candidateId);
    if (exact) return exact;
  }
  const venues = venuesForChain(chainSlug);
  if (venues.length === 0) return null;
  if (venues.length === 1) return venues[0];
  return venues.slice().sort((a, b) => COVERAGE_ORDER[b.coverage] - COVERAGE_ORDER[a.coverage])[0];
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
