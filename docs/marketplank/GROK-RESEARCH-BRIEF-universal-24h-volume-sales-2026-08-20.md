# Research brief for Grok: a real, universal 24h/volume/sales data architecture for Bitcoin Ordinals and Solana

Status: **research brief, not a spec.** Hand this to Grok (or any frontier
research model) to search exhaustively and come back with a real,
implementable architecture — not a summary of the first few results.
Written by Sonnet 5 with direct, current, first-hand knowledge of this
exact codebase, 2026-08-20.

## The problem, precisely

This app tracks NFT collections across 10 chains. The "24h Change / 24h
Volume / 24h Sales" columns in its global rankings table are empty for
**every chain except EVM collections with an OpenSea listing** — and even
those need OpenSea's own `/collections/{slug}/stats` endpoint, called from
`lib/market/multichain/rarity-index-runner.ts`, which is the ONLY code
path anywhere in this codebase that has ever written these fields.

**The real fix for EVM is already half-built and just needs wiring**: this
app has a first-party, self-hosted on-chain indexer,
`plank_seaport_fills` (migration `023_seaport_fill_index.sql`), that
watches Seaport's `OrderFulfilled` event directly on-chain — real
buyer/seller/price/collection/token/timestamp, across every EVM chain it
trades on (Robinhood Chain + 7 foreign chains), completely independent of
OpenSea or any third party. **It is fully populated by
`lib/market/multichain/seaport-fill-indexer.ts` but is never queried
anywhere else in the codebase** — a real, present, correct data asset with
zero consumers. Sonnet is wiring that in directly (real SQL aggregation:
`SUM(price_wei) WHERE block_timestamp > now() - interval '24 hours'` per
`(chain_slug, nft_contract)`, not a research question).

**What's genuinely unsolved, and what this brief is for**: Bitcoin
Ordinals and Solana have NO equivalent to `plank_seaport_fills` — no
on-chain event this app already watches that represents "a real sale, on
any marketplace, for this collection." Both ecosystems lack a single
universal settlement contract the way every EVM chain shares Seaport at
the identical address.

## Non-negotiable invariants (same as this session's prior brief)

- Never fabricate data. A missing number stays `null`, never estimated or
  interpolated to look complete.
- Real, first-party data preferred over a third-party API wherever
  possible — this app's own `previous_floor_price_wei` (its own
  observation history, not a repackaged third-party figure) and the
  `plank_seaport_fills` indexer above are the established pattern to
  extend, not deviate from.
- Fail closed on missing capability (unset API key, no confirmed real
  endpoint) — never silently substitute a fabricated or stale number.
- No private-key custody, ever, in any proposed indexer or read path.

## Research questions

### 1. Bitcoin Ordinals: is there a real, universal on-chain "this inscription just sold" signal?

Ordinals sales settle via PSBT (this app's own `native-bitcoin-listing.ts`
proves the mechanism) — there's no single "marketplace contract" the way
Seaport is one contract on every EVM chain. Research:

- Does a real, reliable **heuristic exist for detecting a sale from raw
  chain data alone** — e.g., a transaction where an inscription-bearing
  UTXO's controlling output changes ownership AND a payment output above
  some real dust threshold goes to a different address in the same
  transaction? Real Ordinals indexers (`ord`, UniSat's own indexer, Magic
  Eden's former Bitcoin indexer before their March 2026 exit,
  Ordinalswallet, Gamma) — how do THEY compute "24h volume" today? Do any
  publish their actual detection methodology, not just their number?
- Is UniSat's own `/v3/market/collection/auction/list` or a sibling
  endpoint (this app already integrates UniSat's Bearer-keyed indexer API
  elsewhere, see `bitcoin-utxo-safety.ts`) able to return REAL historical
  fill/sale data per collection, not just live listings? Check UniSat's
  actual current API surface for anything resembling a sales-history or
  stats-by-collection endpoint, live-verified, not assumed from stale
  docs (this session found UniSat's own docs.unisat.io have real 404s
  elsewhere — verify against their actual current OpenAPI surface or a
  real test call).
- Is a self-hosted "watch every Ordinals transfer, cross-reference
  against this app's own known listing PSBTs" approach viable at Bitcoin's
  real transaction volume/scale, and what would the real infrastructure
  cost/complexity be vs. depending on UniSat's indexer?

### 2. Solana: is there a real, universal on-chain "this NFT just sold" signal?

Unlike EVM's shared Seaport, Solana marketplaces run their own separate
programs (Magic Eden's Auction House, Tensor's AMM/order-book program) —
this app's own `magiceden-solana-trade.ts` already documents "SOLANA HAS
NO SEAPORT EQUIVALENT." Research:

- Does Magic Eden's Auction House program (or Tensor's) have a **single,
  stable, publicly-documented program ID and instruction/log signature**
  this app could watch directly via Helius (already integrated,
  `HELIUS_API_KEY` configured) the same way `seaport-fill-indexer.ts`
  watches Seaport's `OrderFulfilled` event? What's the real Anchor
  event/log shape for "this NFT sold" on each program?
- Does Helius's own enhanced transaction API (webhooks, or a
  transaction-history endpoint) already expose a **parsed, normalized
  "NFT_SALE" event type** — this session found Helius genuinely does
  return real, structured asset data (`mpl_core_info` confirmed live) —
  does its transaction-parsing layer do the same for sales, across
  multiple marketplace programs, in one call? If real, this could be
  meaningfully simpler than watching raw program logs per-venue.
- If a program-log-watching approach is needed, is a shared
  multi-program indexer architecture (one scanner watching N known
  program IDs, normalizing to one internal event shape) the right
  design, mirroring `chain-indexer.ts`'s own EVM cursor-per-chain
  pattern — or does Solana's transaction/slot model make that pattern a
  poor fit, requiring something genuinely different (e.g. Geyser
  plugins, gRPC streaming, a different indexing paradigm entirely)?

### 3. Once real sale events exist for a chain, what's the correct aggregation?

Research the real, standard definition multichain indexers/aggregators
(Reservoir, Dune's own NFT dashboards, Flipside) use for "24h volume" and
"24h sales" per collection — rolling 24h window vs. calendar-day bucket,
how wash-trade filtering is handled (or deliberately NOT handled) at the
raw-indexer layer vs. a display layer, and whether "24h change" should be
computed from a true rolling comparison (this app's own floor-change
precedent: compare against a stored `previous_floor_price_wei`-style
snapshot) or a live window-over-window query.

## What "done" looks like

For Bitcoin and for Solana, separately:

1. Name the real, verified mechanism (a specific API endpoint,
   live-tested if possible, or a specific program/log signature,
   confirmed against real documentation or a real test call — not
   assumed).
2. Propose the concrete indexer design for THIS codebase: what table
   (mirroring `plank_seaport_fills`'s real shape where the parallel
   holds), what cursor/resume strategy, what real rate limits or cost
   constraints apply.
3. Be explicit if the honest answer is "no real universal signal exists
   yet for this chain" — in that case, propose the best available
   approximation (e.g., "count our OWN observed fulfillments only,
   labeled honestly as 'sales through Marketplank' rather than a
   misleading blanket '24h volume'") rather than a fabricated number.

Leave nothing out. This directly gates whether the rankings table can
ever honestly show real data for Bitcoin and Solana collections, which
together are most of what this app tracks.
