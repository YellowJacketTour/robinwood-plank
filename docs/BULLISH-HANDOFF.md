# BULLISH HANDOFF — AXIOM-1 / Marketplank

**Purpose:** everything a competent external engineer needs to take this
protocol over cold — review it, commission an independent audit, and decide
whether to deploy it with real money.

**Repo:** `robinwood-plank-index-vault`
**Branch:** `integrate/dev-hh3` — PR [#62](https://github.com/YellowJacketTour/robinwood-plank/pull/62) into `dev`, **mergeable**
**HEAD at handoff:** see PR #62's latest commit; toolchain is **Hardhat 3** (migrated from Hardhat 2 in this branch — see PR #62's commit messages for the full list of real behavioral differences found and fixed)
**Suite:** `913 passing, 0 failing` (verified independently against the committed tree, not just a working copy, both immediately post-merge and again after the dependency fix below)
**Contracts:** byte-identical to the audited state throughout the entire Hardhat 3 migration — `git diff` across every merge/fix commit shows zero changes under `contracts/`. Every finding and fix described in this document and in the audit report is unaffected by the toolchain migration.
**Deployment status:** **never deployed to any network — not mainnet, not testnet.**
**Independent audit status:** **none. Zero external audits have been performed.**
**Prior branch:** [`feat/cvi-sota-axiom-1`](https://github.com/YellowJacketTour/robinwood-plank/pull/61) (PR #61) is the original audit-remediation branch, still on Hardhat 2 and **not mergeable** into `dev` (toolchain conflict). PR #62 supersedes it for integration purposes; #61 remains as the historical audit record.

This document is the entry point. Read it before any other doc in `docs/`.

---

## 1. What this is

A set of Ethereum smart contracts that turn NFT collections into
continuously-compounding, always-redeemable index positions.

Three layers, plain-language:

**Layer 1 — collection vaults.** Anyone can permissionlessly create a vault
for an NFT collection. Deposit an eligible NFT into it and you receive
exactly 1e18 units of that vault's ERC-20 share, called **`S`**. Burn 1e18
`S` and you get an NFT back. Each vault also runs its own internal
constant-product AMM (WETH ↔ `S`) and its own community liquidity pool, so
`S` is tradeable without leaving the vault.

**Layer 2 — the index.** A single EIP-2535 Diamond holds a weighted basket
of many vaults' `S` tokens, plus WETH, and issues its own ERC-20 index coin.
You can mint the index coin by depositing the basket pro-rata, or by sending
WETH once and letting the contract assemble the basket for you. You can
always redeem it.

**Layer 3 — the Energy Bus.** Every marketplace fee the system generates
lands as WETH at one immutable contract. Anybody — no permission, no keeper
role — can call `route()`, which splits that WETH six ways into fixed
pipes that buy inventory, deepen liquidity, burn supply, and pay yield.
Each of the six paths compounds by default rather than paying out.

The product claim, and the whole reason for the design, is narrow and
falsifiable: **every number this protocol displays is a number it can
actually pay.** Displayed value equals redeemable value. Nothing is marked
at a price the protocol could not realise if it had to sell.

**Terminology note.** There is **no xToken** and **no InventoryStake** in
this system. Both existed in earlier drafts and were deleted. Holding `S`
*is* the compounding position; there is no separate staking token and no
staking step. A vault is identified by `(collection, merkle predicate)`, not
by collection alone. If you find a doc using the old terms, it is retired
history — see `docs/AXIOM-1-DOC-INDEX.md`.

---

## 2. Current status, stated precisely

| Fact | Value | How verified |
|---|---|---|
| Tests | 913 passing, 0 failing | `npm run test:contracts` on `integrate/dev-hh3` (PR #62), Hardhat 3 |
| Audit findings (internal) | 6 CRITICAL, 8 HIGH, 5 MEDIUM — **all marked remediated** | `docs/AUDIT-2026-08-09-FULL-SOLIDITY.md` remediation table |
| Independent external audit | **none, ever** | — |
| Deployed to mainnet | **no** | — |
| Deployed to any public testnet | **no** | `scripts/deploy/axiom1-testnet.ts` has only been dry-run locally with `AXIOM1_DRY_RUN=1` |
| Upgradeability | **none.** `diamondCut` is renounced atomically in the deployer constructor | `contracts/diamond/IndexDeployer.sol`, `Diamond.finalize.test.ts` |
| Largest contract | `CollectionVaultFactory`, 22,723 bytes = **92.5%** of the 24,576-byte EIP-170 limit, 1,853 bytes spare | measured from `.hardhat-artifacts`; unchanged since the toolchain migration (contracts are byte-identical) |
| Dependency advisories | 0 high, 0 moderate, 11 low — **all dev-toolchain-only, confirmed absent from the production dependency tree** | `docs/DEPENDENCY-STATUS.md`, `npm audit` + `npm ls --omit=dev` |

**What "all findings remediated" does and does not mean.** It means the
authoring pipeline believes each finding is closed and wrote tests that
assert the fixed behaviour. It does **not** mean anyone independent has
confirmed that. See §5.

---

## 3. Architecture, and why each load-bearing choice is what it is

### 3.1 Collection vaults — `contracts/factory/`

- `CollectionVault.sol` — one per `(collection, eligibilityRoot)` pair.
  Holds NFTs, issues `S`, runs the internal AMM, hosts the community LP.
- `CollectionVaultFactory.sol` — permissionless CREATE2 deployer.
- `CollectionVaultLP.sol` — the vault's LP share accounting.

**Why a vault is `(collection, predicate)` and not `collection`.** The
statement "1 NFT → 1e18 `S`" is a *claim about fungibility*. Inside a
collection with rare and common items, it is false, and the falsity is
directly extractable: deposit a floor item, redeem a grail, pocket the
difference. NFTX addressed this with a targeted-redeem premium and needed
three separate Critical/High findings across two versions to get it roughly
right — and its auditor signed off only conditionally.

This design does not compensate for a false assumption; it makes the
assumption true. `deployPredicateVault(collection, treasury, sinkBps, root)`
takes a **merkle root over eligible tokenIds**, stored `immutable`. Deposits
require a merkle proof. Collapse the intra-vault variance and caller-chosen
redemption is harmless, with no premium mechanism to get wrong.

The root is immutable **because a mutable predicate is a rug**: an owner
could attract deposits against a tight band, then widen it to admit junk.

**Residual you must understand:** `deployVault(...)` still exists and creates
an **open** vault (`eligibilityRoot == bytes32(0)`, any tokenId admitted),
which is exposed to exactly the rarity-sniping loss described above. This is
deliberate and documented in the factory source. The argument for keeping it
legal is that the loss is *locally contained* — the sniped vault's own `S`
depreciates, its LPs leave, its measured depth falls, its weight falls, and
it stops receiving energy. Nothing propagates to the index or to other
vaults. **Whether that containment argument actually holds is a first-order
thing for an incoming auditor to attack.**

### 3.2 The meta-index Diamond — `contracts/diamond/`

An EIP-2535 Diamond with 21 facets (`contracts/diamond/facets/`). It holds
`S` from admitted vaults plus WETH, and issues the index coin.

`diamondCut` is renounced **atomically inside the deployer's constructor**,
behind three independent locks, plus `LibBytecodeScan` rejects
`DELEGATECALL`/`SELFDESTRUCT` in any installed facet. The diamond is never
observable in a cuttable state. This is genuinely good security engineering
and it carries a brutal corollary that dominates everything else in this
document: **there is no upgrade path, so every remaining bug is permanent.**

Admission and ongoing weight are computed by `contracts/energy/WeightModule.sol`
from on-chain signals — unrecoverable fee contribution, mint/redeem
pressure, windowed-minimum AMM depth, fee-denominated volume — and **never**
from an external floor-price oracle.

### 3.3 The Energy Bus — `contracts/energy/`

`EnergyBus.sol` plus six adapters in `contracts/energy/adapters/`. Verified
constants at `bff8e5c`:

| Pipe | Share | Adapter | Action |
|------|------:|---------|--------|
| Inventory buy | 35% | `InventoryBuyAdapter` | buys `S` into the index |
| Collection LP | 15% | `CollectionLpAdapter` | deepens each vault's locked liquidity |
| Index burn | 15% | `IdxBurnAdapter` | buys and permanently locks the index coin |
| PLANK burn | 10% | `PlankBurnAdapter` | buys and burns PLANK to `0x…dEaD` |
| PLANK LP | 10% | `PlankLpRenounceAdapter` | locks PLANK/WETH LP at `0x…dEaD` |
| Dividend | 15% | `DividendAdapter` | reinvested yield, opt-in cash claim |

`route()` is permissionless. If a pipe cannot complete safely, its funds
fall through to the dividend pipe rather than reverting the whole call — one
sick pipe never blocks the other five, and nothing is stranded. If nobody
ever calls `route()`, fees simply accumulate at the Bus address and **every
user's ability to exit is completely unaffected.** That last property is
what makes the keeper non-load-bearing.

Split ratios and adapter addresses are immutable after `finalize()`. The
honest narrowing of that claim, which the audit forced: **which adapter
receives what fraction is immutable; the venue each adapter trades against
is timelock-governed** (`PlankBurnAdapter.router`,
`PlankLpRenounceAdapter.{swapRouter, plankToken, lpPool}`).

### 3.4 Realizable-value pricing — the core idea

If the index needs to sell `s` units of a constituent whose AMM pool holds
`(x` WETH, `y` shares`)`:

```
realizable(s) = x·s / (y + s)         spot mark = s·x / y
```

The spot mark is what a naive index would print. The realizable integral is
what the index could actually get. Hold shares equal to the pool's own
reserve and realizable is **exactly half** the spot mark.

**Theorem.** Paying a WETH-exiting holder exactly `realizable(s)` is the
*unique* price at which remaining holders are unaffected. Pay more and the
exiter is subsidised by those who stay; pay less and the exiter is taxed by
them.

So the honest price and the fair price are the same number, and it is
**derived, never chosen**. There is no parameter here for governance to set
wrong. It is computed by the same constant-product formula the AMM itself
uses — no oracle, no new trust assumption.

All settlement in this system prices on this integral: `mintSingleAsset`,
`redeemSingleAsset`, every zap leg, and every Energy Bus purchase.

This is why the audit's C-2 (an inert slippage guard) was **deleted rather
than repaired**: once the price you pay already contains the impact, a guard
measuring impact is redundant. See `contracts/energy/adapters/InventoryBuyAdapter.sol:93`.

### 3.5 The two-door redemption model

**Door 1 — in-kind pro-rata (`redeemProRata`). Run-proof by arithmetic.**

Reserves `r₁…rₙ` against supply `T`. Redeeming `q` pays `(q/T)·rᵢ` of each,
leaving `rᵢ' = rᵢ(1−q/T)` and `T' = T−q`:

```
rᵢ'/T' = rᵢ(1−q/T) / T(1−q/T) = rᵢ/T
```

Per-share claim is **invariant** under redemption of any size, in any order.
No first-mover advantage exists → no run is possible → **no gate is ever
required.** This is why ETFs survive crises that suspend open-end funds.

Binding consequences, treated as inviolable design rules in this codebase:
`redeemProRata` is always open, oracle-free, and unblockable — no pause, no
fee, no allowlist, no governance reachability, ever. And because the
liquidity mismatch that motivates tranching, redemption queues, and interval
windows does not exist here, none of those mechanisms are present.

**Door 2 — WETH exit at realizable value (`redeemSingleAsset`).** A
convenience for people who want cash rather than a basket. Priced on the
integral of §3.4, so it never harms door 1. It is self-regulating: larger
exits get strictly worse fills, automatically. **The curve is the queue.**

Honest narrowing, again forced by the audit: **the free exit door is
oracle-free; the two priced convenience paths are oracle-dependent.**
`mintProRata`, `redeemProRata`, `claimPending`, and `previewRedeemProRata`
read reserves only and consult no price. `mintSingleAsset`,
`redeemSingleAsset`, and `_deployToIndexPoolCore` are priced.

### 3.6 Weight must cost what it earns

If weight costs a contribution `C` and attracts reward `R(w(C))`, then
wash-farming is profitable exactly when `R(w(C)) > C`. The design rule is
therefore **`R ≤ C` for all `C`** — a bound, not a heuristic. Two things
establish it:

1. **Only *unrecoverable* contribution counts.** The pre-remediation code
   let a vault creator set their own treasury and sink split and recapture
   ~91.9% of the fee they "paid" — audit H-4 measured ~0.004 WETH buying
   12.5% of all fee flow, permanently. Weight now credits only the portion
   that irreversibly reaches the commons: Bus-credited, burned, or locked
   into LP. Faking the signal costs exactly what it earns.
2. **Purchases happen at realizable price** (§3.4), so attracting protocol
   buying is not a subsidy.

Signal hardening: depth `D` is a **windowed minimum** over 6 buckets of
1,200 blocks (`DEPTH_BUCKETS`, `DEPTH_BUCKET_BLOCKS`), not a latched
instantaneous sample — a flash loan cannot establish it, because holding the
minimum requires holding real liquidity for the whole window. Volume is
measured in fees, not gross notional. A decaying accumulator
(`DECAY_BLOCKS = 100,800`) makes a dormant collection fall to zero without
anyone voting on it.

Concentration is capped by **exit capacity**, not by a chosen number: no
constituent may exceed the weight the index could actually exit within
`EXIT_HAIRCUT_BPS = 1,000` (10%) of measured windowed-minimum depth. The old
fiat `W_MAX_BPS = 2500` is **gone from the code entirely.**

`ROBINWOOD_FLOOR_BPS = 810` (8.1%) is a stated charter privilege — an
explicit floor, deliberately visible, rather than a thumb on the scale
hidden inside the formula. Robinwood is exempt from the fiat cap but **not**
from the exit-capacity cap, because exempting it there would mean lying
about redeemability. When its exit capacity cannot honestly support 8.1%,
the shortfall is routed into deepening Robinwood's own pool until the floor
becomes supportable, rather than being waived or faked.

---

## 4. Security posture

### 4.1 What was found

A five-domain adversarial audit of ~18,000 lines at commit `1525597`
produced **6 CRITICAL and 8 HIGH findings**, four of the criticals proven
with executed proof-of-concept tests. Full detail:
`docs/AUDIT-2026-08-09-FULL-SOLIDITY.md`. Headlines:

- **C-1** — one donated WETH permanently bricked `route()` on an immutable
  contract with no rescue path (a clamp defeated by Solidity's ternary
  evaluation order).
- **C-2** — the slippage guard `MAX_IMPACT_BPS` was *mathematically inert*:
  it compared the fill against the constant-product output formula, which
  already contains the impact, so it measured only the swap fee and could
  never reach its own threshold at any trade size. A buy at 9,092 bps true
  impact passed it.
- **C-3** — zero-fee, zero-lock JIT liquidity captured fee donations
  losslessly. PoC extracted exactly 5.0 of a 10.0 donation in one block.
- **C-6** — `ROLE_CONSTITUENT_ADMISSION` accepted an arbitrary token *and*
  an arbitrary price source with no independence validation. PoC extracted
  **681.66 ETH from a ~3,500 ETH basket.**

The failures were almost entirely **economic, not mechanical**: inert
guards, unvested value, and privileged keys with a blast radius larger than
their documentation claimed. Constant-product math, fee conservation, CEI
ordering, reentrancy discipline, and the diamond's finalization posture all
survived hostile review.

### 4.2 What was fixed

All findings are marked remediated on this branch, tracked commit-by-commit
in the audit doc's remediation table. Each audit PoC was deleted or
**inverted** — the C-1 PoC, for instance, now asserts the brick fails.

### 4.3 The meta-finding — what to distrust

**The 809-passing figure at audit time materially overstated assurance.**
Three load-bearing proofs proved nothing:

1. `Adversary.axiom1.test.ts` (ADV-1), the flagship anti-sandwich test — its
   `else` branch asserted a balance increase it could only ever reach when
   the values already differed. It passed whether or not the guard worked.
   It never once proved the guard fired.
2. `ReserveVest.test.ts` — cited in `IndexFacetBase.sol` as the proof of the
   vesting mechanism. **The file did not exist.** The vest guard shipped
   untested.
3. `Hooks.exitDoorFree.test.ts` — proved "no hook on the exit door" by
   **grepping the source text**, which is structurally incapable of seeing
   the cross-facet self-call through which the hook actually fired (a PoC
   confirmed it firing).

All three have been replaced with behavioural tests. The lesson generalises,
and an incoming auditor should apply it aggressively: **a green suite is
evidence about the tests, not about the code.** Assertions that pass on both
branches, string-grep assertions, and cited-but-absent files are three forms
of the same failure, and this codebase demonstrably contained all three.
Treat the 913 figure as an invitation to check the assertions, not as
assurance.

### 4.4 What is genuinely sound

Recorded because a fair report runs both directions, and several of these
were hostile hypotheses the code defeated:

- `diamondCut` renounced atomically at birth, behind three locks.
- No pause, freeze, or blocklist surface exists anywhere. Governance cannot
  block or price `redeemProRata`, cannot raise any hard ceiling (all
  `constant`, re-checked at execution), cannot change the timelock delay,
  cannot cut the diamond, cannot claw back stream backing.
- `creditInventory`/`onlyEnergyBus` observed-delta doctrine — the function
  accepts no amount parameter at all.
- Timelock is structurally immune to the Notional/C4-#58 class: every queue
  slot is a typed value on a compile-time key whitelist, and key→role is a
  `pure` total function, so no two roles can write one key.
- No generic call/multicall primitive anywhere, despite the diamond holding
  standing max approvals — the Floor Protocol ($1.6M) class is clean.
- DrandBeacon + BLSBN254 cryptography is correct (RFC 9380 §5.3.1
  `expandMsgTo96` with `Z_PAD_LEN = 136`; EIP-197 pairing order; complete G1
  validation; fails closed). The defect was round *selection*, now
  `ROUND_LEAD = 100`.
- Rounding fuzzed 1 wei → 1e21: monotone, no sign flip, always in the
  protocol's favour.

---

## 5. THE OPEN RISKS

**This is the section that matters. Read it before you read anything else in
this repo, and do not let §4.4 soften it.**

### 5.1 The remediation itself has never been audited

`git diff --stat 1525597..bff8e5c` = **79 files changed, 8,631 insertions,
451 deletions.** All of it landed *after* the audit. The audit covered the
code that was **found to be broken**; it did not cover the code written to
fix it. There is no independent review of a single one of those 8,631 lines.

This is the single largest risk in the handoff, and it compounds with 5.3.

### 5.2 Static analysis: honest, corrected status

`docs/SLITHER-TRIAGE-2026-08-09.md` states that whole-project `slither .`
crashes on this repo with `Fatal Python error: _PyEval_EvalFrameDefault:
Executing a cache`, and that per-file invocation was used as a workaround
covering only the principal new/changed contracts.

**That is now out of date, and this handoff corrects it.** At `bff8e5c` a
whole-project run **completes successfully** when Slither is invoked as a
module rather than via its console entry point:

```bash
python -m slither .        # works;  `slither .` is the invocation that crashes
```

Result: `284 contracts analysed with 102 detectors, 748 results` —
Informational 364, Medium 176, Low 161, **High 37**, Optimization 10.

Of the 37 High, 12 are in `contracts/test/` mocks or OpenZeppelin
(`Math.mulDiv`'s well-known `^`-vs-`**` false positive). The 25 in
production contracts break down as **22 `reentrancy-balance`, 2
`reentrancy-eth`, 1 `arbitrary-send-erc20`** — i.e. exactly the two families
the existing triage doc already dismisses with stated arguments (Slither not
modelling the shared `nonReentrant` guard; `_pullCredited` being an internal
function whose call sites all pass `msg.sender`).

**Be precise about what this does and does not establish.** It establishes
that a full run is now mechanically possible and surfaced **no new High
detector family** beyond the two already argued. It does **not** establish
that the code is sound: I did not individually re-triage all 748 results,
and — decisively — **every finding in the original audit was economic and
invisible to static analysis.** Inert guards, unvested value, self-referential
price references, and over-privileged keys are all things Slither cannot
see. A clean static pass is a floor, not a ceiling, and must never be cited
as evidence that the redesign is correct.

### 5.3 The redesign was authored by the pipeline whose code the audit faulted

The honest-index redesign, the remediation, the replacement tests, and the
triage arguments in §5.2 were all produced by the same authoring pipeline
that wrote the code the audit found six CRITICALs in — and that wrote the
three hollow tests in §4.3.

Self-review does not catch systematic blind spots; that is what "systematic"
means. **Independent review by a party with no stake in the design being
right is the only mechanism that addresses this**, and it has not happened.
Every confidence-inspiring statement in this repo, including the ones in
this document, originates upstream of that unaddressed problem.

### 5.4 No upgrade path — every bug is permanent

`diamondCut` is renounced atomically at birth. There is no proxy, no
migration, no admin rescue, no pause. A bug found the day after deployment
is a bug that exists for as long as the contracts do, and the only remedy
available to users is to exit.

This is a security *feature* — it is why no governance key can steal — and it
raises the cost of every remaining defect to its maximum. It also means the
audit-before-deploy decision is genuinely one-way.

### 5.5 The meta-index shape has no audit coverage anywhere, and its only prior implementer abandoned it

The vault-of-vaults meta-index is modelled on **NFTX v1 "D2"**, a
Balancer-style basket of per-collection vault tokens.

Full retrieval of the published audit corpus establishes that **D2 has no
published audit coverage of any kind.** NFTX's v1 security history lists
exactly two events: a Level K audit from Nov 2020 with no report published
anywhere, and a samczsun bug bounty. Their v1 audit page still reads
*"Coming soon…"* — a placeholder never filled. Every other engagement (both
Code4rena contests, Trail of Bits, SECBIT, Spearbit, Cantina) covers v2 or
v3, i.e. strictly after D2 was sunset. **This architecture is unprecedented
in audit coverage.**

And NFTX killed D2 on structural grounds, in their own words:

> *"the multi-layer model was found to suffer from long-tail, illiquid base
> (D1) funds causing liquidity and arbitrage issues for higher level (D2)
> funds which combine them."*

That is a product verdict from the only team that has ever shipped this
shape. A meta-index **inherits the illiquidity of its worst constituent**,
and the divergence between the index and its constituents is a standing
arbitrage surface. Because this design deliberately runs without a price
oracle on the pro-rata paths, **the Diamond cannot even observe that
divergence** — a defensible security choice that is simultaneously a blind
spot for this exact risk.

The realizable-value pricing of §3.4 and the exit-capacity cap of §3.6 are
genuine, direct attempts at the long-tail problem NFTX named — that is
precisely what they are for. But they are *untested against reality*, and the
central architectural bet remains unvalidated by any prior audit. This
deserves a deliberate decision, not inheritance by assumption.

### 5.6 EIP-170 headroom is finite and cannot be relieved later

`CollectionVaultFactory` calls `type(CollectionVault).creationCode`, so its
deployed bytecode literally carries the entire vault creation code as a data
blob. The two are *one* size problem.

Measured at `bff8e5c`: **22,723 bytes, 92.5% of the 24,576-byte limit,
1,853 bytes spare.** (`CollectionVault` itself: 17,468 bytes, 71.1%.) The
relief came from enabling `viaIR` on those two files only — measured, not
assumed: factory size by optimizer runs with `viaIR` on was `runs=1 →
22,592`, `runs=50 → 22,593`, `runs=200 → 22,723`, a 131-byte spread across a
200× change. So `runs` stays at 200 and hot user paths keep full
optimization; users pay nothing for the headroom. The override is scoped to
two files, so no facet's bytecode is affected.

**The ceiling is relieved, not removed**, and because `diamondCut` is
renounced this is a pre-deployment constraint with no later fix. Budget the
1,853 bytes deliberately. If substantially more is ever needed, the real
lever is a minimal-proxy / clone factory so the factory stops carrying the
vault's creation code at all.

### 5.7 Sandwich exposure is BOUNDED, not eliminated

The inert `MAX_IMPACT_BPS` guard (C-2) was **deleted, not repaired**. What
replaces it:

1. **Realizable pricing** — the protocol pays what it can absorb, so a
   sandwicher's manipulation does not cause the protocol to overpay relative
   to actual depth.
2. **`MAX_LEG_POOL_FRACTION_BPS = 200`** in `InventoryBuyAdapter` and
   `CollectionLpAdapter` — any single route leg is capped at **2% of the
   live pool reserve**. Budget above the cap is not lost; it stays in the
   adapter and is refunded to the Bus, so the protocol simply buys again
   next route at a size the market can absorb.
3. **`QUOTE_TOLERANCE_BPS = 50`** — a 0.5% quote/fill tolerance.
4. **`BLOCK_BUDGET_WEI = MAX_ROUTE_WEI = 10 ether`** — a per-block
   cumulative budget, closing H-5's "loop `route()` inside one sandwich."

The cap is chosen so that manipulation moves it in the *safe* direction:
because it is a fraction of the live reserve, an attacker who inflates the
reserve to raise the cap has thereby made the pool deep enough that the
larger trade has the same small impact, and an attacker who drains the
reserve shrinks our trade in exact proportion. That is the property the
deleted guard lacked.

**What this does not do.** It does not eliminate sandwiching. A
same-transaction quote cannot defeat a same-transaction attacker — the code
says so in its own comments. What the cap buys is that the extractable
amount per route leg is bounded to roughly 2% of a pool, instead of the 77%
of a slice the audit measured against the inert guard. **This is a bounded
loss, not a closed hole**, and an auditor should independently re-derive the
bound rather than accept it.

### 5.8 Smaller open items you should not lose track of

- **Open vaults remain legal.** `deployVault` with a zero eligibility root
  creates a vault with the full C-5 rarity-sniping exposure. The defence is
  an *economic containment argument* (§3.1), not a mechanism.
- **MarketplankVault V2 at `0xc4B29D7a01603D2A5937b1FC86ea85E488d72e04`
  ("WormWood") is deployed today and is drainable.** One-sided
  `contributeLiquidity` + `removeLiquidity` + zero-fee `sellShares` drains
  the ETH reserve. **Owner decision, 2026-08-09: leave as-is, no on-chain
  action.** The mitigation is a frontend legacy-address blocklist; the
  on-chain surface remains open to direct calls. This is a superseded
  contract with no upgrade path and the honest-index design does not depend
  on it, but an incoming operator must know it exists and is live.
- **Real-drand wire compatibility IS proven** (corrected — an earlier draft of
  this section said otherwise). `test/contracts/fixtures/drand-round.json`
  holds a real drand **evmnet** round (round 19229507, chain hash
  `0x04f1e906…8c3`), fetched from `api.drand.sh` and `api2.drand.sh` with an
  exact match on both, verified on-curve and against that round's signature
  with `@noble/curves`' independent pairing before being committed. The
  consuming test — "verifies a REAL drand round" in
  `DrandBeacon.bls.test.ts` — **passes** (`✔`, not skipped) in the 913-test
  run. What remains unproven is not the wire format but live *operational*
  relaying: no relayer has run against a real network, because nothing has
  been deployed. Note also that audit **H-7** (`ROUND_LEAD` too thin, making
  the seed grindable) was a defect in round *selection*, not in the
  cryptography, and is fixed.
- **Gas figures are local-Hardhat only.** `route()` on 2 seeded vaults
  measured 1,199,429 gas; empty weights 572,350 (against a soft target of
  <200k, i.e. **over** it — documentation only, not a gate). See
  `docs/GAS-SNAPSHOT-AXIOM-1.md`. These are proxies for cost *ordering*, not
  absolute mainnet figures.

---

## 6. What an incoming auditor should attack first

Prioritised by *newest × least-reviewed × most value-bearing*.

**1. `contracts/energy/WeightModule.sol` — the `R ≤ C` bound.** Almost
entirely new. It decides where 35% + 15% of all fee flow goes. The claim is
a *provable bound*, not a heuristic — so try to break the proof. Can any
path credit weight for value the crediting party can recover? Check
treasury-routed fees, LP that can be withdrawn, and the windowed-minimum
depth accumulator's bucket-boundary behaviour (6 × 1,200 blocks). Confirm
the exit-capacity cap and the 8.1% Robinwood floor interact without leaving
weights summing to less than 10,000 bps — that exact under-summing was audit
finding H-8.

**2. Realizable pricing (`IndexRealizable`, the quote/execute mirror in
`CollectionVault`).** The whole design rests on the claim that quote and
execution agree wei-for-wei, and that rounding never favours the trader. The
`divide-before-multiply` ordering is *intentional and load-bearing*
(`docs/SLITHER-TRIAGE-2026-08-09.md` Family 3) — reformulating the quote to
multiply-first would make it more precise than execution and therefore
**wrong**. Attack the mirror: `_pr()` vs `paymentReserve`, the `_drip()`
ordering, and whether any path can quote higher than it pays.

**3. The `MAX_LEG_POOL_FRACTION_BPS` bound (§5.7).** Independently re-derive
the extractable-value bound for a sandwich across a full 6-pipe route under
the per-block budget. Do not accept the 2% framing without checking whether
repeated routes across blocks, or multiple legs against correlated pools,
compose into something larger.

**4. The three previously-hollow tests, and their replacements.** `ADV-1`,
`ReserveVest.test.ts`, `Hooks.exitDoorFree.test.ts`. Verify each replacement
can actually fail — mutate the contract and confirm the test goes red. Then
sample the rest of the 913 for the same three failure shapes.

**5. Vesting and dwell.** `STREAM_VEST_BLOCKS = 300`,
`DONATION_VEST_BLOCKS = 300`, `LP_MIN_DWELL_BLOCKS = 8`. C-3's prior art is
emphatic that NFTX needed **both** a flash-loan fee **and** a timelock, and
shipped this bug class three times across two versions. Attack the vest from
the neighbouring door — H-1 was exactly a bypass through `redeemSingleAsset`
rather than a defeat of the vest on its own terms.

**6. `IndexZapFacet` and `IndexGovernanceFacet`.** Historically, NFTX's core
held while **the zaps and routers holding user approvals broke** (Cantina
found 3 Critical / 3 High in v3 zaps alone). `queueListing` was audit C-6, a
full-custody key. Re-verify the provenance/independence validation now
gating it, and the `_pullCredited` observed-delta discipline in the zap.

**7. The exit door, empirically.** `redeemProRata` must be unblockable under
every adversarial state: mid-route, post-finalize, with a bricked pipe, with
a hostile constituent listed, with the Bus holding unrouted WETH, with a
reverting ERC-721 in a vault. `ExitDoorSacred.test.ts` and
`RedTeam.ExitDoorBrick.poc.test.ts` are the existing attempts — extend them.

**8. The architectural bet itself (§5.5).** Not a code review. Model whether
exit-capacity caps and realizable pricing actually contain the long-tail
illiquidity that killed NFTX D2, or merely make the index smaller than it
looks. This is the question no line-by-line audit will answer, and it is the
one that decides whether the product works.

---

## 7. Repo map

```
contracts/
  diamond/                 EIP-2535 meta-index
    Diamond.sol            the proxy
    IndexDeployer.sol      deploy-cut-finalize; renounces diamondCut in its constructor
    LibBytecodeScan.sol    rejects DELEGATECALL/SELFDESTRUCT in installed facets
    facets/                21 facets — Core, Trade, Zap, Governance, Stream,
                           Dividend, Pool, Lens, Buyback, Bootstrap, Oracle, …
    storage/               diamond storage layouts
  energy/
    EnergyBus.sol          the immutable 6-pipe splitter
    WeightModule.sol       weight/admission formula
    adapters/              the six pipe adapters
  factory/
    CollectionVault.sol        per-collection vault: S, AMM, community LP
    CollectionVaultFactory.sol permissionless CREATE2 factory (92.5% of EIP-170)
    CollectionVaultLP.sol      LP share accounting
  lib/                     shared libraries (BLS, merkle, math)
  test/                    Solidity mocks and attack contracts (NOT the test suite)
  IndexCoinPool.sol  WrappedIndexShare.sol  PlankGauge.sol
  MarketplankVault.sol  MarketplankVaultV3.sol  DrandBeacon.sol
  TBAValueSweeper.sol  ScopedRoles.sol  BackstopSizingCalculator.sol

test/contracts/          the TypeScript/Hardhat suite (913 tests)
  energy/  factory/  fixtures/  helpers/
  RedTeam.*.poc.test.ts  — inverted audit PoCs
  Audit*.poc.test.ts     — inverted audit PoCs

scripts/
  deploy/axiom1-local.ts     12-step ceremony, local, fully proven
  deploy/axiom1-testnet.ts   same ceremony parameterized for a real network
                             — NEVER RUN AGAINST A REAL NETWORK
  verify/axiom1-postdeploy.ts  deposit → fee → route → warp vest → redeemProRata smoke
  gas/axiom1-gas-snapshot.ts

docs/                     see docs/AXIOM-1-DOC-INDEX.md
```

### Build and test

```bash
npm install
npm run test:contracts     # = cross-env TS_NODE_PROJECT=tsconfig.hardhat.json hardhat test
```

**Use `npm run test:contracts`. Never run bare `npx hardhat test`** — the
suite requires `TS_NODE_PROJECT=tsconfig.hardhat.json`, which the npm script
sets and a bare invocation does not.

**Artifacts go to `.hardhat-artifacts/`, not `artifacts/`** (`hardhat.config.ts`
`paths.artifacts`). Tests read artifacts by that path, so anything that
recompiles into a different directory — or that recompiles *concurrently
with a test run* — will produce spurious `ENOENT ... .hardhat-artifacts/...`
failures that look like real test failures and are not. Run one compile-y
thing at a time.

Compiler: solc **0.8.24**, optimizer on at `runs: 200`, EVM target `paris`.
`viaIR` is enabled **only** for `CollectionVault.sol` and
`CollectionVaultFactory.sol` (see §5.6); all other contracts compile with the
default pipeline and are byte-identical to their pre-`viaIR` builds.

### Static analysis

```bash
python -m slither .        # NOT `slither .` — see §5.2
```

---

## 8. Deployment readiness checklist

Honestly gated. Items are ordered; **nothing below the line marked MAINNET
GATE may be waived**, because there is no upgrade path.

**Done**
- [x] 913 tests passing, 0 failing at `bff8e5c`
- [x] All internal audit findings marked remediated, each PoC deleted or inverted
- [x] Full-project static analysis completes (`python -m slither .`), no new High family
- [x] EIP-170: every contract under the limit; largest at 92.5% with 1,853 bytes spare
- [x] Gas snapshot recorded (local Hardhat)
- [x] Deploy ceremony proven end-to-end locally (`axiom1-local.ts` + `axiom1-postdeploy.ts`)
- [x] Real-network deploy script written and dry-run-proven (`AXIOM1_DRY_RUN=1`)

**MAINNET GATE — all of these must be true, none may be waived**
- [ ] **An independent external audit of the post-remediation code**, scoped
      to include all 8,631 lines added after `1525597`, by a party with no
      involvement in authoring it (§5.1, §5.3)
- [ ] **An explicit, recorded owner decision on the D2 architectural risk**
      (§5.5) — not inheritance by assumption
- [ ] Bytecode-size budget signed off against final source; confirmation
      that no post-audit change pushes the factory past EIP-170 (§5.6)
- [ ] The extractable-value bound of §5.7 independently re-derived and
      accepted, with the residual sandwich loss stated in ETH terms
- [ ] Every replacement test for the three hollow tests confirmed to fail
      under mutation (§4.3, §6 item 4)
- [ ] Live drand *relaying* exercised end to end on the target network — the
      wire format is already proven against a real evmnet round (§5.8); what
      is untested is an operational relayer, since nothing has been deployed
- [ ] Full testnet deployment executed and soaked, with
      `docs/BULLISH-AXIOM1-RUNBOOK.md` filled in from the real run
- [ ] Role custody plan decided: the deploy script runs as a
      **single-operator ceremony**; redistributing `risk` / `seeder` /
      `treasury` / `governance` to separate multisigs is a deliberate,
      currently-unscheduled follow-up
- [ ] Genesis parameters re-verified against the Solidity constants at the
      exact deploy commit (runbook §"Genesis params", which records the drift
      found at `bff8e5c`)
- [ ] Explicit written owner authorization to deploy

**Standing operational item, independent of this launch**
- [ ] MarketplankVault V2 `0xc4B2…72e04` is live and drainable; currently
      accepted/won't-fix with a frontend-only mitigation (§5.8)

---

## 9. Standing principles this codebase is built on

Stated so a reviewer can check the code against its own claimed rules, and
so a maintainer knows which lines are load-bearing.

1. **Never display a number we cannot pay.** Displayed = redeemable, always.
2. **Prefer derived prices to chosen ones.** A parameter governance can set
   wrong is worse than a formula it cannot touch.
3. **Make assumptions true rather than compensating for their falsity.**
   Predicate vaults over redeem premiums.
4. **Signals must cost what they earn.** `R ≤ C`, or the signal gets farmed.
5. **The exit door is sacred.** In-kind pro-rata redemption is never gated,
   priced, paused, or made governance-reachable.
6. **A green test suite is evidence about the tests.** Three load-bearing
   proofs in this repo proved nothing. Assert what can fail.
7. **There is no upgrade path.** Everything must be right *before*
   deployment.

---

## 10. Reading order for the rest of `docs/`

1. This document.
2. `docs/DESIGN-HONEST-INDEX-2026-08-09.md` — canonical design and the
   reasoning behind every choice in §3.
3. `docs/AUDIT-2026-08-09-FULL-SOLIDITY.md` — the findings, the PoCs, the
   remediation table, and the external research basis.
4. `docs/SLITHER-TRIAGE-2026-08-09.md` — every static finding examined and
   the argument for dismissing it, so you can challenge the reasoning rather
   than repeat the work. **Its toolchain section is superseded by §5.2 here.**
5. `docs/AXIOM-1-AS-BUILT.md` — plain-language as-built summary.
6. `docs/TEST-MATRIX-AXIOM-1-ADVERSARIAL.md` — what the suite is supposed to
   cover.
7. `docs/GAS-SNAPSHOT-AXIOM-1.md`, `docs/BULLISH-AXIOM1-RUNBOOK.md`.
8. `docs/AXIOM-1-DOC-INDEX.md` — everything else in the folder is retired
   planning history and each retired doc says so.
