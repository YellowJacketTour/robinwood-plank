# Research brief for Grok: a total-redundancy, swarm-sourced marketplace data warehouse

Status: **research brief, not a spec.** Hand this to Grok to search wide
and invent — not summarize the first few results. Written by Sonnet 5,
2026-08-20, at the end of a long real session that shipped and
live-verified most of the pieces this brief now asks to be unified.

## The ask, precisely

The owner's own words: **"the every cell guarantee total swarm source
always redundant auto coverage no limits perfect marketplace data
warehouse."** Design the most complete, self-healing, maximally-redundant
real-data architecture achievable for this app's global rankings table —
every real cell (Floor, 24h Change, 24h Volume, 24h Sales, Listed, Grade)
filled from the best available real source, with automatic failover
across every viable provider, for every chain this app tracks.

## The one honest ceiling this brief must respect

**Every cell CANNOT literally always be filled — some collections have
zero real trading activity anywhere, ever, and that must stay `null`, not
fabricated.** Confirmed live this session: a Metaplex Core "collection"
with `num_minted: 0` structurally cannot have real volume. A test run
this session matched only 11 of 61,162 tracked Solana collections and 67
of 2,629 tracked Bitcoin collections against CoinGecko's real dataset —
the rest simply aren't tracked by ANY known aggregator because they have
no real liquidity. **"Every cell" means "every cell for which real data
exists anywhere, sourced with maximum redundancy" — never "every cell,
period."** Any proposal that would fill a dead collection's row with an
estimated/interpolated/fabricated number is disqualified regardless of
how elegant it is.

## Real ground truth from this session (what's already built/verified — extend, don't duplicate)

- **EVM (8 chains + Robinhood)**: `plank_seaport_fills`, a first-party
  on-chain Seaport `OrderFulfilled` indexer, now wired into real 24h
  volume/sales aggregation (`updateEvmVolumeFromSeaportFills`,
  `lib/market/multichain/store.ts`). RPC access itself is the current
  bottleneck: Alchemy hit its real monthly quota mid-session; PublicNode
  (free, no key) was added as fallback and rescued 2 of 8 chains live;
  the rest hit PublicNode's own "archive requests require a personal
  token" limit. `foreignRpcUrls()` (`foreign-chain-registry.ts`) is the
  real extension point.
- **Solana + Bitcoin**: CoinGecko's free public NFT API
  (`api.coingecko.com/api/v3/nfts/*`, no key required to read, a free
  Demo key raises 5-15/min to 100/min) has real, live-verified
  `volume_24h`/`one_day_sales`/`floor_price_24h_percentage_change` for
  both platforms. Wired via `lib/market/multichain/discovery/
  coingecko-nft-stats.ts`, exact-slug matching only (never fuzzy).
- **Existing per-chain primary adapters** (still real, still the floor/
  listed source, unaffected by any of the above): UniSat
  (`unisat-collections.ts`) for Bitcoin, Magic Eden (`magiceden-solana.ts`)
  + Helius (`helius-collection-scan.ts`, now filtered to real
  `num_minted > 0` collections) for Solana, Alchemy + OpenSea for EVM.
- **DeFiLlama's `nft.llama.fi/collections`** (`defillama-nft.ts`) — real,
  free, Ethereum-mainnet-only floor-price source, confirmed to have NO
  volume field at all (verified live). Not yet checked this session for
  Solana/Bitcoin coverage under a DIFFERENT real endpoint — worth a fresh
  look (the earlier general web search suggested a marketplace-level
  dashboard for Solana/Ordinals exists on defillama.com; whether it has a
  real, documented, collection-level API behind it was never confirmed
  live this session).

## Research questions — build the swarm

### 1. Every real free/low-cost data source per chain, ranked and cross-checked

For EACH of Floor / 24h Volume / 24h Sales / Listed-count, per chain
family (EVM-with-OpenSea, EVM-without-OpenSea/Robinhood, Solana, Bitcoin
Ordinals), enumerate every real candidate source (not assumed — verify
live where possible, same standard this session held throughout):
CoinGecko, DeFiLlama (re-verify Solana/Ordinals coverage specifically),
Reservoir successors (if any real one now exists post-2025-shutdown),
Bitquery's NFT API (found in this session's own earlier search results,
never live-tested), SimpleHash's real current pricing/free-tier status
post-Phantom-acquisition, Dune's real API (found to have curated
`nft.trades` data covering Solana — real free-tier query-execution limits
need checking), Tensor's own public API for Solana, UniSat's/Magic Eden's/
Ordinalswallet's/Gamma's own real stats endpoints beyond what's already
integrated.

### 2. Real redundancy architecture: what happens when source A is missing/wrong?

For a collection where TWO OR MORE real sources both have data, what's
the correct reconciliation rule — prefer the source with the tightest
match confidence (exact contract address > exact slug > fuzzy name),
prefer the freshest timestamp, or average? For a collection where sources
DISAGREE meaningfully (e.g. two different volume numbers), what's the
right way to surface that honestly (show one with a provenance tag, show
a range, flag as "unreconciled") rather than silently picking one?

### 3. Real RPC swarm for the EVM/on-chain side specifically

Beyond PublicNode: real, live-verified free-tier limits and `eth_getLogs`
archive-depth restrictions for dRPC, Chainstack's free Developer plan (3M
request units/mo per this session's own research), Ankr's public/
Freemium tier, 1RPC, Tenderly Gateway. Does Envio HyperSync (already a
dependency, `@envio-dev/hypersync-client`) have a real free tier that
covers `eth_getLogs`-class historical log scanning WITHOUT the
archive-node restriction free RPC endpoints impose — if so, this may be
the single highest-leverage fix for the exact chains still blocked
(eth/arb/base/bnb-mainnet) rather than adding more RPC providers.

### 4. A real, honest coverage dashboard/audit, not just more sources

Propose a real, queryable "coverage report" this app could generate for
itself: per chain, what % of tracked collections have real Floor/Volume/
Sales data, what % are confirmed-dead (zero real signal from any known
source, safe to deprioritize rather than keep re-checking every cycle),
and what % are still genuinely unknown (never yet checked against the
full source swarm). This turns "when will every cell be filled" from a
guess into a real, honest, re-computable number — the correct answer to
give the owner going forward instead of an estimate.

## Non-negotiable invariants (same as every brief this session)

- Never fabricate, estimate, or interpolate a missing cell. `null` stays
  `null` until a real source has real data.
- Fail closed on missing capability (unset key, exhausted quota, 404) —
  demote/skip that source for that cycle, never substitute a guess.
- Exact-match only for cross-source collection identity (contract
  address > exact venue-native slug). No fuzzy/Levenshtein matching —
  confirmed this session that attaching one collection's real stats to a
  different, wrong collection is a worse failure than staying null.
- Alchemy and every other paid/keyed source stays in the rotation
  wherever it already has real value (NFT metadata, high-quality RPC) —
  this is about ADDING redundancy, never ripping out something working.

## What "done" looks like

A real, prioritized, per-chain source-priority list (not hand-waved —
each entry live-verified or clearly marked "documented, not yet
live-tested" per this session's own honesty convention), a concrete
reconciliation rule for multi-source agreement/disagreement, a real RPC
swarm strategy for the EVM archive-log problem specifically, and the
coverage-dashboard design so "when will every cell be filled" becomes a
real, honest, always-current number instead of a guess.
