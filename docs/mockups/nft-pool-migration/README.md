# NFT pool migration (V1 → V2) — approved mockup & plan

**Status:** Owner-approved direction (2026-07-31). Waiting for go-ahead before
implementation. Nothing in this folder is live code.

**Branch:** `nft-pool-migration` (from `inmotion`). All implementation for this
feature lands here and merges to `inmotion` only after owner testing.

**Mockup:** `mockup.html` — open directly in a browser. Shows the site-wide
banner, the `/migrate` page mid-migration (plank 2 of 3), the four non-happy
states (disconnected, dust wallet, busy/stuck redeem slot, fully migrated),
and implementation notes mapping every control to existing code.

## Decisions locked with the owner

- **Force level: guided-hard.** V1 disappears from Instant Swap (switcher goes
  V2-only, SwapPanel loses the V1 retarget). A connected wallet holding V1
  value gets a persistent site-wide banner into `/migrate`. V1 contract calls
  remain possible only inside that page (redeem / settle / sell dust).
- **Route: `/migrate`** — top-level, deep-linkable, shared Nav + AppBackdrop +
  `data-market-shell`.
- **Dust wallets (< 1.01 shares):** first-class "Sell dust for ETH on V1 and
  be done" (recommended), with "top up to 1.01 and redeem a plank" as the
  alternative.
- Pending-redeem rescue and the multi-plank queue are included as required
  plumbing (single vault-wide redeem slot makes the flow break without them).
  Targeted redeem (+2.5%) is deferred from v1 of the page.

## Facts that shape the design (from code research)

- **No `migrate()` exists on-chain.** V1 is immutable; migration is
  client-orchestrated: redeem NFT out of V1 → deposit into V2. 2 signatures
  per plank happy-path, up to 6 worst-case.
- **Redeem economics:** deposit minted 0.99 shares, redeem burns 1.01 —
  single-deposit holders are always ~0.02 short (the dust top-up / dust exit).
  Round-trip friction ≈ 0.02 shares per plank. No migration tax; standard
  mint 1% / redeem 1% fees only.
- **One random-redeem slot per vault, vault-wide** (`RequestPending`).
  Today's `VaultMigrate.tsx` never checks it; the rescue UI
  (`PendingRedeemClaim` / `StuckRedeemRelay`) lives only in SwapPanel and must
  be lifted into shared components and rendered inline as the step body.
- **Sunset constraint:** never remove `NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESS`
  or the V1 allowlist entry until V1 reads empty — dropping it bricks every
  V1 call client-side ("Blocked unsafe vault target"). Hide UI, keep config.
- **Cannot migrate, ever (be honest in copy):** V1 pool ETH (non-withdrawable
  by design), shares raw-transferred into V1 (no `removeLiquidity` on V1),
  NFTs raw-transferred to the vault without `deposit()`.
- **Postmortem CAP mandates honored:** fee math visible before any CTA
  (CAP-P3), optional/analytics data never gates a step (§7.1.4), structured
  error codes (CAP-E8), migration UI behind its own feature flag independent
  of market enable (CAP-E7): `NEXT_PUBLIC_MIGRATION_MODE = off | soft |
  guided-hard`.

## Implementation phases (when unblocked)

1. **Page + detection.** `useV1Position(account)` hook — one shared 20 s poll:
   `getVaultOnChainSnapshot(legacy)`, `pendingRequester()/pendingRound()`,
   `getOwnedInventory`. `/migrate` route with the stepper, reusing existing
   `vault.ts` calls (`requestRandomRedeem` → sponsor `/api/market/vault/
   settle-random` → `finishRandomRedeem` fallback; `depositForShares`;
   `sellShares`; `buyShares`). Queue state in localStorage; chain balances
   stay the source of truth.
2. **Rescue extraction.** Move `PendingRedeemClaim` / `StuckRedeemRelay` out
   of SwapPanel into `components/market/redeem-rescue/`; render inline in the
   migrate step and keep SwapPanel behavior identical.
3. **Sunset flag + banner.** `NEXT_PUBLIC_MIGRATION_MODE`; root-layout banner
   (connected + V1 value detected only; "Later" dismisses per session);
   Instant Swap V2-only under guided-hard; MarketView's migrate `<details>`
   becomes a link card to `/migrate`; VaultTradeHistory keeps V1 history.
   Update DESIGN.md (Instant Swap contract currently mandates in-tab
   migration — reword to point at `/migrate`) and LearnGuide §17b.
4. **Fix-on-the-way:** 12-plank display cap, hard-coded 200 bps dust
   slippage, legacy-address fallback that throws on a standalone page,
   `refreshOwned` refiring on every progress tick.

## Open questions (non-blocking)

- Banner "Later": per-session or per-day?
- Dust sell: auto-selected or just recommended?
- Is there a public retirement date for V1, or "until empty"?
