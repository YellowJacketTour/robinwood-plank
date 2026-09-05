# AUDIT — PlankCrash on-chain contracts: drift, adversarial findings, hardening plan — 2026-09-04

Author model: claude-fable-5-1 (pinned; two sub-reviews also Fable-pinned and self-reported).
Working tree: `C:\tmp\robinwood-sync-fix2` (HEAD `440561b`). **Analysis only** — no file under
`contracts/`, `lib/`, config or economics was changed. This is the only file written.

Owner's demand, verbatim: *"we have made many changes since contracts were last addressed. we need
fable level impossible to exploit contracts for plank with all our modern solution and state of the
art, pruning all weakness."*

> **Standing honesty line.** "Impossible to exploit" is not a claim this document makes, and no
> document should. What is offered is: proven invariants, tested properties, findings with concrete
> attacks, and an explicit residual-assumption list (§D). **No real value should move on any of these
> contracts before an independent audit** — the ratification (`RATIFICATION-ccs2l-2026-09-02.md` §6)
> already says so and nothing here weakens it.

Static analysis: **none available.** `package.json` has hardhat 3.12 + toolbox only; no slither,
solhint, mythril, foundry in `node_modules/.bin` or on PATH. Nothing was installed. Everything below is
manual call-graph review of the 22 `.sol` files (9,286 lines) plus `scripts/deploy-casino.ts`,
`local-casino-setup.ts`, `relay-drand.ts`, `casino-keeper.ts`, the test corpus names, and the lib/
kernel (`lib/casino/*.ts`, `lib/playtest-room-core.ts`, `lib/playtest-rooms.ts`).

---

## PART A — DRIFT AUDIT

### A.0 What is actually deployable (the production graph)

`scripts/deploy-casino.ts` (mainnet-capable, pinned to chainId 4663, lines 84–86) deploys exactly:
`PlankV2TwapOracle → PlankBurnEngine → PlankPowerboard (V1) → PlankRakeDistributor → PlankCrashDrand
→ PlankBank → PlankFuelBooster`, reusing the already-live `DrandBeacon` at
`0x87d584df130FED0Fe540954eD48CE2691A18D619` (lines 40–52; `lib/constants.ts:447`). `local-casino-setup.ts`
adds `PlankProgression` (line 299) and `DrandBeaconMock`. **Not deployed by any script:**
`PlankCrashV2` (only `local-crash-v2-setup.ts`, local), `PlankCrashVRF`, `PlankCrashEntropy`,
`PlankPowerboardV2`, `PlankEconomicRouterV2`, `OwnershipBurner`, `MarketplankVault` (V1; V3 is the
deployed vault via `deploy-and-seed-v3.ts:132`). The crash family itself is **built + tested, not
deployed** on mainnet (`SPEC-CRASH-GO-LIVE-HARDENING.md` header; `deploy-casino.ts:146–150`
"PROPOSED — not ratified; do not deploy"); the testnet canary runbook targets chainId 46630 with the
mock beacon.

`hardhat.config.ts`: solc 0.8.24, optimizer 200 runs, **viaIR**, **evmVersion paris** (Cancun opcodes
unconfirmed on Robinhood Chain), OpenZeppelin **4.x** (`PullPayment`/`Escrow` — removed in OZ 5.0.0,
see §C.9).

### A.1 Drift table

| Contract | Verdict | One-line reason (file:line) |
|---|---|---|
| `PlankCrashDrand.sol` | **DRIFTED + DANGEROUS** | The production crash. Settles by the pre-CCS parimutuel (`stake×mult` player pot + seed by profit weight with a **per-wallet** `singlePayoutCapBps`, `_splitPayout` 1445–1461) — the exact v1.0 cap the ratification removed as "the textbook violation". Immutable `rakeBps` 450 with no staircase; keeper bounties 5/1/1% of rake (deploy 146–148) vs lib `keeperRewardBps: 0`; multiplier law is quadratic-in-blocks (`_multiplierAt` 1473) vs lib's exponential-in-ms (`playtest-live-shared.ts:42`). Holds player stakes, the Vault, keeper subsidy and rake under all of these. |
| `PlankPowerboard.sol` | **DRIFTED + DANGEROUS** | The deployed lottery. Daily epoch, ball 1/26 with consolation 5% + drawer 2%, `mustHitByEpochs` 30, **epoch-accumulating claimTickets** (279–320), no seal/reset-reserve/ratchet/founder-fee. Lib: per-round draw 1/16 (`playtest-room-core.ts:211`), seal + reset reserve + ratchet `max(+5%,+50k)` (`simulation.ts:210–298`), 10% founder fee, consolation 0. Also carries an unfixed HIGH (B-2 below). |
| `PlankPowerboardV2.sol` | **DEAD** | Laboratory kernel added with the private playtest (`a429abe`), never deployed by any script; superseded by the lib/ simulation. (Sub-review detail §A.3.) |
| `PlankRakeDistributor.sol` | **DRIFTED** | 40/40/20 push split (`receive()` 106–130) but it receives only the **treasury leg after** `reserveShareBps` (40%) has been kept by the crash Vault (`PlankCrashDrand` 1200–1210) and after keeper bounties: effective on-chain = 40% Vault / 24% burn / 24% Powerboard / 12% treasury. Lib: 40 burn / 40 community (65% → Powerboard, 35% → 50/50 principal/emission) / 20 founder (`economics.ts:176–185`, `simulation.ts:381–390`). Different split, different order. |
| `PlankEconomicRouterV2.sol` | **DEAD (prototype)** | Correct 40/40/20 of net rake with escrowed pull legs (78–143), `rulesHash` immutable — closer to lib than the Distributor, but not deployed and not wired as any crash's `treasury`. Keep as the seed of the rewrite (§C). |
| `PlankBank.sol` | **CURRENT** (integration drifted) | Session-key escrow is sound (CEI, nonReentrant, no receive, game allow-list fixed at construction). Its only drift is `placeBetFor(player, autoCashOutBps)` — the interface must change when the seat commitment becomes `(stake, targetBps)` under CCS-2L. |
| `PlankBurnEngine.sol` | **CURRENT** | Fixed route/recipient, TWAP floor, atomic burn (132–169); already reviewed in `AUDIT-PLANK-BUY-BURN-MEV-2026-09-01.md`. Bounded adverse execution, not MEV-free (B-10). |
| `PlankV2TwapOracle.sol` | **CURRENT** | Canonical V2 fixed-window oracle with reserve floor at deploy and on every `update()` (100–163). |
| `PlankFuelBooster.sol` | **CURRENT** (economics drifted) | Boosts the Vault via `fundVault()`; but `fundVault` never raises `seedBudget` (crash 831–835 vs 693–695), so fuel can sit unseedable. Lib has no fuel concept at all. |
| `PlankProgression.sol` | **DRIFTED** | Rank-gated caps/premiums skimmed into the Vault (`_applyProgression` 899–914). Lib has no progression; CCS-2L partition-invariance makes per-wallet caps redundant. Candidate for deletion (§C). |
| `DrandBeacon.sol` / `IDrandBeacon.sol` / `lib/BLSBN254.sol` | **CURRENT** (see §A.3 sub-review) | Shared verify-on-chain drand cache already live for the vault; evmnet `bls-bn254-unchained-on-g1`, period 3 s, genesis 1727521075 (`api.drand.sh/v2/chains/04f1e9…/info`, accessed 2026-09-04). |
| `lib/PlankCcs2LMath.sol` | **CURRENT but UNREACHABLE** | Ratified rule, wei-exact vs `economics-ccs2l.ts` (6/6 differential, harness 2,841 bytes, gas n=2/10/50/100 = 73,899 / 158,600 / 669,807 / 1,310,767 — `EVIDENCE-MANIFEST-CCS2L…txt:41–44`). Referenced only by `contracts/test/PlankCcs2LSettlement.sol`; no game contract imports it. |
| `lib/PlankParimutuelMath.sol` | **DEAD** | PFSS candidate library, "does not select PFSS for production" (7); PFSS is superseded by ccs-2l as live default (`playtest-room-core.ts:33`). |
| `lib/PlankFenwickTree.sol` | **DEAD** | Only consumer is `PlankPowerboardV2` (dead). |
| `PlankCrashV2.sol` | **DEAD (legacy, blockhash entropy)** | Superseded; local script only. |
| `PlankCrashVRF.sol` | **DEAD** | Chainlink VRF not deployed on Robinhood Chain (`PlankCrashDrand` header 23–28). |
| `PlankCrashEntropy.sol` | **DEAD** | Pyth Entropy not deployed on Robinhood Chain (same). |
| `OwnershipBurner.sol` | **DEAD** | Exists solely to renounce `PlankCrashVRF`'s ConfirmedOwner (8–39). **Not used anywhere in the production graph** — `grep` over `scripts/`, workflows, `lib/` finds no reference. The production contracts have no `Ownable` at all; their only privileged surface is the one-shot `setProgression` by `_deployer`. |
| `MarketplankVaultV3.sol` | CURRENT (out of crash scope) | Deployed vault; shares the beacon. Sub-review §A.3. |
| `MarketplankVault.sol` | DEAD/legacy (V1) | Superseded by V3 (`deploy-and-seed-v3.ts:33`). |
| `MarketplankAcrossReceiver` / `DeBridgeExecutor` / `ForeignFeeRouter` | out of crash value-flow scope | Sub-review §A.3. |
| `IPlankProgression.sol` | follows `PlankProgression` | — |

### A.2 The specific drift questions, answered

**Canonical crash contract:** `PlankCrashDrand` — the only one `deploy-casino.ts` and
`local-casino-setup.ts` instantiate (262, 212–218), and the one every current test suite targets
(`PlankCrashDrand*.test.ts`, `CasinoIntegration`, `CasinoKeeper`, `PlankCrashHardening`). V2/VRF/Entropy
are retained legacy variants; their tests still compile them, which is the only reason they are still
in the tree. **They should be deleted** (§C.2) — every extra bytecode in `contracts/` is a
deploy-by-mistake surface (`AUDIT-PLANKCRASH-MECHANISM…` "legacy-contract containment").

**Powerboard V1 vs V2:** V1 is deployed/wired (`deploy-casino.ts:242`, and it is the crash's
`jackpotSink`). V2 is a lab kernel. They disagree economically (V1: epoch draw, ball 1/26, consolation;
V2: see sub-review) and **neither** matches the lib lottery (seal/reset-reserve/ratchet/founder fee,
per-round 1/16 draw, consolation 0, no must-hit).

**Vault / Router lineage:** `MarketplankVaultV3` is canonical (V1 dead). `PlankEconomicRouterV2` has
no deployed predecessor: its predecessor in function is `PlankRakeDistributor` (still the deployed
one). They disagree: Distributor pushes 40/40/20 of what it receives (post-Vault, post-bounty);
RouterV2 escrows 40/40/20 of gross-minus-keeper and would be the crash's `treasury` — but the crash
never calls `routeRake`; it `claimRake()`s into a PullPayment escrow and expects a `receive()`.

**Does ANY on-chain settlement path implement CCS-2L?** **No.** The only on-chain settlement is
`PlankCrashDrand.registerResult/claim/_splitPayout` (1311–1461): player pot split by `w = s·m`
(1341–1345), seed split by `pw = s·(m−1)` with a fair-odds cap and a **per-wallet** cap
`reserveAtLock·singlePayoutCapBps` (1456–1458). CCS-2L (`PlankCcs2LMath.settle` 126–208):
`p_i = f·s_i + premium·s_i·ln(m_i)/W`, house `min(H, reserveAtLock·houseCapBps)` **global**, per-seat
fair-odds cap, no per-wallet cap. Exact divergences and consequences:

1. *Player layer weight* `s·m` vs `f·s + λ·s·ln m`: on-chain has no survivor floor (a 1.01× survivor
   receives ~1.01/W of the pot, not ≥ 75% of stake); skill reward is linear in m, not hazard-weighted.
   Displayed CCS-2L decompositions in the playtest (`RATIFICATION` §4) would be **false** on-chain.
2. *House layer* per-wallet cap: split-relaxable — N wallets get N caps (the contract's own comment at
   184–196 admits it). The ratification's 39,680-case partition search (0-wei gain) does **not** apply
   to the deployed bytecode.
3. *Rounding/dust*: on-chain floor-divides per claimant and leaves the residue as unaccounted contract
   balance (B-12); CCS-2L routes player dust to the largest-weight survivor so `Σp == D_players`
   exactly.
4. *No-survivor*: both route to reserve (`sweepBustedRound` 1287–1300 ≈ `bustedToReserve`) — this one
   agrees.
5. *Commitment fields*: no `settlementRuleId`/`settlementParamsHash` in `Round` (RATIFICATION §6.2).
6. *Crash law*: both are inverse-uniform 1/m (`_deriveCrash` 1512–1519 vs `simulationCrashBps`), so
   `g(m)=ln m` remains exact — but on-chain uses `uint256 % 10000` (2⁻²⁴⁶ bias, negligible) while lib
   uses rejection sampling; and the **time law differs** (quadratic per parent-chain block vs
   exponential per ms), so `m` at a given wall-clock instant is not the same number on-chain and off.

**Rake split / lottery seeding / eligibility — every disagreement:**

| Topic | On-chain | lib/ |
|---|---|---|
| Rake | immutable 450 bps (`PlankCrashDrand:146`) | 450 → floor 250, −25 bps per 25M fresh wagers (`playtest-room-core.ts:8–11`, `simulation.ts:114–120`) |
| Keeper cut | 5%+1%+1% of rake (`deploy-casino.ts:146–148`) | 0 (`playtest-room-core.ts:12`) |
| Split order | Vault 40% of net first (`1200`), then Distributor 40/40/20 of the rest | 40 burn / 40 community / 20 founder of net (`economics.ts:181–184`); Vault is a subdivision of community |
| Powerboard funding | Distributor `airdropBps` 4000 of post-Vault + Vault overflow above `reserveCap` (`_creditReserve` 795–801, `deliverOverflow` 851–863) | `powerboardFundingBps` 6500 of community + emission-buffer overflow above `emissionBufferCap` (`simulation.ts:381–390`) |
| Founder lottery fee | none | 1000 bps on lottery gross (`economics.ts:187–199`) |
| Prize base / seal / reset reserve / ratchet | none: jackpot is a bare accumulator (`fund()` 268–271) | `lotteryInitialBase` 50k, `minimumLotteryGross`, `resetReserve`, ratchet `max(+5%,+50k)` (`simulation.ts:210–298`) |
| Draw cadence & odds | per epoch (86400 s), ball 1/26 (`deploy-casino.ts:264–268`) | per settled round, 1/16 (`playtest-room-core.ts:211,228–232`) |
| Consolation / drawer | 5% / 2% of pot (V1 408, 423) | 0 / 0 |
| Must-hit | `mustHitByEpochs` 30 (V1 109, 406) | **absent** |
| Ticket eligibility | claimTickets into `currentEpoch()` at claim time, accumulating across rounds; anyone may claim for anyone; only settled non-voided rounds (279–320) | `playtest_powerboard_tickets(room, epoch, user)` accumulating stake per eligibility epoch (`playtest-rooms.ts:674–682`) — **and the in-flight design replaces this with round-only eligibility** |
| Seed | fraction of Vault with 5 caps + income budget (`_computeSeed` 700–713) | fixed `crashSeed` 10,000 from emission buffer (`simulation.ts:329`) |
| Manual lock | on-chain `cashOut` at `block.number` gated by `revealNotBefore` (1095–1128) | server-arrival lagged grant δ=1000 ms (`playtest-rooms.ts:604–644`) |

### A.3 Sub-review results (Fable-pinned; merged verbatim where load-bearing)

Two Fable-pinned sub-reviews were dispatched in parallel and both self-reported `claude-fable-5-1`.

**A.3.1 Randomness surface (DrandBeacon / BLSBN254) — CURRENT, sound verifier, two timing findings.**
- Target: drand evmnet, BN254, `bls-bn254-unchained-on-g1`, period 3 s, genesis 1727521075 — all
  constructor immutables (`DrandBeacon.sol:94–113, 131–173`), no owner/setter/upgrade. `chainHash` is
  informational only (143): nothing binds it to the pubkey, so a wrong-key deploy is only caught by the
  real-round fixture test (`DrandBeacon.bls.test.ts:318–333`, fixture round 19229507).
- Hash-to-curve is a proper RFC 9380 construction: `expand_message_xmd` (keccak256, Z_pad 136, len 96;
  `BLSBN254.sol:242–257`), `hash_to_field` count 2 / L 48 (206–231), two SvdW maps (264–294) added via
  precompile 0x06. Message = `keccak256(uint64 BE round)` then hashed with DST
  `BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_` (`DrandBeacon.sol:261–264`) — evmnet's unchained
  convention (keccak, not quicknet's sha256).
- Pairing: `e(sig, −G2)·e(H(m), pk) == 1` via 0x08 (`BLSBN254.sol:115–141`), canonical negated
  generator (90–97). Signature coords range-checked `< P`, on-curve, (0,0) rejected (145–160); G1
  cofactor 1 so on-curve ⇒ in-group; `H(m)=∞` cannot pass since sig=∞ is rejected. Pubkey is
  on-curve-checked but not subgroup-checked (164–178) — harmless, the pairing precompile rejects
  non-subgroup G2 (bricks, never forges). **No forgery path without the drand signature was found.**
- Round convention `currentRoundAt(t)=⌊(t−g)/p⌋+1`, `nextRoundAfter = +1` (303–311) matches drand
  `TimeOfRound`; cross-checked against the fixture (`DrandRoundConvention.test.ts:59–90`). Submission is
  permissionless, first valid write wins, resubmit no-op, different value reverts (227–250); **no time
  gate on submission** (a far-future round is accepted if it verifies — only a colluding LoE threshold
  could produce one; a bounded `round ≤ currentRoundAt(now)+k` is free defence-in-depth).
- Gas: no measured figure in tests; estimate ~160–200k per `submitRound` (8 modexp + pairing 113k +
  SSTORE). INFO: on a chain lacking 0x08/0x05 the `staticcall` returns ok with empty output, so every
  submission reads `InvalidSignature` rather than `PairingCallFailed` (fails closed either way).
  `IDrandBeacon.sol:12` has a stale "round 0" comment.
- Findings raised: the sequencer-clock cash-out window (= B-1, independently rediscovered), the
  permanent-freeze liveness (= B-3), the `_startRound` collision inside `settleRound` (= B-13),
  fixture-only wire-compat proof (B-18).

**A.3.2 Vault / bridge / legacy — classification and findings.**
- `MarketplankVaultV3` CURRENT (deployed via `deploy-and-seed-v3.ts:132`, `deploy-vault-v3.yml:188`;
  `lib/constants.ts:353`). `MarketplankVault` DRIFTED/live-legacy: `scripts/deploy-vault.ts:2–4`
  "DEPRECATED … RETIRED V2 vault … critical, externally exploitable flaw … DO NOT deploy"; still
  on-chain as V1/V2 redeem-only (`lib/constants.ts:354–355`).
- `MarketplankForeignFeeRouter` DEAD (undeployed, bypassed: `foreign-chain-registry.ts:392–394`,
  `foreign-fulfill.ts:5–17`). `MarketplankAcrossReceiver` / `MarketplankDeBridgeExecutor`
  **DEAD-but-wired, DANGEROUS if deployed** (registry null-until-deployed; quote builders still target
  them) — see B-16.
- Legacy crash contracts: all four (`PlankCrashV2` header 6–8 / 100–112 blockhash grindable;
  `PlankCrashVRF` 29–33, 550–556 unchecked checklist, carries `ConfirmedOwner`; `PlankCrashEntropy`
  19–21, 563–570; `PlankPowerboardV2` :7 "prototype", privileged `settler` 35–36, push `claimFounderFees`
  101–102) are full value-holding contracts that compile alongside production; a mistaken
  `getContractFactory("PlankCrashV2")` would ship one. Current scripts select only
  `PlankCrashDrand`/`PlankCrashDrandTestbed`.

---

## PART B — ADVERSARIAL FINDINGS (production graph, ranked by exploitability × value at risk)

Severity scale: CRITICAL (theft/permanent loss, cheap) · HIGH (material extraction or loss of
player money under realistic conditions) · MEDIUM (bounded loss / liveness / griefing) · LOW · INFO.
Every finding names the invariant it breaks. Items marked **(sub-review)** come from §A.3.

### B-1 · HIGH · Manual cash-out window is closed by a clock the sequencer controls
- **Where:** `PlankCrashDrand._cashOut` 1098–1102; `CASHOUT_CLOSE_MARGIN_PERIODS = 2` (235) ⇒ a 6 s margin.
- **Attack:** the drand evmnet signature for `targetDrandRound` exists in the wild at wall-clock
  `genesis + (round−1)·3`. The on-chain gate is `block.timestamp < revealNotBefore`. Arbitrum-family
  chains let the sequencer stamp timestamps up to **24 h in the past** and the docs call timing
  assumptions "unreliable in the shorter term (minutes)" (Arbitrum docs, accessed 2026-09-04). A
  lagging (or colluding) sequencer keeps the window open after the crash point is publicly computable;
  a player reads the drand round from any HTTP relay, computes the crash, and submits `cashOut` (or
  not) with full knowledge. The second belt (`isRoundAvailable`) only helps **after** someone relays —
  and the informed player simply does not relay first.
- **Invariant broken:** I-a "effectiveCashOutBlock is a function of data written before the
  randomness could exist anywhere".
- **Fix in principle:** remove manual on-chain cash-out entirely; every seat commits `(s, m)` at bet
  time (this is also what CCS-2L needs). If a manual path must exist, close it ≥ several minutes
  before the drand due time and/or require the cash-out to be *in the same block or earlier than* a
  relayer-independent anchor. **JUDGMENT** (Chainlink VRF's own consumer guidance — "stop accepting
  user inputs after requesting randomness" — is the industry-standard form of this rule, accessed
  2026-09-04.)

### B-2 · HIGH · Powerboard "undrawn-epoch option": late/out-of-order draws pay the *current* jackpot
- **Where:** `PlankPowerboard.requestDraw` 366–373 (any closed epoch, any order), `drawWinner`
  379–429 uses live `jackpot` at draw time, not a snapshot at epoch close; `claimTickets` credits
  `currentEpoch()` at claim time (309).
- **Attack:** in a quiet epoch, two sybil wallets place the 0.005 ETH minimum pool (rake ≈ 0.000225
  ETH) and claim tickets; nobody else plays that day, so the attacker owns 100% of that epoch's
  tickets. They do **not** request the draw. Weeks later, when the jackpot is large, they
  `requestDraw(oldEpoch)` + `drawWinner`: certain consolation `5%·J` plus `1/26` chance of `J`, i.e.
  ≈ 8.8%·J expected per parked epoch, and with `mustHitByEpochs` (30) every parked epoch ≥ 30 after
  the last hit is a **guaranteed full jackpot**. Multiple parked epochs = multiple options on the same
  pot. Even without parking, an accumulating consolation of 5% per epoch to a stake-weighted ticket
  makes the pot drainable by anyone who dominates low-traffic epochs.
- **Invariant broken:** "a draw pays only the prize that existed when its eligibility closed"; and the
  §10 must-hit promise becomes an attacker's guarantee.
- **Fix in principle:** snapshot `prize` at `requestDraw` (or at epoch end) and/or force in-order
  draws (an epoch cannot be requested while an earlier epoch with tickets is undrawn). Under the
  in-flight **round-only eligibility** design this class disappears structurally (each draw is bound to
  the round whose stakes fund it, §C.5). **JUDGMENT**, attack verified by reading the code.

### B-3 · HIGH (liveness/design) · A single un-relayed drand round halts the game forever with stakes locked
- **Where:** `voidStaleRound` always reverts (1257–1259); `settleRound` needs `entropyRevealed`
  (1170); `_startRound` only runs from `settleRound`/void (1252, 1053).
- **Consequence:** if the drand evmnet signature for one target round is ever unavailable (network
  retired, key rotation, relay abandoned), that round's pool, its seed, and every future round are
  frozen. There is no owner, no escape, no refund. This is a deliberate fail-closed choice (comment
  1255–1256) and the reasoning about outcome-selective voids is correct — but the residual is total.
- **Invariant:** "players can always eventually recover stake or payout".
- **Fix in principle:** an outcome-*independent* long-timeout refund (e.g. 30 days after
  `revealNotBefore`) that returns every stake exactly and the seed to the Vault. Any party holding the
  signature can still reveal first (reveal beats refund in the race), so the refund only fires when
  drand truly died. **JUDGMENT.**

### B-4 · MEDIUM · Winners who are not registered within `registrationWindowBlocks` forfeit to other winners or to the Vault
- **Where:** `registerResult` 1314 (`TooLate`), `claim` divides by `totalWinningWeight` of *registered*
  winners (1375), `sweepBustedRound` sweeps if none registered (1291).
- **Attack/consequence:** the window is 50 `block.number` units (`deploy-casino.ts:161`). On an
  Arbitrum-family chain `block.number` tracks the **parent chain** (Arbitrum docs, accessed 2026-09-04)
  — if the parent is Arbitrum One that is ~12 s; if Ethereum, ~10 min. Either way a censoring
  sequencer or a dead keeper strips unregistered winners' shares to whoever *is* registered — a
  registered winner is economically motivated not to register others. The base of the whole time law
  (multiplier per block, `maxElapsedBlocks` 1800) has the same unresolved unit.
- **Invariant:** "each survivor's payout depends only on committed data and the crash".
- **Fix:** settle in one pass from committed seats (CCS-2L needs the full seat set anyway), or make
  registration windowless (claims are pull, any time). Pin the block-time base empirically before any
  parameter is ratified. **INDUSTRY-STANDARD** (windowless pull claims).

### B-5 · MEDIUM · Deployer retains a one-shot privilege that can degrade or brick betting
- **Where:** `setProgression` (620–624, and Powerboard 249–253, FuelBooster 120–124): `_deployer`
  may wire an arbitrary contract once. `_applyProgression` (899–914) calls `capFor`, `premiumBpsFor`,
  `recordBet` **without try/catch** — a reverting or gas-eating progression bricks `placeBet` forever;
  a malicious one sets `premiumBps = 10000` and skims 100% of every stake into the Vault.
- **Invariant:** "no post-deploy actor can change odds, caps, or fund flows".
- **Fix:** delete `PlankProgression` and the setter (CCS-2L's partition-invariance removes its stated
  purpose), or make it a constructor immutable and wrap calls in bounded-gas try/catch. **JUDGMENT.**

### B-6 · MEDIUM · Vault seed is per-wallet-capped, not partition-invariant (the ratified fix is not on-chain)
- **Where:** `_splitPayout` 1456–1458 (`singlePayoutCapBps` of `reserveAtLock` per **wallet**).
- **Attack:** exactly the v1.0 relaxation: split one position across N wallets to obtain N caps; the
  ratification's I5b regression exists only for the JS/TS kernel and the test harness.
- **Bound:** the `seedBudget` income bound (197–229) caps *cumulative* extraction at bootstrap +
  retained rake, so this is extraction-rate, not unbounded theft. That is why it is MEDIUM not HIGH.
- **Fix:** replace with `PlankCcs2LMath` house layer (global cap). **PROVEN** in the kernel by the
  39,680-case search; must be re-proven against the new contract.

### B-7 · MEDIUM · Keeper bounties are a farmable subsidy only if any floor exists; the bps path is farm-proof, the floor path trusts one address
- **Where:** 1211–1248. bps bounties are of realized rake ⇒ manufacturing a round costs more rake
  than it pays (correct). `designatedKeeper` floor pays from a separate reserve to one immutable EOA.
- **Residual:** that EOA's key custody is a trust assumption; if the deploy sets it, the operator can
  drain `keeperSubsidyReserve` at `keeperEpochBudgetWei` per day by settling trivially. Bounded by
  design. **INFO→MEDIUM only if the floor is enabled.**

### B-8 · MEDIUM · `deliverOverflow` / `fund()` push path and best-effort `claim()` redirect
- **Where:** `deliverOverflow` 851–863 (CEI correct, 100k stipend, restores on failure);
  `claim` 1384–1395 pushes to a self-chosen `payoutRedirect` sink with **all** remaining gas, falling
  back to escrow. `nonReentrant` is shared across all state-changing entry points, so cross-function
  reentrancy from the sink is blocked; **read-only reentrancy** is possible: during the sink call,
  `estimatedPayout`/`currentRound`/`reserve` views are already post-effect (CEI holds), so no stale
  read is exposed. Verified, not a finding — recorded so the next auditor does not re-derive it.
- **Residual:** the sink's gas is unbounded ⇒ a player can make their own claim expensive for the
  keeper who claims on their behalf (griefing the keeper's gas, self-harm only). LOW→MEDIUM for keeper
  economics. **Fix:** bounded stipend on the sink call, like `SINK_GAS_STIPEND`.

### B-9 · MEDIUM · PullPayment (OZ 4.x) escrow: `withdrawPayments(payee)` is public for any payee; Escrow uses `sendValue` with all gas
- **Where:** OZ `PullPayment._asyncTransfer` → per-contract `Escrow`. Anyone can trigger a payee's
  withdrawal; a payee that is a reverting contract has funds stuck in Escrow forever (no rescue). The
  treasury (Distributor) `receive()` is `nonReentrant` and best-effort per leg, so the treasury path
  is safe. **OZ 5.0.0 removed `PullPayment` and all `Escrow` contracts** (OZ CHANGELOG, accessed
  2026-09-04) — the pattern is not maintained upstream. **Fix:** in-contract `mapping(address=>uint)
  owed` + `withdraw()` (the Solidity docs' withdrawal pattern, accessed 2026-09-04), with
  `ReentrancyGuardTransient` once Cancun is confirmed on the chain (EIP-1153). **INDUSTRY-STANDARD.**

### B-10 · MEDIUM · Buy-and-burn is bounded-adverse, not MEV-free; TWAP is manipulable at linear cost
- **Where:** `PlankBurnEngine.executeBurn` 132–169; `PlankV2TwapOracle` 30-min window, 2 h staleness.
- **Attack:** sandwich inside the 3% band on every burn (`maxSlippageBps` 300); sustained pool
  displacement over ≥ a window fraction moves the reference itself — Uniswap's own doc states
  manipulation cost is "approx. linear with liquidity … and with the length of time over which you
  average" (accessed 2026-09-04). Public-mempool exposure per ethereum.org MEV docs (accessed
  2026-09-04). Already documented in `AUDIT-PLANK-BUY-BURN-MEV-2026-09-01.md`; nothing new, but it is
  the largest *continuous* leak in the graph (up to 3% of 40% of rake, every burn).
- **Fix:** private orderflow where available, clip sizing from measured depth, tighter band, or batch
  auction. **INDUSTRY-STANDARD.**

### B-11 · MEDIUM · `PlankFuelBooster` TWAP-priced ETH release on PLANK burn
- **Where:** 139–172. `boost = min(consult(plank, amount), caps, pool)`. A 30-min PLANK pump lets a
  burner convert PLANK into up to `maxBoostPerRoundWei` (0.5 ETH/round) of pool ETH at an inflated
  price. The ETH goes to the shared Vault, not the burner — but the burner can be the dominant
  survivor in the next rounds and the Vault seed is what they harvest, bounded by B-6's
  income budget. Also `fundVault` does not raise `seedBudget`, so fuel may be **un-seedable**
  (economic intent broken, not a theft).
- **Fix:** if fuel survives the rewrite, credit fuel to the *lottery* prize (no seed harvest path) and
  route via the same funding law as rake. **JUDGMENT.**

### B-12 · LOW · Physical-ETH conservation: settlement dust is unaccounted; no `accountedBalance()` on the crash
- **Where:** `_splitPayout` floors per claimant; residue `distributable − Σpaid` stays in the contract
  outside `reserve`, `pendingOverflow`, `keeperSubsidyReserve`, `accumulatedRake`, live pools.
  Forced ETH (selfdestruct) likewise becomes untracked. Not exploitable, but the invariant
  `address(this).balance == Σ tracked` cannot be asserted. `PlankEconomicRouterV2` gets this right
  (`accountedBalance`, `unclassifiedSurplus` 126–133).
- **Fix:** route dust deterministically (CCS-2L rule) and expose `accountedBalance()`; test
  `balance ≥ accounted` as an invariant. **INDUSTRY-STANDARD** (ERC-4626 accounting discipline).

### B-13 · LOW · Config foot-guns without constructor guards
- `bettingDurationSeconds == 0` with `roundIntervalSeconds == 0` makes consecutive `_startRound`
  targets collide ⇒ `BadHardeningConfig` revert inside `settleRound` ⇒ permanent halt (651). Add
  `require(bettingDurationSeconds ≥ (SAFETY+1)·period)` when interval is 0.
- `_rolledWindow` loop is bounded by elapsed days but with tiny `dailyDrawdownBps` could run thousands
  of iterations after long idle (747–752). Cap iterations.
- `maxAwaitBlocks` is dead config (143). Delete.

### B-14 · LOW · `claimTickets` still lets anyone choose *when* a player's tickets land (epoch deferral)
- Documented as accepted MEDIUM-1 in `docs/AUDIT-plankcrash-2026-09-02.md`. Under B-2 it is one of
  the two ingredients. Disappears with round-only eligibility.

### B-15 · INFO · Things that are correct and should be carried forward
- Randomness binding before bets (`_startRound` 641–652, `RESULT_DOMAIN` + chainid + address + beacon
  + roundId + targetRound, 1523–1539) — matches the VRF-consumer discipline.
- `drandRoundToRoundId` uniqueness (651) — no two rounds share a signature.
- Seed income budget (`seedBudget`) — the only true collusion bound in the design; keep.
- Whale cap measured on the final pool at lock (1039–1042).
- Distributor best-effort legs + `flush()`; Bank CEI; BurnEngine fixed route/recipient.
- `_deriveCrash` inverse-uniform law with `r==0 ⇒ 1.00×` instant crash — the 1/m law CCS-2L's
  `g(m)=ln m` requires.

### B-16 · HIGH (sub-review; out of crash scope, in the repo's deployable set) · Bridge receivers spend other users' rescued ETH
- **Where:** `MarketplankAcrossReceiver.sol:202, 212, 229, 259, 273–280`; `MarketplankDeBridgeExecutor.sol:149,
  161, 180, 206, 212–219`.
- **Attack:** a failed push credits `rescuableFunds[recipient]` but leaves the ETH in the balance; the
  next fill computes `delivered = address(this).balance`, forwards the victim's residual into
  `buyNowFor`, and sweeps the refund to the *new* recipient. Attacker: deposit once with a
  reject-ETH recipient (forces a credit), deposit again under-funded, receive the victim's residual as
  change; the victim's `withdrawRescuedFunds` then reverts. Neither test file covers a rejecting
  recipient followed by a second fill.
- **Invariant:** `balance − Σ rescuableFunds ≥ this fill's delivered`.
- **Fix:** track `totalRescuable`, `delivered = balance − totalRescuable`; or escrow failed pushes in
  a separate contract. Also (MEDIUM) Across accepts non-wrapped-native `tokenSent` (194–196) and
  strands it — fail closed like DeBridge (`WrongToken` 134). These contracts are undeployed; **do not
  deploy without this fix.**

### B-17 · MEDIUM (sub-review) · MarketplankVaultV3
- **V3-1 MEDIUM** `deposit`/`depositMany` (295–316) trust the collection's `safeTransferFrom` and never
  check `ownerOf(tokenId) == address(this)`; a proxied/non-standard ERC721 mints unbacked shares that
  `_assertSolvent` (748–751) counts as backed. Fix: assert ownership after each pull.
- **V3-2 MEDIUM** single vault-wide redeem slot (`RequestPending` 328; `ROUND_EXPIRY` 28,800 rounds
  ≈ 24 h at 3 s, 188/741–744) — a requester who never relays blocks all random redeems until someone
  relays (permissionless) or forfeits a share to treasury. Economic griefing, not free.
- **V3-3 LOW** forfeit mints to `treasury` (397): if treasury also operates the relay it has a
  (requester-mitigable) incentive not to relay a draw it can compute.
- INFO (verified, carry forward): no owner/pause/upgrade; all entry points `nonReentrant`; ETH pushes
  after reserve updates so read-only reentrancy sees consistent reserves; no `receive()` so forced
  ETH is dead capital not a lever; LP mints against explicit `ethReserve` not balance, seed LP locked
  at `address(0)` (627–632), rounding favours the pool, `MAX_BATCH` 50 — the ERC-4626-style
  inflation/first-depositor attack (OZ docs, accessed 2026-09-04) does not apply. No test covers V3-1
  or V3-2's duration.

### B-18 · LOW (sub-review) · Beacon wire-compatibility is proven only by the fixture
- `DrandRoundConvention.test.ts` and the real-signature test are the only proof that DST/message/
  pubkey word order match evmnet. A deploy script that sources pk/genesis from anywhere else can
  deploy a mismatched key that fails closed forever (= B-3 freeze for the crash). **Fix:** the deploy
  manifest must assert `submitRound(fixtureRound, fixtureSig)` succeeds on the live chain before any
  consumer is pointed at the beacon; add a bounded future-round guard as free defence-in-depth.

### B-19 · MEDIUM (sub-review) · `MarketplankForeignFeeRouter.buyNowWithToken` strands tokens on partial fills
- 398–426: caller-controlled `numerator/denominator`, fee charged on full declared price, no rescue
  path; `token` is caller-chosen with no allowlist. Undeployed and bypassed; fix or delete.

---

## PART C — HARDENING PLAN (target architecture; no contract code here)

### C.1 Design goals, in the owner's order
1. **Match the ratified economics exactly** (CCS-2L v1 variant A, f = 7,500, houseCapBps = 1,000
   global; 40/40/20 of net rake; rake staircase 450 → 250; founder lottery fee 1,000 bps).
2. **Accommodate the in-flight lottery** as a *requirement*, not a design: progressive carve `x(P)`
   with winner `P·(1−x(P))` and seed `P·x(P)`, both non-decreasing in `P`; base may grow without
   cap; **round-only eligibility**.
3. **Prune**: fewer contracts, fewer bytes, zero post-deploy levers except the ones listed in C.7.
4. **Prove**: every invariant in C.8 as an executable assertion; wei-exact differential vs lib/ (C.9).

### C.2 Keep / rewrite / delete

| Action | Contract(s) | Why |
|---|---|---|
| **KEEP** | `DrandBeacon`, `IDrandBeacon`, `lib/BLSBN254` | Live, shared, verified; only findings are in §B-16+ (sub-review). Do not fork a second randomness surface. |
| **KEEP** | `PlankV2TwapOracle`, `PlankBurnEngine` | Correct as built; drift is integration only. Apply B-10 operational policy. |
| **KEEP (interface change)** | `PlankBank` | Sound escrow; change `placeBetFor(player, targetBps)` to the new seat commitment; no other change. |
| **KEEP (promote)** | `lib/PlankCcs2LMath` | Becomes the *only* settlement math. Add `settlementRuleId/paramsHash` binding at round commit. |
| **REWRITE** | `PlankCrashDrand` → `PlankCrash` (one contract) | Remove manual cash-out (B-1), remove registration window (B-4), replace `_splitPayout` with CCS-2L (A.2, B-6), one-pass settlement from committed seats, in-contract pull ledger (B-9), `accountedBalance` (B-12), long-timeout outcome-independent refund (B-3), delete progression hook (B-5), delete `maxAwaitBlocks`, guard B-13. Keep: envelope-before-bets, seed income budget, drawdown/HWM circuits, whale cap at lock, seed caps, `deliverOverflow` CEI shape. |
| **REWRITE** | `PlankPowerboard` → `PlankLottery` | Round-only eligibility, progressive carve, unbounded base, prize snapshot per draw (B-2), founder fee leg, no consolation/drawer bps unless ratified. See C.5/C.6. |
| **REWRITE (from RouterV2)** | `PlankRakeDistributor` + `PlankEconomicRouterV2` → `PlankRakeRouter` | Take RouterV2's escrowed-pull, `accountedBalance`, `rulesHash` shape; add the ratified staircase input (`effectiveRakeBps` is computed by the crash, router just splits); wire as the crash's treasury via a typed `routeRake` call, not `receive()`. Delete both predecessors. |
| **DELETE** | `PlankCrashV2`, `PlankCrashVRF`, `PlankCrashEntropy`, `OwnershipBurner`, `PlankPowerboardV2`, `lib/PlankParimutuelMath`, `lib/PlankFenwickTree`, `MarketplankVault` (V1), and their tests/mocks (`VRFCoordinatorV2_5Mock`, `MockEntropy`, `PlankCcsSettlement` + `sim-settlement-ccs`) | Dead code is deploy surface and audit cost. Git history preserves them. |
| **DELETE** | `PlankProgression`, `IPlankProgression` | Its stated purpose (raise sybil cost against a per-wallet cap) is obsoleted by a partition-invariant rule; its mechanism is the one live privilege (B-5). |
| **DEFER / likely DELETE** | `PlankFuelBooster` | Not in the ratified economics; B-11. If kept, fuel funds the lottery prize only. |
| **OUT OF SCOPE (keep as is)** | `MarketplankVaultV3`, Across/DeBridge/ForeignFeeRouter | Separate value domain; sub-review findings §B-16+. |

### C.3 CCS-2L on-chain: library vs settlement contract, fixed point, gas, EIP-170
- **Library, internal, inlined** (current shape). The harness inlines to 2,841 bytes; the settle path
  is memory-only and `pure`. Keep it a library so the differential test targets exactly the bytecode
  the game uses (`PlankCrash` imports it; the harness re-exports it — one implementation).
- **Fixed-point conventions are frozen**: BPS = 10⁴, `MIN_TARGET_BPS` 10,100, `lnScaled` = Q96
  normalisation + 40-bit log₂ + `·693147 >> 40` (floor), bounds stake ≤ 1e30, target ≤ 1e9, pot ≤ 1e33
  (`PlankCcs2LMath` 12–21). The overflow arithmetic in the header (premium·w ≤ 2.1e70 < 2²⁵⁶) holds;
  keep the bounds as `require`s at bet time so `settle` can never revert on a live round (a revert in
  settlement = B-3 class halt). **Precision:** `lnScaled` floor error < 1e-6 relative; with W summed
  over ≤ 1e30·2.08e7 the player-layer floor division loses < survivorCount wei, all routed to
  `dustIndex`. **PROVEN** by the 209-point + 500-round differential, to be re-run against the new
  contract.
- **Gas envelope:** measured 73.9k (n=2) → 1.31M (n=100) for `settle` alone, ~13k/seat, linear (three
  loops + one `lnScaled` per seat, ≤ ~70 iterations each). A one-pass `settleRound` that also writes
  n payouts to the pull ledger adds ~22k SSTORE per seat ⇒ ~35k/seat ⇒ 100 seats ≈ 3.6M, 500 seats
  ≈ 18M. **Set a hard `MAX_SEATS` per round (e.g. 256) as a constructor immutable** so settlement can
  never exceed the chain's block gas; an Orbit chain's limit must be measured (canary runbook already
  captures receipt gas). Seats stored as a packed array `(address, uint96 stake, uint32 targetBps)` =
  1 slot each; the per-seat weight `s·lnScaled(m)` is recomputed at settle, not stored.
- **EIP-170:** 24,576 bytes (EIP-170, accessed 2026-09-04). `PlankCrashDrand` under viaIR already
  needs `viaIR` for stack depth; the rewrite *removes* code (manual cash-out, registration, progression,
  PullPayment inheritance, ~300 lines of comments-as-bytecode-free) and *adds* ~3 KB of CCS-2L. Budget:
  target ≤ 20 KB deployed; add a CI size assertion like the existing harness test (line 149).
- **Commitment binding:** `Round` carries `settlementRuleId` (`keccak256("ccs-2l")`), `ruleVersion`,
  `paramsHash` (`keccak256(abi.encode(RULE_ID, 1, floorBps, houseCapBps))` — identical to
  `settlement-rules.ts`) written in `_startRound`; `settleRound` requires an exact match against the
  immutables. This closes RATIFICATION §6.2.

### C.4 Seat commitment replaces cash-out
- `placeBet(targetBps)` with `targetBps ∈ [10_100, maxMultiplierBps]` **required** (no 0 = manual).
  Survival is `targetBps ≤ crashBps`. No `cashOut`, no `cashOutFor`, no `effectiveCashOutBlock`, no
  block-number time law on-chain at all — the crash is a pure function of the drand output
  (`_deriveCrash`), settlement is `PlankCcs2LMath.settle(D_players, seed, crashBps, seats,
  reserveAtLock, params)`. The **display law** (`multiplierBpsAtMs`, δ = 1000 ms lagged grant) is
  purely presentational off-chain; the on-chain contract never needs a clock for the flight. This
  removes B-1, B-4 and the parent-chain block-time ambiguity in one move. **JUDGMENT**, but it is the
  only way I-a can be a bytecode invariant rather than a sequencer assumption.
- Bank: `placeBetFor(player, targetBps)`; `cashOutFor` deleted.

### C.5 Round-only eligibility on-chain
- **Storage:** no ticket segments, no per-epoch arrays, no `claimTickets`. The round's seat array *is*
  the ticket list; weight = stake (or the ratified weight function, applied at draw). Total weight =
  `playerPool`, already tracked. This deletes the `_segments` growth, `ticketsClaimed` map, the
  claim-timing surface (B-14) and the parked-epoch option (B-2).
- **Draw:** every settled, qualified round is a draw. Ball = `keccak(resultSeed, "PLANK_BALL") %
  oddsOneIn` (16 per lib) — from the **same** committed drand round as the crash, so the draw is
  bound before bets like the crash is. Ticket = `keccak(resultSeed, "PLANK_TICKET") % playerPool`,
  owner found by a linear prefix scan over the seat array at settle (≤ `MAX_SEATS`, ~2.1k gas/seat) —
  cheaper than maintaining a Fenwick tree for a one-shot scan.
- **Prize state:** `base` (uint256, uncapped), `prize` (sealed net), `resetReserve`, `pendingFunding`,
  `rollover` — the lib's `LotteryState` fields verbatim so the differential test can compare the
  struct wei-for-wei. On hit: `winner = P·(1−x(P))`, `seed = P·x(P)`; `x(P)` supplied by the in-flight
  design as a pure function (a bps-valued piecewise-linear or monotone table in immutables/constants;
  the contract must only require **monotone non-decreasing** `P·(1−x)` and `P·x` in `P` — assert it
  in tests over the whole domain, C.8 L-5).
- **Unbounded base:** use `uint256`, no cap; every growth step is `max(+bps, +absolute)`; overflow is
  impossible at any conceivable ETH supply, but assert `base ≤ 2¹⁶⁰` anyway as a sanity invariant.
- **Payout:** pull ledger credit to the winner (no push), founder fee leg to the router.

### C.6 Where `mustHitByEpochs` belongs when every round is a draw
- The §10 promise ("can never roll forever") is currently on-chain only and absent from lib. Under
  per-round draws with a 1/16 ball, the expected wait is 16 rounds; a *forced* hit after K rounds is
  a bounded-variance guarantee, not a liveness fix. **Recommendation (JUDGMENT):** keep it, renamed
  `mustHitByRounds`, in the lottery contract, counted in **qualified settled rounds since last hit**,
  with the forced branch paying the same `P·(1−x(P))` carve as a natural hit (so the seed survives).
  It must be **mirrored into lib/** before any parity claim — right now the promise is unimplemented
  where players actually play. If the owner prefers a pure geometric draw, set it to 0 and delete the
  promise from `CASINO-ARCHITECTURE.md` §10; do not leave the two disagreeing.

### C.7 Ownerless posture — what MUST remain configurable and why
- **Immutable at construction (no setters):** beacon address, rake schedule (start/floor/step/volume
  step), 40/40/20, founder lottery fee, `floorBps`, `houseCapBps`, seed caps, drawdown/HWM bps, max
  multiplier, `MAX_SEATS`, `oddsOneIn`, `x(P)` table, `mustHitByRounds`, sink addresses, chainid
  pinned into `resultSeed`. No `Ownable`, no proxy, no `selfdestruct`.
- **Must remain permissionless (not configurable):** lock/reveal/settle/refund/withdraw/flush/burn
  triggers, `fundVault`/`fundLottery` donations.
- **The only justified levers, and their bound:** (1) `deliverOverflow`-style *retry* functions
  (state-restoring, permissionless); (2) an **outcome-independent** long-timeout refund (B-3),
  permissionless; (3) optionally a `designatedKeeper` floor — **recommend OFF**: its only value is
  liveness, and the bps bounty already pays for it; every enabled floor is a key-custody assumption.
  There is deliberately no pause: a pause is an outcome-selective void in disguise.
- **Upgrade path = redeploy + point the frontend.** Deployment must be a signed manifest with
  code-hash attestations of PLANK/WETH/pair/router/beacon (already in `deploy-casino.ts` 95–133; add
  `extcodehash` pins) and the CREATE-address prediction check (285–288) kept.

### C.8 Invariants the test suite must prove (assertions)
Crash / settlement (per round, every fuzz iteration):
- S-1 `Σ playerPayouts == playerDistributable` when any survivor exists; `== 0` and
  `bustedToReserve == playerDistributable + seed` otherwise.
- S-2 `Σ bonuses + houseReturned == seed` and `Σ bonuses ≤ min(seed, reserveAtLock·houseCapBps/BPS)`.
- S-3 `bonuses[i] ≤ stake_i·(m_i − BPS)/BPS` for all i (fair-odds cap).
- S-4 Partition invariance: for any seat split into k parts at the same or adjacent m,
  `Σ(payout+bonus)(split) ≤ (payout+bonus)(unsplit) + k wei`.
- S-5 `playerPayouts[i] ≥ floorBps·stake_i/BPS` for every survivor in mode 2.
- S-6 `reserve_after == reserve_before − seed + houseReturned + bustedToReserve + reserveCut +
  premiums` exactly; `reserve > 0` always; `reserve ≥ reserveFloorWei`.
- S-7 `Σ seeds drawn − Σ seeds returned ≤ bootstrap + Σ reserveCut` (income budget).
- S-8 `address(this).balance ≥ reserve + pendingOverflow + keeperSubsidy + Σ live pools +
  Σ owed(pull ledger)`; equality when no forced ETH (physical conservation).
- S-9 `settlementParamsHash(round) == paramsHash(immutables)` at settle; a round can never settle
  under a different rule than it committed.
- S-10 `targetDrandRound` is written before the first `placeBet` of the round and is unique across
  rounds; `revealNotBefore(target) > bettingEndsAt`.
- S-11 No path changes a seat after `placeBet` (no setter exists; `AlreadyBet` on re-entry).
- S-12 `settleRound` cannot revert for any seat set ≤ `MAX_SEATS` with in-bound stakes/targets
  (fuzz: random seats, random crash, assert success).
- S-13 Refund path: after timeout with no reveal, every seat can recover exactly `stake`; the seed
  returns exactly; if the signature is later submitted, reveal still wins the race only before any
  refund has been paid (mutual exclusion).
- S-14 Rake: `effectiveRakeBps(volume)` matches lib's `evolutionQuote` for 10⁴ random volumes;
  `burn + community + founders + keeper == grossRake` exactly.
Lottery:
- L-1 `Σ ticket weight == playerPool` of the winning round; winner ∈ that round's seats (round-only).
- L-2 On hit: `winnerPaid + seed == P` exactly; both non-decreasing in `P` over the whole domain
  (property test on `x(P)`).
- L-3 `base` never decreases; `prize` displayed == prize redeemable (`netPrize == gross − fee`).
- L-4 A draw pays only prize sealed **before** its round's randomness was committed (kills B-2).
- L-5 Forced hit after `mustHitByRounds` qualified rounds, never earlier, never skipped.
- L-6 `readyForDraw ⇒ resetReserve ≥ minimumLotteryGross(nextBase, fee)` (lib `simulation.ts:428–431`).
Router / burn:
- R-1 `accountedBalance() ≤ balance`; each claim reduces both by the same amount.
- R-2 `executeBurn` output ≥ `TWAP·(1−slip)`; burned == received; `to == engine`.
Randomness (sub-review):
- D-1 A signature verifies iff it is the drand evmnet signature for that round (negative tests:
  wrong round, wrong pubkey, infinity point, non-canonical encoding, subgroup-invalid point).
- D-2 A round cannot be submitted before its emission time; a submitted round is immutable.

### C.9 Differential-testing strategy (Solidity vs lib/, wei-exact)
- Extend `test/contracts/PlankCcs2LSettlement.test.ts` (500 random rounds, 209 `lnScaled` points)
  to drive the **real** `PlankCrash.settleRound` on a hardhat fork with `DrandBeaconMock`, and
  compare the pull-ledger credits per seat against `lib/casino/economics-ccs2l.ts settleCcs2L` and
  `simulation.ts simulateIteration` — same seats, same `crashBps`, same `reserveAtLock`, same policy.
  Assert per-seat equality and every S-*/L-* invariant. Deterministic seed; ≥ 10⁴ rounds in CI
  nightly, 500 per PR.
- Stateful sequence differential: replay N rounds through both (`SimPlankCrashRandomStateful` shape)
  including voids, all-bust, refunds, lottery hits/misses/forced, and compare the full state struct
  (`reserve`, `emissionBuffer`/`protectedPrincipal` mapping, `LotteryState`) after each round.
- Keep the JS engine (`sim-settlement-ccs2l/engine.mjs`) as the third leg; three-way agreement is the
  acceptance bar, as today.
- Add a *negative* differential: mutate one constant in a scratch copy of the Solidity and assert the
  test fails (mutation sanity), so a silent divergence cannot pass.

---

## PART D — RESIDUAL ASSUMPTIONS (explicit)
1. **drand League of Entropy honesty and liveness** for evmnet (`bls-bn254-unchained-on-g1`, 3 s):
   a threshold of members could bias/withhold; if the network is retired, B-3 applies. Mitigation
   is the timeout refund, not prevention.
2. **Sequencer behaviour on Robinhood Chain (Orbit):** timestamp within Arbitrum's stated bounds,
   `block.number` semantics, censorship/reordering of relay and settle transactions. After C.4 the
   contract needs the clock only for `bettingEndsAt` and `revealNotBefore` (both coarse), and never
   for the flight.
3. **Relayer liveness** (`relay-drand.ts`, keeper): permissionless, bounty-paid, but someone must run
   it; otherwise rounds wait (not lost, after B-3 fix).
4. **Deploy-time key custody and manifest correctness:** `DEPLOYER_PK`, correct pair/router/WETH,
   correct beacon address; the CREATE-nonce dance for the 3-way cycle.
5. **External DEX liquidity** in the canonical PLANK/WETH pair for both the TWAP and the burn.
6. **OpenZeppelin 4.x / solc 0.8.24 / viaIR correctness** (the repo already found one viaIR
   empty-try/catch anomaly, `PlankPowerboard` 334–351); pin exact versions in the manifest.
7. **Economic assumptions** carried from the ratification: `g(m)=ln m` is exact only for the 1/m
   law; any change to `_deriveCrash` re-opens CCS-2L.
8. **No independent audit has been performed** on any of this. Nothing here substitutes for one.

---

## PART E — Citations (accessed 2026-09-04)
- Solidity docs, *Security Considerations* — Reentrancy; Use the Checks-Effects-Interactions
  Pattern; Sending and Receiving Ether (withdrawal pattern).
  https://docs.soliditylang.org/en/latest/security-considerations.html (fetched via
  raw.githubusercontent.com/ethereum/solidity/develop/docs/security-considerations.rst).
- OpenZeppelin Contracts CHANGELOG 5.0.0 (removal of `PullPayment`, `Escrow`, `ConditionalEscrow`,
  `RefundEscrow`; `ReentrancyGuard` → utils) and 5.1.0 (`ReentrancyGuardTransient`).
  https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/CHANGELOG.md
- OpenZeppelin docs, *ReentrancyGuard / ReentrancyGuardTransient*.
  https://docs.openzeppelin.com/contracts/5.x/api/utils
- OpenZeppelin docs, *ERC-4626 — inflation attack and virtual offset*.
  https://docs.openzeppelin.com/contracts/5.x/erc4626
- EIP-170 *Contract code size limit* (24,576 bytes). https://eips.ethereum.org/EIPS/eip-170
- EIP-1153 *Transient storage opcodes* (reentrancy-lock use case; Cancun).
  https://eips.ethereum.org/EIPS/eip-1153
- Uniswap v2 docs, *Oracles* — manipulation cost linear in liquidity and window; end-of-block
  cumulative price. https://developers.uniswap.org/docs/protocols/v2/concepts/oracles
- ethereum.org, *MEV* — frontrunning, sandwich, MEV-Boost/private orderflow.
  https://ethereum.org/en/developers/docs/mev/
- Arbitrum docs, *Block numbers and time* — sequencer sets timestamps; bounds 24 h past / 1 h future;
  `block.number` ≈ parent-chain block; "unreliable in the shorter term (minutes)".
  https://docs.arbitrum.io/build-decentralized-apps/arbitrum-vs-ethereum/block-numbers-and-time
- Chainlink VRF v2.5 *Security considerations* — no re-request/cancel, stop accepting user inputs
  after requesting randomness. https://docs.chain.link/vrf/v2-5/security
- drand docs, *Cryptography* — chained vs unchained (`m = H(r)`), BLS groups.
  https://docs.drand.love/docs/cryptography/
- drand API, evmnet chain info — `schemeID bls-bn254-unchained-on-g1`, period 3, genesis 1727521075,
  hash `04f1e906…`. https://api.drand.sh/v2/chains/04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3/info
- In-repo primary evidence: `RATIFICATION-ccs2l-2026-09-02.md`,
  `DESIGN-PLANKCRASH-CCS2L-INTEGRATION-2026-08-31.md`, `EVIDENCE-MANIFEST-CCS2L-INTEGRATION-2026-08-31.txt`,
  `AUDIT-PLANK-BUY-BURN-MEV-2026-09-01.md`, `AUDIT-PLANKCRASH-MECHANISM-AND-SECURITY-2026-09-01.md`,
  `docs/AUDIT-plankcrash-2026-09-02.md`, `RESEARCH-vault-and-lottery-design-2026-09-04.md`.

Label key: **PROVEN** = executable proof/test exists in repo; **INDUSTRY-STANDARD** = primary-source
guidance above; **JUDGMENT** = this reviewer's recommendation, to be ratified.
