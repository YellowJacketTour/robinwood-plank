# DESIGN — Permissionless N-Vault Factory, Sybil-Resistant Index Admission, and Exchange-Rate Value Accrual

**Status:** design only. No `.sol` changes accompany this document.
**Baseline verified:** `bd99ab5` on `feat/global-index-vault` — 13 facets, 627/627 contract tests, Diamond Stages 0–7 complete (see `DESIGN-DIAMOND-UNIFIED-ARCHITECTURE.md` and `HANDOFF-BULLISH-FULL-2026-08-06.md`).

**What this document is answering.** The system as built today is: one governance-curated index, fed by pull-claim dividends, admitting constituents only through a privileged, timelocked `queueListing`/`executeListing` role. The requested end state is different in three specific ways, and this document treats each as a real architecture question, not a parameter tweak:

1. **N vaults, one per collection, launched permissionlessly** — not governance-approved one at a time.
2. **Every vault's fee activity mandatorily routes upward** into the index's value — not opt-in, not something a listing vote decides case by case.
3. **Index-coin value accrues by exchange rate, not by claim** — so it works identically whether the coin sits in a wallet, a Uniswap pool, or a lending market, with zero claim transaction ever required.

Each of these has a real, hard engineering question buried in it, and this document does not paper over any of them.

---

## 0. Executive summary — verdict table

| Requested piece | Verdict | One-line reason |
|---|---|---|
| **Permissionless vault factory, one per collection ID** | **Adopt** | This is a standard, well-understood pattern (Uniswap-v2-style `create2` factory keyed by a unique identifier) — no genuine risk beyond getting the uniqueness key and the immutable-fields lockdown right. |
| **Collection owner may only update the vault's treasury address** | **Adopt, with a timelock on the update itself** | Matches the existing scoped-capability pattern already used everywhere else in this codebase. An instant-effect treasury change is itself a rug vector; delay it the same way every other privileged mutation in this system is delayed. |
| **Fees pegged to Marketplank's schedule unless rare admin override** | **Adopt** | Directly portable from `MarketplankVaultV3.sol`'s existing fee-ceiling pattern (§2). |
| **Mandatory, non-optional fee auto-routing from every vault to the index** | **Adopt the mechanism, reject the framing "automatic transfer"** | A vault cannot literally push funds into a contract it doesn't know exists at its own deploy time and stay upgrade-free. The correct mandatory mechanism is a **fixed, un-opt-outable split baked into the vault's own fee-collection code path**, routed to an immutable per-vault "upstream sink" address set once at vault construction — not a live cross-contract call the index vault has to trust. §3. |
| **Sybil-resistant, permissionless auto-admission of a vault into the index** | **Adopt a maturity-curve + economic-dominance design, new to this codebase** | Nothing in either this repo or the Garden Exchange reference project solves this exact problem off the shelf — this is genuinely new design, built from proven primitives from both. §4. |
| **Exchange-rate value accrual, replacing pull-claim dividends** | **Adopt, and it materially simplifies the system** | This is the correct model for "works anywhere the coin sits, no claim step" — and it happens to *delete* code rather than add it: no `claimDividend`, no `pendingClaim` bookkeeping, no per-holder accumulator. §5. |
| **A hard, on-chain-enforced non-decreasing-NAV invariant** | **Adopt, ported from Garden Exchange's proven conservation law** | Garden Exchange's `NAV' ≥ NAV` invariant is `[PROVEN]` and consensus-enforced per-transaction there, not a design intention. The same shape closes the same class of problem here. §5.3. |
| **Auto-*removal* of an underperforming vault from the index** | **Adopt with an explicit, permissionless trigger — but state the real limit** | Removal can zero a vault's *future* contribution weight automatically; it cannot literally un-mix already-mixed backing that's already fungible with every other constituent's value, and this document says so rather than imply an undo button that doesn't exist. §4.4. |

---

## 1. Why "just let each vault push funds into the index" doesn't work, and what does

The most literal reading of "mandatory, all fees auto-route to the index" is: every vault, on every fee event, calls a function on the index contract to hand it money. This has a real problem, and it's worth stating precisely instead of hand-waving past it.

**A permissionlessly-deployed vault cannot safely hold a live reference to the index contract and call into it unconditionally.** Two independent failure modes:

- **Bricking on push-failure.** If the index vault ever reverts, pauses, or (post-freeze) simply doesn't exist yet at the moment a collection vault is deployed, a design that requires a successful cross-contract call on every fee event means a completely unrelated collection's mint/redeem path now fails whenever the index has any problem at all. This inverts the isolation property `MarketplankVaultV3.sol` already guarantees today (each vault is independently deployed and stands alone).
- **Trust asymmetry.** A live call from N permissionless vaults into one shared index means the index contract's function is now callable by anyone who deploys a vault — it becomes, de facto, a second admission surface with none of the guardrails governance-gated `executeListing` has today.

**The mechanism that actually satisfies "mandatory, no opt-out, no discretion" without either failure mode:** every collection vault's constructor is issued one immutable address at deployment time — its **upstream sink**. The vault's own fee-collection code path (the same code that currently does `accruedFees += fee` and later `withdrawFees()` to a fixed `treasury`) is modified so a fixed, non-adjustable fraction of every fee event routes to the sink instead of (or alongside) the treasury, using the exact same pull-based pattern already proven safe in `MarketplankVaultV3.sol:638-642` — the sink *receives* value, it is never *called into* on the hot path, and a problem on the sink side degrades to "unclaimed balance sits there," never "unrelated vault's mint/redeem reverts."

The sink address itself points at a **per-vault accrual ledger inside the index**, not at a live push target — see §3.2.

---

## 2. The vault factory

### 2.1 Uniqueness and immutability

One vault per collection ID, `create2`-deployed from a factory keyed by `keccak256(abi.encode(collectionContractAddress))` (or, for non-ERC-721 asset types, whatever canonical on-chain identifier is unambiguous). The factory reverts if a vault for that key already exists — this is the entire admission gate for *launching* a vault, and it is genuinely permissionless: no allowlist, no fee, no approval, matching the requirement directly.

Every economically-load-bearing parameter is `immutable`, set once in the constructor, mirroring `MarketplankVaultV3.sol:151-159` exactly:
- the NFT collection address
- `mintFeeWei` / `redeemFeeWei` / `swapFeeBps`, defaulted to Marketplank's existing schedule and its existing hard ceilings (`MAX_MINT_FEE_WEI = 0.05 ether`, `MAX_SWAP_FEE_BPS = 100`, already proven in the live contract — reuse the ceilings verbatim, don't re-derive them)
- the upstream sink address (§1)
- the mandatory routing fraction (a protocol-wide constant, not creator-settable — see §0's rejection of "vaults choose whether to contribute")

### 2.2 What the collection owner can actually change

**Only the treasury address**, and only through the same queue/execute timelock pattern already built and proven in `IndexGovernanceFacet.sol:140-152` and, post-review, in `HookRegistryFacet.sol`'s `queueHook`/`executeHook` split (§ review-fix `2742db4`). An instant-effect treasury change is a real rug vector on a permissionless factory specifically because there is no admission committee checking who deployed each vault — the timelock is the only thing standing between "creator changes payout address" and "creator changes payout address to something malicious the moment before a large redemption."

**Everything else about a deployed vault is frozen at construction**, same principle as the index's own `IndexDeployer` atomicity argument — a factory-deployed vault with a mutable fee schedule or a mutable sink address is a vault whose creator can quietly change the deal after depositors have already committed capital.

### 2.3 Rare admin override

A single, protocol-level (not per-vault) governance action, timelocked identically to every other risk parameter in this system, can grant one specific vault a fee schedule outside the default ceiling — for a genuinely exceptional case (e.g. a high-value blue-chip collection with a negotiated institutional fee arrangement). This is explicitly rare, explicitly public, and explicitly not something a collection owner can grant themselves.

---

## 3. Mandatory fee routing, precisely

### 3.1 What actually flows, and when

On every fee-generating event inside a factory vault (mint, redeem, swap), the mandatory routing fraction — proposed default: mirroring the already-governed 20% ecosystem split constant from `IndexFacetBase.sol:108-109` (`DEFAULT_ECOSYSTEM_SPLIT_BPS = 2_000`, ceiling `CEIL_ECOSYSTEM_SPLIT_BPS = 3_000`) — is credited to that vault's balance owed to its upstream sink, using the identical `accruedFees`-style pattern already in `MarketplankVaultV3.sol`. The remainder stays with the vault's own treasury, exactly as today.

### 3.2 How it reaches the index without a live cross-vault call

The upstream sink is **not** the index contract's address directly. It is a small, dedicated, permissionless-to-call **collection point** — any address (a keeper, the collection owner, a curious holder, anyone) can call `sweep(vaultAddress)` on it at any time, which pulls the accrued balance from a factory vault into the index's accounting via the *index's own* `syncConstituentBalance`-style reconciliation, already proven safe in `IndexBootstrapFacet.sol:127-143`: it only ever credits a surplus that has *already* physically arrived as a real balance, never a caller-supplied number.

This means: no factory vault ever makes an outbound call to the index. The index only ever pulls, permissionlessly, from balances that are already sitting in a place it independently verifies — the same "never trust a self-reported value" principle the Garden Exchange solver-surplus threat model states explicitly: *"No external indexer, venue, solver, or UI calculation is authoritative... a solver could self-report arbitrary surplus and use the puzzle as an unaudited mint/accounting oracle."* The collection point is that same discipline applied here: it moves money, but it is never trusted to say how much value that money represents — the index re-derives that itself from its own balance delta.

---

## 4. Sybil-resistant, permissionless auto-admission

This is the genuinely new design surface. Neither this codebase nor the Garden Exchange reference project has an existing answer — the Garden Exchange extraction confirmed plainly that Garden is a single monolithic singleton with no registry-of-sub-vaults concept, and its factory-allowlist capability is explicitly human-governed, not automatic. What *does* generalize from Garden Exchange is the underlying discipline, and this design applies it to a problem Garden itself never had to solve.

### 4.1 Why identity-based gating is the wrong tool

A permissionless factory means anyone can deploy any number of vaults, including many vaults for fake or wash-traded "collections" designed purely to farm inclusion in the index and dilute real holders' backing. Gating admission by identity (KYC, an allowlist, a reputation score) is exactly the tool sybils defeat by construction — you cannot out-verify an attacker willing to deploy a thousand throwaway wallets.

### 4.2 The mechanism that actually resists this: economic dominance, not identity

Directly generalizing the Garden Exchange result — *"an honest depositor yields 7.58× more matured weight per dollar than a washer at every reachable state; no donation- or attribution-capture threshold flips the sign"* — the design goal is not to detect fake volume, it is to build an admission formula under which **generating fake volume is provably worse, in expectation, than not bothering**, for every attacker, at every scale, with no threshold to tune.

Concretely:

- **Admission weight is computed only from confirmed, on-chain fee receipts already collected via §3** — never from a self-reported volume figure, never from anything read off an external price feed the vault operator could manipulate. This mirrors the regenerative-metrics rule directly: *"All rankings derive from confirmed transition receipts... never a reward weight"* for anything not a receipt.
- **Admission weight matures over a fixed on-chain window**, using the same shape as Garden's `m(Δh) = Δh / (Δh + K)` maturity curve — a vault's contribution counts progressively more the longer its fee history has existed, and a vault that appears, generates a fee-wash burst, and immediately tries to claim admission gets `m(0) ≈ 0`: negligible weight, for negligible reward.
- **Self-dealing is structurally unprofitable, not merely discouraged.** A collection owner who mints/redeems against their own vault to inflate its fee history pays the real mint/redeem fee ceiling on every wash cycle (§2.1's ceilings are not waivable) — the wash-trader is paying the protocol its own real fee on every unit of fake volume it generates, and receiving back only a maturing fraction of a share of index inclusion. As in the Garden result, there is no volume level at which this trade turns net-positive, because the cost (real, paid-out fee) scales linearly with the fake volume while the benefit (maturing admission weight, itself capped — see §4.3) does not scale past a ceiling.

### 4.3 Objective, permissionless admission trigger

Any address may permissionlessly call `checkAdmission(vaultAddress)` on the index. The call succeeds (admits the vault as a constituent, at a starting weight of zero, ramping in exactly as `IndexBootstrapFacet.sol`'s existing `rampStart`/`rampDuration` mechanism already does for governance-approved listings today) only if the vault's on-chain, receipt-derived, maturity-weighted fee history exceeds a fixed, protocol-wide, non-per-vault-negotiable threshold. No human approves this. No governance vote is required. The threshold itself is a risk parameter, changeable only through the existing timelocked governance path, uniformly for every vault — never case by case, which is precisely what prevents it from becoming a second, informal listing committee.

### 4.4 Removal — what it can and cannot honestly do

A vault whose maturity-weighted fee activity falls below a (separately governed, necessarily lower than the admission threshold, to avoid flapping) floor for a sustained on-chain window becomes permissionlessly ejectable the same way it became admittable: anyone can call `checkRemoval(vaultAddress)`.

**What removal actually does:** it zeroes that constituent's ongoing target weight, so no further deposits are routed toward it and its ramp-out follows the existing weight-ramp mechanism already proven in `IndexBootstrapFacet.sol`.

**What removal cannot do, and this document will not claim otherwise:** value already contributed by that vault, once mixed into the shared backing pool and reflected in the index coin's exchange rate (§5), is fungible with every other constituent's contribution. There is no "give back the bad collection's specific dollars" operation, because after mixing there is no longer a "specific dollars" to identify — this is true of every basket/index design that has ever existed, not a gap unique to this one. The defense against a bad constituent doing real damage is therefore entirely in §4.2's admission-side economics (make the attack unprofitable before it's ever admitted), not in a removal mechanism that could undo damage after the fact. Removal is real and useful for stopping *ongoing* dilution — it is not a refund.

---

## 5. Exchange-rate value accrual

### 5.1 The problem this replaces

Today, `IndexDividendFacet.sol`'s `claimDividend` and `IndexCoreFacet.sol`'s `claimPending`/`claimPendingMany` require the holder to actively call a claim function to realize yield. This is proven safe and gas-cheap (§ prior adversarial review, `627/627` tests) — but it has exactly the limitation named directly in conversation: a coin sitting inside a Uniswap pool, a lending market, or any contract that doesn't know to call a claim function on the holder's behalf, never receives that yield. No token issuer can fix this by adding more claim logic — the pool contract itself would have to be aware of the claim, and it isn't.

### 5.2 The model that actually solves it, and why it's proven elsewhere

Switch from "constant supply, holder claims a separate payout" to "constant supply, each unit's redeemable value rises" — the model used by every major liquid-yield-bearing token (stETH being the canonical example) specifically because it is the only model where value-accrual requires zero code awareness from whatever contract happens to be holding the token at the time. A Uniswap pool holding the coin doesn't need to know anything special — the pool just holds an asset that happens to be worth more tomorrow than today, exactly like holding an appreciating asset the pool already knows how to hold.

Mechanically, this **removes** functionality rather than adding it:

- `claimDividend`, `pendingClaim`, `reservedClaims`, the magnified-dividend accumulator in `IndexFacetBase._creditDividends` (`:791-822`) — all of this exists specifically to solve "pay out value without changing supply." Under exchange-rate accrual, none of it is needed: a fee event (§3) increases the vault's total backing (`totalReserveValue`), total share supply is unchanged, so `redemptionValue = totalReserveValue / totalSupply` rises on its own. `redeemProRata` (`IndexCoreFacet.sol:136-164`) already computes a holder's payout from exactly this ratio — the redemption math barely changes; the removed code is entirely the *distribution* machinery, not the *redemption* machinery.
- Reward streams (`IndexStreamFacet.sol`) similarly stop being a separate vesting-and-claim system and become, simply, another source of backing added to `totalReserveValue` — vesting still matters (§5.4) but it now vests *into the reserve number*, not into a claimable balance.

### 5.3 The non-decreasing invariant, ported and made concrete

Garden Exchange's proven result — `NAV' = (V/S)·(S − m·u)/(S − u) ≥ V/S`, enforced per-transaction, consensus-checked, not just intended — generalizes here as a hard, testable invariant on every state-mutating function:

> **`redemptionValue` after any mint, redeem, fee-credit, or sweep event must be `≥` `redemptionValue` immediately before it, with equality permitted only on a pure pro-rata mint (which by definition changes supply and backing in the same ratio) or a pure pro-rata redemption at exactly the current rate.**

Concretely, this becomes a real, checked assertion, not a comment: every function that changes `totalReserveValue` or `totalSupply` computes `redemptionValue` before and after and reverts if the post-value is lower than the pre-value outside the two permitted equality cases. This is directly checkable in the existing test harness the same way `627/627` already checks other invariants, and it is the same discipline as `IndexBootstrapFacet.sol:127-143`'s "only credit a surplus that's actually arrived" — the invariant is enforced by the code path itself, not merely documented as a design goal.

### 5.4 Where mint-timing manipulation has to be re-closed

Removing the claim-based accumulator does not remove the underlying attack the current `_revestOnMint`/dilution-guard logic (`IndexFacetBase.sol:906-931`, rounds 9e/9f) defends against — it changes its shape. Under exchange-rate accrual, the equivalent attack is: mint immediately before a large fee-credit event lands, capture a share of the resulting `redemptionValue` bump you didn't earn, redeem immediately after. The existing `DILUTION_REVEST_MULTIPLE`-based re-vesting mechanism (§ Stage 5, already adversarially reviewed) is the right shape to reuse here — it was built for exactly this class of problem, just needs its trigger re-pointed from "protect claimable stream balance" to "protect not-yet-recognized backing," which is a re-scoping of proven logic, not new logic.

---

## 6. What this document explicitly does not resolve

Consistent with the standard this codebase holds itself to elsewhere: three things below are real open questions, not decided here, and should not be treated as settled by this document's existence.

1. **The exact numeric admission/removal thresholds (§4.3/§4.4)** are a risk-governance decision, not an engineering one — this document specifies the *shape* of the mechanism (maturity-weighted, receipt-derived, uniform-not-per-vault), not the number.
2. **Non-ERC-721 asset types** (fungible collections, RWAs) need their own canonical-identifier scheme for the factory's uniqueness key (§2.1) — this document only worked through the ERC-721 case in detail.
3. **The sweep/collection-point contract (§3.2) is described at the mechanism level, not specified down to function signatures** — it is a real, buildable piece but has not yet been designed to the depth the rest of this document reaches.

These are the genuine next design increments, in roughly that priority order.

---

## 7. Unified, implementation-ready specification (post-interview)

Everything below was resolved through direct back-and-forth after §6 was written and is now decided, not open. This section is the actual build spec — §§1–6 remain the reasoning and precedent behind it.

### 7.1 Earnings model — final

Value flows only to index-coin holders. No separate creator cut, no separate collector-community cut, at the index layer. A creator's upside is entirely their own vault's real usage (already sybil-resistant by construction) plus their share of the mandatory-routing split below. Rejected explicitly because stacking a second reward on the same wash-tradeable signal (a creator's own vault activity) would reopen §4.2's closed gaming surface.

### 7.2 Mandatory fee routing — final, two independent streams

**Stream A — mint/redeem fees.** Artist-selectable split between local treasury and the index's upstream sink, **floor 8.1% to the index, ceiling governed** (reuse the existing `CEIL_ECOSYSTEM_SPLIT_BPS`-style bounded-range pattern). Chosen once, changeable only through the same timelock already used for the collection's treasury address.

**Stream B — swap fees, factory-vault default.** New factory-deployed vaults default `swapFeeBps = 100` (1%, the existing `MAX_SWAP_FEE_BPS` ceiling already live in `MarketplankVaultV3.sol` — not a new risk parameter). Split **50% stays in the local pool's own reserve** (standard AMM fee-compounding, deepens that collection's own liquidity), **50% credited toward the upstream sink**, using the same `accruedFees`-style pattern as today's `swapFeeBps` handling. Justification for 1% over the live product's lower default: Uniswap v3's own published fee-tier guidance puts exotic/illiquid/high-volatility, no-competing-venue pairs — exactly a single-vault-native NFT-collection share — in the 1% tier; this is real precedent, not an arbitrary number, and it is bounded by a ceiling the team already vetted. Honest cost: round-trip (buy+sell) friction rises from ~0.6% to ~2%, accepted because these venues compete on breadth/depth of exposure, not lowest-spread.

**Collection point (§3.2), corrected — push-then-opportunistic-reconcile, not keeper-swept.** A vault never calls into the index's logic; it performs a **plain token/ETH transfer** to the index's own address, atomically, inside the same transaction as the triggering trade — a plain transfer cannot revert the vault's transaction (standard ERC-20 transfers execute no receiver code) so this cannot brick an unrelated vault. The index does not require a keeper to notice this: **every normal interaction with that constituent (the next mint or redeem touching it) opportunistically reconciles any surplus sitting at the index's own address before using `c.reserve`**, applying the same "credit only an observed balance delta, never a self-reported number" rule already proven in `syncConstituentBalance`. A permissionless `reconcile(token)` entry point exists purely as a backstop for a constituent quiet on the index side — the same category as calling `sync()` on a Uniswap pool, callable by anyone, required of no one, not a team operational task.

### 7.3 Value accrual — corrected to a three-stream hybrid (supersedes the original full-deletion call)

**Correction to the earlier version of this section:** it originally deleted `claimDividend`/`_creditDividends` entirely in favor of pure NAV appreciation. That was wrong, not because the appreciation model is wrong, but because it throws away a real, proven, industry-standard mechanism to solve a problem appreciation alone can't: giving holders genuine, claimable cash. Every routed fee (§7.2, §7.10) now splits three ways, each solving a distinct requirement, validated by real precedent rather than invented:

| Stream | Mechanism | What it uniquely solves | Precedent |
|---|---|---|---|
| **NAV appreciation** | Redemption value `= totalReserveValue / totalSupply`; routed fees raise `c.reserve` directly | Works even when the coin is sitting in an external pool or protocol — the only stream that survives the coin being deposited elsewhere | stETH / liquid-staking exchange-rate model |
| **Real cash claim** | `claimDividend`/`_creditDividends` — **kept, not deleted**, the existing capped EIP-2222 magnified-dividend accumulator | Genuine, claimable ETH for holders who hold directly — proven safe (pull-based, no holder-iteration DoS risk, capped against overpromising) | EIP-2222 (the "Funds Distribution Token" standard); GMX's real-yield model, 70% of real protocol fees paid directly to stakers |
| **Buyback-and-lock** | §7.7, funded from the ecosystem sub-split | Compounds value into every remaining circulating coin without a claim step at all | Hyperliquid's Assistance Fund — over 99% of fees to buybacks, ~$65M/month directed to holder value |

The honest limitation carried over from earlier analysis is unchanged: the cash-claim stream only reaches holders who hold directly, never coin parked in an external pool. That's fine now — the appreciation and buyback streams already cover that case, so every holder benefits regardless of how they hold, and holders who hold directly additionally get real GMX-style cash. `redeemProRata`'s weighted-basket math (`IndexCoreFacet.sol:70-114`, already proven) is unaffected by any of this — it was never the thing that needed to change.

The exact three-way split is a governed parameter (same timelock pattern as everything else); this section fixes the *shape*, not the numbers.

### 7.4 Non-decreasing redemption value — final, hard invariant

Every function that changes `totalReserveValue` or `totalSupply` computes redemption value before and after and reverts if it decreases, except the two permitted equality cases (a pure pro-rata mint or redemption at the exact current rate). Checked in code, tested the same way every other invariant in this suite already is (`627/627` pattern) — not a comment, not a design intention.

### 7.5 Sybil-resistant continuous weight — final, replaces binary admission/removal

No vault is ever removed. Weight is continuous, computed only from confirmed on-chain fee receipts (§7.2's swept flows are themselves the receipts — nothing self-reported), matured on the existing `m(Δh) = Δh / (Δh + K)` curve shape already proven for round 9e/9f, generalized as described in §7.6. Weight governs benefit/reward share only — new deposits still distribute per the existing weighted-basket rule (§7.3), so popularity cannot reshape the basket's composition. A dormant vault decays toward ~0 weight without ever being ejected, and can rise again — no discrete removal event, no clawback problem to solve.

### 7.6 Generalized maturity-vesting guard — final

Extends the existing Stage-5 `_revestOnMint`/`_addVest`/`_unvestedOf` mechanism from stream deposits specifically to **every** value injection (swept swap fees, swept mint/redeem fees, buyback-lock purchases, §7.7). Mechanically: split `c.reserve` conceptually into matured (counted in redemption value) and vesting (not yet counted); each fresh injection vests linearly over a governed window (reuse `STREAM_VEST_BLOCKS = 300` as the default, adjustable within the existing risk-parameter timelock pattern) before it counts. This is the "reward patience with zero lock" resolution: the coin itself is never frozen, fully liquid and poolable at every block; only the *timing* of when a specific injected dollar starts counting toward price is gated. Closes the generalized flash-mint-before-injection / flash-redeem-after-injection attack the same way round 9e/9f already closed the narrower stream-specific version.

### 7.7 Buyback-and-lock ("renounced liquidity") — final

Funded as a governed **sub-split of the existing 0–30% ecosystem bucket**, not a new fee. Buys index coin on the open market (from the dedicated pool in §7.10), sends it to the same dead-address pattern as the existing `SEED_LOCK_ADDR`. Locked coin never redeems, so every buyback permanently raises redemption value for every remaining circulating coin. Real risk flagged from precedent (a comparable protocol proposed 100% of fee revenue to buybacks and drew criticism for leaving nothing for other needs): this must stay a *portion* of the ecosystem split, governed and timelocked like everything else, never defaulted to 100%.

### 7.10 The index coin needs its own market — corrected mechanism (supersedes the earlier "recycle into originating pool" idea)

An earlier pass of this design proposed using routed ETH to buy more shares directly from whichever collection's pool it came from. That's wrong for two concrete reasons: repeated one-sided buying pushes against the buyer's own price impact (fewer shares bought per ETH each cycle) and systematically drains the share side of that pool's depth over time — the opposite of "deepens liquidity." The corrected mechanism:

1. **Shares arriving from any vault's sell-direction swap fee are minted into index coin first**, using the existing weighted-basket mint math (`mintProRata`/`mintSingleAsset`) — priced fairly against current reserve composition, which is the "pure pro-rata mint" case §7.4 already permits at unchanged redemption value. This is also the answer to "how do we weight shares from many vaults correctly" — the existing mint formula already handles any collection at any proportion; it doesn't need new logic, only a new caller.
2. **That freshly-minted coin pairs with the ETH arriving from the same activity** (mint/redeem fees, buy-direction swap fees — §7.2) and is deposited as **protocol-owned liquidity into one dedicated index-coin/ETH pool** — not fragmented across N per-collection pools. Every vault, across the whole network, feeds the same pool.
3. This pool runs its own 1% swap fee (kept at parity with the per-vault default rather than the initially-considered lower tier, given this is a niche asset class without the trading volume that would justify a tighter spread). Fee-coin from sells compounds directly back into the pool's own reserve — standard LP fee-compounding, no distribution.
4. **This pool is also where the real-cash-claim stream (§7.3) and the buyback-and-lock stream (§7.7) actually execute** — buybacks buy from this pool; and this pool is the venue a holder sells into if they want ETH in hand outside the claim mechanism. A permanently deepening, protocol-owned pool is what makes "arbitrage keeps the price honest" and "usable anywhere in DeFi" actually true in practice, not just true in principle — without this pool, the index coin has no liquid market at all.

Added complexity, stated honestly: this requires accounting for an LP position's own value (its share of pool ETH + coin reserves) inside `totalReserveValue`, not just flat token balances — comparable in scope to how Beefy/Yearn-style vaults value LP positions. This is real, additional engineering scope beyond what §§7.1–7.7 alone required.

### 7.8 What "ready for testnet" additionally requires

`IndexDeployer.sol` is explicitly not a deploy path today — "NOT FOR DEPLOYMENT to any network from this repo... exists so the property it creates can be TESTED, not so it can be run." Reaching genuine testnet-readiness requires, as its own reviewed piece of work: real network config in `hardhat.config.ts`, an actual deploy script that performs the same atomic deploy-cut-finalize sequence `IndexDeployer` proves in tests, and parameter-setting scripts for the genesis constituent list, initial governance roles, and the risk parameters named in §§7.2–7.7 (swap fee split, ecosystem sub-split, vesting window, admission threshold). This is not a side effect of building the contracts above — it is a distinct, separately-reviewable deliverable.

### 7.9 Build sequencing note

"Build in unison" here means: implement against this entire unified spec as one coherent target, verified as a whole before anything ships — not disjointed increments merged at different times. It does **not** mean multiple writers touching the same facets concurrently; §§7.2–7.6 and 7.10 share files (`IndexFacetBase.sol`, `IndexCoreFacet.sol`, `IndexGovernanceFacet.sol`, plus a new LP-position-valuation module for §7.10) and must be implemented by a single active writer at a time to avoid the exact concurrent-write corruption this project has already hit once and fixed by killing the stray process. Sub-pieces with no file overlap (e.g. §7.7's buyback contract vs §7.8's deploy scripts) may proceed in parallel; anything touching a shared facet may not.

Recommended real sequencing, given §7.10's added LP-accounting scope: (1) factory + §7.2's two fee streams + push-then-reconcile, (2) §7.3's three-stream hybrid on top of the existing (kept) dividend facet, (3) §7.5's continuous weight, (4) §7.10's dedicated pool + LP-position valuation — the largest, riskiest single piece, deserving its own adversarial review pass before anything touching it ships, (5) §7.6's generalized vesting guard, extended to cover §7.10's injections once that pool exists, (6) §7.7's buyback-and-lock, which depends on §7.10's pool existing to buy from, (7) §7.8's deploy tooling last, once every parameter it needs to set actually exists.
