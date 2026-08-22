# Bullish review — Global Market on `dev`

**Do not merge to `master` / do not deploy plank.tanggang.life from this.**

PR: https://github.com/YellowJacketTour/robinwood-plank/pull/95  
Branch: `feat/market-spokes-visible-window` → base **`dev`**  
Local: http://localhost:3800 (`START-MARKET.bat` — own window, not Grok)

## Chain-by-chain cell sources (fail closed)

| Chain | Floor | 24h vol/sales | Change | Listed | Holders | Notes |
|-------|--------|----------------|--------|--------|---------|-------|
| robinhood native | Seaport book or public plank.love | fills / ledger | two floors | book + 1542 | owner-index unique wallets | @RobinWoodPlank; vault/sends in activity |
| robinhood others | OpenSea if slug | OS one_day / fills | only if ≠0 with volume | OS listed_count | OS num_owners | 0 listed of N is real |
| eth/base/arb/op/poly/bnb/avax | OpenSea stats floor + hydrate | OS intervals + CG NFT | never stored 0.0% without volume | OS + snapshot | OS/CG unique addresses | Hydrate **visible named rows**, skip junk titles |
| solana | Magic Eden stats | CG + ME vol | CG ≠0 | ME listedCount | ME uniqueHolders | Browse-only buy |
| bitcoin | UniSat floor | CG ordinals exact slug | — | UniSat | not sourced | always partial rarity |

Display: floor `0` / `$0.00` → dash. `0.0%` with no 24h tape → dash. Vol `0` → dash.

## How to audit in 15 minutes

1. `/market` — RobinWood floor ~0.019 Ξ / 105 listed (public plank.love book if local Postgres is empty). Activity includes **Vault / Send / Batch send**, not only sales.
2. `/market/multichain?chains=solana-mainnet` — quality bar (floor, vol, sales, listed). Holders from Magic Eden `uniqueHolders` after sync/hydrate.
3. `?chains=arb-mainnet` — floors real; **Vol 0 must not appear** (dash if no 24h). Cards show USD under gold native.
4. `?chains=bnb-mainnet` — junk titles (`_-l_`, hex, numeric ids) hidden. Visible rows hydrate OpenSea **floor + 24h + owners** (max 10).
5. `?chains=avax-mainnet` — names + holders when OS/CG has them; no 3477 fan-out.
6. Native hub row: **@RobinWoodPlank**, contract id, 1542 supply, unique wallets from owner index.

## Fail-closed (do not regress)

- No Alchemy NFT API  
- No fake 0 floors/volume  
- Hub GET is snapshot-read; writes via `hydrate-stats` (this file only) or `npm run market:spokes`  
- Exact contract/slug only  
- `START-MARKET.bat` for Next; `npx tsx --env-file=.env.local scripts/spoke-backfill.ts --spoke=evm-opensea-stats --chains=bnb-mainnet,avax-mainnet --minutes=8`

## Still empty by design

| Cell | Why dash |
|------|----------|
| BNB/Avax 24h on OS-unknown contracts | No slug / 429 jail |
| Solana holders until ME uniqueHolders written | Adapter + hydrate |
| RobinWood floor if both local book and plank.love fail | Honest empty |
| Grade on shells without listed/volume/native+vault | `hasGradeEvidence` |

## Secrets

Repo is **public**. Never commit `.env.local`. Never put API keys in `NEXT_PUBLIC_*`.
