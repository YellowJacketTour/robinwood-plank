# Nap handoff — bullish0x + bots (2026-08-20)

Operator is offline. Keep **`dev` only**. **Never merge `dev` → `master`.** Prod is InMotion `plank.tanggang.life` on `master`. PRs: `base: dev`. Local site: `http://localhost:3800` via `START-MARKET.bat` (detached). Do not hang Next on agent commands.

## For bullish0x

Review: [compare master…dev](https://github.com/YellowJacketTour/robinwood-plank/compare/master...dev).

Non-negotiables:

- Fail closed. Never invent floors, names, images, ranks, volume, holders.
- Alchemy NFT API is jailed (monthly 429). Do not re-enable.
- Do not prune Avalanche hypersync shells like Solana zero-minted cleanup.
- Native `/market` is not restyled; no hover mega-menus; no foreign Instant Swap; Across/0x off.
- Hub GET is snapshot-read. Writers are spokes/cron/vines.
- `0` is counted empty book only. Unknown = dash. `sanitizeUnknownZeros`.

Home NFT `0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156`. Vault V3 `0xacE28f72Fc3e15eA1671e689806694A9b0cE047D`. Canonical RobinWood floor from native book + `plank.love` overlay when local `market_orders` empty.

## For bots / next agent

1. **Cron** `scripts/refresh-market-data.ts` now includes `coingecko-bnb-stats` and `coingecko-avax-stats` (exact contract). BNB liquid books are CoinGecko, not OpenSea list slugs (those 404 `/stats`).
2. CG new rows upsert with adapter **`coingecko-nft`**, not `alchemy-nft` (sync skips Alchemy when jailed).
3. Isolated workers: `scripts/spoke-backfill.ts --spoke=coingecko-bnb`, `scripts/run-chain-vines.ts`, `scripts/heal-zeros.ts`. Filter `--chains=` so one 429 does not reorder the world.
4. Hub identity vs catalog: keep UniSat/ME/Helius/Ordiscan rows; hide spam titles only when they have **no** market cells.
5. Monthly CG counter key `coingecko-nft-monthly-v2` — list pages must not increment; details only. Cap 9000.
6. Rarity: `lib/rarity-generic.ts` −log2; Bitcoin UniSat always partial; do not fabricate ranks.
7. Transactions: Seaport 1.6 native; foreign fulfill allowlisted `to`; no custody.

## Recursion loop (stats → rarity → tx)

Each pass: one spoke, fail closed, log a lesson in `LESSONS-STATS-RARITY-TX.md`, heal zeros, do not restart Next unless compile is broken.

| Layer | Specialize | Cover later |
|---|---|---|
| Stats | OS EVM named slugs; CG BNB/Avax/SOL/BTC; ME uniqueHolders; UniSat holders | ETH CG only if OS 404 **and** monthly budget remains |
| Rarity | Native RobinWood + generic −log2 on collection open | Resume first-pass 1k/2k/5k; Solana DAS grouping mint |
| Tx | Native Seaport + overlay; foreign OS/ME/UniSat buy_now | Bundles only with real venue APIs |

## Do not

- Merge to master.
- `--apply` Solana cleanup without review.
- Delete Avax hex rows.
- Invent Element BNB map.
- Commit `.env.local`.
