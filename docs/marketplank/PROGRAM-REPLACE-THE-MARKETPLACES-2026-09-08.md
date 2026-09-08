# Marketplank: the program to replace the marketplaces

Date: 2026-09-08. Every number here was measured on production, not estimated.

## The vision, stated as the owner states it

> Every chain, all collections, all marketplace listings, all offers, all
> metadata, all traits, all rarities, all activity, all provenance. The
> global marketplank optimized as an attention beam, flushing maximum
> resources to whichever collections are visible on any visitor's screen.
> All visitors act as one persistent fingerprint or attention gaze,
> fleshing out the entire catalog with just-in-time provisions wherever
> archived data does not already exist.

That is not a description of a better NFT browser. It is a description of a
**market data commons that funds its own completion through attention**, and
a trading surface good enough that going anywhere else is a downgrade.

## Where the platform actually stands (measured 2026-09-08)

| Dimension | State | Evidence |
|---|---|---|
| Catalog breadth | 246,941 collections, 11 chains | `/api/market/multichain/chain-counts` |
| Catalog growth | live; Solana +491 in one pass | sampled 03:46 -> 03:51 |
| Attention beam | **working** | 10 visibility-demand signals published during a live scroll |
| Native trading | **proven, real money** | 15 parity cells: list, buy, offer, sweep, bundle, swap |
| Foreign trading | **built, gated off** | 132 cells "built-unproven"; `FOREIGN_TRADE_DISABLED` |
| Money-at-risk defects | D1-D4, D6, D7 shipped | sweep binding, PSBT guard, canary caps, offer validation |
| Remaining risk | unaudited cross-chain code | `canary-limits.ts` scope boundary |

**The single most important fact:** the attention-beam half of the vision is
real and running. The catalog half is real and growing. What is NOT real is
foreign settlement, and it is not blocked by missing code or missing keys.
It is blocked by a deliberate governance decision recorded in the code.

## The three gaps between here and the vision

### Gap 1 — Foreign settlement is gated, not broken

Measured: production holds healthy OpenSea keys (0 of 8 calls used against
the ceiling), returns real listings, and hands back real order hashes (BAYC
at 6.82 ETH, `0x3aefcdc0...`). `/api/market/multichain/fulfillment-data`
answers `503 FOREIGN_TRADE_DISABLED` because `FOREIGN_TRADE_CANARY_ENABLED`
is false.

`canary-limits.ts` states why: a completed audit found all cross-chain
fulfillment code unaudited and untested against real conditions. The
Bounded Blast-Radius Canary was built as risk-bounding infrastructure for a
future decision. Building the safety system and turning on live trading
were treated as two separate decisions, and only the first was made.

**What overcomes it — mainnet fork proof, not a testnet.** A testnet has
different Seaport deployments, no real listings, and no real collections, so
passing there proves almost nothing about mainnet. A fork is a throwaway
copy of real chain state: real deployed Seaport, real collection contracts,
a real signed order fetched live. The transaction executes for real against
that state, never reaches the public chain, and the buyer is funded from
nothing.

`scripts/verify-foreign-fee-router-fork.ts` already proved exactly this on
Base — NFT changes owner, fee lands in the treasury to the wei — but was
Base-only and needed a paid Alchemy key. `scripts/prove-foreign-buy-fork.ts`
generalises it to every EVM chain over the keyless public RPC pool, and
`.github/workflows/prove-foreign-buy.yml` runs it in CI with the canary flag
set **only inside the runner**, so production's kill switch is untouched.

This converts 132 cells from "built-unproven" to evidence, with zero funds
at risk, and turns "should we enable trading" from a gamble into a decision
with data behind it.

### Gap 2 — Catalog completeness is capacity-bound, not source-bound

Measured: 154 standing lanes share the worker pool; only 26 discover
collections. Before the fix, fair rotation gave each discovery lane roughly
one turn in 154 — 4 new collections in 3 minutes across all chains.

**What overcomes it:** a dedicated `discovery` worker role claiming only the
15 collection-bringing sources (`claimDataJob` gained a source allowlist),
and mesh capacity raised 3 → 10 in-process lanes with `PGPOOL_MAX=12`. The
3 dated from when each lane was a spawned process; lanes are IO-bound now,
so the real costs are sockets and connections, not cores.

**Still open:** Bitcoin sits at 19,581. Not source exhaustion —
OrdinalsWallet's catalog reports 425,201 entries, though sampling shows the
tail is BRC-20 fungible tokens the scan correctly rejects (offset 0: 100/100
real; 150,000+: 0/100). The catalog walker existed but lived only in a
legacy script the mesh never ran, so Bitcoin had no catalog lane scheduled
at all. Now wired as `ow-catalog`, one page (500) per pass with a durable
cursor and a dead-zone wrap.

### Gap 3 — Truth is not yet provable to a stranger

A marketplace replacement must be verifiable by someone who does not trust
it. The parity oracle samples each chain against independent references
(CoinGecko, Magic Eden, ord's own inscription count) and records
match/near/diverge per collection with an agreement ratio, enqueuing a
resync when they disagree.

**Note on sources:** Hiro's Ordinals API returned `410 Gone` — deprecated.
The denominator now comes from ordinals.com's `ord` server: the newest
inscription's number is the count of inscriptions ever made (127,331,032 at
block 965,969). This is the kind of drift a proof layer exists to catch.

## The documentation that was under-sourced, and what it changes

Honest accounting of where solving from first principles cost time:

1. **Seaport order-validation and `fulfillAvailableAdvancedOrders`
   semantics.** Sweep atomicity guarantees come from the protocol, not from
   our wrapper. `assertSweepMatchesPreview` should cite the partial-fill
   rules it depends on.
2. **OpenSea's `fulfillment_data` contract.** The best-listing endpoint keys
   on OpenSea's own collection slug, not a contract address. Passing an
   address returned nothing, which read as "no live listing" on every chain
   and cost a full proof cycle.
3. **BIP-174 (PSBT).** `psbt-safety.ts` enforces the right invariants but
   should cite the specification defining the fields it parses.
4. **ord recursive endpoints.** Discovered empirically after Hiro's 410. The
   `/r/inscription/{id}` shape is documented and should be referenced.

## Order of work, by payoff

1. **Land the fork proof** (in flight). Converts 132 unproven cells to
   evidence. No funds at risk, no authorization needed.
2. **Bitcoin catalog to a moving number.** The lane is wired; verify a pass
   registers collections rather than assuming it does.
3. **Creator identity at scale.** 60 per pass with free on-chain sources
   first; marketplace handles retracted, not merely blocked.
4. **Owner decision: connect the canary to live trading.** Only after (1)
   provides evidence. The caps ($50/trade, $2,500/day global) already bound
   the blast radius; the question is whether the fork evidence justifies
   letting real value through unaudited paths.
5. **The remaining 27 "unavailable" cells.** Mostly venues with no keyless
   read path. Each needs either a key or a chain-native replacement.

## The standard this program holds itself to

Every claim in this document is measured. Where I previously reported
something as working and it was not, the correction is recorded rather than
quietly dropped:

- "Bitcoin discovery has exhausted its catalogs" — **wrong**; the catalog
  walker was never scheduled.
- "Foreign buying is blocked on a missing OpenSea key" — **wrong**; the keys
  are healthy and the block is the canary switch.
- "The marketplace-handle filter is fixed" — **incomplete**; it blocked new
  writes but never retracted the value already stored.

A platform that intends to replace marketplaces cannot afford a status
report that is more optimistic than its measurements.
