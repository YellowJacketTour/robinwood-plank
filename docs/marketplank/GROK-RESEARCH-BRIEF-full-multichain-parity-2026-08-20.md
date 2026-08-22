# Research brief for Grok: state-of-the-art solutions for every remaining gap to full multichain parity

Status: **research brief, not a spec.** This document exists to be handed to
Grok (or any other frontier research model) to run an exhaustive, world-wide
search of sources, discussions, whitepapers, forums, and real production
implementations, and come back with genuinely novel, game-theoretically
sound, state-of-the-art solutions for every open gap listed below — not a
summary of the first few search results, and not a restatement of what a
handful of competitors already do. Written by Sonnet 5, from direct, current,
first-hand knowledge of this exact codebase (file:line references throughout
are real, not inferred), on 2026-08-20.

## How to use this document (instructions for the research agent)

1. **Search exhaustively, not narrowly.** For every gap below, do not stop at
   the first 3-5 results. Go deep into developer forums (GitHub issues/
   discussions on the real protocols named — Seaport, Metaplex/Magic Eden's
   Auction House program, OpenOrdex, UniSat's own docs), academic auction-
   theory and mechanism-design literature where relevant (criteria/combo
   bidding is a real mechanism-design problem), X/Twitter and Discord
   discussions among actual NFT-trading power users (not just marketing
   copy from marketplace landing pages), and competitor source code where
   public. "Listen to the people, not just a couple top sources" — actual
   trader sentiment and pain points matter as much as what a marketplace's
   own docs claim.
2. **Ground every proposal in this app's real, existing architecture.**
   This is not a green-field design exercise. Read the "Non-negotiable
   invariants" section below before proposing anything, and cite the exact
   file/mechanism your proposal extends or replaces.
3. **Prioritize elegance and reuse over new surface area.** This codebase's
   own standing discipline (see any file in `lib/market/multichain/`) is:
   never fabricate data, fail closed on missing capability, reuse one real
   mechanism across chains rather than inventing N bespoke ones where a
   single unifying abstraction exists. A "state-of-the-art" answer here
   means the most elegant, minimal, provably-correct design — not the
   most feature-dense one.
4. **Be explicit about what's genuinely unsolved vs. what's a known pattern.**
   Some gaps below (Solana trait bidding, EVM criteria offers) have proven,
   copyable real-world implementations. Others (a portable criteria-offer
   primitive that works identically across Seaport/PSBT/Solana-instruction
   chains, or true cross-marketplace floor/liquidity aggregation) may be
   genuinely novel synthesis work — say so, and propose the best original
   mechanism design you can construct, reasoned from first principles and
   real precedent, not hand-waved.
5. **Every chain, every collection, every tab.** The owner's own words:
   "all collections on all chains of all types need ALL features in all
   tabs. The only coming soon is the vault-related and index-related
   features." Vault (`MarketplankVaultV3` and its Instant Swap surface —
   Robinhood Chain-specific, no multichain equivalent exists or is being
   asked for) and the planned Global Index (`SPEC-GLOBAL-INDEX-ULTIMATE-
   FORM.md`, not yet built) are the ONLY features allowed to stay
   chain-limited. Everything else — Buy&Sell, Offers (single-token AND
   criteria/rarity/trait/combo), Activity, My NFTs, My Listings, sweep,
   batch, bundle — needs a real, working answer for Bitcoin Ordinals,
   Solana, and every tracked foreign EVM chain, not just Robinhood Chain.

---

## Non-negotiable invariants (read before proposing anything)

These are load-bearing, already-audited, or architecturally fixed. A
proposal that violates one of these is not "state of the art," it's wrong
for this codebase specifically:

- **This app never holds or signs with a private key, on any chain.**
  Every trading module (`lib/market/multichain/trading/*`) constructs
  unsigned transactions/PSBTs/instructions server-side; the user's own
  wallet extension signs. Any proposed mechanism must preserve this
  boundary exactly.
- **Never fabricate data.** Every adapter in `lib/market/multichain/
  adapters/` returns `null`, not an invented value, when a real source
  doesn't have the answer. This extends to game-theoretic proposals: don't
  propose a mechanism that requires assuming data this app can't actually
  obtain.
- **Fail closed, not open**, on missing capability (unset API key, unsupported
  chain, audit not yet passed). See `native-bitcoin-listing.ts`'s
  `NATIVE_BITCOIN_MAINNET_ENABLED` gate — real money stays off by default
  until a real bar is cleared, never the other way around.
- **Real venues, not synthetic liquidity.** This app routes real
  transactions to real third-party programs/contracts (Seaport for EVM,
  Magic Eden's Auction House for Solana, its own audited-in-progress PSBT
  engine for Bitcoin) — it does not (and per `magiceden-solana-trade.ts`'s
  own header, deliberately will not) insert an aggregator layer skimming
  an extra fee on top.
- **One mechanism, many chains, where the underlying primitive genuinely
  generalizes** (see `lib/market/bulk-list.ts`'s reuse across Robinhood +
  foreign EVM) — **but never force a shared abstraction where the chains'
  actual constraints differ** (see `magiceden-solana-trade.ts`'s "SOLANA
  HAS NO SEAPORT EQUIVALENT" header for why Solana trading is
  necessarily per-venue, not folded into the EVM path).

---

## Gap inventory — every known open item, with real current state

### 1. Data completeness (floor / 24h change / volume / sales / listed-count) across every chain and collection

**Current real state**: `lib/market/multichain/store.ts` and the sync loop
in `scripts/refresh-market-data.ts` pull from exactly ONE venue per chain
(UniSat for Bitcoin, Magic Eden/Helius for Solana, OpenSea/Alchemy for EVM).
Throughput is bounded by a shared batch size across ALL chains' staleness
queue (verified live this session: chains registered later in the sync
order starve). A real, already-found-and-partially-fixed bug: Solana rows
registered through the `helius-solana` adapter were written with their
contract address (a case-sensitive base58 pubkey) force-lowercased,
permanently corrupting tens of thousands of rows — the write-path fix
already landed (`store.ts`'s `normalizeContractAddress`), but the already-
corrupted historical rows were never re-migrated.

**Research this**: What's the actual state-of-the-art architecture real
multichain indexers (The Graph, Reservoir, SimpleHash, Alchemy's own NFT
API, Helius' own DAS) use for (a) fair, starvation-free scheduling across
heterogeneous chains with wildly different collection counts, and (b) safe,
idempotent, resumable backfill/re-migration of a large corrupted dataset
without downtime? Is there a real, provable priority-queue or weighted-
fair-queuing algorithm (beyond this app's current simple
"oldest-synced-first" ORDER BY) that would guarantee every chain makes
real, bounded-worst-case progress regardless of its total row count?

### 2. Cross-marketplace aggregation (floor/volume/listed pulled from EVERY venue trading a contract, not just one)

**Current real state**: confirmed, this session, genuinely unbuilt —
not a bug, a real missing feature. No adapter queries more than one venue
per chain.

**Research this**: How do real aggregators (Reservoir Protocol, Blur's own
cross-marketplace order book, OpenSea Pro/Gem) architect true multi-venue
floor/volume aggregation — normalized order books across marketplaces with
different fee structures, different royalty enforcement, different
liquidity depth? What's the correct way to present a single "floor" number
when it's sourced from N venues with different real settlement risk (one
venue's listing might be stale/unfulfillable in ways another's isn't)? Is
there a real, elegant game-theoretic argument for how a sweep should route
across venues to minimize total cost (this is a real weighted matching /
knapsack problem — has anyone published a genuinely good algorithm for
optimal cross-venue sweep-order construction under gas-cost and
price-impact constraints)?

### 3. Solana Sell tab

**Current real state**: JUST SHIPPED this session — real end-to-end path
(`app/api/market/multichain/solana-sell-instruction/route.ts`,
`listSolanaTokenNow()` in `lib/market/multichain/trading/foreign-fulfill.ts`,
`components/market/NativeSolanaListForm.tsx`), wired into
`MultichainCollectionView.tsx`'s Sell tab. Single-price-mode only (no
per-item pricing yet, no bulk/bundle equivalent to the EVM side's
`NativeBundleListForm`). Inert until `MAGICEDEN_API_KEY` is configured
(fails closed correctly).

**Research this**: Should Solana bundle/batch listing exist at all given
Magic Eden's Auction House has no native multi-item atomic listing
primitive the way Seaport's bulk order support does? Is there a real
address-lookup-table / versioned-transaction pattern (Solana-native) that
lets N listing instructions be submitted with fewer total signature
prompts than this app's current one-signature-per-item sequential loop?

### 4. Bitcoin native listing — mainnet gate, currently FAILED per a real Opus security audit (2026-08-20)

**Current real state**: `lib/market/multichain/trading/native-bitcoin-
listing.ts` implements real PSBT construction (SIGHASH_SINGLE |
ANYONECANPAY, sourced from OpenOrdex's real protocol). A rigorous audit
this session found it **passes for testnet4 piloting, fails for mainnet**,
with one CRITICAL open item: **no code anywhere verifies that a listing's
claimed `inscriptionId` actually lives on the UTXO being listed** — a real,
working fraud primitive (list a worthless UTXO under a blue-chip
inscription's id; the buyer's transaction is fully valid and pays real
money for a worthless sat, irreversibly). A migration comment
(`026_native_bitcoin_listings.sql`) claims this verification exists; it
doesn't. Also found: no spent/staleness check on listed UTXOs, the
burn-prevention math sources from the DB instead of the cryptographically
committed PSBT value, no seller-cancel route exists at all, and the one
UI panel (`NativeBitcoinListingsPanel.tsx`) is hardcoded to testnet4 with
no real mainnet-safe variant yet.

**Research this**: What's the real, proven state-of-the-art way to bind an
Ordinals inscription's identity to a specific UTXO in a PSBT-based listing
protocol, verifiable by a third party without trusting the lister's claim?
(Real indexers — ord, UniSat's own indexer, Ordinals Wallet's — expose
`inscriptionId -> current UTXO` lookups; what's the correct verification
protocol: check at listing time only, at fulfillment time only, or both,
and what's the right behavior if the inscription moved between listing and
fulfillment — auto-invalidate, or require re-signing?) What's a real,
minimal, signature-authenticated cancel-listing PSBT pattern for a
SIGHASH_SINGLE|ANYONECANPAY listing that was never meant to require the
seller's continued online presence?

### 5. Trait / rarity / criteria / combo offers — parity across Bitcoin and Solana

**Current real state**: rarity and inline trait filtering already render
uniformly across every chain (`RarityFloorStrip`, gated only on whether
rarity data exists, not on chain — confirmed this session). But the
EVM-native criteria/combo offer flow (`TraitCriteriaPicker.tsx`, the
"Build a criteria bid" UI shown in the owner's own screenshot) is built on
Seaport's real on-chain criteria-proof mechanism (a merkle-root-committed
set of eligible token IDs, verified at fulfillment time by the Seaport
contract itself) — there is no Solana or Bitcoin equivalent of that
specific mechanism.

**Research this**: Tensor and Magic Eden both have real, live trait-bidding
and collection-wide bidding on Solana (confirmed via research this
session) — what's their actual on-chain mechanism (escrow-based? merkle
proof? something else)? Is it something this app can integrate against
directly (same "call their real program" pattern as the rest of its Solana
trading code), or does it require building a bespoke Marketplank-native
equivalent? For Bitcoin: is there ANY real precedent (Magic Eden had
"collection trait offers" before exiting Bitcoin in March 2026 per this
session's research — what was that mechanism, and does any surviving
Bitcoin marketplace — UniSat, Gamma, Ordinals Wallet — have a working
real one today?) or is a PSBT-native criteria-offer primitive genuinely
unbuilt anywhere in the ecosystem, meaning this app would be first? If so,
propose the actual mechanism design: how does a buyer commit to "I'll pay
X for ANY inscription matching trait Y" in a PSBT-based, no-custody,
SIGHASH_SINGLE-compatible way?

### 6. Sweep / batch / bundle UX — universal, not EVM-only

**Current real state**: sweep (`ForeignSweepConfirm`/
`ForeignCombinedSweepConfirm`) already renders for every chain, with
`isBitcoin`/`isSolana` only adjusting sequencing (confirmed this session).
Bundle/batch LISTING was EVM-only until this session's Solana Sell-tab
work (single-price only, no bundle yet). Bitcoin has none.

**Research this**: real batching mechanics differ fundamentally per chain
— EVM can genuinely batch N purchases into one atomic transaction (a real
multicall), Solana can pack multiple instructions into one versioned
transaction up to its size limit, Bitcoin's PSBT model has no equivalent
"one signature, many purchases" primitive the way EVM/Solana do (every
UTXO-spending input needs its own witness). What's the real state-of-the-
art UX pattern proven marketplaces use to make a Bitcoin multi-item
purchase feel like "one sweep" to the user even though it's mechanically
N separate signature prompts — batched wallet-extension APIs
(`signPsbts` plural, which UniSat/Xverse/Leather may or may not support),
a single combined PSBT with multiple seller inputs (does SIGHASH_SINGLE|
ANYONECANPAY actually allow combining multiple independent sellers'
signed inputs into one buyer-constructed transaction — this may already
be mechanically possible and just unbuilt)?

### 7. Activity feed parity (excluding vault-specific content, which stays Robinhood-only)

**Current real state**: `ForeignActivityFeed` exists and is used for
foreign chains; the native `ActivityFeed`/`ActivityStats` includes vault
liquidity trades (Add LP/Redeem/Deposit) which have no multichain
equivalent and correctly should NOT be replicated per the owner's own
"vault stays coming-soon" exception. Need to verify: does the foreign feed
have full parity for sales/listings/transfers/offers activity (the
non-vault content), across all three chain families, with the same price-
history charting (`SALES PRICE` graph in the owner's screenshot) the
native feed has?

**Research this**: what's the real state-of-the-art pattern for unifying
an activity feed sourced from fundamentally different event models — EVM
log events, Solana program logs / transaction history, Bitcoin's UTXO
transfer graph (no "event log" concept at all, activity has to be
reconstructed from chain state transitions)? Real multichain explorers/
indexers (Dune, Flipside, mempool.space's own address-activity views) —
what's their actual reconciliation approach for presenting one unified
timeline across such different primitives?

### 8. Instant Swap — parity across chains

**Current real state**: `NativeSwapForm` is currently `isForeignEvm`-gated
(EVM-only), same tier as the old Sell-tab gate. Needs the same
chain-by-chain feasibility research as Sell: does an instant-swap
primitive (offer-your-NFT-for-their-NFT-plus-differential) have a real
Solana equivalent (does Magic Eden or Tensor support NFT-for-NFT swaps
natively, or does this need a bespoke escrow), and any Bitcoin equivalent
at all given Ordinals' UTXO model?

### 9. Everything above, multiplied across every already-tracked chain

Not just Bitcoin/Solana — the 7 other foreign EVM chains (`FOREIGN_CHAINS`
in `foreign-chain-registry.ts`) already mostly share the Seaport mechanism,
but confirm per-chain: does every one of them have a real, live,
sufficiently-liquid Seaport deployment, a real RPC this app already trusts,
and no chain-specific quirk (a fee-on-transfer token, a non-standard
royalty enforcement, an L2-specific gas-estimation issue) that would make
"same mechanism, different chain ID" not actually true in practice?

---

## What "done" looks like

For each gap above, a genuinely state-of-the-art answer:

1. Names the real, current best-in-class implementation(s) this was
   researched against (not assumed — actually found and read).
2. Explains WHY that mechanism is correct (the underlying game-theoretic
   or cryptographic argument, not just "this is what X does").
3. Proposes the concrete adaptation for THIS codebase's real architecture
   (file-level: what changes, what's reused unchanged, what invariant from
   the "Non-negotiable invariants" section it respects).
4. Is honest about residual risk or genuine novelty where no existing
   precedent fully solves it — propose the best original mechanism design
   in that case, reasoned from first principles, not hand-waved.

Leave nothing out. Every chain, every collection type, every tab, every
wiring between them.
