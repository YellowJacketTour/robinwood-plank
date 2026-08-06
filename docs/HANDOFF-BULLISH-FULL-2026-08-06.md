# HANDOFF — Marketplank Global Index Vault, Diamond (EIP-2535) Refactor

**Date:** 2026-08-06
**Branch:** `feat/global-index-vault`
**Verified by:** direct compile/test/read this session — every number below was reproduced, not carried forward from an earlier document.

This is an engineering handoff, not a pitch. Every claim traces to a file, a line, a test run, or a commit diff read this session. The "NOT YET DONE" section at the end is not filler — read it before assuming the system is complete.

---

## 1. Test suite status (verified this session)

`npx hardhat test` (bare) **fails** with `ERR_MODULE_NOT_FOUND` — this is not a bug in the test code. `hardhat.config.ts`'s `ts-node` compile target is the repo-root `tsconfig.json`, which is the **Next.js app's** tsconfig (`module: esnext`, `moduleResolution: bundler`) — appropriate for the Next.js app, not for ts-node resolving extensionless relative imports under Node's ESM loader. The repo already carries the correct fix: `package.json`'s `test:contracts` script pins `TS_NODE_PROJECT=tsconfig.hardhat.json` (CommonJS, `moduleResolution: node`), which is the tsconfig meant for `test/contracts/**`. **The correct invocation is `npm run test:contracts`, not raw `npx hardhat test`.** No test file needed recreation or retirement — `test/contracts/helpers/index-vault.ts` and `AuditPoC.certik.test.ts` are current and correct against the Diamond facet interface.

Verified results, this session, both suites:

| Suite | Command | Result |
|---|---|---|
| Solidity/Hardhat contracts | `npm run test:contracts` | **600 passing, 0 failing** (~3m) |
| TypeScript market/app logic | `npm run test:market` | **440 passing, 0 failing** |

(The design doc's baseline at `ca2c1cc` recorded 519 passing before Stages 1-4 landed; 600 is the current, larger count after the facet bodies were built out.)

---

## 2. Compile + EIP-170 bytecode budget (verified this session)

`npx hardhat compile --force` → **77 Solidity files, compiled clean** (evm target `paris`; two pre-existing informational warnings — a deprecated `selfdestruct` in a test-only attack fixture, and two `view`-could-be-`pure` notes in test probe facets — no errors).

Deployed bytecode size of every contract under `contracts/diamond/`, measured from the freshly compiled artifacts' `deployedBytecode` field (limit: 24,576 bytes, EIP-170):

| Facet | Deployed bytes | Headroom |
|---|---:|---:|
| `IndexGovernanceFacet` | 12,872 | 11,704 (52% used) |
| `IndexTradeFacet` | 11,637 | 12,939 |
| `IndexLensFacet` | 9,112 | 15,464 |
| `IndexBootstrapFacet` | 8,774 | 15,802 |
| `IndexCoreFacet` | 6,351 | 18,225 |
| `DiamondCutFacet` | 5,943 | 18,633 |
| `IndexOracleFacet` | 4,922 | 19,654 |
| `IndexDividendFacet` | 4,814 | 19,762 |
| `IndexShareFacet` | 2,773 | 21,803 |
| `IndexEligibilityFacet` | 2,396 | 22,180 |
| `DiamondLoupeFacet` | 2,322 | 22,254 |
| `IndexDeployer` | 235 | — |
| `Diamond` | 189 | — |
| Storage libs (13 namespace libs, `LibDiamond`, `LibBytecodeScan`) | 86 each | — |

**Every facet is well under the EIP-170 limit**, the largest (`IndexGovernanceFacet`) using 52% of its budget. This confirms the design doc's central thesis (§1.2): moving off the single-monolith model (which was at 24,528/24,576 — 48 bytes free — before this refactor) permanently retires the byte-budget problem, because each facet gets its own independent 24,576-byte allowance.

---

## 3. Architecture summary

### 3.1 The Diamond pattern, as actually built

`contracts/diamond/Diamond.sol` is the EIP-2535 proxy. Its `fallback()` (`Diamond.sol:211-223`) looks up `msg.sig` in `DiamondStorage.Layout.selectorToFacetAndPosition`, `delegatecall`s the owning facet, and reverts `FunctionNotFound` on an unmapped selector — it never silently succeeds.

The **frozen-at-birth** deployment model in design-doc §6.2 ("the diamond is never live in a cuttable state") is implemented, not just specified:

- `IndexDeployer.sol` deploys the `Diamond` with `DiamondCutFacet` as its sole facet and itself (`address(this)`, valid only during its own constructor) as the sole cutter, cuts in the remaining facets from pre-deployed addresses, writes the three migrated `immutable`s + initial params + roles into storage, then calls `finalize(expectedFacetSetHash)` — all inside one constructor, i.e. one transaction.
- `LibDiamond.finalize` (`LibDiamond.sol:193-219`) is the gate: it requires `!ds.finalized`, `msg.sender == ds.cutter`, `facetSetHash() == expectedFacetSetHash` (re-derived from the loupe's *actual* installed state, not trusted from calldata), and `!CoreStorage.layout().indexOpen` (belt-and-braces: no cut can ever complete while the index holds public deposits). It then sets `ds.finalized = true` and removes **every** selector owned by the cut facet, including `finalize` itself.
- After that: there is no selector routing to `diamondCut` (fallback reverts `FunctionNotFound`), and even a hypothetically-reachable one would revert on `ds.finalized`. Two independent locks, both verified present in the code, matching design-doc §6.2's "two independent locks, both of which must fail for a cut to occur."
- `Diamond.sol` has **no `receive()` and no payable fallback** (`Diamond.sol:225`, `"NO receive(). NO payable anything."`) — the vault cannot hold ETH, asserted at the proxy level rather than per-facet.

### 3.2 Facet map (verified against `contracts/diamond/facets/`)

Built and live (11 facets, all cut by `IndexDeployer`, confirmed by `INDEX_FACETS` in `test/contracts/helpers/index-vault.ts:107-118`):

`DiamondLoupeFacet`, `IndexShareFacet` (ERC-20 share), `IndexCoreFacet` (exit door), `IndexBootstrapFacet` (seeding/open), `IndexTradeFacet` (single-asset mint/redeem), `IndexOracleFacet`, `IndexEligibilityFacet`, `IndexGovernanceFacet`, `IndexDividendFacet`, `IndexLensFacet` (read-only views). `DiamondCutFacet` exists but is deliberately absent from the *live* set — it is installed and then removed again inside `IndexDeployer`'s constructor, per §3.1.

**Not yet built:** `IndexStreamFacet` (design-doc §2.2 item 9 / Stage 5) and `HookRegistryFacet` (item 13 / Stage 6). See §6 "NOT YET DONE."

### 3.3 Storage namespaces

`contracts/diamond/storage/IndexStorage.sol` implements the ERC-7201-style derivation from design-doc §3.1 (`keccak256(...) - 1` masked to a 256-slot boundary) for 12 namespace libraries: `DiamondStorage`, `CoreStorage`, `ERC20Storage`, `ParamsStorage`, `RolesStorage`, `AllocationStorage`, `EcosystemStorage`, `DividendStorage`, `GovernanceStorage`, `HooksStorage`, `ReentrancyStorage`, plus (per the deployed-bytecode listing above, size 86 bytes each — pure library artifacts) `StreamStorage` is already declared even though `IndexStreamFacet` itself doesn't exist yet, i.e. the storage layout for streams was reserved ahead of the facet build.

`Diamond.storage.test.ts` and `Diamond.selectors.test.ts` (both in the 600-passing suite) are the automated proofs cited in design-doc §7.4 — namespace non-collision and 4-byte selector uniqueness across the union of facet ABIs.

### 3.4 ERC-7575 / ERC-7540 — adopted / rejected, and where (restated from the design doc, §4-§5)

- **ERC-7575 (share/vault split): adopted at the "canonical share" level, pipes NOT built.** The Diamond itself is the share (`IndexShareFacet` is the ERC-20). The design doc's own honest caveat (§4.4) is that `share() == address(this)` is "conformant but degenerate" without the per-constituent `IndexAssetPipe` contracts (§4.2) that would make it a genuine multi-entry-point 7575 vault. Those pipes are **Stage 6, not built.** Today `mintSingleAsset` / `redeemSingleAsset` on `IndexTradeFacet` already provide the per-asset entry/exit the pipes would formalize as separate addresses — the mechanism exists, the standardized address-per-asset surface does not.
- **ERC-7540 (async redeem/claim): explicitly rejected**, for the reasons in design-doc §5.3: it requires an escrowed Pending state (a asset lock, which the codebase's standing rule forbids), requires a privileged or gameable fulfiller to advance Pending→Claimable, and requires `previewRedeem` to revert — breaking properties this codebase has proven repeatedly (e.g. "the quote a caller is shown is the quote the same transaction fills at"). The system instead exposes a *documented partial conformance* over its own pre-existing pull-based `pendingClaim` ledger (§5.6) without claiming the ERC-165 interface id for full 7540 support — this partial-conformance piece is part of Stage 6 and not yet built either.

---

## 4. NFT index mechanics (from `contracts/diamond/facets/*.sol`, this session)

1. **Admission.** `IndexEligibilityFacet.checkEligibility` runs a gas-capped (`ELIGIBILITY_GAS_CAP = 50_000`) staticcall against an external `IEligibilitySource`, fails closed on any revert or short return (`IndexFacetBase.sol:441`). Listing itself is timelocked: `IndexGovernanceFacet.queueListing` (role `ROLE_CONSTITUENT_ADMISSION`) records an `eta = block.timestamp + timelockDelay`; `executeListing` applies it after `eta`, enforcing `MAX_CONSTITUENTS = 32` and recomputing the eligible count. Before the index opens, the `seeder` can add constituents directly via `IndexBootstrapFacet.seedConstituent`, bypassing the timelock (pre-launch only). The effective concentration cap is `min(capBpsFor(eligibleCount, targetHhiBps), params.concentrationCapBps)` — every mint/single-asset-redeem checks that an operation does not push any leg's weight further over that cap.
2. **Disqualification.** `executeListing` with `isRemoval=true` sets `active=false` and starts a decay ramp (`rampDuration`, from governance params) rather than an immediate cliff — no value moves at the moment of removal. Full deletion of the constituent slot happens via the permissionless `IndexBootstrapFacet.delistEmpty`, only once `!active && reserve == 0`.
3. **Minting.** `mintProRata` (`IndexCoreFacet.sol`) takes a ceil-rounded pro-rata basket deposit against every live constituent, with no oracle dependency, and reverts on short delivery from fee-on-transfer tokens. `mintSingleAsset` (`IndexTradeFacet.sol`) values the deposit at the oracle band's low end and the basket at its high end (conservative on both sides), and applies a weight-rebalancing fee that scales with how far the touched asset is from its target weight — underweight legs get a discount, overweight legs a surcharge, symmetric at target weight. Both paths skim a bounded platform allocation (ceilinged at 500 bps) to a governance-appointed treasury.
4. **Redemption + fault tolerance.** `redeemProRata` burns shares and debits every constituent's ledgered reserve **before** any external transfer is attempted (checks-effects-interactions across the whole basket in one pass), then pays each leg through `_payOrDefer`: a gas-capped, non-reverting low-level transfer that, on failure (e.g. a blacklisted or reverting token), credits `pendingClaim[holder][token]` instead of blocking the redemption. `claimPending`/`claimPendingMany` let the holder retry later and are gated by no role, no pause flag, and no hook — this is the "exit door" property design-doc §6.5 enumerates exhaustively and that `IndexCoreFacet` imports nothing privileged to preserve (no `ScopedRoles` import, no role modifier on any exit function).
5. **Dividends/ecosystem fees.** A single-asset EIP-2222-style magnified-dividend accumulator (`magnifiedDividendPerShare` + per-holder signed corrections in `IndexDividendFacet.sol`), updated on every transfer/mint/burn, with the locked seed balance excluded from eligible supply. Any per-push remainder that can't be accommodated (e.g. against near-zero eligible supply) is carried forward in `undistributedDividends` rather than reverting — this is the round-10 (3/5) poisoning fix (see §5 below). `harvestEcosystemFees` is permissionless and routes the segregated `ecosystemFeesWei[asset]` ledger (never mixed into redeemable reserves) to a governance-appointed sink.
6. **Governance timelocks.** A uniform `queueX`/`executeX` pattern across params, listings, roles, and platform treasury: `queueX` records `eta = block.timestamp + timelockDelay`; `executeX` requires `block.timestamp >= eta` and re-validates hard ceilings **at execution time**, not queue time. Roles have no renounce path (a role handover must name a nonzero successor) and re-queuing an already-queued change replaces it on a fresh full delay rather than appending.

---

## 5. Adversarial game-theory audit trail — verified vulnerability → fix → commit table

Built by reading `git show` diffs and full commit messages for every round-numbered commit on this branch, this session (not reconstructed from commit subject lines alone).

| Commit | Vulnerability / property closed | Fix mechanism (from the diff) |
|---|---|---|
| `840dfca` | Seaport relay accepted `orderType=4` (CONTRACT, resolved at fulfillment) bypassing static validation; stale cancelled orders stayed listed; unsigned "tip" items inflated price; missing `startTime` check; fractional `feeBps` crashed price calc | Whitelist only `FULL_OPEN` order type; on-chain cancel/fill/counter check before delisting (fails closed on RPC error); fixed tip/startTime/feeBps handling |
| `92c9979` | No fail-closed eligibility gate; mock WETH instead of real WETH9; same-address self-dealing not redirected; static 40% concentration cap; checkpoint count not risk-scaled; O(n²) sort blew gas at n=256 | Fail-closed `IEligibilitySource` check; vendored `CanonicalWeth9` with CEI-ordered unwrap; self-deal redirect to treasury; closed-form HHI cap; EVT-calibrated checkpoint count; O(n log n) sort |
| `1288775` | A single blanket admin address could reach every timelocked capability | New `ScopedRoles.sol` per-capability role registry; `roleForParamKey()` whitelists which role may queue which key |
| `8523349` | Value airdropped/fee'd to ERC-6551 token-bound accounts owned by vault-held NFTs had no accounting path | New `TBAValueSweeper`, permissionless per-asset-allowlisted sweep, no generic calldata/delegatecall, immutable sinks |
| `0186100` | **Verification round, not a fix.** Investigated whether an intent/settlement layer was needed to close front-running | 13 new tests proving pricing is oracle-band bound and no griefable settlement step exists; no code change |
| `68677cc` | `receiveDividends()` was the one entry point missing the "every entry is nonReentrant" guarantee | Added `nonReentrant` to `receiveDividends`, hardened defense-in-depth even though the live path was already unreachable |
| `04abae3` | `TBAValueSweeper.tbaAddress` was caller-supplied and self-attested (spoofable); sink addresses were unconstrained constructor args | Address now derived on-chain via `IERC6551Registry.account()` and matched exactly; constructor requires sinks be contracts |
| `40a42f4` | No path for imbalance/ecosystem fees to reach the dividend distributor without contaminating redeemable reserves | New segregated `ecosystemFeesWei[token]` ledger, never mixed into constituent reserves or read by pricing |
| `5496993` | **Refactor, not a vuln fix.** Contract was 63 bytes from EIP-170 | Extracted `IndexMath.sol`/`IndexParams.sol`, bodies moved verbatim |
| `ecc82ab` | **Architectural redesign** removing a cross-contract trust boundary | `IndexDividendDistributor` deleted; accrual collapsed into the vault via EIP-2222 magnified accumulator |
| `e4300bf` | **Feature addition.** LP/lending custodians holding vault shares never called `claimDividend()`, losing accrual | New `WrappedIndexShare` wrapper, proportional join, first-depositor inflation protection |
| `55fdd31` | **Feature addition.** Generalizes wrapper backing to N reward streams | Role-gated timelocked stream admission, measured-delta funding, per-leg fault-tolerant withdraw |
| `cd8d44a` | Real flash-drain: with `totalSupply()==0` on a reward stream, ~99.999...% of a pushed reward extractable in one tx for ~1 wei | `carry[token]` holds value pushed with no eligible holder, excluded from backing, released pro rata one block after real supply exists |
| `e4bb14c` | **Verification round.** | Exit-door stress tests at structural maxima; proved `ScopedRoles` has no renounce path |
| `18a1130` | CRITICAL: same-tx deposit→withdraw on `WrappedIndexShare` captured ~99% of stream backing the attacker never contributed to. HIGH: `PlankGauge` sybil math optimum was at N→∞, not N=1 | New mint displaces stream backing and vests linearly over `STREAM_VEST_BLOCKS` (caps single-tx capture ≈1%); gauge registration cost denominated in the burned asset, giving a finite interior optimum |
| `8aa0cb4` | **Refactor.** Contract at 24,499/24,576 bytes | Extracted `IndexOracle.sol`/`IndexValuation.sol`, bodies moved verbatim |
| `55e21a5` | One reverting-transfer constituent (e.g. blacklisted) permanently bricked `redeemProRata` for the entire basket | Fault-tolerant payout: reserves debited before any external call, bounded-gas non-reverting payout per leg, failing leg credited to `pendingClaim` instead of reverting |
| `8a225e0` | `magnifiedDividendPerShare` had no overflow accommodation — one push against near-zero eligible supply could permanently brick all future dividend accrual | Per-push delta capped at `room/2**32` instead of reverting; remainder carried in `undistributedDividends`; revert path removed entirely |
| `129d2e4` | Raw ERC-20 transfers into the vault (e.g. via `TBAValueSweeper`'s documented sink) credited no ledger entry — value silently stranded | Permissionless `syncConstituentBalance(token)` credits measured surplus of real balance over accounted total |
| `ca2c1cc` | A constituent flagged for removal is immediately `isExiting()` but the price band lags (~2.3h); could front-run a large single-asset exit into a still-mispriced leg | Large single-asset exits into a healthy leg require the band to hold across extra settled checkpoints while removal is queued, hard-clamped so it can't become a permanent lock |

**Arc, stated plainly:** the trail starts on a Seaport marketplace relay, then becomes a round-by-round adversarial audit of the vault and its satellite contracts, alternating real fixes (reentrancy, spoofable addresses, stranded value, division/overflow edge cases, front-runnable exit windows) with pure size-motivated library extractions forced by repeatedly hitting the 24,576-byte contract limit — which is the same pressure the Diamond refactor exists to retire permanently (§2). The genuinely quantified value-extraction bugs (flash-drain, unbacked-stream withdrawal, dividend-accumulator poisoning, basket-bricking griefer, stale-band exit race) are all in the last third of the trail and are each closed with a concrete, diff-traceable mechanism, not a vague hardening pass. This audit trail predates the Diamond refactor and was performed against `GlobalIndexVault.sol`/`WrappedIndexShare.sol` directly; the Diamond refactor's job (Stages 0-4, done) was to re-point these proofs at the facet set without re-opening any of them — the 600-passing suite is the evidence that job succeeded for the stages that are built.

---

## 6. Future-proofing

- **Diamond's own upgradeability model:** none, by design, post-finalize. `DiamondCutFacet` exists only during `IndexDeployer`'s constructor and is removed by `finalize` in the same transaction (§3.1). There is no admin, no owner, no implementation setter, and no path to re-install `diamondCut` afterward. The stated upgrade mechanism is **redeploy** — a redeploy cannot touch reserves already held by a different contract, and users migrate by calling the unblockable `redeemProRata` and depositing into the new diamond. This is a deliberate, documented trade (design-doc §6.3): the Diamond buys bytecode headroom and nothing else; any design that also buys post-deploy upgradeability would contradict the codebase's foundational non-upgradeability guarantee.
- **`IndexDeployer`'s role in preventing post-deploy backdooring:** verified in code (§3.1) — it is the sole permitted path to construct a live `Diamond` in a non-cuttable state, self-checks the loupe against a committed `expectedFacetSetHash` before finalizing, and reverts the whole deployment transaction if anything disagrees. Deploying `Diamond` directly (bypassing `IndexDeployer`) produces a still-cuttable diamond — the header comment on `Diamond.sol` says this explicitly ("NOT FOR DEPLOYMENT except through IndexDeployer").
- **`LibBytecodeScan`'s opcode rejection:** verified in code (§3.1, full read above) — `assertNoDangerousOpcodes`, called by `DiamondCutFacet` on every Add/Replace, performs a linear sweep of a facet's deployed bytecode that correctly skips PUSH-immediate data (matching the EVM's own jumpdest analysis, so it has no false positives/negatives on reachable code) and rejects any facet containing `SELFDESTRUCT` (0xff, catastrophic under `DELEGATECALL` — destroys the diamond itself) or `DELEGATECALL` (0xf4, a pivot that would let a facet's own delegatecall run with the diamond's full storage authority). The solc CBOR metadata trailer is stripped before scanning, fail-closed (an implausible trailer causes the *entire* code to be swept rather than trusted).
- **The three immutable→storage migration (§3.3 rule 2 of the design doc): DONE.** Verified in `contracts/diamond/storage/IndexStorage.sol:125-141` — `CoreStorage.Layout` now declares `timelockDelay`, `seeder`, and `dividendAsset` as storage fields, written exactly once, in `Diamond.sol`'s own constructor (`Diamond.sol:138-141`), before any facet exists to be delegatecalled into. This closes the exact failure mode the design doc calls "the #1 mechanical error in diamond conversions" (two facets silently disagreeing about a value that used to be `immutable`, because under `DELEGATECALL` an `immutable` resolves to whatever is baked into the *executing* facet's own bytecode). `Diamond.noWriteToImmutables.test.ts` — part of the 600 passing tests — is the automated proof that no function in the finalized facet set writes those slots again.

---

## 7. Incentive alignment / positive-sum mechanics (mechanism, not marketing)

- **Depositor vs. protocol at mint time:** `mintSingleAsset`'s fee (`IndexTradeFacet.sol`) is a pure function of how far the deposited asset is from its target weight — depositing an *underweight* asset is discounted, depositing an *overweight* one is surcharged, symmetric and zero at target. This makes rebalancing the basket toward target weights individually profitable for whoever does it first, rather than requiring a privileged rebalancer or off-chain solver; the fee revenue that isn't rebate stays in reserves for holders who did not trade (design-doc §7.2, re-verified live in the 600-passing suite: "FEE SYMMETRY: underweight discounted, overweight surcharged; the discount decays to nothing at target").
- **Holder vs. holder at redemption:** `redeemProRata`'s debit-then-pay ordering (§4.4 above) means one holder's redemption against a hostile/reverting constituent cannot degrade any other holder's ability to exit — deferred credit is per-holder, per-token, and immediately retryable, so the fault-tolerance mechanism does not create a queue or a race between holders.
- **Dividend accrual vs. new entrants:** the EIP-2222 magnified accumulator's per-holder correction term makes a newly-minted or newly-received share's claim on *prior* distributions exactly zero — a holder can only earn what accrues while they hold. Combined with the seed-lock exclusion, this means passive third-party custodians (e.g. an LP pool holding the share token) accrue dividends with zero action of their own, which the design doc identifies (§5.4) as the reason the *dividend* leg specifically is allowed to use the accumulator model — value accrues to the token, which is what makes it captureable by anyone downstream holding the token, rather than accruing to an address that has to actively claim.
- **Ecosystem fees are segregated, never inflate NAV artificially:** `ecosystemFeesWei[token]` (round `40a42f4`) is never mixed into a constituent's redeemable `reserve` and never read by pricing (`nav()`/valuation) — so fee accrual cannot be used to make the index look more valuable than its redeemable backing, which would be a direct misalignment between marketed NAV and actual claim.
- **Governance cannot move faster than users can react:** every parameter, listing, and role change is queue/execute with a real timelock (`CoreStorage.timelockDelay`, floor 48 hours / ceiling 30 days, enforced at `Diamond` construction — `Diamond.sol:57-58,130-136`) and hard ceilings re-checked at *execution* time rather than trusted from queue time — so a role holder cannot queue a change while a ceiling is generous and have it apply after the ceiling tightens.

---

## 8. NOT YET DONE — explicit, so this reads as an honest handoff

Cross-referenced against design-doc §9's staged plan (Stage 0 through Stage 7) and verified by directory listing (`find contracts/diamond -iname "*.sol"`, this session):

| Stage | Status | Evidence |
|---|---|---|
| Stage 0 — scaffolding (Diamond, cut/loupe facets, `IndexDeployer`, empty namespace libs, §7.4 tests) | **DONE** | `Diamond.storage/.bytecode/.selectors/.finalize/.noWriteToImmutables/.fallback.test.ts` all present and passing in the 600 |
| Stage 1 — libraries `external` → `internal` | **DONE** | `LibBytecodeScan` rejects `DELEGATECALL` (0xf4); the fact all facets compiled clean under that scan is itself evidence no external-library delegatecall targets remain in the diamond facets |
| Stage 2 — ERC-20 + core facets (`IndexShareFacet`, `IndexCoreFacet`, `IndexBootstrapFacet`, `IndexLensFacet`) | **DONE** | All four present in `contracts/diamond/facets/`, wired into `INDEX_FACETS`, exercised by the 600-test suite |
| Stage 3 — oracle, trade, eligibility facets | **DONE** | `IndexOracleFacet`, `IndexTradeFacet`, `IndexEligibilityFacet` present and tested |
| Stage 4 — governance, roles, allocation, ecosystem, dividends | **DONE** | `IndexGovernanceFacet`, `IndexDividendFacet` present; `GlobalIndexVault.sol` no longer exists in `contracts/` (monolith retired, per commit `4cff5a7`'s message and confirmed by its absence from `find contracts -iname "GlobalIndexVault*"`) |
| **Stage 5 — streams (`IndexStreamFacet`, deferred-credit stream legs in `redeemProRata`)** | **NOT DONE** | No `IndexStreamFacet.sol` exists under `contracts/diamond/facets/`. `StreamStorage` namespace is declared (reserved ahead of time) but unused by any facet. `WrappedIndexShare.sol` **still exists** as a separate, undissolved contract in `contracts/` — the two-token model (vault share + `wIDX`) has not yet been unified, meaning the `RedTeam.WrapStreamDilution` attack surface the design doc wants eliminated (§4.2) is still structurally present, just still defended by round-9f's existing mitigation on the old contract. |
| **Stage 6 — ERC-7575 `IndexAssetPipe` contracts + `HookRegistryFacet`** | **NOT DONE** (explicitly optional per design doc) | No `HookRegistryFacet.sol`, no pipe contracts exist. `IndexShareFacet.share()` returning `address(this)` is the only ERC-7575 conformance currently live — the "degenerate but conformant" case the design doc's own §4.4 caveat warns about. |
| Stage 7 — finalize rehearsal (deploy through `IndexDeployer`, run the entire suite against a *finalized* diamond) | **DONE, at least for the built stages** | `Diamond.finalize.test.ts` is in the passing 600 and asserts `isFinalized()==true`, `facetAddress(diamondCut.selector)==address(0)`, a raw call to the cut selector reverts, and `redeemProRata` still succeeds post-finalize with every role key hostile. This has not yet been re-run against a facet set that includes streams, since that facet doesn't exist. |

**Net position:** the core exit-door, mint, oracle, trade, eligibility, and governance surface is fully migrated to the Diamond and frozen-at-birth per the design doc, verified by a clean compile, a fully green 600-test suite, and every facet comfortably under EIP-170. **The stream/reward-vesting unification (Stage 5) and the ERC-7575 pipe/hook layer (Stage 6, explicitly marked optional in the design doc) are the two pieces of the design-doc plan that remain unbuilt.** Until Stage 5 lands, `WrappedIndexShare.sol` remains a live, separate contract and the single-token unification claimed as one of the refactor's core benefits (design-doc §10: "One token instead of two... the wrap step, the exchange rate, the wrapper's own inflation-attack surface... exist only because there were two tokens") is not yet realized on-chain — it is realized only for the facets that exist.
