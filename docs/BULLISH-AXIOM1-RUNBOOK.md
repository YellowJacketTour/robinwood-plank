# Bullish AXIOM-1 Runbook (template)

**Fill after testnet deploy. Empty addresses = not deployed yet.**

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

See `SPEC-AXIOM-1-ENERGY-BUS-AND-ADAPTERS.md` §0 — confirm identical:

`3500/1500/1500/1000/1000/1500` bps, `K=50400`, `F_MIN=0.05e18`, `W_MAX=2500`, `VEST=300`, `MAX_IMPACT=300`.

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

# deploy testnet (implementer fills)
npx hardhat run scripts/deploy/axiom1-testnet.ts --network <name>

# smoke
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
