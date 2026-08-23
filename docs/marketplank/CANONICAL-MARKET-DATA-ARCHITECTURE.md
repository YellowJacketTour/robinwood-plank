# Canonical market data: evidence before metrics

This document defines the cross-chain invariant. Adapters may be chain- and
protocol-specific; storage, provenance, completeness, and UI truthfulness are
shared. “No observed row” is never converted to “zero activity.”

## Canonical observation

An observation is identified inside its chain namespace:

- EVM: `eip155 + chain slug + transaction hash + log index + sub-index`.
- Solana: `solana + cluster + signature + outer/inner instruction path`.
- Bitcoin: `bitcoin + network + txid + vin/vout`, with a separate immutable
  venue-order revision identity for off-chain PSBT books.

Every asset leg and payment leg is stored independently. Bundle totals remain
`unallocated` unless a protocol supplies an explicit allocation. Fee,
royalty, seller proceeds, fungible consideration, and NFT consideration are
not collapsed. This follows Seaport's native offer/consideration model, which
supports multiple items, criteria, partial fills, and adjusted fulfillment
amounts ([Seaport documentation](https://github.com/ProjectOpenSea/seaport/blob/main/docs/SeaportDocumentation.md)).

## Currency projections

The executable floor is first computed per `(chain, token address, decimals)`.
Different currencies are comparable only through fresh, timestamped,
attributable USD observations. The product must show native amount, currency
identity, USD observation time/source, and an explicit “incomparable” state
when quotes are missing or stale. Historical USD uses the price at the event
time, not today's spot price. Oracle integrations also retain confidence and
publisher/freshness evidence: Pyth explicitly warns that a carried-forward
price may look present while its feed update is stale, and publishes a
confidence interval for uncertainty ([Pyth price-data guidance](https://docs.pyth.network/price-feeds/pro/understanding-price-data),
[best practices](https://docs.pyth.network/price-feeds/core/best-practices)).

## Solana

Inventory/metadata discovery can use paginated DAS, but DAS is not a complete
order book or trade ledger ([Metaplex DAS pagination](https://developers.metaplex.com/dev-tools/das-api/guides/pagination)).
Canonical history is reconstructed from transactions, including inner CPI
instructions, loaded addresses, and pre/post token and lamport balances
([Solana transaction JSON](https://solana.com/docs/rpc/json-structures)).
Venue adapters decode each Magic Eden and Tensor program/version, including
compressed assets, then reconcile live accounts/API orders against finalized
chain evidence. The Solana community itself identifies reliable historical
indexing as dedicated infrastructure rather than a trivial RPC loop
([Solana indexer tooling discussion](https://forum.solana.com/t/indexer-tooling/2059)).

## Bitcoin and Ordinals

The base truth is a Bitcoin node plus an `ord` index: inscription content,
properties, delegates/recursion, sat/UTXO location, transfers, and spent
state. The official `ord` interfaces document the index/API and inscription
properties ([ord API](https://docs.ordinals.com/guides/api.html),
[properties](https://docs.ordinals.com/inscriptions/properties.html)). Active
asks/bids remain venue-specific signed-PSBT books (for example UniSat/OKX),
continuously invalidated against mempool and UTXO state. Retired venue data is
historical evidence, not a live dependency: Magic Eden announced that its
Bitcoin marketplace and Bitcoin API would end on June 30, 2026 while Solana
continues ([service update](https://help.magiceden.io/en/articles/13885504-magic-eden-marketplace-updates-service-changes)).

## Coverage control plane

Coverage is a matrix keyed by chain x venue x protocol version x capability.
Each cell records adapter support separately from runtime state, contiguous
start/through coordinates, observed head, finality, last success/error,
freshness, and evidence source. A cell is `complete` only when its proved
contiguous range reaches the observed finalized head. Dashboards and alerts
derive from these cells using traces, metrics, and logs rather than optimistic
health booleans ([OpenTelemetry observability primer](https://opentelemetry.io/docs/concepts/observability-primer/)).

## Integrity and ranking

Raw evidence is immutable and projections are rebuildable. Ranking excludes
or visibly discounts stale/incomparable floors, unavailable live liquidity,
unproved history, self-transfer-like sales, circular counterparties, extreme
same-block flips, and concentrated maker activity. Flags are evidence for
review, not accusations. This is consistent with empirical NFT-market work
showing that wash-trade detection requires graph, timing, price, and funding
relationships rather than one heuristic ([NFT Wash Trading](https://arxiv.org/abs/2202.03866),
[large-scale analysis](https://arxiv.org/abs/2312.12544)).

## UI contract

Every metric exposes native currency, USD observation provenance, indexed
range, last update, and contributing venues. Tooltips/drilldowns reveal exact
event points and artwork; keyboard and touch select the same evidence. Mobile
uses pan/zoom with explicit reset and a details sheet, while desktop adds
linked brushing. Reduced-motion and a non-WebGL tabular path are first-class.
Visual polish never substitutes for missing evidence.
