# Lessons — stats, rarity, transactions

Append-only. Each lesson is a synergy: specialize first, then reuse.

## 2026-08-20

1. **OpenSea BNB list ≠ book.** Pancake Squad and OS `bsc` slugs often 404 `/stats`. CoinGecko `/nfts/list?asset_platform_id=binance-smart-chain` + exact `contract_address` is the liquid book (Mobox Avatar, XENFT, etc.).
2. **Do not increment monthly CG quota on list pages.** Jail key `coingecko-nft-monthly-v2`; details only. False 9000 jail killed BNB for a session.
3. **Unknown zeros.** Storing empty OS intervals as `0` paints a dead book. `sanitizeUnknownZeros` + COALESCE floors. Heal then re-vine.
4. **Identity filter hid real catalogs.** Chip counts must keep UniSat/ME/Helius/Ordiscan even with empty titles. Spam prune only when no floor/listed/vol/holders/supply.
5. **Alchemy adapter on CG upserts.** New BNB rows with `adapter: alchemy-nft` get skipped by `multichain-sync` when Alchemy is jailed. Use `coingecko-nft`.
6. **`--chains=` on stats.** Running all EVM then 429 burns ETH quota and skips OP. Isolated processes per vine.
7. **RobinWood local empty book.** Overlay `plank.love` canonical (0.019 Ξ / 105 listed) — do not invent.
8. **Hub GET is read-only.** Hydrate/stats/rarity writers are separate routes/scripts so `/market/multichain` cannot hang the table.
9. **Rarity Bitcoin is always partial.** UniSat activity log is not a full inscription walk. Partial rank > fake complete.
10. **Foreign fulfill allowlist.** Wallet `to` must match venue contracts. No custody, no Across/0x Instant Swap on foreign.
11. **Synergy:** same exact-match kernel for CG (contract or id), OS named slug, ME symbol→mint, UniSat collectionId. Fuzzy attach is worse than a dash.
12. **Optimization:** one paced CG worker beats ten concurrent pages. Site stays up if Next is detached (`START-MARKET.bat`).
13. **`--spoke=coingecko-avax` was a no-op** until `spoke-backfill.ts` grew a `want("coingecko-avax")` branch. Cron steps and spoke IDs must stay in lockstep or workers silently finish in 0.1s.
