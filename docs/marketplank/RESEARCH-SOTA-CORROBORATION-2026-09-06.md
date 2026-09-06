# RESEARCH: corroborating the audit against the field (2026-09-06)

Owner directive: "take everything you believe to be the case and the solution and corroborate against rigorous web
search of all discussions and forums and documentation and academia... you must be willing to invent impossible
solutions to achieve outsized successes."

Three Fable-5.1 research lenses with live web access (each cites >=15 sources inline). Reports are reproduced
verbatim below; the CORRECTIONS section at the top is the distilled list of things the audit or the program got
wrong, each with the action taken or queued.

## CORRECTIONS THE RESEARCH FORCED

1. Magic Eden's Bitcoin API shut down 2026-03-27 and its EVM marketplace is gone; only Solana REST remains, with a
   stated sunset risk. Every audit row citing "Magic Eden Ordinals" or ME EVM aggregation is stale. Action: Bitcoin
   sources are OKX aggregator + UniSat + BestInSlot + on-chain settlement; Solana keeps ME REST for hydration only.
2. Magic Eden has no WebSocket; Tensor does (`wss://api.mainnet.tensordev.io/ws`). Action: Solana push =
   Helius webhooks (NFT_SALE/NFT_LISTING/NFT_BID) + Tensor WS.
3. OpenSea's documented stream host is `wss://stream-api.opensea.io/socket/websocket?token=KEY&vsn=2.0.0`;
   `@opensea/stream-js` is archived into `@opensea/sdk/stream`. Delivery is best-effort, unordered, no replay;
   backfill is REST `/events` + chain logs. Action: switch host, order by `event_timestamp`, keep the chain as truth.
4. OpenSea does not list zkSync or BNB. Action: those chains can never get OpenSea listings; mark `statsCapable`
   sources honestly (audit E6).
5. "Listings as only per-collection floor state" is REFUTED by how Reservoir/Ponder store books: per-token best ask
   and top-N bids as state, invalidated by chain events (Transfer/Approval/OrderCancelled/CounterIncremented).
   Action: program item M3 (order-state engine) replaces the floor-only fold as the target.
6. USD at time of sale should use an hourly rate (Allium/Dune convention), not daily. Action: B6 uses hourly closes.
7. Phoenix half-open sockets: track the pending heartbeat ref, tear the socket down on a missed reply (phoenix PR
   4921). Action: the 90 s silence watchdog shipped; pending-ref check queued.
8. Priority lanes without aging starve (Oban DynamicPrioritizer). Action: deadline scheduling
   `interval = k / sqrt(views * events)` (Kolobov et al. 2019, Cho and Garcia-Molina 2003) replaces static priority
   arithmetic as the program target; `deferDataJob` shipped as the primitive.
9. Cooperative cancellation is mandatory: an `AbortSignal` threaded through lanes; a timed-out lane that keeps a pool
   connection is the biggest throughput killer (audit A8, still open).
10. Magic Eden Solana v2 REST `price` is decimal SOL (the SDK converts lamports). Action: D-batch converts at the
    adapter boundary and asserts `price*1e9 == listing.lamports`.
11. Bitcoin PSBT: buyer must parse and assert inscription output, seller output, fee band, no inscribed inputs,
    livenet, then sign with `autoFinalized:false` (msigner pattern). Action: D6.
12. Cheapest credible always-on worker is a Hetzner CX22 (about EUR 3.79/month) beside the existing database, not
    the USD 20-40 the program quoted. Action: program section 4 updated.

## MOVES ADOPTED INTO THE PROGRAM (from the INVENT sections)

- M1 Seaport-only source of truth chain-wide (topics, not collections), stream as cache-warmer.
- M2 Import the traded catalog nightly from Dune/Allium instead of transfer-threshold discovery.
- M3 Order-state engine invalidated by chain events.
- M4 Content-addressed public metadata cache (R2, zero egress).
- M5 Self-hosted SQD Portal + bitcoind/ord as the never-shut-off layer.
- S1 CX22 sidecar worker with local PgBouncer; S2 deadline scheduler; S3 edge coalescer on Workers + Hyperdrive;
  S4 browser-assisted hydration with signed receipts and sampled verification; S5 deterministic replay from BigQuery
  public datasets as golden tests.

# LENS R1 -- indexing and streaming SOTA

## Headline corrections (things the program doc gets wrong or misses)

1. **Magic Eden Bitcoin API is dead and its EVM marketplace is gone.** ME's own help center: the Bitcoin API and all related backend services were fully shut down after 2026-03-27 with no migration tooling; the Solana API "remains operational ... evaluating" (help.magiceden.io/en/articles/13885533). The Block (2026-08-31): "Earlier this year, Magic Eden shut its Bitcoin and EVM marketplaces to refocus on Solana". Audit rows citing "Magic Eden Ordinals" and ME EVM aggregation are stale; ME Solana is a single point of failure with a stated sunset risk.
2. **Magic Eden has no WebSocket.** Its full doc index (docs.magiceden.io/llms.txt) lists zero WebSocket/stream/webhook pages. Only Tensor has one.
3. **OpenSea now trades Solana** (launched week of 2026-08-31) -- the OpenSea stream may become a Solana push source; not yet documented.
4. **Hiro Ordinals API deprecated 2026-03-09 -> Xverse** (docs.hiro.so/en/apis/ordinals-api, docs.xverse.app/api).
5. **`@opensea/stream-js` archived 2026-08-14**, moved into `@opensea/sdk` (`import "@opensea/sdk/stream"`, no Phoenix dependency).

## (1) OpenSea Stream API -- CORROBORATED as best EVM push source, with hard limits

- Wildcard `*` for the collectionSlug is documented (docs.opensea.io/docs/stream-real-time-events). Events (10): item_listed, item_sold, item_transferred, item_metadata_updated, item_received_bid, item_cancelled, collection_offer, trait_offer, order_invalidate, order_revalidate.
- Guarantees: **none**. "Lost messages during disconnects are not re-sent (best-effort delivery)"; "events can arrive out of order... Use event_timestamp for ordering". Streaming does not count toward API rate limits. Endpoint `wss://stream-api.opensea.io/socket/websocket?token=<KEY>&vsn=2.0.0`; mainnet only.
- Chains: the stream docs do not enumerate; OpenSea supports Ethereum, Polygon, Arbitrum, Optimism, Avalanche, Base, Zora, Blast, Sei, B3, Berachain, ApeChain, Abstract, Ronin, HyperEVM, Monad, Robinhood Chain, MegaETH, Solana, etc. (support.opensea.io/en/articles/8867082). **zkSync and BNB are not in OpenSea's list** -> the stream can never cover those two.
- Replay/backfill: none. Backfill is REST v2 `/events` plus on-chain Seaport `OrderFulfilled`/`OrdersMatched` logs. Treat the stream as a latency accelerator over a chain-derived source of truth.

## (2) Bulk EVM logs: HyperSync vs Goldsky vs Substreams vs Alchemy vs QuickNode vs SQD

| Source | Coverage 2026 | Cost (published) | Real-time | Notes |
|---|---|---|---|---|
| Envio HyperSync | 79-85+ EVM chains + Fuel + Solana (envio.dev/chains) | API token mandatory since 2025-11-03; "credits" = bandwidth+disk reads, formula unpublished | stream() transitions backfill->live | the repo's 1.9x stream-vs-paginate claim is plausible but unverifiable externally |
| Goldsky Mirror/Turbo | "150+ chains" incl. Solana, Bitcoin | Turbo pipelines $0.10/worker-hr (~$73/mo always-on), first 1M events free then $1/100k; hosted PG $0.16/hr + $1.50/GB; $100 free credit (goldsky.com/pricing) | yes, to Postgres/ClickHouse/Kafka | cheapest managed "logs -> your Postgres"; event-write pricing punishes Transfer firehose |
| The Graph Substreams | EVM + Solana; Solana full blocks ~500 GB/day, >60% vote txs filterable | bytes-read billing | yes | high engineering cost (Rust modules) |
| Alchemy | NFT API "30+ chains"; `getNFTSales` marketplaces = seaport, wyvern, looksrare, x2y2, blur, cryptopunks; **NFT Activity webhook only Ethereum/Arbitrum/Optimism/Polygon**; Address Activity webhook 30+ EVM + Solana beta | CU-based | webhooks | Reservoir's named migration partner; no Base NFT-activity webhook |
| QuickNode Streams | "60+ chains" incl. Solana, Bitcoin | consumption-billed | yes; documented reorg guarantees; webhook/S3/PG/Kafka | only vendor documenting reorg guarantees + Bitcoin in one product |
| SQD Portal | 140-225+ networks: EVM, Solana, **Bitcoin**, Substrate (sqd.dev/portal) | free dev tier; paid Portals; self-hostable | Solana real-time first; EVM rolling out | decentralized + self-host = no vendor-cutoff risk |

Verdict: HyperSync is reasonable but **single-vendor**; SQD or Goldsky as the second leg is cheap insurance. No vendor covers zkSync + BNB + Avalanche listings at the marketplace layer -- only chain logs.

## (3) Solana: Helius DAS+webhooks vs Magic Eden vs Tensor -- PARTIALLY REFUTED

- Helius DAS "does not return marketplace listings" (corroborates audit lens 1 #7). Webhooks: NFT_SALE / NFT_LISTING / NFT_BID; 1 credit per delivered event; auto-disabled at >=95% failure over 7d. Plans: Free $0/1M credits, Dev $49/10M, Business $499/100M, Pro $999/200M; DAS 2/10/50/100 rps by tier.
- Tensor: real WebSocket `wss://api.mainnet.tensordev.io/ws`, header `x-tensor-api-key`; subscriptions `newTransaction`, `tcompBidUpdateAll`, `tcompBidUpdate`, `ammOrderUpdateAll`, `ammOrderUpdate`. REST has listings, single/collection/trait bids, OHLC.
- Magic Eden: REST only, rate-limited, some endpoints key-gated; free tier ~30 QPM; API "under evaluation".
- ME's own indexer: Geyser -> Kafka -> Redis/Aurora, ~300 tx/s at peak, reflected on site within seconds, 4000 qps (eng.magiceden.dev).
- Verdict: correct stack = **Helius webhooks (NFT_SALE/NFT_LISTING/NFT_BID for ME+Tensor programs) + Tensor WS for bids/AMM + own decode of M2/M3/TCOMP accounts**; ME REST as hydration only.

## (4) Bitcoin ordinals -- no push anywhere; source set has churned

- Hiro deprecated -> Xverse API (inscriptions, UTXOs, rare sats; no listings). ME Bitcoin API shut 2026-03-27; ME told users to migrate to Xverse, OrdinalsBot, Gamma.
- Live sources: UniSat Open API (collection-marketplace endpoints, up to 500 calls/s enterprise); OKX Onchain OS Ordinals marketplace API (collections, listings, activities; aggregates listings from different Bitcoin NFT marketplaces); BestInSlot aggregates floor/listed/volume across OrdSwap, ME, Ordinals Wallet, Gamma, UniSat, OKX; Ordiscan (collection inscriptions, traits). OKX WS is market-price only.
- Push: none documented. The only "push" is Bitcoin itself: every ordinals sale is a PSBT-settled tx moving the inscription sat -- mempool/ZMQ + ord index gives sales before any marketplace API; listings are off-chain PSBTs and must be polled.

## (5) Cross-venue dedup, bundles, ERC-20 pricing, USD-at-sale -- how the pros did it

- Reservoir sales record: `txHash`, `logIndex`, `batchIndex` (dedup key), `orderSource` vs `fillSource`, `orderSide`, `price.currency{contract,symbol,decimals}`, `price.amount{raw,decimal,usd,native}`, `netAmount`, fee bps, `washTradingScore`, `isDeleted` (backfill deletes sales no longer relevant). USD stored at fill time. Bundles: one row per item with batchIndex; price per item = bundle price / items unless per-item consideration.
- Magic Eden EVM aggregation leveraged Reservoir (now sunset). Blur: native + indexed OpenSea/Rarible listings, one ranked view, cheapest wins.
- Public datasets: Allium `crosschain.nfts.trades` has `usd_price` = hourly exchange rate, `trade_type` SINGLE|BUNDLE, `marketplace`, `protocol`, `aggregator_name`, fees; chains incl. ethereum, base, arbitrum, polygon, zora, apechain, b3, berachain, solana, bitcoin, sui. Dune `nft.trades`: `amount_usd`, 12 chains incl. **BNB, zkSync**, Arbitrum, Optimism, Solana.
- Verdict: audit L6 #7/#8 fixes match the industry pattern; add `order_source`/`fill_source`, `batch_index`, `is_deleted`/reverted semantics; use **hourly** not daily price for USD.

## (6) "Selective materialization" -- PARTIALLY REFUTED

Nobody stores the raw firehose, true. But Reservoir stored **every order** (asks/bids with validity state) and derived caches: token `floor_ask` and collection `top_bid` events with causes "new orders, expiries, sales, cancellations, balance changes, approval changes, revalidations, repricing". The Ponder community pattern is identical: asks table + ordered floor index. So: sales as rows = yes; listings as *only* per-collection floor state = **no** (you lose the buy button, the second-cheapest, cancellation replay); bids as *only* top-of-book = no. Correct minimum: per-token best ask + per-collection top N bids as state, invalidated by transfer/approval/expiry events; full order history optional.

## Five outsized moves (small team, months)

**M1. Seaport-only source of truth + OpenSea stream as cache-warmer.** ~95% of EVM aggregate sales on the 8 EVM chains settle through Seaport `OrderFulfilled`/`OrdersMatched`, Blur, or a handful of others. Index those log topics chain-wide (not per collection) from HyperSync/SQD; derive sales, bundles (`batchIndex`), currency (consideration `itemType`/`token`), per-item share. Stream events only pre-populate rows with `finality='observed'`. Cost ~$100-300/mo across 8 chains. Acceptance: for a random 24h window, sales count and USD volume per collection within 2% of Dune `nft.trades` for Ethereum, Base, Arbitrum, Polygon, BNB, zkSync.

**M2. Stop discovering; import the catalog.** Dune/Allium already have every collection with >=1 trade across 12 chains with names and marketplaces. One nightly query replaces the broken transfer-threshold forward scan. Discovery of never-traded contracts is worthless to a marketplace. Cost << $100/mo. Acceptance: catalog contains >=99% of collections with any sale in the last 30 days on all six EVM chains covered by Dune; Arbitrum tracked set shrinks from 1,567 shells to traded collections only.

**M3. Order-state engine driven by chain invalidation, not venue polling.** Store every observed ask/bid as an order row; invalidate by the chain: Transfer/Approval/`OrderCancelled`/`CounterIncremented` logs (EVM), account-close/Helius NFT_SALE (Solana), inscription UTXO spent (Bitcoin). Acceptance: fulfilling any displayed "cheapest" listing fails <1% for staleness over a 1,000-order sample; floor matches OpenSea's within one order for 95% of top-500 collections.

**M4. Content-addressed metadata cache shared with the ecosystem.** Key by (chain, contract, tokenId, tokenURI hash); resolve IPFS CIDs once; expose publicly (R2/S3 + CID). Cost: Cloudflare R2 ~$15/TB/mo, zero egress. Acceptance: p95 metadata resolution <200 ms for the top-2,000 collections per chain; >=95% of tracked tokens have name+image within 24h of first observation.

**M5. Self-hosted SQD Portal + Bitcoin node with ZMQ as the "we never get shut off" layer.** Reservoir, ME Bitcoin/EVM, Hiro, and OpenSea's stream-js all died or moved within 12 months. Run one Portal + one `bitcoind` + `ord`; keep HyperSync/Helius as accelerators, not dependencies. Cost: one 16-core/2TB NVMe box (~$150-250/mo). Acceptance: kill every third-party API key for 1 hour in staging; sales/transfers on all 10 chains keep landing with lag <2 blocks (EVM), <5 slots (Solana), <1 block (Bitcoin).

Sources: docs.opensea.io/docs/stream-real-time-events; github.com/ProjectOpenSea/stream-js; support.opensea.io/en/articles/8867082; theblock.co 2026-08-31 opensea-solana; envio.dev/chains, /pricing, docs.envio.dev HyperSync api-tokens; goldsky.com/pricing; quicknode.com/docs/streams; sqd.dev/portal, docs.sqd.dev portal-open-beta; streamingfast.io lowering-the-cost substreams solana; alchemy.com docs nft-activity-webhook, address-activity-webhook, getnftsales; helius.dev/pricing, /docs/webhooks, /docs/das-api; dev.tensor.trade/reference/websockets.md; docs.magiceden.io/llms.txt, help.magiceden.io 13885533 and 8995559; eng.magiceden.dev scaling parts 1-2; docs.hiro.so ordinals-api; docs.xverse.app/api/ordinals; unisat.io/open-api; web3.okx.com onchainos marketplace-ordinals-api; docs.bestinslot.xyz; ordiscan.com/docs/api; nft.reservoir.tools getsalesv6, top-bid events, floor-ask events; github.com/refinableco/reservoir-indexer; docs.allium.so nft-trades; docs.dune.com nft-trades; github.com/ponder-sh/ponder/issues/1757.

# LENS R2 -- metadata, rarity, listing and offer correctness

## (1) OpenRarity as the standard -- CORROBORATED with two corrections to lens 4 #6

OpenRarity: information content per trait, two-key sort (unique-attribute count desc, then IC score desc), RANK (not DENSE_RANK) ties, and "if the token does not have an attribute, the probability of the attribute being null is used" (github.com/OpenRarity/open-rarity, `rarity_ranker.py`, `scoring/utils.py`). Lens 4 #6 is a real deviation; the fix must also add the two-key sort and RANK ties. OpenSea: OpenRarity adopted, ERC-721 only, string traits only, creator opt-in, recommends fully revealed collections; no coverage percentage exposed. Magic Eden: "Statistical Rarity" (product of per-trait frequencies), missing traits normalized as unique `MISSING_n` markers, ties share rank; HowRare.is multiplicative with category-size normalization; Rarity Sniper constant trait weight with a special 1-of-1 weight and "None" as a value. Moralis returns 202 "being resynced" while partial with a 30-min reprocess lock. No venue publishes a numeric coverage -- an honest coverage triple is a differentiator to own. A cross-chain aggregator must ship both methods (IC for EVM/OpenSea parity, statistical for Solana/Bitcoin parity) and label which.

## (2) Fetching 10k+ metadata -- CORROBORATED, with numbers

ipfs.io/dweb.link began rate-limiting hotlinked/backend traffic 2026-08-25 ("increasing"); backend guidance = self-host (Rainbow/Kubo/Someguy) or `@helia/verified-fetch`. The audit's "3-way race x 25 = 75 concurrent hits" is exactly the throttled pattern. Pinata dedicated gateway: no retrieval rate limits; API 60/250/500 rpm by plan. Trustless gateway CAR fetch (`?format=car&dag-scope=all`) returns a whole directory DAG in one verified request -- 10k requests become ~1 for `ipfs://<dirCID>/<id>.json` collections. Alchemy `getNFTsForContract` 100/page with `withMetadata`, 600 CU/call: 10k tokens = 100 calls = 60k CU. Moralis 40/80/200 rps by plan. ERC-4906: `MetadataUpdate(uint256)`, `BatchMetadataUpdate(uint256,uint256)`; clamp `_toTokenId` (contracts emit `type(uint256).max`). ERC-1155 `{id}`: lowercase hex, no 0x, zero-padded to 64 -- lens 4 #10 confirmed as a gap. Solana DAS `getAssetsByGroup` 1000/page returns `content.json_uri`; off-chain JSON not guaranteed fetched -- corroborates the json_uri fallback. Ordinals: CBOR metadata in tag-5 pushes (>520 B split), tag-17 properties, `/r/metadata/<id>` returns hex CBOR -- corroborates wiring the envelope parser (zero callers today).

## (3) Manipulation / trait spam / honest coverage -- PARTIALLY CORROBORATED

Rarity is priced (3.7M trades, 410 collections: rarer items sell higher, trade less; arxiv 2204.10243), so rarity errors are money errors. The DIT/ROAR benchmark (arxiv 2508.12671) compares rarity.tools, OpenRarity, KRAMER; discusses trait spam, missing traits, manipulation resistance. Practitioner critiques document None-trait and trait-count gaming and cross-tool weight divergence. No academic source on honest coverage reporting; Moralis's 202-while-partial is the closest analogue. Lens 4 #5 is unopposed -- go further (invention 3).

## (4) OpenSea v2 listings -- CORROBORATED (lens 2 #1, #2, bundles, 1155)

Listings carry `price.current = {currency, decimals, value}`; collection stats expose `floor_price` + `floor_price_symbol`. OpenSea itself is currency-explicit; summing `consideration[].startAmount` regardless of token is wrong by construction. Floor derivation: use `/listings/collection/{slug}/best` (sorted asc, limit <=200, `next`, does not compute a floor, duplicates per token not deduped); `/all` is for the book. Free key: 600 reads/h, 30 writes/h, 5 fulfillments/min; keys under one account share a bucket. ERC-1155: partial fills via numerator/denominator and `startAmount>1`; the listings API has long returned only quantity-1 orders for 1155 (opensea-js #841). Carry `offer[i].startAmount` and `remaining_quantity`; price per unit = total / quantity.

## (5) Seaport criteria offers -- CORROBORATED (lens 2 #5), with the resolution

`fulfillAdvancedOrder` needs `criteriaResolvers[{orderIndex, side, index, identifier, criteriaProof}]`; root 0 = any token with an empty proof. REST orders do not include criteria. OpenSea `/offers/fulfillment_data` takes `consideration.{asset_contract_address, token_id}` and, for trait offers, validates the token against the criteria before returning `fulfillment_data.transaction.{function, input_data, value}` ready to send (the older changelog saying criteria unsupported is superseded). Gotchas: seller must have approved the conduit and hold the token; `include_optional_creator_fees` changes consideration; proofs for non-zero roots must come from OpenSea. So lens 2 #5 resolves by calling `fulfillment_data` with `consideration` and forwarding the calldata; until that is built, criteria offers stay view-only (shipped in Batch C).

## (6) WalletConnect v2 / Reown namespaces -- CORROBORATED with nuance

Required namespaces must all be satisfied; optional may be partially approved; sessions may add chains later. Reown guidance: leave `requiredNamespaces` undefined, put every chain in `optionalNamespaces`, listen for `session_update`. Field reality: "Requested chains are not supported" when wallets honour only the first chain; mobile `switchNetwork` shows "Approve in Wallet" then silently fails. Rule: a chain not in the approved session namespace cannot be signed on; request `wallet_addEthereumChain`/`switchEthereumChain`, then wait for `session_update` containing `eip155:<id>` before enabling Buy; otherwise show "reconnect wallet with <chain>".

## (7) PSBT safety -- CORROBORATED, with one correction

Seller signs `SINGLE|ANYONECANPAY` (0x83) on a 1-in/1-out PSBT; buyer builds the full tx with `ALL`; 2-dummy-UTXO padding keeps the inscription at output 0. Atomicals Market (2023-11-15) used `NONE|ANYONECANPAY` (0x82) and suffered "zero-yuan purchases"; CertiK checklist: default `SIGHASH_ALL`, for SINGLE assert output index == input index, verify inscription output >=546 sat, fee ceiling, no unexpected inputs. Correction: Magic Eden's Total Mempool Protection abandoned 0x83 because it is the mempool-sniping vector, using ALL with fixed outputs (and 2-of-2 escrow for listings). Wallet APIs: UniSat `signPsbt({toSignInputs:[{index,address|publicKey,sighashTypes}], autoFinalized})`; ME `signTransaction` with `inputsToSign` and `broadcast:false`. Client rule: never sign an input you did not enumerate; reject any PSBT whose inputs include an inscribed/rune UTXO you did not intend to sell; pin sighash per input; for buys require `ALL` and decode outputs locally before signing.

## INVENT -- 5 outsized moves

1. **Content-addressed shared metadata cache (CAR-first).** Key = `sha256(tokenURI bytes)` and CID; for `ipfs://<dir>/` collections fetch one CAR into `metadata_blobs(cid, body, fetched_at)` shared by all chains; seed from Alchemy `withMetadata` and DAS `json_uri`. Cost ~2 days + one dedicated gateway (~$20/mo) or self-hosted Rainbow. Acceptance: BAYC 10k from 3% to >=99.5% `withTraits` in <10 min; zero requests to ipfs.io/dweb.link.
2. **Deterministic rarity proof = Merkle root over (tokenId, canonical traits, score, rank).** Canonical JSON with explicit `None` per trait type and `openrarity.trait_count`; OpenRarity-exact (two-key sort, RANK ties) plus the ME-style statistical variant; publish `rarity_root`, `method`, `coverage`. Acceptance: golden test against the `open-rarity` Python output for 3 collections, byte-equal ranks; root changes iff traits change.
3. **Honest coverage triple with a "provisional" badge and 202 semantics.** `terminal/expected`, `withTraits/expected`, `withImage/expected` per snapshot; rarity API returns 202 + counters while `withTraits < 99.5%`; UI badge "Provisional (63% traits)"; never `partial=false` from a membership walk. Acceptance: kill the fetcher mid-run; the page shows exact counters and no "Common" ranks.
4. **Per-row currency-normalized order model.** `orders(venue, chain, token, currency_address, currency_symbol, decimals, unit_amount_atomic, quantity, remaining_quantity, bundle_size, order_kind{basic,dutch,english,criteria}, observed_at, executable)`; floor = min over native or wrapped-native rows; ERC-20 rows shown with their own symbol and USD; cheapest-per-token prefers `executable`. Acceptance: fixture with 5 USDC/Polygon, 1 WETH, a 2-token bundle, a 10x ERC-1155 listing renders four correct prices and the floor ignores USDC. (Batch C shipped the pricing half.)
5. **Signed-intent gate for wallet writes (EVM criteria fills + BTC PSBT linter).** One `IntentCheck` before every signature: EVM -- decode calldata, assert `to == protocol_address`, order hash matches, consideration token/amount equals the displayed row, chain in the approved session namespace; BTC -- decode PSBT locally, seller input index == output index with 0x83, buyer inputs `ALL`, inscription at output 0 with >=546 sat, no foreign inscribed UTXO, fee <= ceiling. Acceptance: adversarial fixtures (mutated output, extra inscribed input, 0x82 sighash, wrong chain) all rejected before the wallet prompt.

Sources (~30): github.com/OpenRarity/open-rarity; support.opensea.io openrarity; cointelegraph opensea rarity revision; help.magiceden.io 9062884, 6123149; howrare.is/faq; nftnow rarity tools guide; docs.moralis.com nft-rarity, rate-limits; blog.ipfs.tech 2026-08 beyond-sponsored-gateways; docs.pinata.cloud limits; specs.ipfs.tech trustless-gateway; alchemy get-nfts-for-collection-v3, compute-unit-costs; docs.ar.io; eips.ethereum.org 4906, 1155; quicknode getAssetsByGroup; helius DAS blog; docs.ordinals.com metadata, properties, recursion; arxiv 2204.10243, 2508.12671; poprank medium; tokenmagic rarity tools; opensea-js api-reference; docs.opensea.io get_collection_stats, get_best_listings_collection, api-keys, generate_offer_fulfillment_data_v2, changelog fulfillment-endpoints; seaport SeaportDocumentation, seaport-js discussions/81; opensea-js issues/841; specs.walletconnect.com namespaces; reown.com CAIP-25 guidance; reown appkit issues 1387, 4766, 3788; github.com/me-foundation/msigner; ordinals/ord issues 4291, 802; certik PSBT best practices; l2xl medium safe ordinals trading; docs.unisat.io llms-full; docs-wallet.magiceden.io provider methods.

# LENS R3 -- scheduling, ingest on constrained hosts, execution safety

## (1) Postgres-backed queues -- what the audit gets right and where the literature corrects it

Corroborated: SKIP LOCKED claiming is standard (Graphile, pg-boss, River, Oban, pgmq). Graphile measures ~15.6k jobs/s unbatched vs ~184k/s with completion batching (`completeJobBatchDelay`/`failJobBatchDelay: 250`) -- completion batching, not claim batching, is where round trips go. Lease/heartbeat: pg-boss `expireInSeconds` 15 min default, heartbeat >=10 s; River `RescueStuckJobsAfter` 1 h and notes a job ignoring cancellation "remains stuck until the rescuer intervenes"; Oban Lifeline rescues orphans every minute, single-rescuer. The audit's defect I (lease sweep runs only on claim) is the anti-pattern these design against: sweep on a timer, single sweeper. Retry backoff: pg-boss `retryDelay * 2^retryCount` + jitter; the audit's defect E means the codebase had no backoff primitive -- `deferDataJob` is the missing verb (shipped). pgmq `read_with_poll` holds a connection for seconds -- never long-poll with 4 connections.

Refuted / corrected: priority lanes without aging starve (Oban Pro DynamicPrioritizer: bump one level after 5 min waiting). The demand bus has no aging and `demoteStaleVisibleDemand` (defect L) is the opposite of aging. Cooperative cancellation is not optional: `AbortSignal.timeout()` + `AbortSignal.any()` threaded into every fetch/pg call (BullMQ passes an AbortSignal to processors; River restarts the process when a job ignores cancellation). Audit defect A is the textbook case. Graphile guidance for low-connection setups: claim 1-2 per worker, finish/fail in one batched statement every 250 ms.

Bottom line: the queue design is not the bottleneck; lane time (30-45 s mean, 120 s timeouts, in-lane sleeps) is. Fix A/E/F/G before any queue rewrite (E/F/G shipped as Batch A; A open).

## (2) WebSocket ingest: cron+flock vs supervisor; Phoenix heartbeat; OpenSea guidance

cron+flock is a mutex, not a supervisor. The 20-60 s blind window every hour is inherent to `--max-seconds` + `flock -n`; the mitigation without a daemon is two overlapping cron entries offset by 30 min with 61-min budgets, dedup on `(chain, tx_hash, token_id)`. CloudLinux LVE: NPROC counts every process/thread in the LVE including cron; "once the limit is reached, no new process can be created" -- that is the `spawn EAGAIN`. In-process lanes were the correct response. Phoenix: client sends heartbeat every 30 s; if no reply before the next heartbeat, the socket is dead; the known half-open bug (fixed in phoenix PR 4921) requires tearing the socket down keyed on `pendingHeartbeatRef` plus a `lastEventAt` watchdog (on the wildcard topic >10 s of silence is a dead socket). OpenSea: best-effort delivery, out-of-order events (sort by `event_timestamp`), pair with `GET /api/v2/events/collection/{slug}` reconciliation.

## (3) Cheapest credible always-on hosts + managed Postgres for a 300 GB ledger

| Option | Price (Sep 2026) | Fit |
|---|---|---|
| Hetzner CX22 (2 vCPU/4 GB/40 GB NVMe) | EUR 3.79/mo; CAX11 ARM ~$3.79 | Best: mesh loop + stream as systemd, PgBouncer local |
| Fly.io shared-cpu-1x 1 GB | ~$5.70/mo | OK; 256 MB too small for the parse rate |
| Railway Hobby | $5 + metered RAM/vCPU | worse than Hetzner 24/7 |
| Render | from $7/mo, 5 GB storage cap | no |
| Oracle Always Free A1 | halved 2026-06-15; over-limit instances terminated | not credible for production |
| Cloudflare Workers Paid | $5/mo; cron max 15 min; outbound WebSocket keeps a DO awake | good for edge workers/coalescing, wrong for the stream; Hyperdrive pooling free |

Managed Postgres at 300 GB: Neon ~$105/mo storage + compute; Supabase Pro + Micro ~$70-75/mo (200 pooler connections); Crunchy Hobby capped at 100 GB. Cheapest credible: Supabase Pro + Micro, or keep the DB on cPanel and add one CX22. PgBouncer transaction mode with node-pg: disable named prepared statements (or PgBouncer >=1.21 `max_prepared_statements`), no session state, no LISTEN, no cross-statement advisory locks; `claimDataJob`'s transaction is fine.

## (4) Demand-driven freshness scheduling

Cho and Garcia-Molina (TODS 2003): under a fixed budget, uniform refresh beats proportional; elements that change too fast should be refreshed less. Kolobov, Peres et al. (SIGIR 2019, LambdaCrawl): optimal rate r_i proportional to sqrt(w_i * lambda_i) under host politeness caps. Application: replace click-minus-cost arithmetic with a per-collection refresh rate proportional to sqrt(views x observed event rate), per-vendor politeness cap per key; schedule by deadline (`not_before = last_sync + 1/r_i`). This prevents defect D because priority stops being a static number.

## (5) Seaport fulfilment safety

`fulfillAvailableAdvancedOrders` skips cancelled/expired/filled orders but reverts on revoked approvals or insufficient balance -- pre-validate or per-order fallback. Tips: the fulfiller may extend the consideration array; un-zoned orders can be front-run with modified tips; tips must be part of the signed preview and asserted client-side; consideration totals summed per currency. Criteria: `identifierOrCriteria=0` wildcard; otherwise a merkle proof; use `fulfillment_data.transaction` verbatim and append `calldata_suffix`. How aggregators protected buyers: Reservoir `execute/buy/v7` returns a `path` with per-item quote, total, fees before any step, `partial` and `onlyPath`; OpenSea vends calldata server-side; Blur's 2024 losses came from signature phishing on fields the UI didn't show. Pattern: preview = exact orderHash set + per-order (currency, amount, recipient) + total cap; execute only that set; simulate first (eth_call / Tenderly). Audit #1-#3 violate all three.

## (6) Magic Eden Solana v2 `instructions/buy_now`

Official OpenAPI today: `price` (number, required) = "Price in SOL"; required `buyer`, `seller`, `tokenMint`, `tokenATA`, `price`, `sellerExpiry`; optional `auctionHouseAddress`, referrals, expiries, royalty percent, four priority-fee params; returns `{tx, txSigned}`. The official TypeScript SDK takes lamports and converts internally. Audit #6 confirmed: raw REST wants decimal SOL. Composability: the endpoint returns a whole transaction, possibly partially signed; no composability promise -- treat batched sweep as unproven; send sequentially with per-tx price assertions.

## (7) UniSat / Magic Eden ordinals PSBT: buyer checklist before signPsbt

Reference design is ME's open-sourced `msigner`: seller signs one input `SIGHASH_SINGLE|ANYONECANPAY`; buyer signs `SIGHASH_DEFAULT`; 2-dummy-UTXO algorithm so the inscription lands at offset 0 with ~10k sats postage. Buyer must parse the PSBT and assert: (a) an output to the buyer's address whose sat range contains the inscription; (b) seller input present with expected sighash and seller output equal to the quoted price; (c) sum(inputs) - sum(outputs) = fee within the quoted band; (d) no buyer input contains inscriptions/rare sats; (e) platform-fee output <= quote; (f) `unisat.getChain()` == livenet. Then `signPsbt(hex, { autoFinalized: false, toSignInputs: [...] })` and finalize after re-verifying. Audit #7 (`autoFinalized: true`, blind sign) confirmed as the money-at-risk bug.

## INVENT -- five outsized moves on a tiny budget

1. **One CX22 sidecar (EUR 3.79/mo), DB stays on cPanel.** systemd runs the scheduler loop and the stream with `Restart=always`; local PgBouncer (transaction mode) -> TLS tunnel -> cPanel Postgres; the app keeps PGPOOL_MAX=4, the worker gets 12. Acceptance: `succeededLast15m >= 40` and stream staleness <15 s for 24 h; zero EAGAIN.
2. **Deadline scheduler (sqrt(w*lambda)) replacing priority arithmetic.** Per collection `views_7d`, `events_7d`; interval = k/sqrt(views*events) clamped [2 min, 24 h]; `not_before = last_sync + interval`; claim `ORDER BY not_before`; clicks set `not_before = now()`. Acceptance: with 900 queued and 3 slots, p95 age of any collection viewed in the last hour < 5 min; no job with attempts > 20.
3. **Edge coalescer on Cloudflare Workers ($5/mo) + Hyperdrive (free).** A Worker cron drains a `demand` table via Hyperdrive, fans out vendor fetches with `AbortSignal.timeout(20s)`, writes batched rows back. Acceptance: 500 distinct demand pings in a minute -> <=25 vendor calls and all 500 succeeded within 2 min with the sidecar off.
4. **Browser-assisted hydration with signed receipts.** The collection page already fetches public JSON client-side; browsers POST `(url, sha256(body), body)`; the server re-fetches a 5% sample plus never-seen hashes, stores the rest as `finality='browser'`, promoted on corroboration. Scope to ME/UniSat/Helius public endpoints. Acceptance: a cold 10k collection reaches 100% metadata within 10 min of 20 concurrent viewers with the mesh at 0 jobs/min; mismatch rate <0.1% or the source auto-disables.
5. **Deterministic replay from public datasets for the ledger.** Backfill fill tables and `plank_market_events` from BigQuery `crypto_ethereum.logs` decoded with the same Seaport/Wyvern decoders; snapshot per chain as Parquet; CI replays into a scratch schema and diffs volume/sales/buyer board against golden values. Cost $0 (1 TB/mo free quota). Acceptance: BAYC and one Base collection replayed 30-day volume within 2% of OpenSea; every stream sale matches a chain row by `(tx_hash, token_id)`.

Confirmed-open money bugs to gate before live trading: sweep executes an unconfirmed set with no cap (#1/#2), MarketView skips C1 (#3), criteria resolvers dropped (#5), ME lamports-vs-SOL (#6), UniSat blind auto-finalize (#7).

Sources (~30): worker.graphile.org/docs/performance; pgboss.io/api/jobs; riverqueue.com maintenance-services and go-stuck-jobs; oban.hexdocs.pm Lifeline; oban.pro DynamicPrioritizer; pgmq.github.io; netdata SKIP LOCKED; openjsf.org AbortSignal; bullmq.io cancelling jobs; dev.to cron-vs-systemd, flock-in-cron; docs.cloudlinux.com limits; docs.litespeedtech.com ts-cloudlinux; github.com/phoenixframework/phoenix/pull/4921; hexdocs.pm/phoenix/js; docs.opensea.io stream; hetzner.com pressroom cx-plans; northflank railway-vs-flyio; hostim.dev render-vs-railway-vs-fly; infoq oracle free tier 2026; developers.cloudflare.com workers pricing, hyperdrive; neon.com/pricing; supabase.com/pricing; docs.crunchybridge.com plans; crunchydata prepared statements pgbouncer; dl.acm.org Cho & Garcia-Molina 2003; erichorvitz.com SIGIR 2019 crawl under politeness; github ProjectOpenSea/seaport docs; docs.opensea.io fulfillment_data; nft.reservoir.tools postexecutebuyv7; decrypt.co blur 240k; docs.tenderly.co simulations; docs.magiceden.io buy_now; github.com/magiceden/magiceden-sdk; solana.com versioned tx; github.com/me-foundation/msigner; certik.com PSBT best practices; docs.unisat.io wallet API; github.com/unisat-wallet/dev-support/issues/33.
