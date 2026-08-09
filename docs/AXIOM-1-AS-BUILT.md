# AXIOM-1 — As-Built (Compounding Vault Index)

**Status:** delivered. All 12 build stages shipped, independently verified.
**Repo:** `robinwood-plank-index-vault` · **Branch:** `feat/cvi-sota-axiom-1`
**Verification:** `npm run test:contracts` → **809 passing, 0 failing** (full adversarial matrix included, `docs/TEST-MATRIX-AXIOM-1-ADVERSARIAL.md`)
**Date:** 2026-08-09

This is the single authoritative description of the delivered system. It
supersedes every earlier planning document in this repo.

---

## 1. What this is

A maintained, multi-collection NFT index: each supported NFT collection has
its own vault; a meta-index holds a weighted basket of those vaults' own
shares plus WETH; every marketplace fee generated anywhere in the system is
automatically split six ways — buying into the index, deepening a permanent
liquidity floor, burning the index coin, burning the partner token, locking
partner-token liquidity, and paying out yield. Every one of those six paths
compounds by default. Exit is always available, pro-rata, to any holder, at
any time, with no dependency on an external price oracle.

## 2. Collection vault (per NFT collection)

- One ERC-20 share, `S`, per collection. Depositing an NFT mints `S` 1:1;
  redeeming burns `S` 1:1 and returns the NFT.
- `S`'s own redemption value (`convertToAssets`) rises directly as fees land
  in the vault's reserve — there is no separate staking token and no
  separate staking step. Holding `S` *is* the compounding position.
- An internal constant-product AMM lets anyone buy/sell `S` against WETH
  inside the vault itself.
- A native community liquidity pool sits alongside that AMM: a permanent,
  unremovable liquidity floor is minted and locked forever at genesis;
  after that, anyone can add or remove their own proportional liquidity and
  earn real trading fees on it.

## 3. The index

- Holds a weighted basket of collection shares (`S` from each admitted
  vault) plus WETH.
- Admission and ongoing weight are set purely by a multi-signal, on-chain
  formula (paid fees, mint/redeem pressure, AMM depth, trading volume) —
  **never** by an external floor-price oracle.
- Users can mint the index coin either by depositing the exact basket
  pro-rata, or via a single-asset "zap": send WETH once, and the contract
  automatically acquires the correct weighted basket and mints the exact
  index amount requested in one transaction.
- Redemption is always pro-rata and always available, independent of
  whether any background compounding process has run recently.

## 4. The Energy Bus

An immutable contract that receives WETH fee flow from across the system
and splits it, on a **permissionless call**, into six fixed pipes:

| Pipe | Share | Action |
|------|------:|--------|
| Inventory buy | 35% | buys collection shares (`S`) into the index |
| Native LP | 15% | deepens each collection vault's own locked liquidity floor |
| Index burn | 15% | buys and permanently locks the index coin |
| Partner-token burn | 10% | buys and burns the partner token (PLANK) |
| Partner-token LP | 10% | locks partner-token/WETH liquidity |
| Dividend | 15% | reinvested yield (default), opt-in cash claim |

- The split is fixed at deployment and can never be changed afterward —
  there is no admin function anywhere on the Bus that can move a pipe or
  swap an adapter post-launch, and the deploying key's own privileged
  reference is zeroed the moment the system is finalized.
- There is no spendable admin treasury inside the Bus at all.
- If a pipe's real-world action can't complete safely (stale price,
  unopened pool, excessive price impact), that pipe's funds fall through
  to the dividend pipe automatically — nothing is ever stranded, and a
  temporary problem in one pipe never blocks or reverts the others.
- If nobody calls the routing function for a long time, fees simply sit
  safely at the Bus's own address — every user's ability to exit their
  own position is completely unaffected either way.

## 5. Guarantees (independently tested)

- Fees never mint free index coin or free collection shares to anyone —
  value only ever compounds into existing holders' redemption value.
- The partner token (PLANK) can never enter the index's own redeemable
  basket, no matter how it's routed.
- Every liquidity position the protocol locks for itself is permanently
  unremovable by anyone, including the deployer.
- Pro-rata exit works at every stage: mid-route, post-finalize, with a
  keeper that never calls in, or after a long period of inactivity.
- No function anywhere in the fee/settlement/mint/redeem path reads an
  external price or floor oracle.

## 6. Deployment status

- Local deploy ceremony and full smoke test (deposit → fee → route → vest
  → redeem) built and proven end-to-end against a local network.
- Real-network deploy tooling is built and dry-run-proven locally.
- **No deployment to any public testnet or mainnet has occurred.** That
  step requires separate, explicit authorization and is not part of this
  delivery.

---

For deploy operator commands and the address/checklist template to fill in
once a real network deployment happens, see `docs/BULLISH-AXIOM1-RUNBOOK.md`.
