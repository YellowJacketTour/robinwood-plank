# Internal security review — MarketplankVaultV3 (pre-deploy)

**Date:** 2026-08-01
**Reviewer:** Claude (adversarial multi-pass internal review)
**Target:** `contracts/MarketplankVaultV3.sol` @ current `winplank`/`nft-pool-migration` tree
**Method:** three independent adversarial reviewers, each assigned a distinct attack
surface, tasked to *break* the contract; cross-checked against the existing test
suites and prior audit docs; plus the full green gate (`npm test` — **104 passing**,
incl. `VaultV3.audit.test.ts` 16 tests + `VaultV3.fuzz.test.ts` 140 ops × 4 seeds).

> ⚠️ **This is NOT the independent third-party audit SPEC gate 3 requires.** It is a
> rigorous *internal* review by the same system that helped build this. It raises
> confidence and found no critical/high correctness bug, but it does not satisfy the
> formal external-audit gate. Enabling the live market on this basis is an explicit,
> informed risk decision for the operator.

## Verdict

**No Critical or High correctness vulnerability found.** The contract is safe to
deploy **conditioned on the deployment-parameter hardening below** (none are code
changes). The immutable, no-rug design (proportional LP, locked `address(0)` seed
LP, ETH-fee isolation, single-slot commit-reveal with settle/forfeit backstop) holds
up under adversarial analysis.

## Surfaces reviewed & result
1. **LP accounting / pool-drain** → SAFE. The V2 LP-1 flash-drain is structurally
   eliminated: `addLiquidity` is ETH-driven and pulls matching shares (no one-sided
   donation), `removeLiquidity` is strictly pro-rata, all rounding floors toward the
   pool, and the initial `sqrt(E·S)` LP is permanently locked. Round-trips proven
   `≤ input` algebraically. First-depositor/ERC4626 inflation impossible (explicit
   reserve storage, locked seed).
2. **Fees / solvency / ETH / reentrancy** → SAFE. Solvency invariant
   `supply + pending·UNIT == held·UNIT` holds on every path; fees are exact-`==` and
   fully segregated in `accruedFees` (never drainable via trades/LP exit); single
   shared `nonReentrant` + CEI on every mutator; a reverting treasury bricks only
   `withdrawFees`, never user paths.
3. **Random-redeem / single slot / batch** → SAFE (correctness). F-1 (round
   off-by-one) and F-2 (undeliverable-requester slot brick) confirmed fixed; the draw
   set is immutable from commit to pin; forfeit burns the share to treasury (no free
   reroll); permissionless settle/forfeit cannot redirect or steal; batch ops bound,
   exact-fee, duplicate-safe, atomic.

## REQUIRED before mainnet deploy (deployment parameters — not code)
1. **Non-zero mint & redeem fees.** Zero fees nullify the slot-occupation
   rate-limiter (Low-1): an attacker could re-occupy the single redeem slot for gas
   only (never a permanent brick — relay+settle always frees it — but a nuisance).
   Ship with non-zero `mintFeeWei`/`redeemFeeWei`. (Current placeholder 0.001 ETH is
   non-zero; OrangeGooey confirms the final immutable values.)
2. **Confirm the collection is a plain ERC-721.** The F-2 fix relies on
   `collection.transferFrom(this, requester, id)` never reverting. If the RobinWood
   NFT had a transfer blocklist / ERC-721C hook / revert-capable `_beforeTokenTransfer`,
   a pinned-but-undeliverable request could brick the slot. Verify the mainnet
   `MARKET_COLLECTION_ADDRESS` has no revert-capable transfer restrictions before
   deploy. (Reported standard; must be confirmed on-chain — see runbook checklist.)

## OPTIONAL hardening (defense-in-depth; requires recompile + re-review if taken)
3. **Raise `ROUND_LEAD`** (currently 1 → target round = now+2, ~6s). On this Orbit
   chain the sequencer controls `block.timestamp`; a backdate beyond ~2 periods could
   let a colluding requester predict the draw and grind. This is the documented
   sequencer-trust residual; a larger lead (~30–60s) widens the margin at the cost of
   a few seconds of redeem latency. Medium severity, requires a malicious/manipulated
   sequencer clock (the stated trust boundary). If taken, it is a one-constant code
   change that re-triggers the green gate + this review.

## Info-level (non-blocking; nice-to-have)
- Defensive `if (!poolOpen) revert PoolNotOpen();` on `removeLiquidity` (harmless
  today — no one can hold LP pre-open — but makes intent explicit).
- `redeemTargetMany` uses `type(uint256).max` as a "no pending draw" sentinel;
  astronomically-improbable tokenId `2^256−1` collision is liveness-only, single
  `redeemTarget` unaffected.
- Cheap regression tests worth adding: two-LP fairness, extreme-ratio add after heavy
  sells, `redeemTarget` interaction with a *pinned* pending request, the exact
  `held == pending + n` boundary, `removeLiquidity` pre-open revert.

## Bottom line
Deploy is **not blocked by a code defect.** Gate it on: non-zero fees (1), a confirmed
plain-ERC-721 collection (2), and OrangeGooey's explicit acceptance of the internal-
audit basis in lieu of the formal external gate. The optional `ROUND_LEAD` bump is a
judgment call on sequencer-trust defense-in-depth.
