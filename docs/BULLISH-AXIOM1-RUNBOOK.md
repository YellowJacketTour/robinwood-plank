# Bullish AXIOM-1 Runbook

**Master handoff document:** `docs/BULLISH-HANDOFF.md`. Read that first.

> # ⚠ NO DEPLOYMENT HAS OCCURRED
>
> **This system has never been deployed to any network — not mainnet, not
> any public testnet.** Every Network / Address / Incident field below is
> intentionally blank and must stay blank until a real deploy happens. Do
> not populate them speculatively.
>
> What *has* been proven:
> - `scripts/deploy/axiom1-local.ts` — the full 12-step ceremony, executed
>   end-to-end against local Hardhat.
> - `scripts/deploy/axiom1-testnet.ts` — the same ceremony parameterized for
>   a real network, compiled, type-checked, and **dry-run** against local
>   Hardhat with `AXIOM1_DRY_RUN=1` (mocks standing in for real venue
>   addresses). Its own file header states: *"THIS FILE HAS NEVER BEEN
>   EXECUTED AGAINST A REAL NETWORK."*
> - `scripts/verify/axiom1-postdeploy.ts` — deposit → fee → route → warp
>   vest → `redeemProRata`, against a local deploy.
>
> Running against a real `--network` requires explicit owner authorization,
> which has not been given. See `docs/BULLISH-HANDOFF.md` §8 for the mainnet
> gate.

**Verified at:** branch `feat/cvi-sota-axiom-1`, HEAD `bff8e5c`. Now also current on
`integrate/dev-hh3` (PR #62 into `dev`, mergeable, Hardhat 3): the Solidity contracts are
byte-identical across that entire migration (test/build toolchain only), so every constant and
line number below is unchanged and still accurate.
Every constant below was read out of the Solidity source at that commit.

---

## Network

*Blank by design — no deployment has occurred.*

| Field | Value |
|-------|-------|
| Chain | |
| Chain ID | |
| RPC | |
| Explorer | |
| Deploy commit / tag | |
| Date | |
| Deployer address | |

---

## Genesis params — verified against the Solidity constants

Read directly from source at `bff8e5c`. **This table supersedes the earlier
template's claim of "no drift found" — there is drift, listed in the second
table below.**

### Energy Bus split (constructor args, `scripts/deploy/axiom1-testnet.ts:103-108`)

| Pipe | Constant | Value | Sums to |
|------|----------|------:|---------|
| Inventory buy | `INV_BPS` | 3,500 | |
| Collection LP | `CLP_BPS` | 1,500 | |
| Index burn | `IDX_BURN_BPS` | 1,500 | |
| PLANK burn | `PLANK_BURN_BPS` | 1,000 | |
| PLANK LP | `PLANK_LP_BPS` | 1,000 | |
| Dividend | `DIV_BPS` | 1,500 | **10,000** |

Deploy reverts if these do not sum to 10,000 (`EnergyBus.sol`; test-matrix
INV-6). The split is frozen by `finalize()` and has no post-launch setter.

### `contracts/energy/EnergyBus.sol`

| Constant | Value | Line |
|---|---:|---|
| `BPS_DENOM` | 10,000 | 35 |
| `MAX_IMPACT_BPS` | 300 | 38 |
| `MAX_ROUTE_WEI` | 10 ether | 39 |
| `MIN_ROUTE_WEI` | 0.001 ether | 40 |
| `BLOCK_BUDGET_WEI` | `= MAX_ROUTE_WEI` (10 ether) | 90 |
| `TRUSTED_CAP_BPS` | 0 | 93 |

### `contracts/energy/WeightModule.sol`

| Constant | Value | Line |
|---|---:|---|
| `ALPHA_F_WAD` (fee signal) | 0.45e18 | 102 |
| `BETA_P_WAD` (pressure) | 0.25e18 | 103 |
| `GAMMA_D_WAD` (depth) | 0.15e18 | 104 |
| `DELTA_V_WAD` (volume) | 0.15e18 | 105 |
| `K_BLOCKS` (maturity half-scale) | 50,400 | 107 |
| `F_MIN_WEI` (admission floor) | 0.05 ether | 108 |
| `DECAY_BLOCKS` (quiet decay window) | 100,800 | 109 |
| `EWMA_ALPHA_WAD` | 0.2e18 | 113 |
| `DEPTH_BUCKETS` | 6 | 117 |
| `DEPTH_BUCKET_BLOCKS` | 1,200 | 121 |
| `EXIT_HAIRCUT_BPS` | 1,000 (10%) | 128 |
| `EXIT_PROBE_DIVISOR` | 9 | 132 |
| `ROBINWOOD_FLOOR_BPS` | 810 (8.1%) | 135 |

### Adapters

| Constant | Value | Where |
|---|---:|---|
| `QUOTE_TOLERANCE_BPS` | 50 | `InventoryBuyAdapter.sol:155`, `CollectionLpAdapter.sol:122` |
| `MAX_LEG_POOL_FRACTION_BPS` | 200 (2% of live pool reserve) | `InventoryBuyAdapter.sol:183`, `CollectionLpAdapter.sol:123` |
| `LEG_PAIR_SPLIT_BPS` | 5,000 | `CollectionLpAdapter.sol:133` |
| `SKIM_TO_BUS_BPS` | 2,000 | `CollectionLpAdapter.sol:190` |
| `LP_LOCK_ADDR` | `0x…dEaD` | `CollectionLpAdapter.sol:194`, `PlankLpRenounceAdapter.sol:116` |
| `BURN_ADDRESS` | `0x…dEaD` | `PlankBurnAdapter.sol:76` |

### Vesting, dwell, timelock

| Constant | Value | Where |
|---|---:|---|
| `STREAM_VEST_BLOCKS` | 300 | `IndexFacetBase.sol:250` |
| `WEIGHT_MATURITY_BLOCKS` | `= STREAM_VEST_BLOCKS` (300) | `IndexFacetBase.sol:275` |
| `WEIGHT_DORMANCY_BLOCKS` | `= STREAM_VEST_BLOCKS × 10` (3,000) | `IndexFacetBase.sol:276` |
| `DONATION_VEST_BLOCKS` | 300 | `CollectionVault.sol:308` |
| `LP_MIN_DWELL_BLOCKS` | 8 | `CollectionVault.sol:317` |
| `TIMELOCK_GRACE_PERIOD` | 14 days | `IndexFacetBase.sol:242` |
| `GRACE_PERIOD` | 14 days | `ScopedRoles.sol:98` |
| `ROUND_LEAD` (drand) | 100 | `MarketplankVaultV3.sol:260` |
| Timelock delay (deploy default) | 48 hours (`TIMELOCK = 48 * 3600`) | `test/contracts/helpers/index-vault.ts:19`, overridable via `MARKET_INDEX_TIMELOCK_DELAY` |
| Mint/redeem sink bps (deploy default) | 3,000 | `scripts/deploy/axiom1-testnet.ts:173`, overridable via `AXIOM1_MINT_REDEEM_SINK_BPS` |

### DRIFT FOUND — the previous template was wrong on two rows

| Template claimed | Reality at `bff8e5c` | Assessment |
|---|---|---|
| `W_MAX = 2500` is a live genesis param (`WeightModule.sol:42`) | **`W_MAX_BPS` no longer exists in the contracts.** It appears only in explanatory comments (`WeightModule.sol:76`: *"`W_MAX_BPS = 2500` is gone"*; `IWeightModule.sol:53`). It was replaced by the **exit-capacity cap** derived from `EXIT_HAIRCUT_BPS = 1,000` against windowed-minimum depth, plus `ROBINWOOD_FLOOR_BPS = 810`. | **Template stale. Do not configure `W_MAX`; there is nothing to configure.** |
| `MAX_IMPACT = 300` is the live slippage guard | The constant `MAX_IMPACT_BPS = 300` still exists on `EnergyBus.sol:38`, **but the guard it named was deleted, not repaired** (audit C-2). `InventoryBuyAdapter.sol:93` says so explicitly: *"THE MAX_IMPACT_BPS GUARD IS GONE. DELETED, NOT REPAIRED."* The live bounds are `MAX_LEG_POOL_FRACTION_BPS = 200` and `QUOTE_TOLERANCE_BPS = 50`. | **Template describes a dead guard.** Do not treat `MAX_IMPACT_BPS` as a live risk parameter. See `docs/BULLISH-HANDOFF.md` §5.7. |

Line-number drift (harmless, but the template's citations are stale): the
template cited `WeightModule.sol:40/41/42/43`; the real lines at `bff8e5c`
are `107/108/—/109`.

Constants absent from the old template entirely but material to a deployer:
`MIN_ROUTE_WEI`, `BLOCK_BUDGET_WEI`, `TRUSTED_CAP_BPS`, `EXIT_HAIRCUT_BPS`,
`ROBINWOOD_FLOOR_BPS`, `DEPTH_BUCKETS`, `DEPTH_BUCKET_BLOCKS`,
`MAX_LEG_POOL_FRACTION_BPS`, `QUOTE_TOLERANCE_BPS`, `DONATION_VEST_BLOCKS`,
`LP_MIN_DWELL_BLOCKS`. All are listed above.

---

## Addresses

*Blank by design — no deployment has occurred. Do not fill in speculatively.*

| Contract | Address |
|----------|---------|
| WETH | |
| EnergyBus | |
| WeightModule | |
| InventoryBuyAdapter | |
| CollectionLpAdapter | |
| IdxBurnAdapter | |
| PlankBurnAdapter | |
| PlankLpRenounceAdapter | |
| DividendAdapter | |
| Index Diamond | |
| IndexCoinPool | |
| CollectionVaultFactory | |
| Collection A vault | |
| Collection B vault | |
| NFT collection A | |
| NFT collection B | |
| PLANK token | |
| PLANK/WETH pool | |
| PLANK swap router | |
| PLANK LP router | |
| Price source A | |
| Price source B | |
| SEED_LOCK / dead | |

Known live legacy address, **not** part of this deployment:
`MarketplankVault V2 = 0xc4B29D7a01603D2A5937b1FC86ea85E488d72e04` —
deployed and drainable; owner disposition is accepted/won't-fix with a
frontend blocklist as the only mitigation. See `docs/BULLISH-HANDOFF.md`
§5.8.

---

## Operator commands

### Tests

```bash
npm run test:contracts
```

Never run bare `npx hardhat test` — the suite needs
`TS_NODE_PROJECT=tsconfig.hardhat.json`, which only the npm script sets.
Artifacts land in `.hardhat-artifacts/`, not `artifacts/`.

### Static analysis

```bash
python -m slither .
```

Use the module form. The console-script form (`slither .`) crashes on this
toolchain with `Fatal Python error: _PyEval_EvalFrameDefault: Executing a
cache`. See `docs/BULLISH-HANDOFF.md` §5.2 and
`docs/SLITHER-TRIAGE-2026-08-09.md`.

### Local dry-run of the real-network ceremony (safe; this is what was proven)

```bash
AXIOM1_DRY_RUN=1 npx hardhat run scripts/deploy/axiom1-testnet.ts --network hardhat
```

`AXIOM1_DRY_RUN=1` swaps in the same mocks `axiom1-local.ts` uses and mints
/ funds the deployer from them, so the wiring is exercised end to end with
no real network and no env addresses required.

### Real-network deploy — REQUIRES EXPLICIT OWNER AUTHORIZATION. NOT YET GIVEN.

Every variable below is **required** when not in dry-run; `reqAddr()` throws
on any that is missing (`scripts/deploy/axiom1-testnet.ts:112-116`). Names
verified against the script.

**Required addresses**

| Env var | Feeds |
|---|---|
| `WETH_ADDRESS` | the sole payment token, everywhere |
| `PLANK_TOKEN_ADDRESS` | PLANK burn + PLANK LP pipes |
| `PLANK_SWAP_ROUTER_ADDRESS` | `PlankBurnAdapter.router` |
| `PLANK_LP_ROUTER_ADDRESS` | `PlankLpRenounceAdapter.swapRouter` |
| `NFT_COLLECTION_A_ADDRESS` | seed vault A |
| `NFT_COLLECTION_B_ADDRESS` | seed vault B |
| `AXIOM1_PRICE_SOURCE_A_ADDRESS` | constituent A price source |
| `AXIOM1_PRICE_SOURCE_B_ADDRESS` | constituent B price source |
| `MARKET_INDEX_ROLE_ADMIN` | store-only diamond role |
| `MARKET_INDEX_ROLE_ADMISSION` | store-only diamond role |
| `MARKET_INDEX_ROLE_ALLOCATION` | store-only diamond role |

**Required keys and token ids**

| Env var | Purpose |
|---|---|
| `DEPLOYER_PK` | the single ceremony signer (plays treasury / risk / seeder / governance) |
| `AXIOM1_BUS_DEPLOYER_PK` | dedicated key for the predicted-Bus-address nonce trick: 6 adapter deploys + the Bus, 7 sequential txs from this key |
| `AXIOM1_COLLECTION_A_TOKEN_IDS` | JSON array, ≥3 token ids the deployer already owns on collection A |
| `AXIOM1_COLLECTION_B_TOKEN_IDS` | JSON array, ≥3 token ids the deployer already owns on collection B |

**Optional, with defaults**

| Env var | Default |
|---|---|
| `MARKET_INDEX_NAME` | `AXIOM-1 Index` |
| `MARKET_INDEX_SYMBOL` | `IDX` |
| `MARKET_INDEX_TIMELOCK_DELAY` | 172,800 s (48 h) |
| `AXIOM1_MINT_REDEEM_SINK_BPS` | 3,000 |
| `AXIOM1_DRY_RUN` | unset (`=1` selects the mock path) |

**Network vars** are consumed by `hardhat.config.ts`'s `robinhoodNetworks()`,
not by the script: `ROBINHOOD_TESTNET_RPC_URL`, `ROBINHOOD_TESTNET_CHAIN_ID`.

```bash
WETH_ADDRESS=0x.. PLANK_TOKEN_ADDRESS=0x.. PLANK_SWAP_ROUTER_ADDRESS=0x.. \
PLANK_LP_ROUTER_ADDRESS=0x.. NFT_COLLECTION_A_ADDRESS=0x.. \
NFT_COLLECTION_B_ADDRESS=0x.. AXIOM1_PRICE_SOURCE_A_ADDRESS=0x.. \
AXIOM1_PRICE_SOURCE_B_ADDRESS=0x.. MARKET_INDEX_ROLE_ADMIN=0x.. \
MARKET_INDEX_ROLE_ADMISSION=0x.. MARKET_INDEX_ROLE_ALLOCATION=0x.. \
AXIOM1_COLLECTION_A_TOKEN_IDS='[101,102,103]' \
AXIOM1_COLLECTION_B_TOKEN_IDS='[201,202,203]' \
AXIOM1_BUS_DEPLOYER_PK=0x.. DEPLOYER_PK=0x.. \
ROBINHOOD_TESTNET_RPC_URL=... ROBINHOOD_TESTNET_CHAIN_ID=... \
npx hardhat run scripts/deploy/axiom1-testnet.ts --network robinhood-testnet
```

**Preconditions the script cannot create for you on a real chain:** the
deploying key must already hold real WETH and must already own the listed
token ids on both collections. There is no `.mint()` on a real
token/collection.

### Post-deploy smoke

```bash
npx hardhat run scripts/verify/axiom1-postdeploy.ts --network hardhat
```

As written, this script calls `deployAxiom1Local()` internally and then
drives the smoke against that fresh local deploy. Sequence it proves:

1. **deposit** — a real NFT into an already-admitted vault, minting real `S`
2. **fee** — real Stream A/B activity landing real WETH at the finalized Bus
3. **route** — `EnergyBus.route()` called permissionlessly, *after*
   `finalize()`, proving finalize did not brick routing
4. **warp** — advance past `STREAM_VEST_BLOCKS` (300)
5. **redeemProRata** — a real index redeem, asserting it still works
   post-route and post-finalize **and** that it paid out more per share than
   before the route

It also re-confirms `EnergyBus.finalize()`'s actual behaviour rather than
assuming it.

**To point it at a real deployment** it must be modified to attach to a real
address set instead of calling `deployAxiom1Local()`. That modification has
not been made, because there is no address set. Note also that step 4 uses
Hardhat's time helpers; on a real network you wait for real blocks instead.

---

## Soak checklist

*To be executed against a real testnet deployment. None has occurred, so
none of these are checked.*

- [ ] A random EOA with no roles can call `route()` successfully
- [ ] `redeemProRata` succeeds while the Bus holds unrouted WETH
- [ ] `redeemProRata` succeeds mid-route and post-finalize
- [ ] A new vault is admitted after it accrues fees past `F_MIN_WEI` (0.05 ETH), matured over `K_BLOCKS`
- [ ] No admin can change any pipe's bps after `finalize()` — attempt and confirm revert
- [ ] No admin can change an adapter address after `finalize()` — attempt and confirm revert
- [ ] A pipe made to fail falls through to the dividend pipe without reverting `route()`
- [ ] Weights sum to exactly 10,000 bps with 1, 2, 3, and ≥4 admitted vaults (this was audit H-8)
- [ ] Windowed-minimum depth cannot be established by a single-block liquidity add (audit C-4/H-6)
- [ ] Per-block route budget (`BLOCK_BUDGET_WEI = 10 ether`) holds under looped `route()` in one block (audit H-5)
- [ ] Predicate vault rejects an out-of-set tokenId; open vault accepts any
- [ ] Locked protocol LP at `0x…dEaD` cannot be removed by anyone, deployer included
- [ ] PLANK never appears in a `redeemProRata` payout
- [ ] Gas for `route()` re-measured on the real chain and compared with `docs/GAS-SNAPSHOT-AXIOM-1.md`

---

## Incidents

*None. Nothing has been deployed.*

| Date | Issue | Resolution |
|------|-------|------------|
| | | |

---

## Mainnet

**Blocked.** Gated on the full checklist in `docs/BULLISH-HANDOFF.md` §8 —
of which the two non-negotiable items are an **independent external audit of
the post-remediation code** (8,631 lines added after the audited commit,
reviewed by nobody) and a **recorded owner decision on the NFTX-D2
architectural risk**. There is no upgrade path, so no item on that gate can
be deferred to a patch.
