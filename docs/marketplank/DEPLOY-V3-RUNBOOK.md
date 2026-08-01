# V3 deploy runbook (Premium Plank Liquidity)

Automated, gated deploy + seed of `MarketplankVaultV3` to Robinhood Chain, then the
app cutover. Everything below is executed by `.github/workflows/deploy-vault-v3.yml`
(dispatch-only) + `scripts/deploy-and-seed-v3.ts`. The contract is **immutable** and
`openPool()` is **one-way** — read this before dispatching mainnet.

## Fixed facts
- **Mainnet** chainId `4663`, RPC `vars.NEXT_PUBLIC_ROBINHOOD_RPC_URL` (`…mainnet.chain.robinhood.com`).
- **Testnet** chainId `46630`, RPC `vars.ROBINHOOD_TESTNET_RPC_URL` (`…testnet.chain.robinhood.com/rpc`), explorer `explorer.testnet.chain.robinhood.com`.
- **Beacon** (reused, no new deploy): `vars.DRAND_BEACON_ADDRESS` = `0x87d584df130FED0Fe540954eD48CE2691A18D619`.
- **Collection** (mainnet RobinWood NFT): `0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156`.
- **Legacies** (stay redeem-only): V1 `0xb2019Fd4cA24502e812C0C73b751Fa49979BF708` (Driftwood), V2 `0xc4B29D7a01603D2A5937b1FC86ea85E488d72e04` (WormWood).

## Secrets & variables
Already set: `vars.DRAND_BEACON_ADDRESS`, `vars.NEXT_PUBLIC_ROBINHOOD_RPC_URL`,
`vars.ROBINHOOD_TESTNET_RPC_URL`, `vars.ROBINHOOD_TESTNET_CHAIN_ID`,
`vars.V3_DEPLOY_ENABLED` (currently `false`).

To add by a human (the only key handling — Claude never touches key material):
- `secrets.DEPLOYER_PK_TESTNET` — throwaway testnet key, funded with testnet ETH (for the rehearsal).
- `secrets.DEPLOYER_PK` — the **mainnet treasury key** (add LAST, after testnet passes). This wallet IS the treasury (immutable fee recipient + sole seeder); fund it with real ETH. Prove control with one tx first.

## Required immutable inputs (typed at dispatch, echoed for review)
`treasury` (== the deploy key's address), `mint_fee_wei` (**>0**), `redeem_fee_wei`
(**>0**), `target_premium_wei`, `swap_fee_bps` (≤100), `seed_token_ids`,
`seed_eth_wei` (locked forever — keep small). Ceilings: mint/redeem ≤0.05 ETH,
premium ≤0.1 ETH. Non-zero mint/redeem is enforced by the workflow (audit Low-1).

## Step 1 — Testnet rehearsal
1. Add `secrets.DEPLOYER_PK_TESTNET` (funded testnet key).
2. `gh variable set V3_DEPLOY_ENABLED --body true`.
3. Dispatch **Deploy MarketplankVaultV3** with `network=robinhood-testnet`,
   `confirm_open=true`, real fee values, `seed_token_ids=1,2`, a small `seed_eth_wei`.
   (Leave `treasury`/`collection` blank — testnet self-provisions a mock ERC721 and
   defaults treasury to the signer.)
4. The run green-gates the tests, then deploys→seeds→checklist→opens on testnet.
   Confirm the job is green and `deploy-out/v3.json` shows `opened: true` + correct
   immutables. This proves the exact sequence, gas, and constructor args.

## Step 2 — Mainnet pre-deploy verification
- **Confirm the collection is a plain ERC-721** (audit item 2): `0x327c…b156` must have
  no transfer blocklist / ERC-721C hook / revert-capable `_beforeTokenTransfer`, or a
  pinned-undeliverable redeem could brick the slot. Verify on the mainnet explorer.
- Decide the immutable fee schedule (final, forever).
- Prove control of the treasury wallet (send one tx) and fund it (gas + seed + later depth).
- Optional hardening: if raising `ROUND_LEAD`, do it BEFORE deploy — it re-triggers the green gate + review.

## Step 3 — Mainnet deploy + seed
1. OrangeGooey adds `secrets.DEPLOYER_PK` (treasury key).
2. Ensure `V3_DEPLOY_ENABLED=true`.
3. Dispatch with `network=robinhood`, `confirmation=DEPLOY_V3_MAINNET`, the treasury
   address, final fees, real `seed_token_ids` (NFTs the treasury owns), a small
   `seed_eth_wei`, `confirm_open=true`.
   - The script asserts VAULT_VERSION==3, reads back every immutable == input, seeds,
     runs the **pre-open checklist** (held≥1, ethReserve>0==balance−fees, shareReserve>0,
     collection/treasury correct, poolOpen==false), then the one-way `openPool()`.
   - It does **not** add real liquidity (MEV) — do that separately via `addLiquidity`
     (private relay for large depth).
4. Grab the V3 address from the `deploy-out/v3.json` artifact.

## Step 4 — App cutover (deliberate, separate)
1. `gh variable set NEXT_PUBLIC_MARKET_VAULT_ADDRESS --body <V3>`
2. `gh variable set NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESSES --body 0xb2019Fd4cA24502e812C0C73b751Fa49979BF708,0xc4B29D7a01603D2A5937b1FC86ea85E488d72e04`
   (Keep BOTH legacies — dual-vault discipline; never drop one until it reads empty.)
3. Dispatch `inmotion.yml` (`operation=deploy`) → rebuild bakes the new address, ships,
   health-verifies, auto-rolls-back on failure.
4. `gh variable set RELAY_VAULT_ADDRESSES --body <V3>,0xc4B29D7a01603D2A5937b1FC86ea85E488d72e04,0xb2019Fd4cA24502e812C0C73b751Fa49979BF708`
   so the drand relayer services V3 (if the cPanel cron `relayer.env` is live, update its `VAULT_ADDRESSES` too).

## Step 5 — Go-live
`MARKET_ENABLED` is a runtime `/admin` flag (no rebuild) — flip it only on the explicit
go-live decision, weighing the internal audit (`AUDIT-2026-08-01-v3-internal.md`) against
the SPEC gate-3 external-audit requirement.

## Post-deploy verification
On-chain: `VAULT_VERSION()==3`; `collection()/treasury()/beacon()`+fees == input;
`poolOpen()==true`; `ethReserve>0`; `heldTokenCount≥1`. App: `/market?tab=swap` shows V3
primary; `/migrate` shows Driftwood/WormWood legacy; `/floorboards` shows Driftwood; a V3
random-redeem gets serviced by the relayer.
