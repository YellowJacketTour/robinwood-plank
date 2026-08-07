# DESIGN — Unified Diamond Architecture for the Global Index Vault

**Status:** design only. No `.sol` changes accompany this document.
**Baseline verified:** `ca2c1cc` on `feat/global-index-vault`.
`npx hardhat clean && npx hardhat compile` → 57 files, ok.
`npm run test:contracts` → **519 passing**, 0 failing.
`GlobalIndexVault` deployed bytecode measured at **24,528 / 24,576 bytes** (48 bytes free), compiled with the existing per-file `runs: 1 + viaIR` override.

**Standing rules this design is written under, and none of which it relaxes:**
simulator/Hardhat only; no deploy scripts or network config touched; no key handling;
**no mechanism may lock or trap user assets**; every safety property proven to date must
have a named home in the new structure.

---

## 0. Executive summary — what I recommend, and what I recommend against

| Requested piece | Verdict | One-line reason |
|---|---|---|
| **EIP-2535 Diamond core** | **Adopt**, with one significant modification | Solves the byte budget permanently and legitimately — *but only if the diamond is never live in a cuttable state* (§6). A live, cuttable diamond would destroy the single strongest property this codebase has. |
| **Irrevocable `diamondCut` renouncement** | **Adopt, and strengthen to atomic-at-deploy** | A renouncement that happens *later* implies a window in which it hadn't happened yet. Close the window to zero blocks. |
| **ERC-7575 share/vault split** | **Adopt, with a caveat stated honestly** | Genuinely correct model for "one share, many entry points". But `share() == address(this)` on the diamond is a degenerate conformance; the value is only real if the per-asset *entry points (Pipes)* are actually built (§4). |
| **ERC-7540 async claims for stream vesting** | **Recommend AGAINST** | ERC-7540's defining mechanic is *escrow shares now, settle later*. That is, by construction, a mechanism that holds user assets in a non-withdrawable state. It is the exact shape this repo has refused in every prior round. See §5 for the full argument and the alternative I recommend instead. |
| **Uniswap-v4-style extension hooks** | **Adopt, in a de-fanged form** | `CALL` not `DELEGATECALL`, bounded gas, non-reverting, permission bitmap fixed at registration, and **categorically no hook anywhere on the `redeemProRata` path**. |
| *(new)* **Collapse stream distribution onto the EIP-2222 accumulator** | **Considered and REJECTED** | It looks like the elegant answer and it is not. `WrappedIndexShare.sol` records the counter-argument and the counter-argument is right: a per-holder accumulator strands value at an LP-pool address. Full analysis and the reversal in §5.4. |
| *(new)* **Merge streams into `redeemProRata` as deferred-credit legs** | **Recommend — this is the actual answer** | Keeps the composability-safe backing-pool model, ports round-9f verbatim, and adds **zero external calls** to the exit door. §5.5. |

**Single biggest new risk introduced:** not storage collision. It is that
`delegatecall` + a mutable selector table creates, for the first time in this codebase, a
state in which **`ROLE_ADMIN` is a de-facto withdrawal path over pooled reserves** — because a
cut can install a facet that does anything at all. Today "no role can reach reserves" is
proven by ABI enumeration (`GlobalIndexVault.audit.test.ts`: *"ANCHOR RULE: no privileged
function can reach reserves already pooled"*). Under a live diamond, ABI enumeration proves
nothing. The closure is §6: **the diamond is cut and frozen inside a single deployment
transaction and is never observable in a cuttable state.**

---

## 1. What exists today (the thing being refactored)

### 1.1 Contracts in scope

| File | Deployed bytes | Role |
|---|---|---|
| `GlobalIndexVault.sol` | 24,528 | ERC-20 share + basket custody + oracle + governance + dividends |
| `WrappedIndexShare.sol` | 15,474 | opt-in wrapper (`wIDX`) + N-asset reward streams + 9f re-vest |
| `PlankGauge.sol` | 15,359 | burn-for-weight gauge — **deliberately has no reach into the vault** |
| `TBAValueSweeper.sol` | 9,411 | ERC-6551 stranded-value capture, push-only, immutable sinks |
| `ScopedRoles.sol` | (abstract) | scoped-capability role base, shared by vault + gauge |
| `BackstopSizingCalculator.sol` | 2,008 | stateless pure CVaR library |
| `lib/IndexValuation` / `IndexOracle` / `IndexParams` / `IndexMath` / `IndexEligibility` | 6,110 / 3,638 / 2,512 / … | external `public` libraries, reached by `DELEGATECALL`, linked at deploy |

### 1.2 The byte-budget history that motivates this

`hardhat.config.ts` records the escalation honestly: the contract crossed EIP-170 at 26,252
bytes; `runs: 1` + `viaIR` bought it back to 21,379; five library extractions have since been
spent, and it is at 24,528 with **48 bytes of headroom**. The config's own note records that
one extraction attempt (`applyCapAndRedistribute`) made the contract *bigger*, because an
external-library call site costs ~100–150 bytes of stub plus ABI encoding.

This is a dead end and the admin is right to call it that. Library extraction trades size for
five extra `DELEGATECALL` targets, a link map every test must reproduce, and diminishing
returns that are now negative. **Facets are the correct answer**: each facet is a full 24,576-byte
budget of its own, the routing stub is paid once in the proxy fallback rather than per call
site, and there is no link map.

### 1.3 The property the current design buys with its non-upgradeability

`ScopedRoles.sol` states it in the file header, and this document must not paper over it:

> *"there is no upgradeability, no proxy, no delegatecall, and no admin-settable
> implementation pointer, because those are themselves the canonical path to 'the admin bricked
> or rugged the vault'. A redeploy is the upgrade mechanism, and a redeploy cannot touch the
> reserves of a contract already holding them."*

**A Diamond directly contradicts that paragraph.** Any design that adopts EIP-2535 owes an
answer, not a footnote. §6 is that answer, and it is the reason §6 is the longest section here.

---

## 2. Facet map

### 2.1 Design rules the map obeys

1. **The exit door gets its own facet, and that facet imports nothing it does not need.**
   `IndexCoreFacet` holds `redeemProRata`, `claimPending`, `claimPendingMany`. It has **no
   `import` of `ScopedRoles`, no role modifier on any function, and no read of any governance
   storage namespace.** A reviewer can read one small file and confirm the anchor rule.
2. **Views are where size pressure goes.** Views cost nothing at the margin and can be split
   arbitrarily. Any facet that is running out of room moves its views to `IndexLensFacet`.
3. **One namespace per *concern*, not per facet.** Facets that operate on the same data import
   the same storage library. This is the opposite of the naive "one namespace per facet" and it
   is safer: it means there is exactly one declaration site per struct.
4. **No facet declares a state variable in its own contract body.** Enforced by review *and* by
   an automated test (§7.4).

### 2.2 The facets

| # | Facet | Selectors (from today's ABI) | Storage namespaces read/written |
|---|---|---|---|
| 1 | **`DiamondCutFacet`** | `diamondCut`, `finalize(bytes32)` | `diamond` |
| 2 | **`DiamondLoupeFacet`** | `facets`, `facetFunctionSelectors`, `facetAddresses`, `facetAddress`, `supportsInterface`, `isFinalized` | `diamond` (read-only) |
| 3 | **`IndexShareFacet`** (ERC-20 + ERC-7575 share) | `name`, `symbol`, `decimals`, `totalSupply`, `balanceOf`, `transfer`, `approve`, `allowance`, `transferFrom`, `increase/decreaseAllowance`, `share()`, `vault(address)`, `SEED_LOCK`, `INDEX_VERSION` | `erc20` (w), `dividend` (w — the correction hook), `stream` (w — the per-token correction hooks) |
| 4 | **`IndexCoreFacet`** ← *the exit door* | `mintProRata`, `redeemProRata`, `claimPending`, `claimPendingMany`, `pendingClaim`, `reservedClaims` | `core` (w), `erc20` (w, via internal mint/burn), `dividend`+`stream` (w, via the correction hook only) |
| 5 | **`IndexTradeFacet`** | `mintSingleAsset`, `redeemSingleAsset` | `core` (w), `oracle` (r), `params` (r), `ecosystem` (w) |
| 6 | **`IndexOracleFacet`** | `checkpoint`, `checkpointAll`, `priceBand`, `persistenceHolds`, `persistenceHoldsFor`, `realizedVolBps`, `requiredCheckpoints`, `requiredCheckpointsFor` | `oracle` (w), `core` (r), `params` (r) |
| 7 | **`IndexGovernanceFacet`** | `queueParam`, `executeParam`, `queueMetric`, `executeMetric`, `queueListing`, `executeListing`, `queuePlatformTreasury`, `executePlatformTreasury`, `roleForParamKey`, `queueRole`, `executeRole`, `cancelRole`, `roleHolder`, `queuedRoles`, `hasRole` | `params` (w), `governance` (w), `roles` (w), `core` (w — listing only) |
| 8 | **`IndexDividendFacet`** | `receiveDividendsWrapped`, `reinvestAsset`, `claimDividend`, `accumulativeDividendOf`, `withdrawableDividendOf`, `withdrawnDividends`, `harvestEcosystemFees`, `totalDividends*`, `undistributedDividends`, `magnifiedDividendPerShare` | `dividend` (w), `ecosystem` (w), `erc20` (r) |
| 9 | **`IndexStreamFacet`** | `depositStream`, `queueStream`, `executeStream`, `cancelStream`, `delistStream`, `pruneStream`, `streams`, `streamCount`, `streamHeld`, `unvestedOf`, `streamVestEndsAt`, `carryUnlockBlock` — **no claim function of its own; stream payouts settle through `IndexCoreFacet.claimPending*` (§5.5)** | `stream` (w), `erc20` (r), `roles` (r — `ROLE_STREAM_LISTER` only) |
| 10 | **`IndexEligibilityFacet`** | `checkEligibility`, `refreshEligibleCount`, `eligibleConstituentCount`, `capBpsFor`, `effectiveConcentrationCapBps` | `core` (r/w — count only), `params` (r) |
| 11 | **`IndexBootstrapFacet`** | `seedConstituent`, `seedDeposit`, `openIndex`, `syncConstituentBalance`, `delistEmpty` | `core` (w), `erc20` (w) |
| 12 | **`IndexLensFacet`** | `nav`, `weightBps`, `targetWeightsBps`, `previewMintProRata`, `previewRedeemProRata`, `previewRedeemSingleAsset`, `previewMintFeeBps`, `imbalanceFeeBps`, `constituentCount`, `constituentAt`, `listConstituents`, `reserveOf`, `constituentInfo`, `isExiting`, `capabilities`, `params` | everything, **read-only** |
| 13 | **`HookRegistryFacet`** | `registerHook`, `hooksFor`, `hookPermissions` | `hooks` (w) |

**Deliberately NOT facets, and staying as separate deployed contracts:**

- **`PlankGauge`.** Guarantee 5 of the vault header — *"PLANK's concentration can never reach
  basket admin"* — is enforced by the gauge having no reach into the vault. Making it a facet
  would give it `DELEGATECALL` into the vault's own storage. That is a categorical no.
- **`TBAValueSweeper`.** It exists precisely because it holds no vault authority. It attaches
  through the hook registry (§8) and through the already-proven push-then-`syncConstituentBalance`
  path. Making it a facet would give it write access to `core` storage.
- **`BackstopSizingCalculator`.** Stateless and pure; its own suite proves it has no storage,
  no payable path, and no custody. Leave it alone.

### 2.3 What happens to `WrappedIndexShare.sol`

Under ERC-7575 the wrapper's *token* disappears (§4) and its logic splits three ways:

| `WrappedIndexShare` concern | Destination |
|---|---|
| stream whitelisting (`queue/execute/cancel/delistStream`) | `IndexStreamFacet` + `roles` namespace (`ROLE_STREAM_LISTER` joins the vault's role set) |
| stream funding (`depositStream`, measured-delta credit) | `IndexStreamFacet` |
| stream payout (`_payout`, `pendingClaim`, `claimPending*`) | **merged with the vault's identical deferral ledger** — the vault's `_payOrDefer` is already a verbatim port of `_payout`; after the merge there is *one* implementation, in `IndexCoreFacet` |
| zero-denominator `carry` | `IndexStreamFacet`, unchanged arithmetic |
| the round-9f re-vest (`_revestOnMint`, `_addVest`, `unvestedOf`, `M = 25`, `STREAM_VEST_BLOCKS`) | **`IndexStreamFacet`, ported verbatim** — fires on `mintProRata`/`mintSingleAsset` instead of `deposit`. See §5.4 for why the "better" alternative was rejected. |
| `_netOf`'s three-term subtraction (`reserved + carry + unvestedOf`) | `IndexStreamFacet`, unchanged — this one expression *is* the anti-extraction invariant |
| `harvest()` (pull vault dividends into the wrapper) | **deleted**. With one token there is nothing to pull *from*; `harvestEcosystemFees` already credits the accumulator directly. This is the only cross-contract mutable call in the whole system, and it disappears. |
| the exchange-rate model (`exchangeRate`, `previewWithdraw`, `quoteDividendAssetIn`, wrapper virtual offsets) | **deleted as a surface, preserved as a mechanism.** The *backing-pool* model survives — stream legs are still priced pro-rata against net backing at burn time (§5.5). What goes away is the second token, and therefore the price between two tokens. |

### 2.4 Libraries under the new structure

**Convert all five external `public` libraries back to `internal`.** The byte budget was the
only reason they were external. Going internal:

- removes five `DELEGATECALL` targets from the runtime graph (a strict security win under a
  design that is already adding one intentional delegatecall);
- removes the link map from `indexVaultFactory()`, simplifying every test fixture;
- inlines, which the `viaIR` optimiser handles well.

`IndexValuation` currently takes `storage` pointers to the caller's `constituentList` and
`constituents` map. Internal-linkage makes that trivially correct instead of "correct because
the library declares no storage of its own".

---

## 3. Storage namespace design

This is the safety-critical part. Get it wrong and facets silently corrupt each other.

### 3.1 The slot derivation

```solidity
library CoreStorage {
    // keccak256("marketplank.index.storage.core.v1") - 1, masked to a 32-byte-aligned
    // pointer that is provably not the preimage of any keccak used elsewhere.
    bytes32 internal constant SLOT =
        keccak256(abi.encode(uint256(keccak256("marketplank.index.storage.core.v1")) - 1))
            & ~bytes32(uint256(0xff));

    struct Layout { /* ... */ }

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly { l.slot := s }
    }
}
```

The `-1` and the `& ~0xff` mask are the ERC-7201 derivation. `-1` breaks the "someone can find
a preimage" objection; the mask aligns the root to a 256-slot boundary so that appending a
member to the struct can never walk into a *different* namespace's root even in a pathological
layout. Both are cheap and both are standard; use both.

### 3.2 The namespaces

| Namespace id | Contents (mapped from today's `GlobalIndexVault` storage) |
|---|---|
| `…storage.diamond.v1` | *(the EIP-2535 canonical `diamond.standard.diamond.storage` slot, kept at its standard value so third-party loupe tooling works)* `selectorToFacetAndPosition`, `facetAddresses`, `supportedInterfaces`, **`finalized`** |
| `…storage.erc20.v1` | `_balances`, `_allowances`, `_totalSupply`, `_name`, `_symbol` |
| `…storage.core.v1` | `indexOpen`, `constituentList`, `constituents`, `pendingClaim`, `reservedClaims`, `eligibleConstituentCount`, `seeder`, `timelockDelay`, `dividendAsset` |
| `…storage.params.v1` | the whole `IndexParamSet`, `minEligibilityFeesWei`, `minEligibilityBlocks`, `targetHhiBps` |
| `…storage.oracle.v1` | *(none of its own — observations live inside `Constituent`, which lives in `core`. The facet is separate; the storage is not.)* |
| `…storage.governance.v1` | `queuedParams`, `queuedListings`, `queuedPlatformTreasury` |
| `…storage.roles.v1` | `roleHolder`, `queuedRoles` |
| `…storage.allocation.v1` | `platformTreasury`, `platformAllocationBps` |
| `…storage.ecosystem.v1` | `ecosystemFeesWei`, `ecosystemSink`, `ecosystemAsset`, `ecosystemFeeSplitBps` |
| `…storage.dividend.v1` | `magnifiedDividendPerShare`, `magnifiedDividendCorrections`, `withdrawnDividends`, `totalDividendsReceived`, `totalDividendsWithdrawn`, `undistributedDividends` |
| `…storage.stream.v1` | `streamList`, `tracked`, `isStream`, `queuedStreams`, `carry`, `carryUnlockBlock`, `vest[token]` (the round-9f `StreamVest` schedule). **No per-holder state — see §5.4.** |
| `…storage.hooks.v1` | `hooks[point]`, `hookPermissions` |
| `…storage.reentrancy.v1` | the single `_status` word backing `nonReentrant` |

### 3.3 The rules that make collision impossible, not merely unlikely

1. **No facet declares a state variable, ever.** A facet's contract body contains only
   `constant`/`immutable`, functions, events, and errors. Any `contract` inheriting `ERC20`,
   `ReentrancyGuard`, or `ScopedRoles` in its OZ form is disallowed — those declare storage at
   slot 0 and are exactly how a facet lands on top of the diamond's own slot 0. Vendored,
   namespace-backed equivalents replace all three. (§7.4 automates the check.)
2. **`immutable`s are per-facet, not shared.** An `immutable` lives in the facet's *own*
   bytecode; under `DELEGATECALL` it resolves to the value baked into whichever facet is
   executing. Today's `timelockDelay`, `seeder`, and `dividendAsset` are `immutable`. Under a
   diamond they **must move to `core` storage**, written once during the deployment
   transaction, or two facets will disagree about them. This is a real bug class and it is not
   theoretical — it is the #1 mechanical error in diamond conversions. Written down here so the
   implementation cannot miss it.
3. **Structs stored in dynamic arrays may not be extended.** Appending a member to a struct used
   as a *mapping value* is safe (each key hashes to its own region). Appending to a struct used
   as a *dynamic array element* changes the element stride and shifts every element. `Constituent`
   is a mapping value → safe to extend. Every namespaced `Layout` struct carries a trailing
   `uint256[16] __gap` regardless, so the rule never has to be reasoned about at the site.
4. **Reentrancy is one global word, in its own namespace.** OZ's `ReentrancyGuard` at slot 0 of
   each facet would give every facet its own independent guard — meaning `nonReentrant` on
   facet A would not exclude a reentrant call into facet B. This is a *silent* loss of a
   currently-proven property (`"a reentrant token cannot double-credit"`,
   `"a reentrant claimer…"`). One shared namespaced word restores cross-facet exclusion, which
   is *stronger* than today's per-contract guard.
5. **Selector collision is checked at cut time.** `diamondCut` reverts if a selector is already
   owned by a different facet. Additionally, §7.4's test asserts the union of all facet ABIs has
   no duplicate 4-byte selector, catching the case where two *distinct* function signatures hash
   to the same selector — the classic `collate_propagate_storage()` / `burn(uint256)` class.

### 3.4 The `Constituent` struct and `OBS_SLOTS`

`Constituent` embeds `Observation obs[OBS_SLOTS]` — a fixed array inside a struct inside a
mapping. That is layout-stable and needs no change. `OBS_SLOTS` stays in `lib/IndexTypes.sol`
as the single declaration site, exactly as today, since it fixes the storage shape and must
never be defined twice.

---

## 4. ERC-7575 share/vault split

### 4.1 What the spec actually requires

- Vaults implement ERC-4626 **excluding** the ERC-20 methods and events.
- `function share() external view returns (address)` — MUST return an ERC-20 representing the
  vault's shares. **May be the vault itself.**
- Where `share() != address(this)`, entry functions increase the receiver's balance on the
  *share* contract and exit functions decrease the owner's.
- Multi-Asset Vaults: several vault contracts, different `asset()`, **one** share token. Entry
  points SHOULD NOT themselves be ERC-20.
- Share token SHOULD implement `vault(address asset) returns (address)`.
- ERC-165: vaults return true for `0x2f0a18c5`; share tokens for `0xf815c03d`.
- `event VaultUpdate(address indexed asset, address vault)`.

### 4.2 The design

**The Diamond is the canonical share.** `IndexShareFacet` is the ERC-20 and returns
`0xf815c03d` from `supportsInterface`. This eliminates `wIDX` and with it the entire
wrap/unwrap step, the two-asset distinction, and the `RedTeam.WrapStreamDilution` attack
surface that only existed because there were two tokens with a price between them.

**The entry points are per-constituent Pipes.** Today `mintSingleAsset(token, …)` and
`redeemSingleAsset(shares, token, …)` are *already* per-asset entry points with a shared share
class — they are an ERC-7575 Multi-Asset Vault written before the standard existed. Making that
explicit:

```
IndexAssetPipe (one tiny non-ERC-20 contract per constituent, ~1.5KB)
  asset()                       -> the constituent ERC-20
  share()                       -> the Diamond
  deposit(assets, receiver)     -> Diamond.mintSingleAssetFor(asset, assets, receiver, minOut)
  mint(shares, receiver)        -> ditto, share-denominated
  withdraw / redeem             -> Diamond.redeemSingleAssetFor(...)
  maxDeposit / maxRedeem / previewX  -> forwarded to IndexLensFacet
  supportsInterface(0x2f0a18c5) -> true
```

and on the share side, `IndexShareFacet.vault(asset)` returns the registered pipe, with
`VaultUpdate` emitted at registration (timelocked, `ROLE_CONSTITUENT_ADMISSION`, and registered
as part of the same `executeListing` that admits the constituent).

**Why the pipes and not just `share() == address(this)`:** a diamond that returns itself from
`share()` is conformant but degenerate — it advertises a standard while gaining nothing from it.
The value is that a pipe is (a) an *address* a 4626-aware integrator can point at, one per asset,
(b) the natural attachment point for the TBA sweeper and future stream types (§8), and (c)
**not privileged** — a pipe holds nothing and its only power is to call two functions the
Diamond already exposes permissionlessly.

### 4.3 The one thing the pipes must not do

A pipe must never be able to initiate `redeemProRata` on someone's behalf, and no pipe may be
consulted *during* `redeemProRata`. `redeemProRata` remains a direct, unmediated call on the
Diamond taking `msg.sender` and nothing else. The BasketDAO 2021 incident (cited in the vault's
own header) was an infinite-approval bug in exactly such a periphery wrapper. Pipes get
`transferFrom` allowances from users for *entry* only; the exit door needs no approval at all
because it burns `msg.sender`'s own shares.

### 4.4 Honest caveat

ERC-7575 gains us a *vocabulary* and an integration surface. It does not make anything safer by
itself, and the pipes are ~13 new deployed contracts for a 32-constituent basket (though only
for constituents anyone wants a 4626 surface on — registration is optional per asset). Build the
core first (§9 Stage 5) and treat pipes as a genuinely separable stage that can be dropped
without touching anything proven.

---

## 5. Stream vesting: ERC-7540, and why I recommend against it

### 5.1 What the current mechanism actually is

Round 9f's defense is **not** a per-user lock. `_revestOnMint` runs *after* a mint and displaces
a fraction of each stream's *net backing* out of the redeemable pool:

```
revest_t = min( net_t , net_t * minted * M / (supplyBefore + minted + VIRTUAL_SHARES) )
M = DILUTION_REVEST_MULTIPLE = 25
```

`_addVest` then commits the release-so-far and re-arms a linear window of
`STREAM_VEST_BLOCKS = 300`. `unvestedOf(t)` is a **pure function of storage and `block.number`**
— nothing can extend it, no role can read/write/reach it (proven:
*"no role can read, write, extend or reach the vest — there is no setter at all"*), and every
backing read subtracts it (`_netOf`).

Structurally this is **Yearn V2's `lockedProfit` / `lockedProfitDegradation`**: a global,
supply-side, linearly-degrading holdback on the profit pool. It is a *named, widely-forked,
externally-documented* pattern already. It never delays any individual user's withdrawal; it
only makes the pot temporarily smaller for everyone.

### 5.2 What ERC-7540 actually is

Per the spec: `requestRedeem(shares, controller, owner)` moves shares into a **Pending** state;
the vault later makes them **Claimable**; the user then pulls via `redeem`/`withdraw`. The spec
is explicit that *"users MUST pull the tokens via the Claim function"*, and that async-redemption
vaults **MUST make `previewRedeem`/`previewWithdraw` revert for all callers and inputs**.

### 5.3 Why that is the wrong shape here — four concrete reasons

1. **It is an asset lock, and the standing rule forbids asset locks.** Between Pending and
   Claimable the user's shares are escrowed and their assets are unwithdrawable. ERC-7540 exists
   to serve RWA and off-chain-settled funds *that genuinely need that*. This vault's entire
   thesis is the opposite: `IndexVaultIntentSurface` proves *"nobody — not an attacker, not any
   role — can stall a redemption into a later block"*, and `IndexExitWindowRace` is at pains to
   prove even the one existing surcharge *"is a DELAY, never a lock"* on the *convenience* path
   only. Introducing a Pending state is introducing exactly the hostage mechanism `ScopedRoles`'
   header refuses.
2. **Someone has to advance Pending → Claimable.** In every real 7540 deployment that transition
   is driven by a privileged fulfiller or an off-chain agent. Making it permissionless-and-
   time-based just re-implements the current vesting with extra steps and per-user state; making
   it privileged hands a role the ability to withhold a claim, which is categorically forbidden.
   There is no third option.
3. **`previewRedeem` MUST revert.** That would break `previewWithdraw`, `exchangeRate`,
   `quoteDividendAssetIn`, and the "the quote a caller is shown is the quote the same transaction
   fills at" property, along with the tests that pin them. Conforming to the standard here means
   *deleting* proven properties.
4. **The property proven is not the property the standard names.** Round 9f proves *"backing that
   predates you is not yours"*. ERC-7540 names *"settlement is not atomic"*. Wrapping the former
   in the latter's vocabulary would make an auditor look for a settlement risk that does not
   exist and miss the dilution property that does. That is worse auditability, not better —
   which is the opposite of the stated goal.

**Recommendation: do not adopt ERC-7540 anywhere on the mint/redeem/stream paths.**

### 5.4 The tempting alternative — a per-token EIP-2222 accumulator — and why I reject it

**This subsection is a reversal.** The obvious "elegant" move is to generalise the vault's own
magnified-dividend accumulator from one asset to `mapping(address => uint256)` over the stream
set. Round 9f's re-vest exists *only because* `wIDX` prices a fresh mint against the whole
existing backing pot; the accumulator's correction term makes a new holder's claim on prior
distributions **exactly zero**, not "bounded at 1%". `IndexDividendAccrual` already proves it for
the dividend leg (*"a MINT after the push earns nothing from it"*). On the flash-extraction axis
alone it is strictly better than 9f:

| | round-9f re-vest | per-token accumulator |
|---|---|---|
| flash-extraction bound | ≤ `Vst/(4M)` = 1% instantaneous, 4% salami-sliced | **0**, exactly, at every size |
| honest exit inside 300 blocks | forfeits the re-vesting slice | keeps every wei accrued while held |

**I still recommend against it, because `WrappedIndexShare.sol` already argues the case and the
argument holds.** Its architectural rule is stated as an absolute:

> *"There is no per-holder reward state anywhere in this contract, and there must never be. …
> Adding a per-holder correction-term accumulator would reintroduce the exact stranding bug one
> level up (the LP pool becomes the accruer of record for the bribe)."*

That is correct and it is load-bearing. Under a **backing-pool / exchange-rate** model, value
that arrives accrues to *the token*, so an LP pool holding the token gets richer and its LPs
capture that through the pool's price — with zero action by anyone. Under an **accumulator**
model, value accrues to *addresses*, so the LP pool address becomes the entitled party and the
real holders behind it cannot reach it without the pool implementing a claim forwarder that
does not exist. This is not hypothetical; it is proven in the suite twice, and both proofs would
die:

- `WrappedIndexShare.audit`: *"a passive third-party custodian (an LP pool) gains with zero
  action of its own"*
- `WrappedIndexShareStreams.audit`: *"a bribed-in stream reaches a passive third-party custodian
  (an LP pool) with zero action of its own"*

Trading a 1%-bounded, self-healing, value-preserving griefing surface for a **permanent value-
stranding surface on every DEX-held share** is a bad trade. The accumulator is the right
mechanism for the *dividend* leg — where the vault has already accepted that tradeoff
deliberately, in writing — and the wrong mechanism for streams.

**Verdict: port round 9f verbatim into `IndexStreamFacet`.** `M = 25`,
`STREAM_VEST_BLOCKS = 300`, `_revestOnMint`, `_addVest`, `unvestedOf`, `_netOf`'s three-term
subtraction, and the `carry` state machine all move unchanged. The proven math is preserved
exactly, which is what the mandate asked for. `_revestOnMint` now fires on `mintProRata` and
`mintSingleAsset` instead of on `deposit`.

### 5.5 What actually changes, and it is a genuine improvement: streams become deferred-credit legs

Unifying onto one token (§4) means `redeemProRata` must pay stream legs too — the wrapper's
`withdraw` and the vault's `redeemProRata` become one function. Done naively that is
32 constituents + 32 streams = **64 bounded-gas external calls in one transaction**, which
threatens `IDX-08`'s worst-case gas measurement outright.

**The resolution: stream legs are credited directly to `pendingClaim`, with no external call at
all.**

```
redeemProRata(sharesIn, minAmountsOut):
    burn
    for each constituent k:   size from pre-burn reserve, debit, then _payOrDefer   (external call)
    for each stream t:        size from pre-burn net backing, then credit
                              pendingClaim[msg.sender][t] += amt;
                              reserved[t] += amt                                    (NO external call)
```

This is strictly better than either the current two-contract shape or the naive merge:

- **The exit door's external-call count is unchanged** — still exactly `n_constituents`. The
  gas added by streams is SSTOREs, not calls, and it is O(1) per stream with no failure mode.
- **It cannot block, delay, or gate anything.** `claimPending` / `claimPendingMany` are already
  proven *"reachable by nobody but the credited holder, and by no role"*, not gated on
  `whenOpen`, on listing, or on any flag. A credit is a debt the contract already owes.
- **It is not a lock.** The user can pull immediately, in the same block, in the same
  transaction via a multicall if they want. Nothing is time-gated; there is no Pending state
  and nothing to fulfil.
- **It reuses a mechanism that is already proven**, rather than adding one. The vault's
  `_payOrDefer` and the wrapper's `_payout` are already line-for-line identical; after the merge
  there is one implementation and one `pendingClaim` ledger.
- **The KYC-restricted-RWA property gets stronger**, not weaker: a restricted stream now never
  even attempts a transfer during redemption, so it cannot consume gas or emit a failure.

Cost, stated honestly: a redeemer must make a second transaction to receive stream tokens. That
is a UX cost, not a safety cost, and it is the same shape as today's deferred-leg retry which
the suite already treats as acceptable. If the measurement shows 64 in-line calls fit
comfortably, paying streams in-line is a valid alternative — but the deferred-credit form should
be the default because it makes the exit door's gas *independent of the stream count*, which is
a property worth having on its own.

### 5.6 Where ERC-7540's *vocabulary* does fit honestly

The vault already has a genuine Pending → Claimable → Claimed ledger that nobody designed as
one: `pendingClaim[holder][token]` / `claimPending` / `claimPendingMany`. It is pull-based, it
is created without a user request, it is reachable by nobody but the credited holder, and it is
gated on no role and no flag.

Expose a **documented partial conformance** over it —
`pendingRedeemRequest(0, controller)` reading as 0 and `claimableRedeemRequest(0, controller)`
reading the deferred credit — so 7540-aware tooling can see deferred legs.

**Do not** advertise `0x620ee8e4` via ERC-165. We do not implement `requestRedeem` and never
will. Claiming the interface id for a half-implementation is precisely the kind of standards
theatre that makes an auditor trust the wrong thing.

---

## 6. `diamondCut` and its renouncement — the answer to §1.3

### 6.1 The problem, stated at full strength

Today: *"ANCHOR RULE: no privileged function can reach reserves already pooled"* is proven by
enumerating the ABI and calling every privileged function from every role. That proof technique
is **sound for a fixed-code contract and worthless for a live diamond**, because the ABI is not
the code — `diamondCut` can install a facet with `function drain() { token.transfer(msg.sender, …) }`
and the enumeration test passes right up until it does.

So: for as long as `diamondCut` is callable, `ROLE_ADMIN` (or whichever role gates the cut) **is**
a withdrawal path over pooled reserves. A 48-hour timelock bounds *when*, and §1.3's whole point
is that a timelock never bounds *what*.

### 6.2 The design: the diamond is never live in a cuttable state

**Tier A — the recommended and only mainnet-eligible form.**

A single `IndexDeployer` contract whose constructor, in **one transaction**:

1. deploys the Diamond with `DiamondCutFacet` as its only facet and *itself* as the sole cutter;
2. cuts in all remaining facets from pre-deployed addresses passed in as calldata;
3. writes the former `immutable`s (`timelockDelay`, `seeder`, `dividendAsset`) and the initial
   `IndexParamSet` into `core`/`params` storage, and seeds the roles;
4. calls `finalize(bytes32 expectedFacetSetHash)`;
5. self-checks the loupe and reverts the whole transaction if anything disagrees.

`finalize` does three things and is the last cut that ever happens:

```
finalize(bytes32 expectedFacetSetHash):
    require(!ds.finalized)
    require(keccak256(canonical encoding of (facetAddress, selectors[]) sorted)) == expectedFacetSetHash
    require(coreStorage().indexOpen == false)          // no user funds present yet
    require(no selector maps to address(0) that the manifest claims)
    ds.finalized = true
    remove EVERY selector owned by DiamondCutFacet — including finalize itself
    emit Finalized(expectedFacetSetHash, block.number)
```

**Two independent locks, both of which must fail for a cut to occur:**

- there is **no selector** routing to `diamondCut` (the fallback reverts `FunctionNotFound`);
- even if one were somehow reachable, `ds.finalized` makes it revert.

The `expectedFacetSetHash` is committed in the deployment calldata and re-derived on-chain from
the loupe's actual state, so the deployer cannot install a facet the manifest does not name and
the manifest is published with the source.

**Why this is strictly better than "deploy cuttable, renounce later":**
a later renouncement means there was a window — measured in blocks, but a window — during which
the anchor rule was false, and in which the deployer key was equivalent to full custody. If the
index is seeded during that window, the window has real assets in it. Making the cut capability
expire *inside the transaction that created the contract* means no external party ever observes,
and no attacker can ever race, a cuttable diamond. **The `finalize` precondition
`indexOpen == false` is belt-and-braces on top of that**: even a botched deployer cannot leave
a cuttable diamond holding public deposits.

**Tier B — rehearsal only, and it must be impossible to confuse with Tier A.**
For local iteration a `DevIndexDeployer` may leave the cut facet installed. It must (a) live
under `contracts/test/`, (b) write a permanent `ds.devMode = true` flag, and (c) have
`IndexCoreFacet` — no, better: have `DiamondLoupeFacet.capabilities()` report `devMode`, and
have the audit suite assert `devMode == false` on every fixture that claims to prove a
production property. Tier B never touches `deploy/`.

### 6.3 "What if a facet is buggy and needs replacing before renouncement?"

**There is no before.** Under Tier A the only state in which a bug can be found is the state in
which the diamond is already frozen, and the answer is exactly the answer `ScopedRoles`' header
already gives today: **redeploy**. A redeploy cannot touch the reserves of a contract already
holding them. Users migrate by exercising `redeemProRata` — which is unblockable, needs no
price, and works with every role key hostile — and depositing into the new diamond.

This is not a regression from today; it is *identical* to today. The Diamond buys bytecode
headroom and buys nothing else, and that is the correct trade. Any design in which the Diamond
also buys upgradeability is a design that has traded away §1.3, and I do not recommend it at any
price.

### 6.4 `delegatecall` risk closure

| Risk | Closure |
|---|---|
| A facet contains `SELFDESTRUCT`, destroying the diamond's code | Two closures. (a) Compile target is `paris`, but do not rely on that — §7.4 scans **every facet's deployed bytecode for opcode `0xff`** and fails the build. (b) `SELFDESTRUCT` under `DELEGATECALL` destroys *the caller*, i.e. the Diamond. This is the single highest-severity mechanical risk and it gets an explicit, automated, always-on test. |
| A facet contains its own `DELEGATECALL`, letting a caller pivot | §7.4 scans for opcode `0xf4` in facet bytecode and fails on any occurrence. **This is why §2.4 converts the five external libraries to `internal`** — external `public` libraries are reached by `DELEGATECALL` and would trip this scan legitimately, so the scan and the library conversion are one decision, not two. |
| A facet writes a storage slot it does not own | Namespaced-only storage (§3.3 rule 1), plus §7.4's assertion that no facet declares a state variable, plus a per-facet documented namespace list reviewed against its imports. |
| A facet's `initialize` is callable post-cut and overwrites owner/params | No facet has an `initialize`. All initialisation happens in the deployer's transaction, writing storage directly, and `finalize` removes the only path that could ever run an init delegatecall. There is no `_init` selector in the final facet set — asserted. |
| Function-selector clash between two facets | `diamondCut` rejects re-registration; §7.4 asserts the union of all facet ABIs is selector-unique. |
| `receive` / payable reaching the diamond | The Diamond has **no `receive()` and no payable fallback**, preserving *"the vault cannot hold ETH at all"* — which is currently asserted twice, in `GlobalIndexVault.audit` and again in `IndexDividendAccrual`. Asserted against the diamond's fallback, not against any facet. |

### 6.5 The categorical question: can anything gate, block, or delay `redeemProRata`?

Enumerated exhaustively, because this is the one that must be answered "no" without hedging:

| Candidate path | Status |
|---|---|
| A role modifier on the function | `IndexCoreFacet` does not import the roles namespace. Asserted by the storage-namespace test *and* by the existing collusion test re-pointed at the diamond. |
| A pause / freeze flag | None exists in any namespace. `ds.finalized` is checked only inside `diamondCut`, never on any user path — asserted by a source-level grep test *and* by exercising a redemption post-finalize. |
| A hook consulted during redemption | **`HookRegistryFacet` defines no hook point on `redeemProRata`, `claimPending`, or `claimPendingMany`.** This is a design constant, not a configuration (§8). |
| `diamondCut` removing the `redeemProRata` selector | Impossible post-finalize: no cut selector exists. Pre-finalize there is no live diamond. |
| A facet upgrade that adds a guard | Same. |
| The dividend transfer hook reverting | The hook makes no external call and has no parameter that can fail it. §5.4 rejects the per-token generalisation precisely so this stays a **one-asset, O(1)** hook — the proof (*"the hook cannot brick a transfer"*) carries over unmodified. |
| A hostile constituent's `transfer` | Already closed by `_payOrDefer`; unchanged. |
| A hostile *stream* token during redemption | Cannot participate: §5.5 credits stream legs to `pendingClaim` with **no external call at all** on the exit path. Sizing goes through the existing bounded-gas `_probeBalance`, whose failure already reads as zero. |
| Gas: 32 constituent legs + N stream legs + the diamond fallback dispatch | `IDX-08` must be re-measured. §5.5's deferred-credit design makes the exit door's external-call count **independent of the stream count**, which is what keeps this bounded — but the fallback's ~2.6k selector lookup applies to every call and must be recorded. |

---

## 7. The existing-properties checklist

Every item below is a property proven at `ca2c1cc` and must have a named home and a passing
test under the new architecture. **519 total.** Grouped by destination facet.

### 7.1 `IndexCoreFacet` — the exit door (highest priority; nothing here may weaken)

From `GlobalIndexVault.audit.test.ts`:
- [ ] pro-rata redemption never pays more than a strict slice of the real reserve
- [ ] every remaining holder's per-share backing is non-decreasing in every asset
- [ ] the redeemer's ownership fraction is identical across every constituent
- [ ] a mint → redeem round trip never returns more than was put in
- [ ] dust never accumulates to whoever redeems last
- [ ] redemption needs no price at all — it works with every constituent stale
- [ ] a raw donation to the vault is inert — reserves are explicit, never `balanceOf`
- [ ] the first public depositor cannot be inflation-attacked (virtual offset + locked seed)
- [ ] refuses to mint against a short delivery from a fee-on-transfer constituent
- [ ] a deactivated constituent's reserves stay redeemable and cannot be stranded
- [ ] ANCHOR RULE: no privileged function can reach reserves already pooled — **must be
      re-expressed for the diamond (§6.1): ABI enumeration is no longer sufficient on its own
      and must be paired with the finalize assertion**
- [ ] the vault cannot hold ETH at all — no `receive`, no payable path — **re-asserted against
      the diamond fallback**

From `IndexExitDoorFaultTolerance.test.ts` (all 9):
- [ ] a blacklisted holder still redeems EVERY other leg, in full, in one call
- [ ] the deferred leg is retryable in full the moment the restriction lifts
- [ ] `claimPendingMany` is tolerant: a still-blocked leg re-credits exactly, others pay
- [ ] a deferred slice leaves `reserve` immediately and cannot be redeemed twice
- [ ] a globally-broken constituent blocks nobody, and the delist deadlock is open
- [ ] a leg that merely LIES on transfer defers rather than silently vanishing
- [ ] a gas-burning leg cannot starve the legs that come after it
- [ ] the healthy path is bit-for-bit unchanged: slippage guard, floors, dust
- [ ] `claimPending` is reachable by nobody but the credited holder, and by no role

From `RedTeam.ExitDoorBrick.poc.test.ts`:
- [ ] PoC-C (CLOSED): a blacklisted holder now redeems every OTHER leg, keeps a credit for the blocked one
- [ ] PoC-D (CLOSED): a vault-level freeze no longer closes the exit door for anyone

From `IndexInvariantHardening.test.ts`:
- [ ] EXIT DOOR (maximal): full 32-leg basket + ceiling fees + hostile role slate + in-flight ramp-out → exact pro rata
- [ ] EXIT DOOR (maximal): `redeemProRata` is permissionless — a fresh receive-only address can exit a full basket

From `AuditPoC.certik.test.ts`:
- [ ] IDX-02 (CLOSED): a reverting constituent defers its own leg and blocks nobody
- [ ] IDX-08: worst-case gas at `MAX_CONSTITUENTS = 32` — **re-measure with the diamond
      fallback dispatch AND the §5.5 stream legs; this is the one number the refactor can realistically
      regress**

### 7.2 `IndexTradeFacet` / `IndexOracleFacet` / `IndexEligibilityFacet`

Single-asset paths, fee symmetry, sandwich unprofitability (`GlobalIndexVault.audit`,
`GlobalIndexVault.timing`, `SelfDealAndDirectionSymmetry` §direction-symmetry,
`IndexVaultIntentSurface`, `IndexExitWindowRace`):
- [ ] the single-asset exit is strictly worse than the pro-rata exit
- [ ] the single-asset exit fee scales with how imbalanced the ask is
- [ ] the imbalance fee is retained in reserves for the holders who stayed
- [ ] a single-asset exit can never empty the leg it targets
- [ ] a single-asset mint → single-asset redeem round trip is unprofitable
- [ ] no operation may push a constituent further over the concentration cap
- [ ] the sqrt weight curve dampens outsized constituents and the cap redistributes
- [ ] a newly added constituent ramps in over a real window, never in one block
- [ ] a stale constituent's ramp-in freezes (§2.9 silent-constituent breaker)
- [ ] ISOLATION: a large constituent's flow never debits a small one's reserve
- [ ] ISOLATION: the imbalance fee is charged against the acting leg's own depth
- [ ] RAMP-OUT: decays, never cliffs; freezes NEW deposits immediately; every exit stays open at every stage; `mintProRata` stays open
- [ ] FEE SYMMETRY: underweight discounted, overweight surcharged; the discount decays to nothing at target
- [ ] no function in the ABI takes a direction/side/buy-sell flag
- [ ] the ONE fee formula is a function of `(amount, against)` only
- [ ] the mint side's extra term vanishes identically at target weight
- [ ] a ROUND TRIP is strictly loss-making, equally in either order
- [ ] exposes no rebalance/swap/solver/intent entrypoint at all
- [ ] no entrypoint forwards arbitrary calldata or names an external venue — **re-verify against
      the diamond: the fallback IS a calldata forwarder, so this test must be rewritten to assert
      the fallback routes only to the finalized facet set and to no settable address**
- [ ] `targetWeightsBps` is a pure view
- [ ] the only two token-out paths are share-burning redemptions to `msg.sender` — **plus, if
      §4.2 pipes are built, `…For(receiver)` variants; this test must be updated deliberately,
      not incidentally**
- [ ] a victim's quote does not move when an attacker trades first
- [ ] the quote shown is the quote the same transaction fills at
- [ ] sandwiching a MINT / a REDEEM is strictly loss-making; the sandwich accrues to stayers; repeating compounds the loss
- [ ] pro-rata redemption stays open after an adversarial sandwich sequence
- [ ] pro-rata redemption works with the oracle FULLY STALE
- [ ] nobody can stall a redemption into a later block
- [ ] all 10 `IndexExitWindowRace` properties, including *"it is a DELAY, never a lock"*, *"the requirement is CLAMPED at ring-buffer depth"*, *"`redeemProRata` is completely untouched"*, *"no role can extend, aim, or make permanent the window"*

Oracle (`GlobalIndexVault.audit`, `IndexVaultPersistenceCalibration` all 17):
- [ ] NAV is a band, always strictly wider than a point
- [ ] a single-block spike enters as at most one capped step; spike-and-revert inside a window is ignored
- [ ] the persistence check rejects a band that has not held
- [ ] small operations stay instant — the gate is size-keyed
- [ ] a checkpoint cannot be spammed inside the minimum interval
- [ ] PLANK gets exactly one price path; NAV is ETH-denominated end to end
- [ ] `realizedVolBps`: zero when unmoved; exact RMS of settled moves; measures the CAPPED move; unsigned; survives the 90-day window roll
- [ ] `requiredCheckpointsFor`: reduces to size-only at zero vol; matches the closed form; monotone in vol; ceiling holds; floor holds
- [ ] the calibration cannot be gamed by a burst (up-only, cannot be pushed down, asymmetry is structural)
- [ ] the priced paths gate on the CALIBRATED requirement; small ops never gated; the fixed-N view and the calibrated form can disagree
- [ ] prices a real V3 v-token straight off the V3 vault's own reserves

Eligibility + HHI (`IndexVaultEligibility` all 23):
- [ ] no privileged path sets an eligibility flag; no role can make an ineligible constituent eligible
- [ ] reads the constituent's own numbers back verbatim; both bars inclusive; future `firstActivityBlock` refused
- [ ] FAILS CLOSED, never reverts (EOA / plain ERC-20 / reverting source / gas bomb)
- [ ] a hostile constituent cannot brick a whole-basket recount
- [ ] `refreshEligibleCount` is PERMISSIONLESS and emits count + cap
- [ ] recomputed automatically on constituent-set change; only ACTIVE counted
- [ ] both bars TIMELOCKED and risk-role-only; absurd bar degrades to the flat cap
- [ ] `capBpsFor`: NatSpec examples; `n<=1` → 100%; infeasible `T<1/n` → equal-weight; rises with n; achieved HHI ≤ target; matches reference for n∈[0,96]
- [ ] `targetHhiBps` ceilinged at EXECUTION; effective cap is the MIN of dynamic and flat
- [ ] `targetWeightsBps` matches reference clamp-and-redistribute; no leg above cap after redistribution; the TRADE-TIME guard uses the dynamic cap

### 7.3 `IndexGovernanceFacet` / `roles` namespace

`ScopedRoles.isolation` (9 vault + 5 gauge), `GlobalIndexVault.audit`, `IndexInvariantHardening`:
- [ ] ISOLATION: each admin-gated function accepts its own role and rejects every other
- [ ] ISOLATION: every risk key routes to the risk role and nothing else
- [ ] ISOLATION: the shared queue mapping is not a back door between roles — **now also across facets**
- [ ] ESCALATION: `ROLE_ADMIN` cannot grant itself another role in one transaction
- [ ] ESCALATION: refuses unknown roles and the zero address
- [ ] ESCALATION: there is no second write path to `roleHolder` anywhere in the ABI — **must
      become "anywhere in the union of the finalized facet set", which is a strictly larger
      surface to check; §7.4 automates it**
- [ ] BLAST RADIUS: a compromised key of each role touches nothing outside its scope
- [ ] BLAST RADIUS: even ALL roles colluding cannot move a reserve or mint themselves shares —
      **the load-bearing test for §6; must be run with `finalized == true`**
- [ ] THE EXIT DOOR: no role, no pause, no queued change, no collusion can block a redemption
- [ ] a parameter change is QUEUED, never applied instantly
- [ ] hard parameter ceilings hold even after the timelock elapses
- [ ] the timelock delay itself is immutable — **note §3.3 rule 2: `timelockDelay` moves from
      `immutable` to storage. The property must be re-proven as "written once at deploy and
      reachable by no function", which is a *different* proof and needs a new assertion that no
      facet in the final set writes that slot**
- [ ] a role handover is itself timelocked; a below-floor delay cannot be deployed at all
- [ ] NO RENOUNCE PATH EXISTS: role handover is queue/execute/cancel only; a role can never be vacated
- [ ] RE-QUEUE IS REPLACE, NOT APPEND, on a fresh full delay, still cancellable
- [ ] A SUCCESSOR ADMIN INHERITS CANCELLING AUTHORITY over pending proposals
- [ ] the seeder has zero privilege the instant the index opens
- [ ] SEEDING: the first constituent cannot be seeded into a manipulable share price; the seeder cannot add once open
- [ ] CLAIMED-VS-NOT: admission reads no ownership; a claimed owner gets no path in
- [ ] MID-FLIGHT: add while another is mid-removal; removing a majority-NAV leg moves no value
- [ ] the seed shares are locked at a dead address forever, so supply is never zero

### 7.4 New tests this architecture *requires* (not adaptations — genuinely new)

- [ ] **`Diamond.storage.test.ts`** — every namespace slot is distinct; slots are ≥256 apart;
      no two `Layout` structs overlap; a write through facet A is read identically through facet B
- [ ] **`Diamond.bytecode.test.ts`** — for every facet artifact: no `0xff` (SELFDESTRUCT), no
      `0xf4` (DELEGATECALL); no facet's `storageLayout` declares a non-constant variable
- [ ] **`Diamond.selectors.test.ts`** — the union of all facet ABIs is 4-byte-unique; every
      selector in the manifest resolves through the loupe to the manifest's facet; no selector
      resolves to `address(0)`; the manifest hash matches `Finalized`'s argument
- [ ] **`Diamond.finalize.test.ts`** — after the deployment fixture: `isFinalized() == true`;
      `facetAddress(diamondCut.selector) == address(0)`; a raw call to the `diamondCut` selector
      reverts `FunctionNotFound`; `devMode == false`; a `redeemProRata` still succeeds after
      finalize with every role key hostile
- [ ] **`Diamond.noWriteToImmutables.test.ts`** — no function in the finalized set writes the
      `timelockDelay` / `seeder` / `dividendAsset` slots (replaces the `immutable` guarantee)
- [ ] **`Diamond.fallback.test.ts`** — the diamond has no `receive`, is not payable on any
      selector, and the fallback reverts (does not silently succeed) on an unknown selector
- [ ] **`Hooks.exitDoorFree.test.ts`** — no hook point exists on `redeemProRata` /
      `claimPending*`; a maximally hostile registered hook cannot affect a redemption's gas,
      outcome, or success

### 7.5 Dividends, ecosystem fees, streams, carry

`IndexDividendAccrual` (21), `IndexDividendAccumulatorPoisoning` (8), `IndexEcosystemFees` (21),
`IndexZeroDenominatorCarry` (12), `IndexConstituentSync` (6), `AuditPoC` IDX-01/01b — **every
one carries over unchanged in claim and very nearly unchanged in code**, because §5.4 rejects the
per-token generalisation and leaves the dividend accumulator a one-asset, O(1) mechanism. In
particular these need no re-derivation, only re-pointing at the diamond:

- [ ] a MINT after the push earns nothing; a BURN does not destroy accrued; transfer moves future not past
- [ ] SELL ACROSS A PUSH; PARTIAL sale; claiming twice pays once
- [ ] the locked seed accrues NOTHING
- [ ] a push with no eligible holder is PARKED, never lost, never reverted
- [ ] CEILING: total withdrawable ≤ total received over a long randomised sequence
- [ ] SOLVENCY: the vault holds ≥ reserve + undrawn dividends of the dividend asset
- [ ] the hook cannot brick a transfer; GAS: the hook's overhead measured and disclosed
- [ ] all 8 accumulator-poisoning properties (`MAX_PUSH_HEADROOM_DIVISOR`, never-revert, self-healing carry)
- [ ] all 21 ecosystem-fee properties, including *"EXIT DOOR: a pro-rata redeemer is paid BIT-FOR-BIT the same with the ledger full or empty"* and *"a harvest cannot be made to fire mid-redemption"*
- [ ] all 12 zero-denominator-carry properties, across all three denominators — **note the wrapper's two denominators (streams, wrapper-harvest) now live in `IndexStreamFacet`; the wrapper-harvest one collapses into the vault's own, so `DENOM 2` is retired and its claim is subsumed by `DENOM 1`**
- [ ] all 6 `IndexConstituentSync` properties, including *"never swallows a DEFERRED redemption credit"* — **now materially more load-bearing, since §5.5 puts stream legs into that same deferred ledger; `syncConstituentBalance` must subtract `reservedClaims` for stream tokens too**

Plus, from the wrapper's own suites, the properties that must survive the wrapper's dissolution
(`WrappedIndexShare.audit` 17, `WrappedIndexShareStreams.audit` 17, `WrapStreamRevest.audit` 10,
`RedTeam.StreamSlotGrief` 2, `RedTeam.WrapStreamDilution` 2):

- [ ] the atomic deposit→withdraw round trip captures ≈0 of the stream backing (**PoC-A**)
- [ ] capture does not scale with attacker size, at every size (**PoC-B**)
- [ ] salami-slicing many small deposits does not escape the bound
- [ ] an honest holder who holds across the window earns the stream in FULL
- [ ] release is strictly monotone in block height and reaches exactly zero on schedule
- [ ] **a passive third-party custodian (an LP pool) gains with zero action of its own** — the
      property §5.4 exists to protect; must be re-proven on the unified token
- [ ] **a bribed-in stream reaches a passive third-party custodian with zero action of its own**
- [ ] shares still transfer freely and the recipient's exit is gated by nothing
- [ ] no role can read, write, extend or reach the vesting/accumulator state
- [ ] `pruneStream` refuses to orphan a live balance
- [ ] a hostile stream cannot brick `deposit`/`mintProRata` through the stream path
- [ ] solvency invariant: total claims never exceed real backing across mixed ops
- [ ] exactly one stream capability role, reaching no value path
- [ ] only the listing role whitelists, and only after the full timelock
- [ ] an un-whitelisted token can never be pushed; cannot be listed twice or as a core leg
- [ ] pro-rata payout across every stream in native units
- [ ] `depositStream` credits the MEASURED delta on a fee-on-transfer stream
- [ ] a KYC-restricted RWA stream cannot trap raw shares or any other asset
- [ ] a reserved slice is not redeemable a second time
- [ ] a stream that LIES on transfer defers rather than vanishing
- [ ] delisting stops new pushes and NEVER claws back held backing
- [ ] `MAX_STREAMS` enforced with a clear revert; a prune frees a slot
- [ ] PoC-E / PoC-F: a drained delisted stream can be pruned; 32 slots cannot be permanently pinned
- [ ] stream discovery enumerates every stream and balance for a UI
- [ ] **Explicitly retired, with the reason recorded:** `exchangeRate`, `previewWithdraw`,
      `quoteDividendAssetIn`, `harvest()`, *"reads its dividend denomination from the vault's own
      getter"*, *"refuses to exist against a vault with dividends switched off"*, the wrapper's
      own first-depositor/donation tests, and *"Alice vs Bob: a post-harvest depositor does NOT
      capture yield that predates them"*. All of these exist **only because there were two
      tokens with a price between them**. Their claims are carried by the vault's own
      equivalents: the wrapper's inflation-attack tests by *"the first public depositor cannot be
      inflation-attacked"*, the Alice-vs-Bob test by *"a MINT after the push earns nothing from
      it"*. **This is the only place the refactor deliberately drops tests, and each one needs a
      line in the PR naming the surviving test that carries its claim.**

### 7.6 Out of scope, unchanged, must still be green

`PlankGauge.audit` (35), `PlankGaugeSybilCost.audit` (12), `SelfDealAndDirectionSymmetry`
§PlankGauge (11), `TBAValueSweeper.audit` (43), `BackstopSizingCalculator` (28),
`GameTheory.MechanismDesign.poc` (7), `VaultBootstrapLock` (8), `MarketplankVault*`, `Seaport*`,
`Drand*`, `BLS*`. These touch no vault storage. The two that need a re-point:
`TBAValueSweeper.audit`'s *"NO-TRAP: redeemProRata is unreachable from this contract"* and
`IndexConstituentSync`'s six sync tests, both of which name the vault address.

---

## 8. The extension model (Uniswap-v4-inspired, de-fanged)

v4 encodes hook permissions in the *address bits* of the hook contract, which requires CREATE2
salt mining and buys atomicity guarantees a singleton AMM needs. **We should not copy that.**
The bit-mining is a source of deployment complexity with no benefit here, and it makes the
permission set unreadable.

Instead: `HookRegistryFacet` with an explicit registration.

```
registerHook(bytes32 point, address hook, uint16 permissions)   // ROLE_RISK_PARAM, timelocked
```

Rules, all of them non-negotiable:

1. **`CALL`, never `DELEGATECALL`.** A hook runs in its own storage. It can never touch a
   namespace.
2. **Bounded gas** (`HOOK_GAS`, same reasoning as `PAYOUT_GAS` / `PROBE_GAS` — the 63/64 rule
   makes the bound real).
3. **Non-reverting.** A failing hook emits `HookFailed` and is ignored. A hook can never
   change control flow, only observe.
4. **Hook points are compile-time constants.** `registerHook` can only populate a `point` from
   a fixed enumerated set. Governance chooses *who*, never *where*.
5. **The enumerated set contains no point on `redeemProRata`, `claimPending`, or
   `claimPendingMany`.** Asserted by §7.4's `Hooks.exitDoorFree.test.ts`.
6. **A hook is never on a value path.** Hooks receive values; they are never asked for one.
   Nothing a hook returns is used in arithmetic. (This is what makes rules 2–3 sufficient: an
   ignored hook and a successful hook produce identical accounting.)

Initial points: `AFTER_SYNC` (the natural attachment for `TBAValueSweeper` — it already pushes
then relies on `syncConstituentBalance`), `AFTER_LISTING`, `AFTER_CHECKPOINT`.

---

## 9. Staged implementation plan

Each stage must be independently verifiable, so that stage *k+1* never re-opens stage *k*.

**Stage 0 — scaffolding, no behaviour.** Diamond proxy, `DiamondCutFacet`, `DiamondLoupeFacet`,
`IndexDeployer`, the namespace libraries with *empty* `Layout` structs, and all of §7.4's new
tests. **Exit criterion:** the seven new diamond tests pass against an empty diamond; the 519
existing tests still pass against the untouched `GlobalIndexVault`. Nothing is deleted yet.

**Stage 1 — libraries `external` → `internal`.** Pure refactor of today's contract. **Exit
criterion:** all 519 still pass; `indexVaultFactory()` no longer builds a link map;
`GlobalIndexVault` bytecode grows past 24,576 and *that is expected and fine* because Stage 2
immediately moves it behind facets. (If it is preferred to keep the tree compiling at every
commit, do Stage 1 *after* Stage 2 — it is the only ordering choice in this plan that is free.)

**Stage 2 — the ERC-20 + core facets.** `IndexShareFacet` + `IndexCoreFacet` + `IndexBootstrapFacet`
+ `IndexLensFacet`, over the `erc20`/`core` namespaces. `indexVaultFactory()` switches to
deploying the diamond and returning a combined-ABI handle. **This is cheap: `IndexFixture.vault`
is typed `any`, so call sites do not change.** **Exit criterion:** §7.1's entire exit-door
checklist green, plus `IDX-08` gas re-measured and recorded.

**Stage 3 — oracle, trade, eligibility.** **Exit criterion:** §7.2 green.

**Stage 4 — governance, roles, allocation, ecosystem, dividends.** **Exit criterion:** §7.3 and
the dividend/ecosystem half of §7.5 green, with `finalized == true` in the fixture.

**Stage 5 — streams.** Build `IndexStreamFacet` by porting round-9f, `_netOf`, and the `carry`
state machine **verbatim** (§5.4), and wire stream legs into `redeemProRata` as deferred credits
(§5.5). **Gate:** PoC-A / PoC-B / salami-slice must still show capture ≈0; the two LP-custodian
composability tests must pass on the unified token; the 60-op and 70-op solvency fuzzes must
hold across every asset; `IDX-08` gas must be re-measured with 32 constituents **and** 32
streams. Delete `WrappedIndexShare.sol` only after this gate passes.

**Stage 6 — ERC-7575 pipes + `HookRegistryFacet`.** Fully optional and fully separable; if the
schedule or the complexity budget runs out, stop after Stage 5 and the system is complete and
coherent without it.

**Stage 7 — the finalize rehearsal.** Deploy through `IndexDeployer` in a Hardhat fixture,
assert the manifest hash, assert `isFinalized()`, then run the **entire** suite against the
frozen diamond. Nothing merges until the full suite is green *against a finalized diamond*, not
against a dev-mode one.

---

## 10. Honest accounting of the complexity cost

**What genuinely improves:**
- The byte budget stops being a design constraint. Five library extractions and a per-file
  compiler override exist purely to serve it, and all of that pressure goes away.
- One token instead of two. The wrap step, the exchange rate, the wrapper's own inflation-attack
  surface, and the `RedTeam.WrapStreamDilution` attack class exist *only* because there were two
  tokens with a price between them.
- Two identical `_payout` / `_payOrDefer` implementations become one, and two `pendingClaim`
  ledgers become one.
- Five `DELEGATECALL` library targets become zero (§2.4).
- **The only cross-contract mutable call in the entire system disappears.** `WrappedIndexShare`
  → `GlobalIndexVault.claimDividend()` is the single mutable coupling anywhere in this codebase
  (`PlankGauge` reads nothing; `TBAValueSweeper` reads one view). Unification removes it, and
  with it the `harvest()` ceremony and the zero-supply wrapper-harvest carry denominator.
- Four independent `ScopedRoles` registries become three, and the four hand-replicated
  `queueX`/`executeX`/`cancelX` timelock implementations become one shared internal — including
  `PlankGauge`'s three-way variant whose `roleForParamKey` whitelist exists *specifically* to
  stop key-space collision between its own queues.
- The `_pullCredited` / `_burnFor` / `depositStream` / `sweepTBAERC20` "measured balance delta"
  discipline, currently written out four times, becomes one reviewed internal.

**What genuinely gets worse:**
- **Reasoning cost.** Reading one 2,721-line file with everything in it is, for an auditor,
  easier than reading thirteen files plus a selector manifest plus a namespace table. The
  mitigation is that the *exit door* — the part that matters most — gets *easier* to audit,
  because `IndexCoreFacet` is small and imports nothing privileged. That is the right place to
  spend the win.
- **A new proof obligation.** "No role can reach reserves" changes from a property of the ABI to
  a property of *the ABI plus the finalization*. §6.2 makes it a strong property, but it is a
  *different* property and every reviewer must be walked through why.
- **A new failure mode with no analogue today:** a botched deployment transaction. Today a
  mis-deploy is a contract with wrong parameters. Under a diamond it could be a contract with a
  missing selector, frozen. The `IndexDeployer` self-check and the manifest hash exist to make
  that atomic-revert rather than a live, broken, unfixable contract — and Stage 7 rehearses it.
- **Gas.** Every call pays the fallback's selector lookup (~2.6k) and a `DELEGATECALL`. On the
  32-leg redemption this is noise; on a plain `transfer` it is not nothing. Must be measured and
  disclosed alongside the existing disclosed hook overhead.

**What I would drop if the budget were cut:** Stage 6 entirely (pipes and hooks). Stages 0–5
plus 7 are the coherent minimum, and they deliver the byte budget, the single token, and the
frozen diamond — which is the whole of the mandate's core.

---

## 11. Loose ends found while reading, worth deciding deliberately

Not blocking, but each is a small honest defect the refactor should resolve rather than
faithfully reproduce:

- `TBAValueSweeper.ExecuteFailed()` is **declared and never thrown** — `_execute` makes a
  high-level call and lets the callee's revert propagate. Either throw it or delete it.
- `PlankGauge.queueParam` does its role check **inline** (reading `roleHolder` and reverting
  `NotRoleHolder` by hand) rather than through `onlyRole`, because the role depends on the key.
  Correct, but it is the one place the modifier discipline is broken and it should be a named
  internal.
- `ScopedRoles.cancelRole` and `PlankGauge`'s cancels signal cancellation by **re-emitting the
  queue event with zeroes**, which is ambiguous to an indexer. A distinct `RoleCancelled` event
  costs nothing.
- `WrappedIndexShare` discloses that a **raw `transfer` of a stream token into the wrapper while
  supply is zero is invisible and not carried** — first-comer capture. Under unification the
  same hole exists against the diamond, and `syncConstituentBalance` is the natural place to
  close it for stream tokens as well as constituents. Decide explicitly.
- Four `ROLE_ADMIN` keys exist today (vault, gauge, wrapper, sweeper) with no shared holder by
  design. Unification removes one. **Do not take that as licence to merge the others** — the
  sweeper's header states the separation is deliberate.

---

## 12. The three things a reviewer should check first

1. **§3.3 rule 2** — `timelockDelay`, `seeder`, `dividendAsset` move from `immutable` to storage.
   Under `DELEGATECALL` an `immutable` resolves to the value in *whichever facet is executing*,
   so leaving them as `immutable` means two facets silently disagree. This is the
   highest-probability silent bug in the whole conversion, and it has no test today because it
   cannot happen today.
2. **§6.2** — is atomic deploy-and-finalize achievable in one transaction within the block gas
   limit for a 13-facet diamond? If not, the design degrades to a two-transaction deploy with a
   one-block window, and the `indexOpen == false` precondition on `finalize` becomes the *sole*
   guarantee that no user funds are exposed during it. Still acceptable, but a weaker statement
   that must be written down as such.
3. **§5.4's reversal** — I recommended the per-token accumulator, then withdrew it after finding
   `WrappedIndexShare.sol`'s own counter-argument and the two LP-custodian tests that prove it.
   A reviewer should independently check that reasoning, because if I am wrong there is a
   materially better mechanism available and this document is leaving it on the table.
