# Vault deploy tool — RETIRED (2026-08-02)

**Do not use this tool for new deployments.** It builds and deploys
`contracts/MarketplankVault.sol` — the pre-Premium-Plank-Liquidity share-fee
design whose LP primitive has a proven, externally exploitable flaw (see
the privately-held V2 LP audit and the "Do not migrate users into
V2" rule in `AGENTS.md`). Its constructor shape
(`mintFeeBps`/`redeemFeeBps`/`targetPremiumBps`) also does not match
`MarketplankVaultV3.sol`'s (`mintFeeWei`/`redeemFeeWei`/`targetPremiumWei`/
`swapFeeBps`), so this tool cannot deploy the current vault generation even if
you retargeted the artifact copy step.

**What replaced it:** `.github/workflows/deploy-vault-v3.yml`, a
`workflow_dispatch` that already deployed RobinWood's own V3 vault to
mainnet. It CI-gates tests before deploying, holds the deploy key as a repo
secret (`DEPLOYER_PK`) instead of a browser wallet, and requires typing
`DEPLOY_V3_MAINNET` to touch real value. Full procedure:
`docs/marketplank/DEPLOY-V3-RUNBOOK.md`.

**Why not just update this tool to V3 instead:** the trust model this tool
offers — the treasury signs bytecode it can verify against source, on its own
machine, and no key ever touches a server — is real and was worth building.
But re-targeting it safely means matching V3's different constructor
(wei-denominated fees, a swap-fee-bps parameter, and the contract's own
fee-ceiling reverts), plus its beacon-reuse and seeding flow, in a hand-rolled
browser tool with no test harness — on a contract where a bad deploy costs
real, unrecoverable mainnet gas. That was judged more likely to introduce a
bug than to add safety over the already-proven, CI-tested workflow, so it was
retired rather than half-migrated. If the workflow's `DEPLOYER_PK`-in-secrets
trust model ever becomes the actual blocker (not a hypothetical one), rebuild
this tool from scratch against `MarketplankVaultV3.sol`'s real ABI rather than
patching the old form.

The code below is left as-is (not deleted) as a historical/reference
implementation of the wallet-connect + verify-on-chain flow. Do not run it
against real value.

---

## Before you touch this (historical — describes the retired V1/V2 flow)

1. Read `docs/marketplank/AUDIT-2026-07-27-fable.md`. No independent
   third-party audit has happened. That's your call to make, not this tool's.
2. The drand parameters are pre-filled with values fetched from two
   independent mirrors (api.drand.sh, api2.drand.sh — exact agreement) and
   proved end-to-end against a real published round
   (`test/contracts/fixtures/drand-round.json`, see AUDIT §5b). That's
   stronger than "looks well-formed," but it's still an AI's fetch —
   **re-check it against a mirror yourself** before trusting it with real
   value: `https://api.drand.sh/v2/beacons/evmnet/info`. Confirm the scheme
   is `bls-bn254-unchained-on-g1`, not a BLS12-381 quicknet scheme.
3. Confirm you hold the treasury key: send a trivial transaction from
   `0xcdb7ca36d35fa16d15fda859a46f1d72d979e9d8` before deploying (it currently
   shows nonce 0 / balance 0 on-chain — nobody has proven control of it).

## Run it

```
cd robinwood-plank
npx hardhat compile          # compiles contracts/ into .hardhat-artifacts/

cd scripts/deploy-tool
npm install                  # isolated from the main app's dependencies
npm run build                # bundles ethers + WalletConnect into wallet-bundle.js
                              # (esm.sh's CDN could not transpile WalletConnect's
                              #  dependency tree — confirmed, not assumed — hence
                              #  a local bundle instead of a CDN <script> import)
cp ../../.hardhat-artifacts/contracts/DrandBeacon.sol/DrandBeacon.json .
cp ../../.hardhat-artifacts/contracts/MarketplankVault.sol/MarketplankVault.json .
npx serve .
```

Re-run the `cp` step after any change to the contracts — nothing here checks
that the copied JSON matches the current `contracts/` source, so a stale copy
would silently deploy old bytecode.

Open the printed `http://localhost:...` URL. Connect either way:

- **Browser extension** (MetaMask, Sage, Rabby, …) — it will prompt to switch
  to Robinhood Chain, id 4663, if needed.
- **WalletConnect v2, QR code, mobile wallet** — paste a free project ID from
  [cloud.reown.com](https://cloud.reown.com) (2-minute signup, yours — this
  tool cannot get one for you), then scan the QR with your phone. The session
  is scoped to chain 4663 from the start.

Both paths end up at the same `ethers` signer underneath. Every deploy is a
transaction your wallet shows you and you approve — this page only builds the
calldata, it never has your key, and that's true whether the wallet is an
extension in this browser or a phone on the other end of a QR code.

## After deploying

The page's own Step 5 re-reads every constructor argument straight off the
deployed contracts, so you're not trusting this tool's memory of what it sent.
Cross-check the addresses on https://robinhoodchain.blockscout.com yourself too.

The vault deploys **closed to trading, with no fixed liquidity target.**
Deposit NFTs, then `seedShares` (never `seedLiquidity` alone — that strands
ETH with no shares to price against), across as many transactions as you
want, at your own pace. Nobody else can seed — treasury-only, enforced
on-chain. When you personally decide it's ready, come back to Step 6 and call
`openPool()`. That is **one-way and permanent**: the moment it lands, trading
is public forever and seeding is dead forever, for everyone, you included.
There is no contract-enforced minimum — that judgment call is entirely yours.

Then: verify the deployed addresses and configure them through a reviewed
`master` release. Production random-redemption settlement is performed by
the standalone relayer packaged in each Passenger release and scheduled by the
cPanel cron. `scripts/relay-drand.ts` remains the source/manual diagnostic, not
the long-running production command. Follow the
[InMotion drand relayer runbook](../../docs/INMOTION_DEPLOYMENT.md#12-inmotion-drand-relayer).
