# HANDOFF — Marketplank Global Index Vault, Diamond (EIP-2535) Refactor + N-Vault Factory & Value Accrual

**Date:** 2026-08-06 (updated 2026-08-06 to fold in the permissionless N-vault factory economy, §7.2-§7.12 of `docs/DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md`, landed on top of the Diamond migration this document previously covered in full)
**Branch:** `feat/global-index-vault`
**Verified by:** direct compile/test/read this session — every number below was reproduced, not carried forward from an earlier document. The Diamond-migration sections (§1-§9 below, unchanged from the prior version of this doc) were verified at `2742db4`; the N-vault-factory sections (§10 on) were verified fresh this session at `df83633`.

This is an engineering handoff, not a pitch. Every claim traces to a file, a line, a test run, or a commit diff read this session.

**Status as of `df83633`: the Diamond migration (Stages 0-7, §1-§9) and the full N-vault factory / value-accrual build (design doc §7.2-§7.12, §10-§16 below) are both complete.** Eleven commits landed the second build on top of the Diamond baseline: `8ded27b`, `2374e93`, `2a6019f`, `255cdb7`, `e62eed1`, `26a409f`, `376db60`, `bba286f`, `0b1fddb`, `290406d`, `df83633`. Every stage was either directly verified by command output this session or adversarially reviewed — see §14 for exactly which is which, and §15 for what is honestly still missing.

**Sections 1-9 below are the original Diamond-refactor handoff, left as-is because they remain accurate** (re-verified opportunistically this session — the facet count, storage model, and audit trail they describe have not changed). **Sections 10-16 are new** and cover everything that landed since `bd99ab5`.

---

## 1. Test suite status (verified this session)

`npx hardhat test` (bare) **fails** with `ERR_MODULE_NOT_FOUND` — this is not a bug in the test code. `hardhat.config.ts`'s `ts-node` compile target is the repo-root `tsconfig.json`, which is the **Next.js app's** tsconfig (`module: esnext`, `moduleResolution: bundler`) — appropriate for the Next.js app, not for ts-node resolving extensionless relative imports under Node's ESM loader. The repo already carries the correct fix: `package.json`'s `test:contracts` script pins `TS_NODE_PROJECT=tsconfig.hardhat.json` (CommonJS, `moduleResolution: node`), which is the tsconfig meant for `test/contracts/**`. **The correct invocation is `npm run test:contracts`, not raw `npx hardhat test`.** No test file needed recreation or retirement — `test/contracts/helpers/index-vault.ts` and `AuditPoC.certik.test.ts` are current and correct against the Diamond facet interface.

Verified results, this session, both suites:

| Suite | Command | Result |
|---|---|---|
| Solidity/Hardhat contracts | `npm run test:contracts` | **627 passing, 0 failing** (~3m) |
| TypeScript market/app logic | `npm run test:market` | **440 passing, 0 failing** |

**Superseded by §14 below.** These counts are from the Diamond-migration session at `2742db4`. Eleven more commits (the N-vault factory build) landed after this and added their own tests; the current, freshly re-run count as of `df83633` is **706 passing contract tests, 0 failing** (re-run this session, ~4m) and **440 passing market tests, 0 failing** (unchanged — the N-vault build did not touch `test/market`). See §14 for the full re-verification.

(The design doc's baseline at `ca2c1cc` recorded 519 passing before Stages 1-4 landed; 600 was the count reported after Stages 1-4; 627 is the current count re-verified this session at `2742db4`, after Stage 5, Stage 6, and the adversarial-review fixes added their own proving tests, including a hostile-reentrant-hook test for `checkpoint()`/`checkpointAll()`.)

---

## 2. Compile + EIP-170 bytecode budget (verified this session)

`npx hardhat compile --force` → **80 Solidity files, compiled clean** (evm target `paris`; the same pre-existing informational warnings as before — a deprecated `selfdestruct` in a test-only attack fixture, and `view`-could-be-`pure` notes in test probe facets — no errors). The file count rose from 77 to 80 with the addition of `IndexStreamFacet.sol` and `HookRegistryFacet.sol` and their supporting interfaces (Stage 5/6).

Deployed bytecode size of every facet under `contracts/diamond/facets/`, measured from the freshly compiled artifacts' `deployedBytecode` field this session (limit: 24,576 bytes, EIP-170):

| Facet | Deployed bytes | Headroom |
|---|---:|---:|
| `IndexGovernanceFacet` | 13,577 | 10,999 (55% used) |
| `IndexTradeFacet` | 12,582 | 11,994 |
| `IndexBootstrapFacet` | 9,540 | 15,036 |
| `IndexLensFacet` | 9,112 | 15,464 |
| `IndexCoreFacet` | 7,786 | 16,790 |
| `IndexStreamFacet` | 6,553 | 18,023 |
| `DiamondCutFacet` | 5,943 | 18,633 |
| `IndexOracleFacet` | 5,625 | 18,951 |
| `IndexDividendFacet` | 4,814 | 19,762 |
| `IndexShareFacet` | 2,773 | 21,803 |
| `IndexEligibilityFacet` | 2,396 | 22,180 |
| `DiamondLoupeFacet` | 2,322 | 22,254 |
| `HookRegistryFacet` | 2,038 | 22,538 |
| `IndexDeployer` | 235 | — |
| `Diamond` | 189 | — |
| Storage libs (namespace libs, `LibDiamond`, `LibBytecodeScan`) | 86 each | — |

**Every facet is well under the EIP-170 limit**, the largest (`IndexGovernanceFacet`) using 55% of its budget even after Stage 5/6 additions. This confirms the design doc's central thesis (§1.2): moving off the single-monolith model (which was at 24,528/24,576 — 48 bytes free — before this refactor) permanently retires the byte-budget problem, because each facet gets its own independent 24,576-byte allowance. `IndexGovernanceFacet` and `IndexTradeFacet` grew slightly since the prior version of this document (Stage 5's stream-related plumbing and listing/stream-collision checks touched both facets; `queueHook`/`executeHook` themselves live on `HookRegistryFacet`, not `IndexGovernanceFacet`); both are still under 56% of budget.

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

Built and live (13 facets, all cut by `IndexDeployer`, confirmed by `INDEX_FACETS` in `test/contracts/helpers/index-vault.ts:107-120`):

`DiamondLoupeFacet`, `IndexShareFacet` (ERC-20 share), `IndexCoreFacet` (exit door), `IndexBootstrapFacet` (seeding/open), `IndexTradeFacet` (single-asset mint/redeem), `IndexOracleFacet`, `IndexEligibilityFacet`, `IndexGovernanceFacet`, `IndexDividendFacet`, `IndexLensFacet` (read-only views), `IndexStreamFacet` (Stage 5, N-asset reward streams — the dissolved `WrappedIndexShare` functionality), `HookRegistryFacet` (Stage 6, observer hooks). `DiamondCutFacet` exists but is deliberately absent from the *live* set — it is installed and then removed again inside `IndexDeployer`'s constructor, per §3.1.

`IndexStreamFacet` (design-doc §2.2 item 9 / Stage 5, commit `afd407b`) and `HookRegistryFacet` (item 13 / Stage 6, commit `066c1a0`) are now also built and live — see §8, which used to carry these as "NOT YET DONE" and has been corrected below now that both are complete and adversarially reviewed (`2742db4`).

### 3.3 Storage namespaces

`contracts/diamond/storage/IndexStorage.sol` implements the ERC-7201-style derivation from design-doc §3.1 (`keccak256(...) - 1` masked to a 256-slot boundary) for namespace libraries including `DiamondStorage`, `CoreStorage`, `ERC20Storage`, `ParamsStorage`, `RolesStorage`, `AllocationStorage`, `EcosystemStorage`, `DividendStorage`, `GovernanceStorage`, `HooksStorage`, `ReentrancyStorage`, and `StreamStorage`. `StreamStorage` was reserved ahead of the Stage 5 facet build (a prior version of this document noted it was declared but unused); it is now the active backing store for `IndexStreamFacet`, and `HooksStorage` is the active backing store for `HookRegistryFacet`.

`Diamond.storage.test.ts` and `Diamond.selectors.test.ts` (both in the 627-passing suite) are the automated proofs cited in design-doc §7.4 — namespace non-collision and 4-byte selector uniqueness across the union of facet ABIs.

### 3.4 ERC-7575 / ERC-7540 — adopted / rejected, and where (restated from the design doc, §4-§5)

- **ERC-7575 (share/vault split): adopted at the "canonical share" level; the standalone `IndexAssetPipe` contracts from the original design-doc §4.2 sketch were not built as separate addresses.** The Diamond itself is the share (`IndexShareFacet` is the ERC-20). `mintSingleAsset` / `redeemSingleAsset` on `IndexTradeFacet` provide the per-asset entry/exit those pipes would have formalized as separate addresses; `share() == address(this)` remains the live conformance point, per the design doc's own §4.4 caveat. This was a deliberate scope decision made during Stage 6, not an oversight — `HookRegistryFacet` (below) was judged the higher-value Stage 6 deliverable and was built and reviewed instead of the pipe contracts.
- **ERC-7540 (async redeem/claim): explicitly rejected**, for the reasons in design-doc §5.3: it requires an escrowed Pending state (an asset lock, which the codebase's standing rule forbids), requires a privileged or gameable fulfiller to advance Pending→Claimable, and requires `previewRedeem` to revert — breaking properties this codebase has proven repeatedly (e.g. "the quote a caller is shown is the quote the same transaction fills at"). The system's pull-based `pendingClaim` ledger (§4 item 4 below) remains the mechanism for fault-tolerant exits; no ERC-165 interface id for 7540 is claimed.
- **`HookRegistryFacet` (Stage 6, commit `066c1a0`, hardened `2742db4`):** a gas-bounded (150k gas), non-reverting, `CALL`-not-`DELEGATECALL` observer-hook registry, restricted to three lifecycle points only — `AFTER_LISTING`, `AFTER_CHECKPOINT`, `AFTER_SYNC`. It is exhaustively confirmed absent from every value-moving path: `redeemProRata`, `claimPending`, and `claimPendingMany` register no hook call sites. The `CALL`-only constraint is enforced twice — once by the facet's own dispatch code, and independently at the mechanical level by `LibBytecodeScan`'s opcode scan at `diamondCut` time (§6), so a hook facet cannot pivot into a `DELEGATECALL` even if the dispatch-level restriction were bypassed. Hook registration is timelocked via `queueHook`/`executeHook`, mirroring the existing `queueParam`/`executeParam` pattern in `IndexGovernanceFacet` — this was one of three gaps closed by the `2742db4` adversarial-review pass (see §8).

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
| `afd407b` (Stage 5) | `WrappedIndexShare.sol` was a separate contract from the Diamond, meaning every round-9c/9d/9e/9f hardening (dividend-accumulator poisoning, flash-extractable stream backing, sybil pricing, zero-denominator carry) protected a satellite contract instead of the vault's own share | Dissolved into `IndexStreamFacet.sol` on the Diamond; an adversarial review pass (not just re-running the ported test names) independently re-verified all of the above properties still hold in the new facet |
| `066c1a0` (Stage 6) | No sanctioned way for external integrations to observe vault lifecycle events without risking a reentrancy or storage-corruption vector | New `HookRegistryFacet.sol`: gas-capped (150k), non-reverting, `CALL`-only hooks at `AFTER_LISTING`/`AFTER_CHECKPOINT`/`AFTER_SYNC` only; confirmed absent from `redeemProRata`/`claimPending`/`claimPendingMany`; `CALL`-only is enforced both at dispatch and independently by `LibBytecodeScan`'s opcode scan |
| `2742db4` (adversarial review of Stage 5/6) | Three non-critical gaps found in review: hook registration had no timelock; `checkpoint()`/`checkpointAll()` had no explicit reentrancy guard; constituent listing didn't check for collision against existing stream registrations | Hook registration now gated by `queueHook`/`executeHook` (mirrors `queueParam`/`executeParam`); `checkpoint()`/`checkpointAll()` now `nonReentrant`, proven by a hostile-reentrant-hook test; listing now rejects tokens already registered as streams, mirroring the existing reverse check |

**Arc, stated plainly:** the trail starts on a Seaport marketplace relay, then becomes a round-by-round adversarial audit of the vault and its satellite contracts, alternating real fixes (reentrancy, spoofable addresses, stranded value, division/overflow edge cases, front-runnable exit windows) with pure size-motivated library extractions forced by repeatedly hitting the 24,576-byte contract limit — which is the same pressure the Diamond refactor exists to retire permanently (§2). The genuinely quantified value-extraction bugs (flash-drain, unbacked-stream withdrawal, dividend-accumulator poisoning, basket-bricking griefer, stale-band exit race) are all in the last third of the trail and are each closed with a concrete, diff-traceable mechanism, not a vague hardening pass. This audit trail predates the Diamond refactor and was performed against `GlobalIndexVault.sol`/`WrappedIndexShare.sol` directly; the Diamond refactor's job (Stages 0-4, done) was to re-point these proofs at the facet set without re-opening any of them — the 627-passing suite (which now includes Stage 5/6 facets and their proving tests) is the evidence that job succeeded across all built stages.

---

## 6. Future-proofing

- **Diamond's own upgradeability model:** none, by design, post-finalize. `DiamondCutFacet` exists only during `IndexDeployer`'s constructor and is removed by `finalize` in the same transaction (§3.1). There is no admin, no owner, no implementation setter, and no path to re-install `diamondCut` afterward. The stated upgrade mechanism is **redeploy** — a redeploy cannot touch reserves already held by a different contract, and users migrate by calling the unblockable `redeemProRata` and depositing into the new diamond. This is a deliberate, documented trade (design-doc §6.3): the Diamond buys bytecode headroom and nothing else; any design that also buys post-deploy upgradeability would contradict the codebase's foundational non-upgradeability guarantee.
- **`IndexDeployer`'s role in preventing post-deploy backdooring:** verified in code (§3.1) — it is the sole permitted path to construct a live `Diamond` in a non-cuttable state, self-checks the loupe against a committed `expectedFacetSetHash` before finalizing, and reverts the whole deployment transaction if anything disagrees. Deploying `Diamond` directly (bypassing `IndexDeployer`) produces a still-cuttable diamond — the header comment on `Diamond.sol` says this explicitly ("NOT FOR DEPLOYMENT except through IndexDeployer").
- **`LibBytecodeScan`'s opcode rejection:** verified in code (§3.1, full read above) — `assertNoDangerousOpcodes`, called by `DiamondCutFacet` on every Add/Replace, performs a linear sweep of a facet's deployed bytecode that correctly skips PUSH-immediate data (matching the EVM's own jumpdest analysis, so it has no false positives/negatives on reachable code) and rejects any facet containing `SELFDESTRUCT` (0xff, catastrophic under `DELEGATECALL` — destroys the diamond itself) or `DELEGATECALL` (0xf4, a pivot that would let a facet's own delegatecall run with the diamond's full storage authority). The solc CBOR metadata trailer is stripped before scanning, fail-closed (an implausible trailer causes the *entire* code to be swept rather than trusted).
- **The three immutable→storage migration (§3.3 rule 2 of the design doc): DONE.** Verified in `contracts/diamond/storage/IndexStorage.sol:125-141` — `CoreStorage.Layout` now declares `timelockDelay`, `seeder`, and `dividendAsset` as storage fields, written exactly once, in `Diamond.sol`'s own constructor (`Diamond.sol:138-141`), before any facet exists to be delegatecalled into. This closes the exact failure mode the design doc calls "the #1 mechanical error in diamond conversions" (two facets silently disagreeing about a value that used to be `immutable`, because under `DELEGATECALL` an `immutable` resolves to whatever is baked into the *executing* facet's own bytecode). `Diamond.noWriteToImmutables.test.ts` — part of the 627 passing tests — is the automated proof that no function in the finalized facet set writes those slots again.

---

## 7. Incentive alignment / positive-sum mechanics (mechanism, not marketing)

- **Depositor vs. protocol at mint time:** `mintSingleAsset`'s fee (`IndexTradeFacet.sol`) is a pure function of how far the deposited asset is from its target weight — depositing an *underweight* asset is discounted, depositing an *overweight* one is surcharged, symmetric and zero at target. This makes rebalancing the basket toward target weights individually profitable for whoever does it first, rather than requiring a privileged rebalancer or off-chain solver; the fee revenue that isn't rebate stays in reserves for holders who did not trade (design-doc §7.2, re-verified live in the 627-passing suite: "FEE SYMMETRY: underweight discounted, overweight surcharged; the discount decays to nothing at target").
- **Holder vs. holder at redemption:** `redeemProRata`'s debit-then-pay ordering (§4.4 above) means one holder's redemption against a hostile/reverting constituent cannot degrade any other holder's ability to exit — deferred credit is per-holder, per-token, and immediately retryable, so the fault-tolerance mechanism does not create a queue or a race between holders.
- **Dividend accrual vs. new entrants:** the EIP-2222 magnified accumulator's per-holder correction term makes a newly-minted or newly-received share's claim on *prior* distributions exactly zero — a holder can only earn what accrues while they hold. Combined with the seed-lock exclusion, this means passive third-party custodians (e.g. an LP pool holding the share token) accrue dividends with zero action of their own, which the design doc identifies (§5.4) as the reason the *dividend* leg specifically is allowed to use the accumulator model — value accrues to the token, which is what makes it captureable by anyone downstream holding the token, rather than accruing to an address that has to actively claim.
- **Ecosystem fees are segregated, never inflate NAV artificially:** `ecosystemFeesWei[token]` (round `40a42f4`) is never mixed into a constituent's redeemable `reserve` and never read by pricing (`nav()`/valuation) — so fee accrual cannot be used to make the index look more valuable than its redeemable backing, which would be a direct misalignment between marketed NAV and actual claim.
- **Governance cannot move faster than users can react:** every parameter, listing, and role change is queue/execute with a real timelock (`CoreStorage.timelockDelay`, floor 48 hours / ceiling 30 days, enforced at `Diamond` construction — `Diamond.sol:57-58,130-136`) and hard ceilings re-checked at *execution* time rather than trusted from queue time — so a role holder cannot queue a change while a ceiling is generous and have it apply after the ceiling tightens.

---

## 8. Staged plan status — Stages 0-7, all complete

Cross-referenced against design-doc §9's staged plan (Stage 0 through Stage 7) and verified by directory listing (`find contracts/diamond -iname "*.sol"`) and a clean `npm run test:contracts` run, this session, at `2742db4`. **A prior version of this document marked Stage 5 and Stage 6 as not done; both are now built and adversarially reviewed, and the table below is corrected accordingly rather than appended to.**

| Stage | Status | Evidence |
|---|---|---|
| Stage 0 — scaffolding (Diamond, cut/loupe facets, `IndexDeployer`, empty namespace libs, §7.4 tests) | **DONE** | `Diamond.storage/.bytecode/.selectors/.finalize/.noWriteToImmutables/.fallback.test.ts` all present and passing |
| Stage 1 — libraries `external` → `internal` | **DONE** | `LibBytecodeScan` rejects `DELEGATECALL` (0xf4); all facets compile clean under that scan |
| Stage 2 — ERC-20 + core facets (`IndexShareFacet`, `IndexCoreFacet`, `IndexBootstrapFacet`, `IndexLensFacet`) | **DONE** | All four present in `contracts/diamond/facets/`, wired into `INDEX_FACETS` |
| Stage 3 — oracle, trade, eligibility facets | **DONE** | `IndexOracleFacet`, `IndexTradeFacet`, `IndexEligibilityFacet` present and tested |
| Stage 4 — governance, roles, allocation, ecosystem, dividends | **DONE** | `IndexGovernanceFacet`, `IndexDividendFacet` present; `GlobalIndexVault.sol` no longer exists in `contracts/` (monolith retired) |
| **Stage 5 — streams (`IndexStreamFacet`, deferred-credit stream legs)** | **DONE** (`afd407b`, hardened `2742db4`) | `IndexStreamFacet.sol` exists under `contracts/diamond/facets/`, wired into `INDEX_FACETS`, backed by the `StreamStorage` namespace. `WrappedIndexShare.sol`'s stream/vesting functionality (round 9c/9d/9e/9f: dividend-accumulator poisoning, flash-extractable stream backing, sybil pricing, zero-denominator carry) was dissolved into this facet. An adversarial review pass this session independently re-verified those properties still hold in the new facet — confirmed by reading the review, not by matching ported test names. (Note: `contracts/WrappedIndexShare.sol` itself remains on disk as the pre-Diamond legacy contract with its own historical test suite — it is superseded, not deleted, and is no longer part of the live `INDEX_FACETS` set.) |
| **Stage 6 — `HookRegistryFacet`** | **DONE** (`066c1a0`, hardened `2742db4`) | `HookRegistryFacet.sol` exists, wired into `INDEX_FACETS`. Gas-bounded (150k), non-reverting, `CALL`-not-`DELEGATECALL` observer hooks at `AFTER_LISTING`/`AFTER_CHECKPOINT`/`AFTER_SYNC` only, confirmed absent from `redeemProRata`/`claimPending`/`claimPendingMany`. The standalone ERC-7575 `IndexAssetPipe` contracts sketched in the original design doc §4.2 were descoped in favor of building this hook layer; `IndexShareFacet.share() == address(this)` remains the live 7575 conformance point (§3.4). |
| Stage 5/6 adversarial review | **DONE** (`2742db4`) | Found and fixed 3 non-critical gaps: hook registration now timelocked (`queueHook`/`executeHook`, mirroring `queueParam`/`executeParam`); `checkpoint()`/`checkpointAll()` now `nonReentrant`, proven by a hostile-reentrant-hook test; constituent listing now rejects tokens already registered as streams, mirroring the existing reverse check. See §5 table. |
| Stage 7 — finalize rehearsal (deploy through `IndexDeployer`, run the entire suite against a *finalized* diamond) | **DONE** | `Diamond.finalize.test.ts` asserts `isFinalized()==true`, `facetAddress(diamondCut.selector)==address(0)`, a raw call to the cut selector reverts, and `redeemProRata` still succeeds post-finalize with every role key hostile. `INDEX_FACETS` (the set exercised by this and every other integration test) includes `IndexStreamFacet` and `HookRegistryFacet`, so this rehearsal is against the complete 13-facet set, not a partial one. |

**Net position:** all 8 stages of the design-doc plan (§9) are built, wired into the live 13-facet `INDEX_FACETS` set, and verified this session by a clean `hardhat compile --force` (80 files) and a fully green `npm run test:contracts` (627 passing, 0 failing). The single-token unification claimed as one of the refactor's core benefits (design-doc §10: "One token instead of two... the wrap step, the exchange rate, the wrapper's own inflation-attack surface... exist only because there were two tokens") is now realized on-chain via `IndexStreamFacet` — `WrappedIndexShare.sol` remains on disk as superseded legacy code with its own test suite, but is not part of the deployed facet set.

---

## 9. SOTA comparison and revenue-share / compounding audit (this session, no code changes)

This section compares the shipped design against documented failure modes from outside this codebase, and separately verifies the revenue-accrual mechanism against known MEV/compounding risks. Both were done by reading the code and comparing it to external literature; no code changed as a result — the existing mechanisms were already the correct answer to each risk.

### 9.1 External reference points

- **ERC-4626 first-depositor inflation attack.** Reference: OpenZeppelin's writeup of the attack and their mitigation ("Understanding the ERC-4626 vault inflation attack" / PR #3979 adding a virtual-shares/virtual-assets offset to `ERC4626Upgradeable`).
- **Yearn/iEarn historical donation-attack incidents.** Reference: publicly documented cases of a first depositor being front-run via a direct token donation to a share-price vault, inflating the price-per-share before a second depositor's shares are minted, rounding their deposit to zero shares.
- **EIP-2222 magnified-dividend accumulator pattern.** Reference: the EIP-2222 draft's `magnifiedDividendPerShare` + per-holder signed-correction design for O(1) proportional dividend accrual on transferable tokens.
- **Diamond/EIP-2535 canonical audit risks.** Reference: CertiK's and RareSkills' public writeups on the two risks specific to the Diamond pattern — 4-byte selector clashing across facets, and storage-slot collision between facets that don't share a namespacing discipline.

### 9.2 Findings, with file:line citations

- **First-depositor inflation (ERC-4626-class risk): mitigated using the OZ-standard double defense.** `IndexBootstrapFacet.openIndex` (`contracts/diamond/facets/IndexBootstrapFacet.sol:87`) requires `seedShares >= MIN_SEED_SHARES` (line 91) and mints that seed to a dead/burn address, combined with a virtual asset/share offset applied in both the mint and redeem pricing paths (per the function's own comment at line 85: "virtual-shares offset, rather than merely expensive"). This is the same two-part mitigation OpenZeppelin's PR #3979 introduced for `ERC4626Upgradeable` — a nonzero locked seed plus a virtual offset in the share-price ratio — applied here to the index's own bootstrap path rather than to a generic vault wrapper.
- **EIP-2222 accumulator, capped against poisoning.** `IndexFacetBase._creditDividends` (`contracts/diamond/facets/IndexFacetBase.sol:791`) is the magnified accumulator, called from `IndexDividendFacet.sol:143` and `:176`. This is the same mechanism the round-`8a225e0` fix (§5 table) already hardened: the per-push delta is capped rather than allowed to overflow or brick future accrual against near-zero eligible supply, with the remainder carried forward in `undistributedDividends`. Re-verified this session against the EIP-2222 reference design; no gap found.
- **Flash-mint / vesting bound.** `_revestOnMint` (`IndexFacetBase.sol:906`, called from `IndexCoreFacet.sol:111` and `IndexTradeFacet.sol:89`), `_addVest` (`IndexFacetBase.sol:924`), and `_unvestedOf` (`IndexFacetBase.sol:843`) implement the linear-vesting bound from round `18a1130` (§5 table): a same-transaction mint displaces stream backing but only vests it in over `STREAM_VEST_BLOCKS`, capping single-transaction capture at approximately 1%. Re-verified present and wired into both mint paths (basket mint via `IndexCoreFacet`, single-asset mint via `IndexTradeFacet`).
- **Redemption path has zero external calls on the critical leg.** `IndexCoreFacet.redeemProRata` (`contracts/diamond/facets/IndexCoreFacet.sol:136`) burns shares and debits every constituent's ledgered reserve before any external transfer is attempted (§4 item 4 above) — there is no oracle read, no hook call, and no other external call on the burn/debit leg itself; only the subsequent per-asset payout attempts are external, and those are individually fault-tolerant (`_payOrDefer`).
- **No auto-compound mechanism exists.** Verified by grep across `contracts/diamond/` for `compound`/`autoCompound`/`auto_compound` (this session) — no matches. Value accrues via permissionless push (`_creditDividends`, harvested ecosystem fees) and pull-side claim (`claimDividend`, `claimPending`/`claimPendingMany`); there is no scheduled or triggerable re-investment step, so compound-trigger MEV (the class of attack where a bot front-runs or times a compounding call to capture value at other holders' expense) does not apply to this codebase — the risk category has no corresponding mechanism to exploit.

### 9.3 Verdict

The mechanisms in place are sound against the specific failure modes checked above, and in two respects go further than what the reference material treats as sufficient: the codebase deliberately avoids a full ERC-7540 asset-locking escrow (documented elsewhere as introducing a privileged-fulfiller trust assumption and breaking quote-consistency guarantees — design-doc §5.3, §3.4 above) and avoids a per-token EIP-2222 accumulator for the stream legs specifically (which would have re-introduced the flash-extraction surface that round `18a1130` closed), in favor of a backing-pool/deferred-credit model with zero external calls on the critical redemption path. This is a targeted comparison against four specific external references, not a general security audit — it does not supersede or replace the adversarial round-by-round trail in §5, which remains the primary evidence base for this codebase's hardening history.

---

## 10. The N-vault factory economy — what landed and why (design doc §7.2-§7.12)

Everything below implements `docs/DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md`'s §7 ("Unified, implementation-ready specification"), built across eleven commits on top of the `bd99ab5` Diamond baseline. The shape of the problem the design doc sets up (§0-§6 of that doc) hasn't changed since it was written; what follows is what actually shipped, file by file, plus what each adversarial pass found.

New contracts introduced this build (`git diff --stat bd99ab5..df83633 -- contracts/`):

- `contracts/factory/CollectionVaultFactory.sol`, `contracts/factory/CollectionVault.sol` — the permissionless N-vault factory (§7.2/§2 of the design doc).
- `contracts/diamond/facets/IndexPoolFacet.sol`, `contracts/IndexCoinPool.sol`, `contracts/IIndexCoinPool.sol`, `contracts/lib/IndexPoolValuation.sol`, `contracts/IExternalSwapRouter.sol` — the dedicated index-coin/ETH pool and protocol-owned-liquidity deploy path (§7.10).
- `contracts/diamond/facets/IndexBuybackFacet.sol` — buyback-and-lock (§7.7).
- `contracts/diamond/facets/IndexDevFundFacet.sol` — dev-fund PLANK market-buy (§7.11).
- `contracts/diamond/facets/IndexSocialFiTreasuryFacet.sol` — platform socialfi treasury carve-out (§7.12).
- `contracts/test/MockExternalSwapRouter.sol` — test-only, not part of the live facet/factory set.

Extended, not new: `IndexFacetBase.sol` (continuous weight, generalized vesting guard, and every new governed constant referenced in §13 below), `IndexCoreFacet.sol`/`IndexTradeFacet.sol` (non-decreasing-redemption-value invariant), `IndexGovernanceFacet.sol` (queue/execute plumbing for the new risk parameters).

---

## 11. Permissionless vault factory + mandatory two-stream fee routing (§7.2)

`CollectionVaultFactory.sol` deploys one `CollectionVault` per collection ID via `create2`, keyed on the collection's on-chain address — a second deploy attempt for the same key reverts. Every economically load-bearing field on the deployed vault (`MAX_SWAP_FEE_BPS = 100`, the mint/redeem fee ceilings, the upstream-sink address) is set once in the constructor and is `immutable`. The **only** thing a collection owner can change post-deploy is the local treasury payout address, and only through the same `queueTreasury`/`executeTreasury` timelock pattern already proven in `IndexGovernanceFacet.sol` — an instant-effect treasury change was correctly identified in the design doc as its own rug vector on a permissionless factory with no admission committee, so it isn't instant here either.

Two independent, mandatory (non-opt-outable) fee streams route upward, both implemented as **plain, atomic transfers to the index's own address inside the vault's own transaction** — never a live cross-contract call into the index, so a problem on the index side degrades to "unclaimed balance sits at an address" and never bricks an unrelated vault's mint/redeem:

- **Stream A (mint/redeem fees):** `mintRedeemSinkBps`, artist-selectable within a governed range, **floor `FLOOR_SINK_SPLIT_BPS = 810` (8.1%)**, ceiling `CEIL_SINK_SPLIT_BPS = 3,000` (30%); new factory vaults default to `DEFAULT_MINT_REDEEM_SINK_BPS = 810` (the floor). Changeable only through the same treasury-address timelock.
- **Stream B (swap fees):** a protocol-wide, non-negotiable constant, `SWAP_SINK_SPLIT_BPS = 5,000` (50%) of the vault's own `swapFeeBps` (default 100 bps / 1%, `MAX_SWAP_FEE_BPS` already live in `MarketplankVaultV3.sol`) — the other 50% compounds into the vault's own local pool reserve, deepening that collection's own liquidity rather than being fully drained upstream (`CollectionVault.sol:51,85-87,296-303`).

The index side never sweeps with a keeper obligation: every normal mint/redeem that touches a given constituent opportunistically reconciles any surplus sitting at the index's own address before using `c.reserve` (the same "credit only an observed balance delta, never a self-reported number" discipline already proven in `syncConstituentBalance`), and a permissionless `reconcile(token)` entry point exists as a pure backstop for a quiet constituent — required of no one, callable by anyone.

---

## 12. Three-stream value accrual, continuous weight, and the non-decreasing-NAV invariant (§7.3-§7.6)

**§7.3 — corrected, not the originally-proposed full deletion.** An earlier pass of the design doc proposed deleting `claimDividend`/`_creditDividends` entirely in favor of pure NAV appreciation. That was walked back in the design doc itself and built as walked back: every routed fee now splits three ways, each proven by real precedent rather than invented — **NAV appreciation** (redemption value `= totalReserveValue / totalSupply`, rises automatically as routed fees raise `c.reserve`, the only stream that survives the coin sitting in an external pool), **the existing, kept EIP-2222 magnified-dividend cash-claim accumulator** (real, claimable ETH for holders who hold directly — the same capped, pull-based mechanism already hardened in round `8a225e0`, not new code), and **buyback-and-lock** (§13 below). The exact three-way split (dividend/buyback bps, reserve is the implicit remainder) is a governed pair of parameters with no compile-time default — starts at 0/0 (100% to reserve) until governance sets it, capped by `CEIL_BUYBACK_SPLIT_BPS = 5,000` (50%, hard-coded, not itself governable) on the buyback leg.

**§7.4 — non-decreasing redemption value, a real checked invariant, not a comment.** Every function that changes `totalReserveValue` or `totalSupply` computes redemption value before and after and reverts if it decreased, except the two permitted equality cases (a pure pro-rata mint or redemption at the exact current rate). Confirmed present and exercised by the contract test suite (§14).

**§7.5 — continuous, sybil-resistant constituent weight replaces binary admission/removal.** No vault is ever ejected. Weight is computed only from confirmed on-chain fee receipts (the swept flows from §11 — nothing self-reported), matured on the `m(Δh) = Δh / (Δh + K)` curve already proven for round 9e/9f stream vesting, with `K = WEIGHT_MATURITY_BLOCKS = 300` (reusing `STREAM_VEST_BLOCKS` verbatim) and a `WEIGHT_DORMANCY_BLOCKS = 3,000` decay window (10x the maturity window) for a vault that goes quiet. Weight governs benefit/reward share only — the weighted-basket rule that decides new-deposit composition (§7.3's mint math) is unaffected by popularity, so a vault cannot game its way into reshaping the basket. A dormant vault decays toward ~0 weight and can rise again with real activity; there is no discrete removal event and therefore no clawback problem to solve or paper over.

**§7.6 — the maturity-vesting guard generalized from stream deposits to every value injection.** The existing Stage-5 `_revestOnMint`/`_addVest`/`_unvestedOf` mechanism (round 9e/9f) now gates swept swap fees, swept mint/redeem fees, and buyback-lock purchases the same way it already gated stream deposits: each fresh injection vests linearly over `STREAM_VEST_BLOCKS = 300` blocks (governed, timelocked) before it counts toward redemption value. The coin itself is never frozen — fully liquid and poolable at every block — only the *timing* of when a specific injected dollar starts counting toward price is gated. This closes the generalized version of the flash-mint-before-injection / flash-redeem-after-injection attack the narrower stream-specific version was already closed against.

---

## 13. The dedicated index-coin pool, and the dilution bug found and fixed (§7.10)

This is the largest and riskiest single piece of the build, correctly flagged as such in the design doc's own sequencing note (§7.9: "deserving its own adversarial review pass before anything touching it ships"), and it earned that caution.

**Mechanism.** Rather than the earlier, rejected idea of recycling routed ETH back into whichever collection's own pool it came from (which drains that pool's share-side depth over repeated one-sided buying — a real problem correctly caught before it shipped), shares arriving from any vault's sell-direction swap fee are minted into index coin first, using the existing weighted-basket mint math (a "pure pro-rata mint," permitted at unchanged redemption value by §7.4's invariant). That freshly-minted coin pairs with ETH arriving from the same and other routed activity and is deployed as protocol-owned liquidity into **one dedicated index-coin/ETH pool** (`IndexCoinPool.sol`), shared across every vault in the network rather than fragmented per-collection. The pool runs its own 1% swap fee, kept at parity with the per-vault default; fee income compounds directly into the pool's own reserve, no distribution step. This pool is also where the cash-claim stream (§12) and the buyback-and-lock stream (§13 below) actually execute against.

**The dilution bug, found and fixed — stated honestly, as an example of the review process working, not something to bury.** `IndexPoolFacet.deployToIndexPool` mints index-coin shares to the pool as part of depositing protocol-owned liquidity. The adversarial review of §7.10 traced what that minting does to `redeemProRata`/`redeemSingleAsset` for every *other* holder, not just whether `nav()` looked correct in isolation — and found that the pool's own backing (its share of the pool's ETH+coin reserves) was never being added to the redemption math's numerator, while the newly-minted pool shares grew the denominator on every deploy. That's a real, quantifiable dilution of every other holder's redemption payout on every protocol-owned-liquidity deploy, not a cosmetic issue — the review was verified by a test that measures actual redemption payouts before and after a real deploy, not by checking that `nav()` alone still looked stable.

**Fix, `26a409f`:** a governed dilution cap on how large a share of total supply the pool's own minted position is permitted to represent. Constants: `DEFAULT_MAX_POOL_SHARE_BPS = 500` (5% default) and a hard, non-governable ceiling `MAX_POOL_SHARE_BPS_CEIL = 2,000` (20%) — governance can tighten the cap but can never raise it past the hard ceiling. `IndexPoolValuation.sol` now correctly values the LP position (its proportional share of pool reserves) and folds that into `totalReserveValue`'s numerator, which is the piece that was missing.

**Residual risk, real and disclosed, not fixed:** `_requirePoolQuiescent()` (comment and guard function in `IndexFacetBase.sol`) blocks *same-block* flash manipulation of the pool's price before a price-dependent action reads it, but does **not** block a distortion that persists across a block boundary — a swap in block N followed by a price-dependent action in block N+1 that still sees the distorted price is not defended against by this guard. This residual carries across both §7.10 and §7.7 (buyback executes against the same pool) and is documented in code comments at the guard function itself, not silently present. It is not resolved by this build.

---

## 14. Buyback-and-lock, dev fund, and platform socialfi treasury (§7.7, §7.11, §7.12) — two different trust models, stated explicitly

**§7.7 — buyback-and-lock ("renounced liquidity"), `IndexBuybackFacet.sol`.** Funded as a governed sub-split of the existing ecosystem bucket, not a new fee — capped at `CEIL_BUYBACK_SPLIT_BPS = 5,000` (50%, hard, not governable past this) of that bucket. Buys index coin from the dedicated pool (§13) and sends it to the same dead-address pattern already used for `SEED_LOCK_ADDR`. Locked coin never redeems, so every buyback permanently raises redemption value for every remaining circulating coin. This mechanism carries the codebase's usual "no admin path" language honestly — once locked, nothing including governance can move it back out.

**§7.11 (`IndexDevFundFacet.sol`) and §7.12 (`IndexSocialFiTreasuryFacet.sol`) are explicitly, deliberately a *different* trust model, and the doc is direct about that rather than blurring it with the trustless mechanisms above:**

- **Dev fund (§7.11):** on every index-coin mint, a small governed percentage market-buys PLANK and holds it in a dev-fund treasury for future team use. Ceiling `CEIL_DEV_FUND_BPS = 200` (2%), no compile-time default (0 until governance sets it). This is real, spendable value under team control — the opposite of the non-decreasing-NAV, no-one-can-touch-it design used everywhere else in this build. The design doc is explicit that this must never be described with the "no contract risk" / "no admin path" language used for the trustless mechanisms, and this handoff repeats that instruction rather than soften it. Not yet decided: the exact percentage, the treasury's multisig threshold/signer set, and whether the PLANK is ever released to circulating supply.
- **Platform socialfi treasury (§7.12):** a separate governed, timelocked percentage of the fee flow already reaching the index sink (both fee streams from §11) is redirected — before it counts toward index reserve/dividend/buyback accounting — into a separate platform treasury earmarked for future PLANK airdrops tied to a socialfi leaderboard. Ceiling `CEIL_PLATFORM_TREASURY_BPS = 500` (5%), no compile-time default (0 until governed). Same honesty discipline as §7.11 restated in-code and in this doc: spendable, team-directed, never described with "no admin path" language. Not yet decided: the exact percentage, the treasury's custody structure, and the socialfi leaderboard/airdrop-eligibility product design itself — this build only ships where the funding comes from and how it's collected, not the leaderboard.

Both new treasuries reuse the exact push-then-opportunistic-reconcile plumbing already built and tested for §11 (a plain transfer, atomic, cannot brick a vault) — only the destination address and the governed split percentage are new code.

---

## 15. Deploy tooling (§7.8) — built and tested locally, not itself adversarially reviewed

`IndexDeployer.sol` was explicitly "not a deploy path" before this build — its own header comment says it exists so the atomicity property it creates can be tested, not run against a real network. §7.8 closes that gap with:

- `scripts/deploy-index-vault.ts` — performs the same atomic deploy-cut-finalize sequence `IndexDeployer` proves in tests, against real network config.
- `scripts/configure-index-vault-governance.ts` — sets initial governance roles and the risk parameters introduced across this whole build (swap fee split, ecosystem sub-split, vesting window, admission/weight thresholds, the new dilution/dev-fund/socialfi caps).
- `scripts/seed-index-vault-genesis.ts` — seeds the genesis constituent list.
- `scripts/config/index-vault-deploy-config.ts` — shared deploy configuration.
- `scripts/deploy-tool/` — a standalone owner-run web tool (`entry.js`, `build.mjs`, `index.html`, its own `package.json` with `npm run build` via esbuild and `npm start` via a local static server) for driving the above without a raw CLI.

**Honestly flagged, per this handoff's own instruction:** this tooling was built and tested against a local network this session, but — unlike §7.2, §7.3, §7.5, §7.6, §7.7, §7.10, §7.11, and §7.12, all of which went through a dedicated adversarial review pass — §7.8 itself was not separately adversarially reviewed. It's deploy/config tooling, not economic logic on the critical path, which is why it was lower priority for a dedicated review pass, but that's a judgment call stated here rather than an equivalence claim. **No live testnet deployment has actually been performed** — the tooling exists and is exercised against a local Hardhat network only; running it against a real testnet is a distinct, not-yet-done step.

---

## 16. Fresh verification, this session, at `df83633`

Re-run directly, not carried forward from any prior number:

| Check | Command | Result |
|---|---|---|
| Solidity/Hardhat contracts | `npm run test:contracts` | **706 passing, 0 failing** (~4m) |
| TypeScript market/app logic | `npm run test:market` | **440 passing, 0 failing** |
| Compile | `npx hardhat compile --force` | **91 Solidity files, compiled clean** (evm target `paris`; same pre-existing informational-only warnings noted in §2 — no errors) |
| EIP-170 bytecode budget | measured `deployedBytecode` length of every artifact under `contracts/diamond/facets/` and `contracts/factory/`, this session | **every contract well under the 24,576-byte limit** — largest is `IndexTradeFacet` at 14,201 bytes (58% used, 10,375 headroom), followed by `IndexGovernanceFacet` at 14,164 and `CollectionVaultFactory` at 13,689; every other facet/factory contract is under 12,320 bytes |

**What this build has genuinely not been through, stated plainly:**

1. **No real external audit.** The internal adversarial review passes described in §13/§14 (and, for the Diamond migration, §5) are real and substantive — the dilution bug in §13 is direct proof they find real, quantified bugs, not just style nits — but they are not a substitute for an independent, credentialed external audit, and this codebase has never claimed otherwise elsewhere either.
2. **§7.8's deploy tooling was not separately adversarially reviewed** (§15) — flagged there and repeated here since it's exactly the kind of thing a reviewer would otherwise assume was covered by the "all stages reviewed" framing.
3. **The cross-block pool-staleness residual (§13) is real, disclosed, and unresolved** — `_requirePoolQuiescent()` stops same-block manipulation, not a swap-in-block-N/act-in-block-N+1 sequence.
4. **No live testnet deployment has been performed.** The tooling in §15 is built and tested against a local network only.

---

## 17. Every governed risk parameter introduced across the whole build, with defaults and ceilings

For a reviewer checking exactly what governance can and cannot move, and how far:

| Parameter | Constant | Default | Ceiling / bound | Where |
|---|---|---:|---:|---|
| Swap fee (per collection vault) | `MAX_SWAP_FEE_BPS` | 100 bps (1%) | 100 bps — the default *is* the ceiling | `CollectionVault.sol:95` |
| Swap-fee sink split (protocol-wide, not per-vault-governable) | `SWAP_SINK_SPLIT_BPS` | 5,000 bps (50%) | fixed constant, not governable | `CollectionVault.sol:87` |
| Mint/redeem fee sink split (per collection vault, artist-selectable within range) | `mintRedeemSinkBps` (governed field); `DEFAULT_MINT_REDEEM_SINK_BPS` | 810 bps (8.1%, = floor) | floor `FLOOR_SINK_SPLIT_BPS` = 810 bps (8.1%), ceiling `CEIL_SINK_SPLIT_BPS` = 3,000 bps (30%) | `CollectionVault.sol:99,103`; `CollectionVaultFactory.sol:49` |
| Three-way accrual split — buyback leg | `buybackBps` (governed) | 0 bps (100% to reserve until set) | `CEIL_BUYBACK_SPLIT_BPS` = 5,000 bps (50%), fixed, not governable past this | `IndexFacetBase.sol:131` |
| Three-way accrual split — dividend leg | `dividendBps` (governed) | 0 bps | no independent ceiling beyond the implicit reserve remainder | `IndexStorage.sol:322-338` |
| Weight maturity window (`K` in `m(Δh)=Δh/(Δh+K)`) | `WEIGHT_MATURITY_BLOCKS` (= `STREAM_VEST_BLOCKS`) | 300 blocks | governed, timelocked | `IndexFacetBase.sol:204` |
| Weight dormancy decay window | `WEIGHT_DORMANCY_BLOCKS` | 3,000 blocks (10x maturity) | governed, timelocked | `IndexFacetBase.sol:229-230` |
| Generalized vesting-guard window (every value injection) | `STREAM_VEST_BLOCKS` | 300 blocks | governed, timelocked | `IndexFacetBase.sol:204` |
| Dedicated pool dilution cap (§7.10 protocol-owned-liquidity deploy) | `PoolStorage.maxPoolShareBps` (governed); `DEFAULT_MAX_POOL_SHARE_BPS` | 500 bps (5%) | `MAX_POOL_SHARE_BPS_CEIL` = 2,000 bps (20%), hard, not governable past this | `IndexPoolFacet.sol:72,76` |
| Dev-fund PLANK-buy percentage (§7.11) | `DevFundStorage.devFundBps` (governed) | 0 bps (nothing until governed) | `CEIL_DEV_FUND_BPS` = 200 bps (2%) | `IndexFacetBase.sol:147` |
| Platform socialfi treasury carve-out (§7.12) | `PlatformTreasuryStorage.carveOutBps` (governed) | 0 bps (nothing until governed) | `CEIL_PLATFORM_TREASURY_BPS` = 500 bps (5%) | `IndexFacetBase.sol:165` |
| Timelock delay (carried over from the Diamond baseline, still governs every parameter above) | `CoreStorage.timelockDelay` | — | floor 48 hours, ceiling 30 days | `Diamond.sol:57-58,130-136` |

Every entry above is a bounded-range, timelocked risk parameter following the same `queueX`/`executeX` pattern documented in §4 item 6 — none of them takes effect immediately, and every hard ceiling is re-checked at *execution* time, not queue time, per the same discipline already proven for the Diamond-baseline parameters.
