# PlankCrash on Robinhood Chain mainnet — the finalized stack, and the state of the art it will meet (2026-09-13)

Written while the invite table was being brought up on plank.love. It has two
halves: what is actually built (read from this repo, not remembered), and what
the outside world looks like in September 2026 for each piece of it (web
research, sources at the end). Every recommendation names the file it touches.

---

## 0. The one-paragraph version

The stack is already the right *shape* for mainnet: an immutable, permissionless
parimutuel crash game (`PlankGuardedCrash`) whose randomness is a public beacon
verified on-chain (`DrandBeacon` on BN254 via `ecPairing`), a keeper whose every
step anyone may call and be paid for, a rake router that burns $PLANK through a
TWAP-guarded engine, a never-zero lottery, and a `PlankBank` that removes the
per-bet popup with session keys and no third-party wallet infrastructure. Three
things about the world have moved since the architecture doc was written and
should change decisions before mainnet: (1) Robinhood Chain shipped mainnet
(chain 4663) on Arbitrum Nitro with 100ms blocks, a sequencer feed, and
first-class ERC-4337 plus Alchemy gasless infrastructure — the doc's "no
account-abstraction infra is live on Robinhood Chain yet" is no longer true;
(2) BLS12-381 precompiles (EIP-2537) are **not** enabled on Arbitrum chains
until ArbOS 51 "Dia", so the beacon's BN254/evmnet choice is correct today and
quicknet is a later migration, not a v1 option; (3) the keeper-as-a-service
market collapsed under us — Gelato Functions reached end-of-life 2026-03-31 and
OpenZeppelin Defender sunsets 2026-07-01 — so the self-hosted keeper this repo
already has is the primary, and Chainlink Automation (now moving into CRE) is
the only credible hosted backstop.

---

## 1. The finalized stack, as built

| Layer | What exists | File(s) |
|---|---|---|
| Game | Parimutuel crash with pre-committed targets, seat cap 256, target ceiling 10,000x, keeper reward ≤5%, abandoned-round refund ×30, 4,000-round spillover threshold | `contracts/PlankCrash.sol`, `PlankGuardedCrash.sol`, `PlankScalableCrash.sol`, `lib/PlankCcs2LMath.sol`, `lib/PlankCappedPoolMath.sol` |
| Randomness | drand **evmnet** (BN254, G1 signatures, 3s period) verified on-chain; target round = `nextRoundAfter(bettingEndsAt) + 20 periods`; `presetCashOut` gated on entropy *availability* (audit CRITICAL, fixed) | `contracts/DrandBeacon.sol`, `lib/BLSBN254.sol`, `IDrandBeacon.sol` |
| Relay | Quorum fetch from three drand HTTP APIs → `submitRound(round, sig)`; on-chain verifier stays authoritative | `scripts/relay-drand.ts` |
| Keeper | lock → randomness → settle → rake → claims → oracle/burn, every step permissionless, `attempt()` isolates failures; `KEEPER_INTERVAL_MS` | `scripts/casino-keeper.ts` |
| Value flow | Rake router → burn engine (balance-delta burn, `minPlankOut` sandwich refusal) with a V2 TWAP oracle; numbered/cycle lotteries with O(log n) draws; community fuel | `PlankRakeRouter.sol`, `PlankBurnEngine.sol`, `PlankV2TwapOracle.sol`, `PlankNumberedLottery.sol`, `PlankCycleLottery.sol`, `PlankCommunityFuel.sol` |
| Instant UX | `PlankBank`: deposit → `grantSession(localKey, cap, expiry)` → `betVia`/`cashOutVia`; session key strictly weaker than root; no admin, no upgrade | `contracts/PlankBank.sol`, arch doc §8 |
| Client | `crash.html` (module, ethers v6, three.js + Rapier lottery theatre), event-driven scoreboard, client-side `queryFilter` scans | `public/arcade/*` |
| Test hosting | anvil + preview/keeper + invite gateway under cron/flock; Next rewrites `/table`, `/arcade/table.html`, `/api/invite/*`, and (since today) `practice-clock.js` and the stamped manifest | `scripts/plankcrash-table.sh`, `scripts/invite-arcade-preview.ts`, `next.config.ts`, `.github/workflows/inmotion.yml` |
| Audit | Fresh adversarial audit 2026-09-02: HIGH-1 fixed, three MEDIUMs documented/accepted, invariants re-proven | `docs/AUDIT-plankcrash-2026-09-02.md` |

Open business parameters (arch doc §6) are still open: keeper/locker/drawer
reward bps (`keeperRewardBps` is 0), epoch length, burn cadence /
`maxEthPerCall`, and who runs the keeper.

---

## 2. The chain it will run on

Robinhood Chain mainnet went live 2026-07-01 on Arbitrum Nitro (Reth execution,
Nitro sequencer), EIP-4844 blobs for DA, **ETH as gas**, **first-come-first-
served sequencing** (no Timeboost express lane), and **100ms** soft-confirmed
blocks. Public endpoints are rate-limited and explicitly "not recommended for
production"; Alchemy, QuickNode, Blockdaemon, dRPC and Validation Cloud are the
listed providers, with archive reads via Alchemy.

| | Mainnet | Testnet |
|---|---|---|
| Chain id | **4663** | 46630 |
| RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Sequencer feed | `wss://feed.mainnet.chain.robinhood.com` | `wss://feed.testnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` | `https://explorer.testnet.chain.robinhood.com` |

`hardhat.config.ts` already carries both chain descriptors and Blockscout
verification URLs. The docs state "first-class support for ERC-4337 account
abstraction" and name Alchemy for "gasless transaction infrastructure"; the
repo's `NEXT_PUBLIC_GASLESS_ENABLED` flag predates this and should be
re-pointed at a real Gas Manager policy (see §5).

What the FCFS sequencer means for this game specifically: the classic crash-game
MEV — racing a cash-out against the crash — does not exist here because targets
are committed at bet time and settlement is parimutuel; the remaining ordering
sensitivity is `lockRound` timing, which the contract makes harmless (anyone may
lock, the target drand round is fixed by `bettingEndsAt`, and entropy is gated on
availability, not on who called what).

---

## 3. Randomness: the beacon choice is right, and when it changes

- **evmnet vs quicknet.** drand's `evmnet` (launched 2024) signs on BN254 G1
  precisely so the EVM's `ecPairing` precompile can verify it. drand's own
  Ethereum PoC measured **BLS12-381 ~131.6k–140.6k gas vs BN254 ~159.3k gas**
  per verification — a 20% saving that requires EIP-2537. **EIP-2537 is not
  enabled on Arbitrum chains in ArbOS 40 "Callisto"; it arrives with ArbOS 51
  "Dia".** Until Robinhood Chain runs Dia, `DrandBeacon` on BN254 is the only
  on-chain-verifiable option, and ~160k gas per round on a 100ms L2 is
  negligible. Plan the quicknet migration as a new beacon contract deployed
  after Dia, not as a v1 concern.
- **Beacon vs VRF-as-a-service.** Chainlink VRF v2.5, Pyth Entropy and Supra
  dVRF are per-request, per-fee, callback-shaped. A shared-round parimutuel game
  wants one public value per round that every client can verify independently
  and that nobody — operator, oracle, or player — requests; a beacon whose
  signature becomes public at a known time is exactly that, and the contract
  already handles the one hazard (public-before-reveal) by gating on
  availability. Keep the beacon. VRF would add a paid dependency and a callback
  liveness risk for no fairness gain.
- **Relay liveness.** The relay reads `api.drand.sh`, `api2.drand.sh` and
  Cloudflare's mirror with a quorum. For mainnet add a fourth independent source
  and alert on `latest_round - last_submitted_round > 3` (nine seconds); the
  contract's refund/void path covers a dead relay, but players should never
  see it. `TARGET_ROUND_SAFETY_PERIODS = 20` gives a 60s window, which is
  generous against a 3s beacon.

---

## 4. Keeper: the market moved, the design already anticipated it

Arch doc §4b made every state-advancing step permissionless and rewardable so
the loop "does not depend on any single operator". In 2026 that turned out to
be the whole ballgame: **Gelato Functions hit end-of-life on 2026-03-31 and
OpenZeppelin Defender sunsets 2026-07-01.** Chainlink Automation survives and
is being folded into the Chainlink Runtime Environment (CRE); Tenderly Alerts +
Actions remain; KeeperHub positions itself as the Gelato/Defender successor.

Recommendation, in order:
1. **Self-host `casino-keeper.ts` as the primary**, on two independent hosts
   with different RPC providers, each under the flock/cron pattern proven on
   plank.love today (`scripts/plankcrash-table.sh` is the template: foreground
   tree, heartbeat tick file, two-strike health). Set `provider.pollingInterval`
   low; keep `attempt()` isolation.
2. **Set `keeperRewardBps > 0`** (and lock/reveal bps) before mainnet so third
   parties are paid to compete — this is the only automation that cannot be
   sunset.
3. **Chainlink Automation as backstop**, custom-logic upkeep whose
   `checkUpkeep` returns true when a round has been lockable/settleable for more
   than N blocks. Its cost is only paid when the primaries miss.
4. Alert on: keeper heartbeat age, relay lag, `stalledRound`, burn engine
   balance growth without burns.

---

## 5. Instant play: PlankBank now, ERC-4337/7702 next

`PlankBank`'s three-signature entry then popup-free play is a complete,
audited, dependency-free v1 and should ship as is. What has changed is the
ceiling above it:

- **EIP-7702** (live since Pectra, May 2025; L2s followed through mid-2025)
  lets an EOA delegate to smart-account code, so a player's existing wallet can
  hold a scoped session without a separate contract account.
- **ERC-7715 `wallet_grantPermissions`** standardises exactly what
  `bank.grantSession` does — target contract, allowed selectors, value cap,
  expiry — and is referenced by Coinbase, MetaMask, Biconomy and Rhinestone
  stacks. **ERC-7579** session-key validators (ZeroDev Kernel V3, Biconomy
  Nexus) are the modular form.
- **Paymasters**: Alchemy Gas Manager (47M+ sponsored txs), Pimlico, ZeroDev
  Ultra Relay carry most UserOp volume; Robinhood's docs name Alchemy for
  gasless. Robinhood-Chain-specific Gas Manager availability is not confirmed in
  public search results — verify in the Alchemy dashboard before promising
  gasless.

Path: v1 = PlankBank (no external dependency, already tested). v1.1 = accept an
ERC-7715 permission as an *alternative* way to authorise the same
`betVia`/`cashOutVia` calls, sponsored by a Gas Manager policy scoped to
`PlankBank` selectors and a daily cap, so a player never buys ETH for gas. The
invite gateway's server-held guest wallets are a *test* construct and must not
carry to mainnet.

---

## 6. Real-time presentation and data

- **Polling → feed.** The arcade polls the RPC at 400ms (`refresh`,
  `pollScoreboard`). Robinhood Chain publishes a sequencer feed over WebSocket
  (`wss://feed.mainnet.chain.robinhood.com`) giving soft confirmation the
  instant a transaction is sequenced — sub-100ms. Subscribing to it (or to a
  provider's `eth_subscribe` newHeads/logs) removes the poll cadence as a source
  of latency entirely and makes lock/settle discovery deterministic. This is the
  mainnet answer to every "discovered after liftoff" bug fixed in the test rig.
- **Client-side scans → indexer.** `runStatsScan` and the receipt/lottery
  reads `queryFilter` from a start block on every open; the arcade's own comment
  says a mainnet deployment "would want a proper indexer behind this same UI".
  Envio HyperIndex has native Arbitrum Orbit support and benchmarks 142× The
  Graph / 157× Ponder on a Uniswap V2 workload; Goldsky is the managed
  alternative. Index `BetPlaced`, `RoundSettled`, `SeatSettled`, `Draw`,
  `NumberedDraw`, rake and burn events; the arcade reads the scoreboard,
  leaderboard and a player's history from it and keeps the chain only for the
  live round. Archive RPC (Alchemy) covers what the indexer has not backfilled.
- **Presentation timing.** The 8s lead / 1400ms ignition / 2.6s finale /
  4.8s reveal choreography lives in the practice contract and the client; on
  mainnet the production contract has no `practiceLiftoffAtMs`, so the client's
  non-lead path (`performance.now()+1600`) is what plays. It was the *only* path
  that never double-counted or skipped a beat in this week's testing.

---

## 7. What today's hosted-table work taught that carries to mainnet

- **The chain is not something you host.** Every failure class this week —
  glibc binaries, 89MB state dumps, resumed-in-the-past clocks, seeds newer
  than states — disappears when the chain is Robinhood's. The gateway shrinks
  to an allowlist (NFT/holder gate) in front of a normal wallet flow.
- **Verify on the real host.** The arcade branched on hostname and loaded the
  testnet manifest on plank.love while 127.0.0.1 was 100% green. Mainnet
  verification must be a browser on the production URL driving a real bet.
- **Heartbeats, not silence.** A healthy supervisor logs nothing; provisioning
  must watch a tick file. The same applies to the keeper and relay on mainnet.
- **Every guard is mutation-tested before it ships.** The seed validator that
  rejected a valid `0x2ef` and the paging test that read a literal are the two
  cautionary examples from this cycle.

---

## 8. Pre-mainnet checklist (deliberate decisions, not code)

1. Set `keeperRewardBps`, lock/reveal bps, epoch length, burn cadence.
2. Deploy `DrandBeacon` with the evmnet chain hash and group key fetched from
   `https://api.drand.sh/<chainHash>/info` and cross-checked against the other
   two APIs (per `DrandBeacon.sol` header).
3. Contract RPC + archive from a listed provider; never the public endpoint.
4. Two self-hosted keepers + Chainlink Automation backstop; relay on both.
5. Envio indexer for the arcade's history views; feed subscription for live.
6. PlankBank v1; ERC-7715/Gas Manager as v1.1 after confirming Robinhood Chain
   support in the Alchemy dashboard.
7. External audit of `PlankGuardedCrash`, `PlankBank`, `DrandBeacon`,
   `PlankBurnEngine` on the exact bytecode to be deployed (the 2026-09-02 audit
   is internal and predates the guarded/scalable variants' latest changes).
8. Plan the quicknet (BLS12-381) beacon migration for after ArbOS 51 "Dia".

---

## Sources

- Robinhood Chain: [About](https://docs.robinhood.com/chain/), [Connecting](https://docs.robinhood.com/chain/connecting), [Arbitrum: mainnet live](https://blog.arbitrum.io/robinhood-chain-mainnet/), [Arbitrum: testnet](https://blog.arbitrum.io/robinhood-chain-testnet/), [Chainstack overview](https://chainstack.com/what-is-robinhood-chain/), [QuickNode guide](https://www.quicknode.com/guides/robinhood/what-is-robinhood-chain), [Dwellir](https://www.dwellir.com/blog/what-is-robinhood-chain)
- Arbitrum: [ArbOS 40 Callisto](https://docs.arbitrum.io/run-arbitrum-node/arbos-releases/arbos40), [ArbOS 51 Dia](https://docs.arbitrum.io/run-arbitrum-node/arbos-releases/arbos51), [EIP-2537 disclosure](https://forum.arbitrum.foundation/t/disclosure-of-support-for-eip-2537-on-arbitrum-one-and-nova/29720), [Inside Nitro](https://docs.arbitrum.io/how-arbitrum-works/inside-arbitrum-nitro), [Timeboost](https://docs.arbitrum.io/how-arbitrum-works/timeboost/gentle-introduction), [Read the sequencer feed](https://docs.arbitrum.io/run-arbitrum-node/sequencer/read-sequencer-feed), [Sequencer & censorship resistance](https://docs.arbitrum.io/how-arbitrum-works/deep-dives/sequencer), [Envio quickstart on Arbitrum](https://docs.arbitrum.io/for-devs/third-party-docs/Envio)
- Randomness: [drand about](https://drand.love/about/), [drand developer docs](https://docs.drand.love/developer/), [Verifying quicknet on Ethereum (gas table)](https://docs.drand.love/blog/2025/08/26/verifying-bls12-on-ethereum/), [EIP-2537](https://eips.ethereum.org/EIPS/eip-2537), [Chainlink VRF](https://chain.link/vrf), [Supra dVRF](https://docs.supra.com/dvrf), [Switching from VRF to Pyth Entropy](https://dev.to/tensorlabs/switching-from-chainlink-vrf-to-pyth-entropy-2h5b), [VRaaS paper](https://eprint.iacr.org/2024/957.pdf)
- Crash-game design: [Provably-fair crash RNG](https://crashgamechronicle.com/provably-fair-crash-verify-rng/), [Decentralized casino operator risk 2026](https://track360.io/blog/decentralized-provably-fair-casino-smart-contract-operator-2026), [MEV protection](https://blockchain.oodles.io/dev-blog/solving-front-running-issues-defi-smart-contracts-mev-protection/)
- Automation: [KeeperHub comparison](https://keeperhub.com/compare), [LogRocket automation guide](https://blog.logrocket.com/tools-smart-contract-automation-guide/), [Chainlink/Gelato/Reactive guide](https://medium.com/@Bhaisaaab_/the-definitive-guide-to-smart-contract-automation-chainlink-gelato-and-reactive-network-36914c47ed6e)
- Account abstraction: [ERC-4337 explained 2026](https://eco.com/support/en/articles/15254036-what-is-erc-4337-account-abstraction-explained-2026), [EIP-7702 deep dive](https://eco.com/support/en/articles/15254037-erc-7702-deep-dive-2026-eoa-becomes-smart-wallet), [ERC-7715](https://eco.com/support/en/articles/11953354-erc-7715-explained-wallet-permissions-sessions-and-subscriptions), [ERC-7579](https://eco.com/support/en/articles/11890018-erc-7579-the-modular-smart-account-standard-explained), [ZeroDev permissions](https://docs.zerodev.app/smart-wallet/permissions/intro), [Openfort smart wallet security](https://www.openfort.io/blog/smart-wallet-security-best-practices), [thirdweb AA 2026](https://blog.thirdweb.com/account-abstraction-in-2026-how-eip-7702-and-erc-4337-are-transforming-ethereum-wallets-for-developers/), [Alchemy Gas Manager](https://www.alchemy.com/dapps/gas-manager), [Gas sponsorship 2026](https://eco.com/support/en/articles/15254045-gas-sponsorship-2026-how-apps-sponsor-user-fees)
- Indexing: [Envio best indexers 2026 benchmark](https://docs.envio.dev/blog/best-blockchain-indexers-2026), [Protofire indexer comparison](https://protofire.io/guides/blockchain-indexers/), [What is HyperSync](https://docs.envio.dev/blog/what-is-hypersync)
