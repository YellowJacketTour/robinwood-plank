# Bullish AXIOM-1 Runbook (template)

**Fill after testnet deploy. Empty addresses = not deployed yet.**

> **PR12 status (2026-08-09):** Real testnet deploy tooling
> (`scripts/deploy/axiom1-testnet.ts`) is built and dry-run-proven against
> local Hardhat (`AXIOM1_DRY_RUN=1`, mocks standing in for real venue
> addresses) — the exact same 12-step ceremony `scripts/deploy/axiom1-local.ts`
> already proved, now parameterized for a real network via env vars. **No
> real testnet or mainnet deployment has been executed.** Running it against
> a real `--network` requires explicit owner authorization, which has not
> been given as of this PR. Everything below the "Genesis params used" and
> "Operator commands" sections remains template/blank until that deploy
> happens for real.

## Network

| Field | Value |
|-------|-------|
| Chain | _TBD (e.g. Base Sepolia / Ethereum Sepolia)_ |
| Chain ID | |
| RPC | |
| Explorer | |
| Deploy commit / tag | |
| Date | |

## Genesis params used

See `SPEC-AXIOM-1-ENERGY-BUS-AND-ADAPTERS.md` §0 — confirmed identical to the
real on-chain constants (no drift found):

`3500/1500/1500/1000/1000/1500` bps, `K=50400`, `F_MIN=0.05e18`, `W_MAX=2500`, `VEST=300`, `MAX_IMPACT=300`.

| Constant | Template value | Contract | Real value |
|----------|-----------------|----------|------------|
| `INV_BPS`/`CLP_BPS`/`IDX_BURN_BPS`/`PLANK_BURN_BPS`/`PLANK_LP_BPS`/`DIV_BPS` | 3500/1500/1500/1000/1000/1500 | `EnergyBus.sol` constructor args (axiom1-local.ts / axiom1-testnet.ts) | same, sum 10000 |
| `K_BLOCKS` (maturity half-scale) | 50400 | `WeightModule.sol:40` | `50_400` |
| `F_MIN_WEI` (admit floor) | 0.05e18 | `WeightModule.sol:41` | `0.05 ether` |
| `W_MAX_BPS` (max weight/collection) | 2500 | `WeightModule.sol:42` | `2_500` |
| `DECAY_BLOCKS` (quiet-decay window, not in template) | — | `WeightModule.sol:43` | `100_800` |
| `VEST_BLOCKS` (reused from `STREAM_VEST_BLOCKS`) | 300 | `scripts/verify/axiom1-postdeploy.ts:52` | `300` |
| `MAX_IMPACT_BPS` | 300 | `EnergyBus.sol:38` | `300` |
| `MAX_ROUTE_WEI` (not in template) | — | `EnergyBus.sol:39` | `10 ether` |

## Addresses

| Contract | Address |
|----------|---------|
| WETH | |
| EnergyBus | |
| WeightModule | |
| InventoryBuyAdapter | |
| CollectionLpRenounceAdapter | |
| IdxBurnAdapter | |
| PlankBurnAdapter | |
| PlankLpRenounceAdapter | |
| DividendAdapter | |
| Index Diamond | |
| IndexEnergyFacet (via diamond) | |
| IndexCoinPool | |
| CollectionVaultFactory | |
| Sample CollectionVault | |
| Sample NFT | |
| PLANK token | |
| PLANK/WETH pool | |
| SEED_LOCK / dead | |
| ExternalSwapRouter | |

## Operator commands

```bash
# tests
npm run test:contracts

# deploy testnet — real network (requires explicit owner authorization; DO
# NOT run without it). Every env var below is required — see
# scripts/deploy/axiom1-testnet.ts's file header for the full list and what
# each one feeds (WETH/PLANK/NFT collection addresses, AXIOM1_BUS_DEPLOYER_PK
# for the predicted-Bus-address nonce trick, MARKET_INDEX_ROLE_* for the
# store-only diamond roles, AXIOM1_PRICE_SOURCE_*_ADDRESS for real oracles,
# AXIOM1_COLLECTION_*_TOKEN_IDS for the seeding deposits):
WETH_ADDRESS=0x.. PLANK_TOKEN_ADDRESS=0x.. PLANK_SWAP_ROUTER_ADDRESS=0x.. \
PLANK_LP_ROUTER_ADDRESS=0x.. NFT_COLLECTION_A_ADDRESS=0x.. \
NFT_COLLECTION_B_ADDRESS=0x.. AXIOM1_BUS_DEPLOYER_PK=0x.. \
MARKET_INDEX_ROLE_ADMIN=0x.. MARKET_INDEX_ROLE_ADMISSION=0x.. \
MARKET_INDEX_ROLE_ALLOCATION=0x.. AXIOM1_PRICE_SOURCE_A_ADDRESS=0x.. \
AXIOM1_PRICE_SOURCE_B_ADDRESS=0x.. \
AXIOM1_COLLECTION_A_TOKEN_IDS='[101,102,103]' \
AXIOM1_COLLECTION_B_TOKEN_IDS='[201,202,203]' \
DEPLOYER_PK=0x... ROBINHOOD_TESTNET_RPC_URL=... ROBINHOOD_TESTNET_CHAIN_ID=... \
npx hardhat run scripts/deploy/axiom1-testnet.ts --network robinhood-testnet

# local dry-run proof (what PR12 actually ran — no real network involved):
AXIOM1_DRY_RUN=1 npx hardhat run scripts/deploy/axiom1-testnet.ts --network hardhat

# smoke (scripts/verify/axiom1-postdeploy.ts already implements this exact
# sequence — deposit -> fee -> route -> warp vest -> redeemProRata — against
# axiom1-local.ts's local deploy; once a real address set exists from a real
# axiom1-testnet.ts run, point the same verify script at it instead of
# calling deployAxiom1Local() internally):
npx hardhat run scripts/verify/axiom1-postdeploy.ts --network hardhat
# 1. approve NFT + WETH fee
# 2. vault.deposit(tokenId)
# 3. energyBus.route()
# 4. warp VEST_BLOCKS
# 5. lens / redeemProRata check
```

## Soak checklist

- [ ] Random EOA can `route()`  
- [ ] `redeemProRata` while bus has pending WETH  
- [ ] New vault admit after fees  
- [ ] No admin can change bps post-finalize  

## Incidents

| Date | Issue | Resolution |
|------|-------|------------|
| | | |

## Mainnet

Blocked until external audit + this runbook completed for testnet.
