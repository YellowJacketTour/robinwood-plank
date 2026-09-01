# $PLANK buy-and-burn MEV and operational-security review

## Verdict

The current transaction **atomically buys and burns**: the immutable router
sends output to `PlankBurnEngine`, the engine measures the received balance,
and `plank.burn(received)` executes before the transaction can return. No other
transaction can interleave between those operations. The caller cannot choose
the route, token, recipient, minimum output, or destination of the burned
tokens.

That does **not** make the AMM purchase MEV-free. A public-mempool observer can
place trades before and after `executeBurn`. The on-chain TWAP-derived floor
limits how badly the burn can execute and makes a sufficiently large adverse
move revert, but an attacker may still extract value inside the configured
slippage band. The correct claim is **bounded adverse execution**, not
“provably no MEV.”

## Adversary model

The review assumes an adversary can:

- read the public mempool and simulate the burn;
- order a front-run and back-run around it;
- borrow capital atomically;
- manipulate the execution pool for one or more blocks;
- call permissionless oracle, distributor, and burn functions;
- operate many identities and compete for keeper actions;
- compromise a public RPC endpoint or censor one transport;
- exploit L2 sequencer ordering and temporary censorship.

It does not assume the adversary can forge the target chain's consensus,
change immutable deployment addresses, forge ERC-20 balances, or break the
cryptographic signature scheme.

## Contract-enforced guarantees

1. **Fixed route:** `[WETH, PLANK]` is constructed by the engine.
2. **Fixed recipient:** the router must deliver to the engine.
3. **Atomic destruction:** all measured output is burned in the same call.
4. **Bounded size:** `ethAmount <= maxEthPerCall`.
5. **Independent price floor:** `amountOutMin` is derived from a fixed-window
   Uniswap V2 cumulative-price oracle, not supplied by the keeper.
6. **Freshness and depth fail closed:** uninitialized, stale, or shallow-pool
   observations revert before ETH moves.
7. **No keeper steering:** the production keeper reward is zero by default;
   the caller receives no PLANK and cannot redirect ETH.
8. **Reentrancy boundary:** `executeBurn` is `nonReentrant`; accounting is
   updated only after the router and burn succeed, and any failure reverts the
   entire swap.

## Residual MEV

### Sandwiching inside the slippage band

The attacker may move spot execution against the burn while keeping output at
or above `TWAP × (1 − maxSlippage)`. The attack ceiling depends on pool depth,
burn size, fees, competing arbitrage, ordering power, and the configured
slippage. A 3% floor is a loss ceiling, not an expected loss and not immunity.

### Sustained TWAP manipulation

An attacker that holds the pool off-market for a material part of the oracle
window can move the reference itself. A longer window and deep-liquidity floor
increase cost but do not make manipulation impossible. Uniswap's own oracle
design explicitly frames longer windows as increasing manipulation cost while
reducing freshness.

### Back-running

Even a perfectly unsandwiched buy changes the AMM price. Arbitrageurs may
back-run that price impact. This is normal AMM execution cost, not loss of
custody, but it transfers part of the community's trade impact to arbitrageurs.

### Sequencer and private-orderflow trust

An L2 private mempool reduces public searcher visibility but does not prove a
sequencer cannot reorder or leak the transaction. Private submission is a
defense-in-depth transport, never a contract invariant.

## Production policy

1. Submit burns through a private/MEV-protected transaction endpoint when the
   target chain demonstrably supports one; fall back to public submission only
   with the same on-chain price floor.
2. Keep `BURN_KEEPER_REWARD_BPS = 0`; reimburse an operator off-chain during
   alpha rather than creating a manufacturable on-chain reward.
3. Derive `MAX_ETH_PER_BURN` from measured canonical-pool depth. The maximum
   burn should be a small fraction of WETH reserves, not a fixed promotional
   number copied between deployments.
4. Ratify the smallest slippage that remains live under measured volatility.
   Slippage and maximum burn size must be reviewed together.
5. Require exact factory/pair/router/token/code-hash attestations in the signed
   deployment manifest; constructor reserve depth alone does not prove a pair
   is canonical.
6. Alert on TWAP/spot divergence, shallow reserves, stale updates, failed
   burns, execution near the floor, and unexpected route bytecode changes.
7. Split accumulated burns into bounded clips with rate limits. Do not expose a
   predictable large inventory-clearing transaction.
8. If materially stronger MEV resistance is required, migrate execution to a
   uniform-price batch auction or solver protocol with an on-chain price
   checker. A commit/reveal of the burn amount alone is insufficient because
   the reveal transaction itself is visible and sandwichable.

## Academic and protocol basis

- Uniswap V2 whitepaper: cumulative end-of-block prices and longer-window
  manipulation-cost/freshness trade-off.
- Ethereum MEV documentation: public transaction contents enable sandwiching,
  front-running, back-running, censorship, and orderflow auctions.
- FairTraDEX: frequent batch auctions as a mechanism for reducing ordering
  advantage.
- SoK: Mitigation of Front-running: plain commit/reveal permits selective
  reveal and does not provide general input privacy.
- *How to Serve Your Sandwich? MEV Attacks in Private L2 Mempools* (2026):
  private L2 ordering changes attack feasibility but is not a universal
  cryptographic guarantee.
- *Ormer* (2024): long-window TWAPs remain economically manipulable under
  sustained attacks, motivating layered oracle and circuit-breaker designs.

## Implemented deployment gates and verification

The production script now refuses every chain except Robinhood mainnet 4663,
requires deployed code at PLANK, WETH, pair, router, and beacon addresses, and
reads the venue before deployment to prove all of the following:

- pair tokens are exactly PLANK and WETH;
- pair factory equals router factory;
- router WETH equals the configured WETH;
- the liquidity floor is an explicit positive ratified input, never a generic
  fallback;
- routed rake defaults to 40% burn, 40% Powerboard, and 20% founder/operations.

Regression tests bind those properties to the deployment source. The complete
local verification passed 1,051 market checks (1,018 pass, 33 deliberate
skips), 372 Solidity tests, TypeScript, lint, and a production build. These are
strong internal evidence, not a substitute for an independent audit or a
signed live-chain deployment attestation.

## Supply-chain residual

`npm audit --omit=dev` currently reports eight findings (three high, five
moderate) in the installed Solana dependency path, principally
`@solana/web3.js`, `@solana/spl-token`, `bigint-buffer`, `jayson`, and `uuid`.
The suggested npm remediation is a breaking downgrade and was not applied
blindly. This blocks a claim of a zero-risk software supply chain even though
it does not invalidate the Solidity invariants above. Production policy must
isolate Solana parsing from the EVM signer/deployer, constrain untrusted buffer
sizes, and track an upstream patched release or a reviewed dependency
replacement.

## Release language

Allowed: “Every buy-and-burn has a contract-derived TWAP floor, immutable
route and recipient, bounded size, and atomic burn.”

Not allowed: “MEV-proof,” “unsandwichable,” “cannot be front-run,” or “zero
exploit edge.”
