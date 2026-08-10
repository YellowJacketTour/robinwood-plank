# Full Solidity Audit — AXIOM-1 / Marketplank

**Date:** 2026-08-09
**Commit audited:** `1525597` on `feat/cvi-sota-axiom-1`
**Scope:** all ~18,000 lines of Solidity in `contracts/` (50 files), plus the test suite's assurance quality
**Method:** five parallel adversarial code audits (one per contract domain), three external-research sweeps of published audits for the protocols this design borrows from, and a Slither 0.11.6 static pass (238 contracts, 64 detectors)
**Baseline at audit time:** 809 tests passing, 0 failing

---

## Verdict

**Do not deploy as-is.** Six CRITICAL findings, four of them proven with executed proof-of-concept tests that are committed alongside this report.

The mechanical engineering is genuinely strong — constant-product math, fee conservation, swap-and-pop inventory indexing, CEI ordering, reentrancy discipline, and the diamond's finalization posture all survived hostile review. Notably, **`diamondCut` is renounced atomically inside the deployer's constructor**, behind three independent locks, so the diamond is never observable in a cuttable state. That is excellent security engineering.

It also carries a hard corollary that dominates every other consideration:

> **There is no upgrade path. Every finding below is permanently unfixable once deployed.**

The failures are almost entirely **economic**, not mechanical: guards that are inert, value that is unvested, and privileged keys whose blast radius is larger than documented. Those are precisely the class of bug that a passing test suite does not catch — and, as documented in the meta-finding below, did not.

---

## Strategic finding: the meta-index architecture was tried once, and abandoned by its author

This sits above the individual findings because no code fix addresses it.

The vault-of-vaults meta-index is modelled on **NFTX v1 "D2"** — a Balancer-style basket of per-collection vault tokens. Retrieval of the full published audit corpus establishes two things:

1. **D2 has no published audit coverage of any kind.** NFTX's own security history lists exactly two v1 events: a Level K audit from Nov 2020 with no report published anywhere, and a samczsun bug bounty. Their v1 audit page still reads *"Coming soon…"* — a placeholder never filled. Every other engagement (both Code4rena contests, Trail of Bits, SECBIT, Spearbit, Cantina) covers v2 or v3, i.e. strictly *after* D2 was sunset. **Our meta-index is unprecedented in audit coverage.**

2. **NFTX killed D2 on structural grounds, and said why:** *"the multi-layer model was found to suffer from long-tail, illiquid base (D1) funds causing liquidity and arbitrage issues for higher level (D2) funds which combine them."*

That is a product verdict from the only team that has ever shipped this shape. The meta-index **inherits the illiquidity of its worst constituent**, and the divergence between the index and its constituents is a standing arbitrage surface. Because we deliberately run without a price oracle on the pro-rata paths, **our Diamond cannot even observe that divergence** — which is a defensible security choice and simultaneously a blind spot for this specific risk.

This does not mean the design cannot work; our weight formula and admission floor are genuine attempts at the long-tail problem NFTX named. It does mean the central architectural bet is unvalidated by any prior audit, and was abandoned by its originator for reasons that apply to us. It deserves an explicit, deliberate owner decision rather than inheritance by assumption.

---

## CRITICAL

### C-1 — One WETH permanently bricks the Energy Bus
`contracts/energy/EnergyBus.sol:165` · **Confirmed by direct code reading**

```solidity
uint256 leftBus = beforeBal - afterBal <= amount ? beforeBal - afterBal : amount;
```

The subtraction is evaluated inside the ternary *condition*, before the comparison can clamp it. Four adapters refund `weth.balanceOf(address(this))` — their entire balance, not their slice (`InventoryBuyAdapter:184`, `CollectionLpAdapter:244`, `PlankBurnAdapter:200`, `PlankLpRenounceAdapter:249`). Donating WETH directly to any adapter therefore makes it refund more than it was sent, so `afterBal > beforeBal` and the subtraction underflow-panics.

The panic occurs in an internal function **outside** the `try/catch`, which wraps only `adapter.execute()`. All of `route()` reverts. Because the transaction reverts, the donation is never consumed — so it reverts **permanently**, on an immutable contract with no rescue path. The clamp was clearly intended; Solidity's evaluation order defeats it.

**Cost to attacker:** slightly over 10% of `MAX_ROUTE_WEI` (~1 WETH). **Fix:** `afterBal >= beforeBal ? 0 : beforeBal - afterBal`, and cap every adapter refund at `min(balance, amountIn)`.

### C-2 — `MAX_IMPACT_BPS` is mathematically inert
`contracts/energy/adapters/InventoryBuyAdapter.sol:211`, `CollectionLpAdapter.sol:300` · **Confirmed by direct code reading**

```solidity
uint256 spotShares = (budget * shareReserveBefore) / (paymentReserveBefore + budget);
```

This *is* the constant-product output formula `Δx·y/(x+Δx)` — it already contains the full price impact. Comparing the actual fill against it measures only the **swap fee**. A true no-impact reference is `budget·y/x`.

The measured quantity is `1 − f(x+b)/(x+f·b)`, which peaks near 149 bps as `b→0` and **falls monotonically toward zero as the trade grows**. It can never reach its own 300 bps threshold at any size. Since `buyShares(budget, 0)` passes `minSharesOut = 0`, this inert guard is the only slippage defence in the system.

Measured: a buy at **9,092 bps true impact passes the guard**. Sandwiching a 3.5 WETH Pipe-I slice nets **+2.686 WETH (77% of the slice)** — atomic, flash-loanable, no attacker capital, repeatable every route. The guard is also self-referential: reserves are read in the same call, after the front-run. Sherlock has judged this exact pattern HIGH (`2023-01-derby-judging#310`).

### C-3 — Zero-fee JIT liquidity sandwiches every fee donation
`contracts/factory/CollectionVault.sol:509` / `:546` / `:339` · **PoC passing**

`addLiquidity`/`removeLiquidity` charge **no fee** and impose **no lock**; the round-trip is provably lossless. `_compoundXToken` credits `paymentReserve += wethIn` **instantly and unvested**. An attacker therefore adds liquidity immediately before a donation and removes immediately after, capturing a pro-rata slice for free.

PoC result: attacker extracted **exactly 5.0 of a 10.0 donation**, share delta 0, in one block, at zero risk.

The related swap-based sandwich is real but rate-limited — break-even at `D/PR ≈ 3.2%`, so a single small organic donation does not clear it. **C-3 removes that brake entirely**, because JIT LP has no fee to pay.

**Note the asymmetry:** the index side already vests routed value over 300 blocks via `_addReserveVest`. The codebase learned this lesson in one place and not the other. Yearn streams harvests over 6 hours for exactly this reason.

**Prior art is emphatic here.** Spearbit's v3 core audit rates this exact attack Critical (C-8) and High (H-1) — free vToken flash-loan → own ~100% of shares → trigger the fees → collect them back, plus a flash-loan-free variant that buys on the AMM, deposits, captures a distribution and exits **within one block**. Spearbit's words: *"straightforward stealing of the protocol LP yield."* **Our internal AMM makes the buy leg cheaper than NFTX's was.** NFTX shipped this bug class **three times across two versions** (C4-2021-05 H-4 → C4-2021-12 M-07/M-13 → Spearbit H-1), and the fix that finally held required **both a flash-loan fee and a one-hour timelock** — not one or the other. A vest alone may be insufficient.

### C-4 — Permissionless factory + self-reported depth = flash-loanable budget theft
`contracts/energy/WeightModule.sol:370`, `contracts/factory/CollectionVaultFactory.sol`

`deployVault` is unpermissioned and the attacker is treasury of their own vault. `noteDepth` persists the **latest reported value** and is never re-measured:

flash-loan 10,000 WETH → `addLiquidity` → one dust `buyShares` (fires `noteDepth(1e22)`, latched forever) → `removeLiquidity` → repay.

Admission costs only the sink cut (~0.05 ETH; treasury and compound cuts return to the attacker). The attacker then holds `W_MAX_BPS` = 25% of Pipe I, and `buyLeg` spends it **unconditionally** into their own pool at a price they alone set — because per C-2, the impact guard bounds nothing.

A cheaper variant: **~0.004 WETH buys 12.5% of all fee flow, permanently**, by choosing one's own `treasury_` and `sinkBps` at deploy time.

Corrected during review: `_reconcileCore` requires a *listed* constituent, so index NAV is not poisoned. The unconditional WETH loss stands.

### C-5 — "Deposit junk, redeem treasure" with the premium set to zero
`contracts/factory/CollectionVault.sol:270` / `:673`

`redeem(tokenId)` is caller-chosen and burns exactly 1e18 `S` regardless of which NFT leaves. NFTX solved this problem across three versions: a 5% targeted-redeem premium in v2, and in v3 a premium starting at **500% of one vToken decaying to 0% over 10 hours, with 90% paid to whoever deposited that NFT**.

Ours charges a flat fee only. This is not a disabled feature — `_addHeldToken` stores only an index, so there is **no deposit block and no depositor recorded**; the state required for a dwell-time premium does not exist.

Cheapest exploit needs no AMM and no flash loan: `deposit(floor)` at 0.01 + `redeem(grail)` at 0.01 = **0.02 ETH to convert a 1 ETH item into a 3 ETH item**, in one transaction.

**Do not fix this with on-chain randomness.** C4 2021-05 H-03/M-01/M-09 rate that approach as published-broken: a contract caller simply reverts on unfavourable draws until it receives the item it wants.

**Important counter-consideration — this is a genuine trade-off, not a pure loss.** Spearbit's v3 core audit shows the premium mechanism NFTX adopted carried its own family of Critical/High bugs: `swap()` transferred NFTs out before in, letting an attacker round-trip the same `tokenId` to **steal the depositor slot and snap the premium to maximum** (C-2/C-6); `removeLiquidity` applied no premium bound at all and simply spent whatever `collect()` returned (H-3). All three were closed by a single parameter, `vTokenPremiumLimit`, and **Spearbit signed off only conditionally**: *"whether it be set too lax the stealing within it is still possible."*

Charging zero premium therefore **structurally immunizes us against that entire bug family**. Adopting a premium imports it. The decision is: accept a known, quantified rarity-sniping loss, or take on a mechanism that three separate Critical/High findings say is hard to get right. Recommendation is still to price the option — but with the depositor/dwell state added carefully and the premium *bounded*, and with the awareness that this is the single most bug-prone surface in NFTX's history.

### C-6 — `ROLE_CONSTITUENT_ADMISSION` is a full-custody key
`contracts/diamond/facets/IndexGovernanceFacet.sol:293-308`, `IndexFacetBase.sol:1336-1368` · **PoC passing**

`queueListing` accepts an arbitrary `token` **and an arbitrary `IIndexPriceSource`** with zero validation at queue time or execute time. Nothing checks that the price source is independent of the token, or of the caller.

The holder lists a token they minted, priced by an oracle they wrote, warms eight checkpoints (persistence holds *perfectly*, since a constant price means every observation equals the TWAP), mints via `mintSingleAsset` up to the concentration cap, and exits through the deliberately unblockable `redeemProRata`.

PoC extracted **681.66 ETH of real reserves from a ~3,500 ETH basket** at a 4,000 bps cap — repeatable across 32 slots, up to ~50% of NAV at the legal maximum.

This contradicts the facet header's claim that "no code path transfers a reserve to anyone except a share-burning redeemer." That is literally true and materially false: **the key manufactures the redeemer.** By contrast `queueStream` validates its candidates and documents lister responsibility at length; `queueListing` does neither.

---

## HIGH

| ID | Finding | Location |
|----|---------|----------|
| H-1 | `redeemSingleAsset` bypasses the reserve-vest guard entirely; its pro-rata component is also fee-free. Measured: 18.18 tokens of unvested value out immediately | `IndexValuation.sol:140/147/262` |
| H-2 | `IndexZapFacet` credits a **self-reported** number (`c.reserve += _routeDevFundBuy(...)`, no `_pullCredited`, no delta, no `ShortDelivery`) and grants an **unvalidated address** an allowance over the diamond's WETH | `IndexZapFacet.sol:203`, `:227-233` |
| H-3 | Dividend leg has no vest → atomic mint→credit→redeem→claim snipe; `dividendBps = 10000` is legal, making routed value 100% snipeable | `IndexFacetBase.sol:1478-1513` |
| H-4 | Unbounded `admittedVaults` + permissionless creation + no removal; `weights()` is O(n²) on the hot path of Pipes I and L → permanent DoS | `WeightModule.sol` |
| H-5 | `MAX_ROUTE_WEI` is a per-call cap, not a rate limit — loop `route()` inside one sandwich. The repo's own BUS-4 test proves looping works | `EnergyBus.sol` |
| H-6 | Signal manipulation: depth `D` is an instantaneous latched snapshot; volume `V` is gross notional, not fee (the interface doc's claim is false); first EWMA sample is undamped | `WeightModule.sol` |
| H-7 | `ROUND_LEAD = 1` gives only 3–6s of clock-skew tolerance. Skew backward ≥6s and the drand round is already published; `index = keccak256(seed, requester) % len` is then address-grindable, and an attacker who finds no favourable address simply never broadcasts — cost zero, forfeit-burn never fires | `MarketplankVaultV3.sol:187,334` |
| H-8 | With <4 admitted vaults, capped weights sum to 2500/5000/7500 rather than 10000 — at launch **75% of the largest pipe silently leaks to dividends** | `WeightModule.sol` |

---

## Live-funds item (pre-existing, already documented)

**MarketplankVault V2 — `0xc4B29D7a01603D2A5937b1FC86ea85E488d72e04` ("WormWood") is deployed and drainable.** V2's one-sided `contributeLiquidity` + `removeLiquidity` + zero-fee `sellShares` drains the entire ETH reserve (worked example: a 10,000 ETH flash-borrow takes a 100 ETH pool, repaid in the same transaction).

This is already known and documented across the repo, and the V3 deploy script acknowledges it. **However, the mitigation is a frontend legacy-address blocklist** — the on-chain surface remains open to direct calls. Recommendation: drain the remaining reserve to treasury rather than relying on the UI to protect it.

This is the only finding in the audit that touches funds already at risk today.

**Disposition (owner decision, 2026-08-09): leave V2 as-is; no on-chain action.** The frontend legacy-address blocklist remains the mitigation. V2 is a superseded contract with no upgrade path; the value-at-risk does not warrant an adversarial on-chain rescue, and the honest-index redesign does not depend on it. This item is closed as "won't fix / accepted," not outstanding.

---

## Meta-finding: three load-bearing tests prove nothing

The 809-passing figure **materially overstated assurance**. Independently verified:

1. **`Adversary.axiom1.test.ts:237-246` (ADV-1)** — the flagship anti-sandwich test. Its `else` branch asserts `sAtIndexAfter > sAtIndexBefore`, but it only reaches that branch because the values already differ, and the balance can only increase. It passes whether or not the guard works. It has never proven the guard fires. *(This one is mine, from PR11.)*
2. **`ReserveVest.test.ts`** — cited at `IndexFacetBase.sol:1767` as the proof of the vesting mechanism. **The file does not exist.** The vest guard shipped untested.
3. **`Hooks.exitDoorFree.test.ts:53-59`** — proves "no hook on the exit door" by **grepping the source text** of `IndexCoreFacet.sol`. That is structurally incapable of seeing the cross-facet self-call through which the hook *actually* fires during `redeemProRata` (confirmed firing by PoC).

**Lesson:** a green suite is evidence about the tests, not about the code. Assertions that can pass on both branches, string-grep assertions, and cited-but-absent files are all forms of the same failure.

---

## What is genuinely sound

Recorded because a fair audit reports both directions, and several of these were hostile hypotheses that the code defeated:

- **`diamondCut` renounced atomically at birth** — three independent locks, plus `LibBytecodeScan` rejecting `DELEGATECALL`/`SELFDESTRUCT` in installed facets. Never observable in a cuttable state.
- **No pause, freeze, or blocklist surface exists anywhere.** Governance cannot block or price `redeemProRata`, cannot raise any hard ceiling (all `constant`, re-checked at execution), cannot change `timelockDelay`, cannot cut the diamond, cannot claw back stream backing.
- **`creditInventory`/`onlyEnergyBus` observed-delta doctrine is airtight** — the function accepts no amount parameter at all.
- **Vesting genuinely defeats single-transaction flash-mint capture.** The math is correct; it is defeated only via the neighbouring door (H-1), not on its own terms.
- **Timelock is structurally immune to the Notional/C4-#58 class** — every queue slot is a typed value dispatched on a compile-time key whitelist, not an arbitrary payload. Key→role is a `pure` total function, so no two roles can write one key.
- **Split conservation is exact** (last pipe absorbs the remainder); no `unchecked` blocks anywhere in the energy scope.
- **CEI/reentrancy clean** in `CollectionVault.redeem` despite the ERC-721 `safeTransferFrom` callback; the shared reentrancy guard is correctly *shared* (fragmentation is the real bug, per the Vyper 0-day) and no facet rolls its own.
- **No generic call/multicall primitive anywhere** despite the diamond holding standing max approvals — the Floor Protocol ($1.6M) class is clean.
- **DrandBeacon + BLSBN254 cryptography is sound** — `expandMsgTo96` matches RFC 9380 §5.3.1 including the correct `Z_PAD_LEN = 136`; correct pairing with EIP-197 ordering; complete G1 validation; fails closed. The defect is round *selection* (H-7), not the crypto.
- **TBAValueSweeper authorization is sound** — CREATE2 check fed the proven-held token id, immutable sinks, no arbitrary-calldata forwarding, `operation=0` (CALL, never DELEGATECALL).
- **Rounding fuzzed 1 wei → 1e21: clean**, monotone, no sign flip. The 1-wei donation brick (C4 2021-12 H-03) is not present — all `balanceOf` uses are deltas or inequalities.
- **Slither: zero real findings.** The one High/High (`_pullCredited` `arbitrary-send-erc20`) is a false positive — internal function, all four call sites pass `msg.sender`. The `reentrancy-balance` hits are the shared-guard blind spot; the twenty `incorrect-equality` hits are `x == 0` unsigned zero-guards.

---

## Accuracy of the public claims

Two documented claims need narrowing before they go in front of anyone:

- **"No settlement oracle."** True and verified for the free doors — `mintProRata`, `redeemProRata`, `claimPending`, and `previewRedeemProRata` read `c.reserve` only and consult no price. But `mintSingleAsset`, `redeemSingleAsset`, and `_deployToIndexPoolCore` are *fully* oracle-priced. Honest formulation: **the free exit door is oracle-free; the two priced convenience paths are oracle-dependent.** (This is exactly why C-6 works.)
- **"No admin can change a pipe after finalize."** The split ratios and adapter addresses are genuinely immutable — bytecode-verified, 13 immutable refs and only three storage slots, zero `delegatecall`. But `PlankBurnAdapter.router` and `PlankLpRenounceAdapter.{swapRouter,plankToken,lpPool}` are governed, and — the gap nobody had written down — `IdxBurnAdapter`, `DividendAdapter`, and `InventoryBuyAdapter` hold immutable pointers to the index Diamond. *An immutable pointer to an upgradeable target confers nothing* (the diamond is in fact renounced, so this one resolves — but only because of a property proven elsewhere, not by the adapters themselves). Honest formulation: **which adapter receives what fraction is immutable; the venue each adapter trades against is timelock-governed.**

---

## Recommended fix order

**Tier 1 — unambiguous bugs, no design decision required**
1. C-1 underflow clamp + cap every adapter refund at `min(balance, amountIn)`
2. C-2 correct the impact reference to `budget·y/x`, and pass a real `minSharesOut`
3. H-2 use `_pullCredited` in the zap; validate the leg before granting any allowance
4. H-1 apply `_reserveNetOfVest` in `IndexValuation`; charge the imbalance fee on the pro-rata component
5. `IndexCoinPool.swap` — add `nonReentrant`, move reserve updates before `transferFrom`
6. Replace the three vacuous/missing tests with assertions that can actually fail

**Tier 2 — economic parameters, owner decision required**
7. C-3 vest `_compoundXToken` (port `_addReserveVest`) and/or block same-block LP removal
8. C-5 adopt an NFTX-v3-style dwell-decaying redeem premium — requires recording deposit block and depositor
9. C-4/H-6 make depth time-averaged rather than latched; gate admission on `poolOpen`; bound `admittedVaults`
10. C-6 validate that a listed token's price source is independent of the token and the lister

**Tier 3 — governance hardening**
11. Add `GRACE_PERIOD` expiry and a cancel/veto path (currently a compromised key's queued value is unstoppable, and rotation always lands after the malicious eta)
12. Bound `largeOpValueWei` and `minCheckpointInterval`; move the two spendable treasuries off `ROLE_RISK_PARAM`

**Tier 4 — operational**
13. Drain V2 (`0xc4B2…72e04`) to treasury
14. H-7 raise `ROUND_LEAD` to ~100 and reject requests whose target round is already available
15. Populate `fixtures/drand-round.json` and make `DrandBeacon.realsig.test.ts` pass — real-drand wire compatibility is still unproven

---

## External research basis

Findings were checked against published audits and post-mortems rather than derived from first principles alone. Principal sources:

- **NFTX** — Code4rena [2021-05](https://code4rena.com/reports/2021-05-nftx) (rarity sniping, LP flash-loan H-04, the fee-distributor family H-02/M-03/M-05/M-08) and [2021-12](https://code4rena.com/reports/2021-12-nftx) (reward front-running M-07/M-13, share-denominated approval inflation M-06, 1-wei donation brick H-03); [v2/v3 comparison](https://docs.nftx.io/v2-v3-comparison) for the premium parameters
- **ERC-4626 inflation/donation** — [OpenZeppelin](https://www.openzeppelin.com/news/a-novel-defense-against-erc4626-inflation-attacks), [OZ docs](https://docs.openzeppelin.com/contracts/5.x/erc4626); [ResupplyFi $9.8M](https://rekt.news/resupplyfi-rekt)
- **Harvest sandwiching** — [Yearn v2 spec](https://docs.yearn.fi/developers/v2/SPECIFICATION) (`lockedProfitDegradation`); [Code4rena bveCVX](https://code4rena.com/reports/2021-09-bvecvx)
- **Self-referential slippage guards** — [Sherlock 2023-01 Derby #310](https://github.com/sherlock-audit/2023-01-derby-judging/issues/310)
- **Balancer** — [Nov-2025 $128M rounding exploit](https://research.checkpoint.com/2025/how-an-attacker-drained-128m-from-balancer-through-rounding-error-exploitation/) (65 sub-threshold ops in one `batchSwap` — why per-call caps fail); [Aug-2023 boosted-pool rounding](https://immunefi.com/blog/bug-fix-reviews/balancer-rounding-error/)
- **Diamond/EIP-2535** — [Trail of Bits](https://blog.trailofbits.com/2020/10/30/good-idea-bad-design-how-the-diamond-standard-falls-short/); [Audius $6M slot-0 collision](https://blog.audius.co/article/audius-governance-takeover-post-mortem-7-23-22)
- **Hooks** — [Cyfrin on Uniswap v4 hooks](https://www.cyfrin.io/blog/uniswap-v4-hooks-security-deep-dive) (Cork ~$12M, Bunni v2 guard-unlock)
- **Generic call primitives** — [Floor Protocol $1.6M](https://medium.com/coinmonks/anatomy-of-the-1-6-million-floor-protocol-exploit-a-security-post-mortem-4e5f06cae125)
- **Timelock** — [Notional C4 #58](https://github.com/code-423n4/2021-08-notional-findings/issues/58); [Uniswap Timelock `GRACE_PERIOD`](https://github.com/Uniswap/governance/blob/master/contracts/Timelock.sol)
- **Reentrancy guard fragmentation** — [Curve/Vyper 0-day](https://hackmd.io/@LlamaRisk/BJzSKHNjn) (JPEG'd ~$11.5M)
- **Sudoswap v2** — [Cyfrin](https://github.com/solodit/solodit_content/blob/main/reports/Cyfrin/2023-06-01-Sudoswap.md) (rounding direction; unvalidated pair address)

**Both NFTX v3 audits were retrieved in full** (the docs site's GitBook `{% file %}` paths 404; the real signed CDN URLs are inlined in the page JSON):

- **Spearbit — NFTX v3 core**, 19 Nov 2023, commit `2054f8…83128`: **50 issues — 11 Critical, 6 High, 11 Medium, 11 Low, 7 Gas, 4 Info; 44 fixed, 6 acknowledged.** Findings bearing directly on us: **C-8/H-1** JIT extraction of fee distributions (our C-3); **C-2/C-6/H-3** the targeted-redeem premium family (our C-5's counter-consideration); **C-1** reentrancy on balance-derived share pricing via the NFT transfer hook, with a general recommendation to **move off `balanceOf`-based accounting entirely** — aimed squarely at `convertToAssets`; **H-6/C-4** a fee-distributor `leftover` accumulator never reset on success that permanently bricks distribution — and because distribution sat in the mint/redeem/swap path, the whole protocol halted. *Our splitter is immutable, so the equivalent halt would be unfixable forever — compare C-1 above.* Also **C-7** router confused-deputy (anyone could drain a position merely *approved* to the router), **C-9** Permit2 `uint160` truncation → free minting, **C-11** a missing fee-accumulator checkpoint in `increasePosition` → steal others' fees.
- **Cantina Managed — v3 zaps**, 15 Nov 2023, commit `e2e906f1`: **13 issues — 3 Critical, 3 High, 2 Medium, 2 Low.** Includes `CreateVaultZap` making the creator the vault manager. Consistent with the historical pattern that NFTX's **core held while the zaps/routers holding user approvals broke**.

**Confirmed research gap:** no published audit of NFTX v1 "D2" — the Balancer-of-vTokens meta-index, our closest structural ancestor — exists anywhere. See the strategic finding at the top of this report.

---

## Proof-of-concept tests

Committed alongside this report. **Each asserts buggy behaviour and must be deleted or inverted once the corresponding finding is fixed.**

| File | Proves |
|------|--------|
| `test/contracts/energy/AuditPoc.energy.test.ts` | C-1 permanent brick; C-2 inert guard and the 77%-of-slice sandwich |
| `test/contracts/factory/AuditDonationSandwich.poc.test.ts` | C-3 JIT-LP donation capture |
| `test/contracts/factory/AuditJitLp.poc.test.ts` | C-3 lossless LP round-trip |
| `test/contracts/factory/AuditRounding.poc.test.ts` | rounding fuzz (clean result) |
| `test/contracts/RedTeam.VestBypassAndExitHook.poc.test.ts` | H-1 vest bypass; hook firing on the exit door |
| `test/contracts/RedTeam.HostileConstituentAdmission.poc.test.ts` | C-6 — 681.66 ETH extracted |
