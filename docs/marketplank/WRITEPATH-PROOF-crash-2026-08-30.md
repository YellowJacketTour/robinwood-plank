# Crash family — write-path proof (§6.4) — LOCAL CHAIN

**This is a LOCAL chain proof, not a public-chain proof.** Every transaction below was
mined on an in-process Hardhat/EDR chain (chainId **31337**) created by
`scripts/crash-writepath-proof.ts` and discarded when the script exited. Nothing was
deployed to chain 4663 (Robinhood Chain), to any testnet, or to any other public network.
No environment private key was read. The transaction hashes are real signed-transaction
hashes on that ephemeral chain and are reproducible only by re-running the script.

- Generated: 2026-08-30T17:46:43.415Z
- Contracts: `contracts/PlankCrashDrand.sol`, `PlankBank.sol`, `PlankRakeDistributor.sol`,
  `PlankPowerboard.sol`, `PlankFuelBooster.sol`, `PlankBurnEngine.sol`, `PlankV2TwapOracle.sol`
  @ commit 5e93fab (branch `feat/cos-p3-crash-hardening`)
- Deploy sequence: the same one `scripts/deploy-casino.ts` performs (oracle → burn engine →
  nonce-predicted Powerboard → RakeDistributor → PlankCrashDrand → PlankBank → FuelBooster;
  PlankProgression is not wired by deploy-casino.ts and is not wired here). The real $PLANK,
  WETH, v2 pair and router do not exist on a private chain — the repo's test mocks stand in
  for them and are NOT under proof.
- Script: `scripts/crash-writepath-proof.ts` (`npx hardhat run scripts/crash-writepath-proof.ts`)
- Chain clock started at 1785209131 (2026-07-28T03:25:31.000Z) so each
  crash round's target drand round could land on a round with a real signature (see Randomness).

## Signers (Hardhat default test accounts — never used with real value)
| Role | Address |
|---|---|
| deployer | 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 |
| treasury | 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 |
| alice | 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC |
| bob | 0x90F79bf6EB2c4f870365E785982E1f101E93b906 |
| carol | 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 |
| dave | 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc |
| erin | 0x976EA74026E726554dB657fA54763abd0C3a0aa9 |
| frank | 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955 |
| gina | 0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f |
| relayer | 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720 |
| keeper | 0xBcd4042DE499D14e55001CcbB24a551F3b954096 |
| w1 | 0x71bE63f3384f5fb98995898A86B02Fb2426c5788 |
| w2 | 0xFABB0ac9d68B0B445fB7357272Ff202C5651694a |
| w3 | 0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec |
| w4 | 0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097 |

Distinct EOAs that signed mined transactions: 15.

## Deployed addresses (ephemeral)
| Contract | Address |
|---|---|
| DrandBeacon (REAL contract, real evmnet params) | 0x5FbDB2315678afecb367f032d93F642f64180aa3 |
| PlankV2TwapOracle | 0x5FC8d32690cc91D4c39d9d3abcBD16989F875707 |
| PlankBurnEngine | 0x0165878A594ca255338adfa4d48449f69242Eb8F |
| PlankPowerboard | 0xa513E6E4b8f2a923D98304ec87F64353C4D5C853 |
| PlankRakeDistributor | 0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6 |
| PlankCrashDrand | 0x8A791620dd6260079BF849Dc5567aDC3F2FdC318 |
| PlankBank | 0x610178dA211FEF7D417bC0e6FeD39F05609AD788 |
| PlankFuelBooster | 0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e |
| MockERC20Burnable ×2, MockV2Pair, MockV2Router (stand-ins, not under proof) | 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512, 0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0, 0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9, 0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9 |

## Randomness — REAL drand signatures, no mock, no test relay
The beacon is `contracts/DrandBeacon.sol` constructed with the real drand **evmnet**
parameters from `test/contracts/fixtures/drand-round.json` (chainHash `0x04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3`,
genesis 1727521075, period 3s, BN254 G2 group key, DST `BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_`).
Every settled round's `targetDrandRound` (asserted at lock) was one of these real rounds:
**19229507, 19229807, 19230107, 19230407, 19231007** — the committed fixture round plus later rounds whose published
signatures were fetched from api.drand.sh / api2.drand.sh (byte-identical) and embedded in
the script. The relayer EOA submitted each round's REAL BLS signature via `submitRound`,
which the contract verified with the BN254 pairing precompile before caching `keccak256(sig)`;
`revealEntropy` then derived the crash point from that value (asserted equal to the offline
derivation from the same signature). Because those signatures are public, the script chose
auto-cash-out targets knowing each crash point — a private-chain authoring convenience that
lets winners, losers, the payout cap and the daily circuit be reached deterministically.

## Constants used — PROPOSED (SPEC-CRASH-GO-LIVE-HARDENING.md §6 / deploy-casino.ts defaults), NOT RATIFIED
| Constant | Value |
|---|---|
| rakeBps | 450 (4.5%) |
| keeperRewardBps / keeperRevealBps / keeperLockBps (of rake) | 500 / 100 / 100 |
| seedMaxBps | 500 (bytecode ceiling 1000) |
| singlePayoutCapBps (of reserveAtLock) | 200 |
| dailyDrawdownBps / hwmDrawdownBps | 1500 / 5000 |
| **maxMultiplierBps** | **100000 (10x) — PLACEHOLDER, owner question #4; ⇒ maxMultiplierElapsedBlocks 578** |
| reserveCap (Stage-1) | 2.0 ETH |
| seedBootstrapBudgetWei | 0.2 ETH (= reserveCap/10, NEW-1) |
| seedNumerator/seedDenominator, reserveShareBps, reserveFloorWei | 1/8, 4000, 0 |
| betting / registration / maxAwait / maxElapsed | 30s / 50 blocks / 3000 / 1800 |
| minParticipants / minPoolSize / maxStakePerWalletBps | 2 / 0.005 ETH / 6000 |
| distributor burn / airdrop / treasury | 2000 / 4000 / 4000 bps of rake |
| Powerboard epoch / drawerReward / ballRange / jackpotBall / consolation / mustHit | 86400s / 200 / 26 / 8 / 500 / 30 |
| Vault funding used in this proof | 1.0 ETH (below the 2 ETH cap — see the daily-circuit note) |

Bytecode constants in play: CASHOUT_CLOSE_MARGIN_PERIODS 2 (revealNotBefore = emission − 6 s),
TARGET_ROUND_SAFETY_PERIODS 20, SEED_INCOME_MULTIPLE_BPS 10000, DRAWDOWN_WINDOW 24 h.

## Transactions
| # | Step | From | Tx hash | Gas | Block |
|---|---|---|---|---|---|
| 1 | deploy DrandBeacon (REAL contract, REAL evmnet params) — chainHash 0x04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3 | 0xf39Fd6e5… | 0xd54b766b8485a09fefa5ea07ee7b2e573e9467b7a284477d55cb7c84989eeb49 | 1132415 | 1 |
| 2 | deploy MockERC20Burnable ($PLANK stand-in) | 0xf39Fd6e5… | 0xf2c9bb3f909f5d40e8f3364fa8b69bae3f306d111c07dccf623799e727eaf72c | 261583 | 2 |
| 3 | deploy MockERC20Burnable (WETH stand-in) | 0xf39Fd6e5… | 0x80e53464b27c71f8125b6d1d4ee091a28c5115992f5c6cf823b352124f332708 | 261583 | 3 |
| 4 | deploy MockV2Pair (deep PLANK/WETH stand-in) | 0xf39Fd6e5… | 0x2d57ea12fce4817d2d95e8190fcbb973cc5d342efddc3c24acd22f87304110f5 | 235195 | 4 |
| 5 | deploy MockV2Router (stand-in) | 0xf39Fd6e5… | 0x334da866618384bd9b6a1741fdb52f04f2a2360b1f142c7ab5b26679d266dad1 | 256869 | 5 |
| 6 | deploy PlankV2TwapOracle | 0xf39Fd6e5… | 0x8d9563b2fff6868df3c3be4c1326a153aac0c3c353e2cf32d66805a44cd44b1d | 640923 | 6 |
| 7 | deploy PlankBurnEngine | 0xf39Fd6e5… | 0x2b0992f6f1ba4157e59e5dcf2f979c52fa1640048d605deec2617c1c7e9e1292 | 659289 | 7 |
| 8 | deploy PlankPowerboard (allowedSources=[predicted crash]) | 0xf39Fd6e5… | 0x59c28def08e1596bfd6ed92764286871eaa83345db87d65400b0e747c691b7d0 | 1691915 | 8 |
| 9 | deploy PlankRakeDistributor (burn 20% / airdrop 40% / treasury 40%) | 0xf39Fd6e5… | 0x356afd1d78644754fad94160fc60bd8e9acaac8ef1cdfba19f727d28591f1370 | 602553 | 9 |
| 10 | deploy PlankCrashDrand (PROPOSED constants; maxMultiplierBps PLACEHOLDER 100000) | 0xf39Fd6e5… | 0xcfbf359537d96680c8c94b8ba8f91bb80b9de31b9af7b3868f102d04d207bdee | 4159354 | 10 |
| 11 | deploy PlankBank([crash]) | 0xf39Fd6e5… | 0xeef077205d38474114601de7e7efeb183ed280fbb551b1cfb4e50352407b04b9 | 710744 | 11 |
| 12 | deploy PlankFuelBooster | 0xf39Fd6e5… | 0x0180f22ff222ddb10cabab2fe4d946753292cdebcae47458a4be7665349246e8 | 663276 | 12 |
| 13 | treasury.fundVault(1.0 ETH) | 0x70997970… | 0xb260786194c04473287f9b11f5c9629fd9334ae9c77b44f34973da52f76182d0 | 93761 | 13 |
| 14 | keeper.lockRound → round 1 voided (no bettors) | 0xBcd4042D… | 0x8da9b9c33d9d2484efd0516c9b926f62b7303b04a859c486391e5701bd9f60bc | 175804 | 15 |
| 15 | frank: placeBet(auto 0, 0.05 ETH) | 0x14dC7996… | 0x011ea11b60f53d72292a57745736b9b17e91bda4115f5c903eabce8aa55d1674 | 108594 | 16 |
| 16 | keeper.lockRound → round 2 voided (1 participant < minParticipants 2) → _rescueSeed — seed 0.05 ETH returned | 0xBcd4042D… | 0x17cfdc458b59d47b9732a611d0443c09342caa264795cbebcbcf0e530fb46e12 | 171356 | 18 |
| 17 | erin.bank.deposit(0.1 ETH) | 0x976EA740… | 0x61c33dee9e7ea75db97efe3bfaa9a228e5ef91b9ac6d9d48a79b0753876ce652 | 45506 | 19 |
| 18 | gina.bank.deposit(0.1 ETH) | 0x23618e81… | 0x494c6551953500b58eb856f38e964f94f43a604127bc0466f6a60c3a5fa8909c | 45506 | 20 |
| 19 | erin.crash.setPayoutRedirect(bank) | 0x976EA740… | 0x83924df83e144bd8e0cfb58d03d1cdd33ce123d5cb4fba71e7a35517cd0fb001 | 45063 | 21 |
| 20 | alice (auto at the crash block): placeBet(auto 12263, 0.2 ETH) | 0x3C44CdDd… | 0x2dc22881157f11b11ebc855dbdc7b1615a5ba624e5e0326706bb1e49edd0fe3d | 186074 | 22 |
| 21 | bob (manual): placeBet(auto 0, 0.15 ETH) | 0x90F79bf6… | 0x1f9aca8f0a12e90d86b066a772057ff652ad178371c45960e0835fee3e215475 | 71693 | 23 |
| 22 | carol (rides, loses): placeBet(auto 0, 0.1 ETH) | 0x15d34AAf… | 0xcde8ee6f0d2e50a4ca7077d35ddc5a31c1a1175313f3abc799037081c2665ea6 | 71693 | 24 |
| 23 | dave (auto above the crash, loses): placeBet(auto 16487, 0.1 ETH) | 0x9965507D… | 0xf391d3e0046ce7794ef2c0849c18d8ac1bf3bd45818f824341bbecdace4de1f8 | 114959 | 25 |
| 24 | erin (bank, auto at crash, redirect→bank): bank.bet(crash, 0.05 ETH, auto 12263) → placeBetFor | 0x976EA740… | 0x551f946a729f1ca7d1512507733240dc7c09def513da4e9999e60fedd4292211 | 161078 | 26 |
| 25 | gina (bank, manual via cashOutFor): bank.bet(crash, 0.05 ETH, auto 0) → placeBetFor | 0x23618e81… | 0xf0728ccf84dc12a7970b7aad4c5fdf22882043a2cd3ffad813f5701d56f575f9 | 117798 | 27 |
| 26 | frank.carryForwardStake(2) → round 3 | 0x14dC7996… | 0x4f6793404cc2deaffd3b8b638452b8c5d8c6e8e8dec5fb2622ccca98539d3de1 | 97103 | 28 |
| 27 | alice.placeBet again (AlreadyBet) — REVERTED AlreadyBet (expected) — negative control | 0x3C44CdDd… | (reverted, not mined) | — | — |
| 28 | w1.placeBet(auto 10000 = 1.00x) — REVERTED BadAutoTarget (expected) — negative control | 0x71bE63f3… | (reverted, not mined) | — | — |
| 29 | w1.placeBet(auto > maxMultiplierBps) — REVERTED BadAutoTarget (expected) — negative control | 0x71bE63f3… | (reverted, not mined) | — | — |
| 30 | keeper.lockRound (block ts pinned to 1785209531) — round 3 | 0xBcd4042D… | 0x800da873d49f7e0a51eabd4c9974f2c08a9153f1774faa941d109c5d4b641a9f | 180224 | 29 |
| 31 | bob (manual): cashOut(3) (manual, inside window) | 0x90F79bf6… | 0xa300110e26d5e17bf449f34c04df8937e25da7fa71225645ee0215126b08841b | 76153 | 30 |
| 32 | gina (bank, manual via cashOutFor): bank.cashOut(crash, 3) → cashOutFor | 0x23618e81… | 0x49e56ba917b8b8a0f8154743518d23f1fe58bbb9ca2c86d997e136b6215ee86a | 88714 | 31 |
| 33 | dave.cashOut(3) at revealNotBefore — REVERTED CashOutWindowClosed (expected) — negative control | 0x9965507D… | (reverted, not mined) | — | — |
| 34 | relayer.beacon.submitRound(19229507, REAL evmnet BLS sig) — verified by BN254 pairing precompile | 0xa0Ee7A14… | 0xaccb943c3e46a7651311412e44ca66306163f8231213c963d5362f50d1043b30 | 200205 | 32 |
| 35 | alice (auto at the crash block): cashOut(3) after relay (belt) — REVERTED CashOutWindowClosed (expected) — negative control | 0x3C44CdDd… | (reverted, not mined) | — | — |
| 36 | relayer.revealEntropy(3) — true crash 12251 bps @ 46 blocks | 0xa0Ee7A14… | 0x4f5b1c5124fd6a81cb7a634a791039cb998d38f25271fad9a2e4a8f0c476a7f1 | 86994 | 33 |
| 37 | deployer.settleRound(3) | 0xf39Fd6e5… | 0xafc947b7b1e42e4cc4f5bca8806e1283e49fde995f61b4f94deb6344b58de931 | 360547 | 76 |
| 38 | w1 (r4, auto at crash): placeBet(auto 23904, 0.05 ETH) | 0x71bE63f3… | 0x379ccd1eb811c5088d9f3927e178f55f87f5a7e77034795b10b39f51224c41e4 | 186102 | 77 |
| 39 | w2 (r4, auto at crash): placeBet(auto 23904, 0.05 ETH) | 0xFABB0ac9… | 0xb25cdb513f035f12ca480974d52bce3e496798cde086e447cd943b7443c04c99 | 115001 | 78 |
| 40 | w3 (r4, auto at crash): placeBet(auto 23904, 0.05 ETH) | 0x1CBd3b27… | 0x72bb51f133aae7047dae0157319f58b45dbf55488a4ba8337ee3569bd1a688fa | 115001 | 79 |
| 41 | w4 (r4, auto at crash): placeBet(auto 23904, 0.05 ETH) | 0xdF3e18d6… | 0x54065318386c9cb545c1e58270735ea1e7402c9bad4c4342c7f165954963f018 | 115001 | 80 |
| 42 | keeper.registerResult(3, alice (auto at the crash block)) — won | 0xBcd4042D… | 0x90f3994f8e87a8d97d2a610af9ca8e592343ed08c2a417feebfd4100d5c453a7 | 162662 | 81 |
| 43 | keeper.registerResult(3, bob (manual)) — won | 0xBcd4042D… | 0x4b3dd0ed26590dcf2f6539078946c801759b223d49f47b88d4d3036718a6304c | 120023 | 82 |
| 44 | keeper.registerResult(3, carol (rides, loses)) — lost | 0xBcd4042D… | 0xc4457d78880c33c3f1cc4b6957e4dd7b8ce5f1a6673b657b31d42387f2a5cd25 | 62664 | 83 |
| 45 | keeper.registerResult(3, dave (auto above the crash, loses)) — lost | 0xBcd4042D… | 0x57fa9d578cfa620e522f6bfce6ca105278c6826d460433f19da544b6b1520581 | 75418 | 84 |
| 46 | keeper.registerResult(3, erin (bank, auto at crash, redirect→bank)) — won | 0xBcd4042D… | 0x4869208595984cb033f5931700354e26384c380d539d4e92ddcfb4f063e91ca7 | 128474 | 85 |
| 47 | keeper.registerResult(3, gina (bank, manual via cashOutFor)) — won | 0xBcd4042D… | 0x89402d7a7346b399312d61db9ba17665497b19eb7ecc2fb661919b097cffbb93 | 120023 | 86 |
| 48 | keeper.registerResult(3, frank (carried, rides, loses)) — lost | 0xBcd4042D… | 0x9e2d3558953d05eb6503ca2fe409a0d55c9776d3293926ad1567369063d5783b | 62664 | 87 |
| 49 | keeper.claim(3, alice (auto at the crash block)) — payout 0.342018883908781953 ETH, CAPPED: excess 0.020305254016500217 ETH → Vault | 0xBcd4042D… | 0x21e03d76c88fbe06e3073d21408d7f3ab41a52d39d50d576f006d7ba280f9230 | 127558 | 139 |
| 50 | keeper.claim(3, bob (manual)) — payout 0.198868298811862634 ETH | 0xBcd4042D… | 0x2c10be77b8973161e0df1f569e9e14c69d8cbd87551d27dcb0941034f5f003af | 112582 | 140 |
| 51 | keeper.claim(3, erin (bank, auto at crash, redirect→bank)) — payout 0.090581034481320542 ETH | 0xBcd4042D… | 0xaabb297afdac672a79f7e46026e599cb6aacd40c0256f69a9d3196312e049a75 | 95982 | 141 |
| 52 | keeper.claim(3, gina (bank, manual via cashOutFor)) — payout 0.066726528781534651 ETH | 0xBcd4042D… | 0x9896f153a5bcbc0338c33f8beefece20fb945895511a403bdb74b468f250acca | 112582 | 142 |
| 53 | round 3 summary: distributable 0.7185 ETH, paid 0.69819474598349978 ETH, capped excess 0.020305254016500217 ETH → Vault | 0x8A791620… | (summary) | — | — |
| 54 | alice.powerboard.claimTickets(crash, 3, alice) | 0x3C44CdDd… | 0x5020bd40441abc06f5ce6f516161da91484e558404045233fd1e2536ac4e4c03 | 214067 | 143 |
| 55 | alice.withdrawPayments(alice) (pull) — 0.342018883908781953 ETH | 0x3C44CdDd… | 0x3b838fd285af6e40c8623d79d8ac69e5eafde8a64ba0d3b948add409bc6f0610 | 35713 | 144 |
| 56 | erin.bank.withdrawAll() — 0.140581034481320542 ETH (stake change + recycled win) | 0x976EA740… | 0x3dfba8e2925053a6e1cbe9a2cc3baf288432de7bdc736834b2a99a7d20ea7119 | 32659 | 145 |
| 57 | keeper.lockRound (block ts pinned to 1785210431) — round 4 | 0xBcd4042D… | 0x8073a46881306d8bb9c104b3e82cb8c6b5a2907d9c7260d32beac7169c5f179a | 180224 | 146 |
| 58 | relayer.beacon.submitRound(19229807, REAL evmnet BLS sig) — verified by BN254 pairing precompile | 0xa0Ee7A14… | 0xc0695a42100714fb92a22e534019830ae23ebaa34db8bf227634e20d9474f255 | 200032 | 147 |
| 59 | w1 (r4, auto at crash): cashOut(4) after relay (belt) — REVERTED CashOutWindowClosed (expected) — negative control | 0x71bE63f3… | (reverted, not mined) | — | — |
| 60 | relayer.revealEntropy(4) — true crash 23820 bps @ 182 blocks | 0xa0Ee7A14… | 0xfc53b3f59cdc8eb43dc258310c895e8b70a0aea84ef8289eee2ae6c524208d1f | 87022 | 148 |
| 61 | keeper.settleRound(4) | 0xBcd4042D… | 0xed3d23bdeeee775413df018c51180ddb826618949f12a8e87ec5ac2b8fadbf51 | 287347 | 329 |
| 62 | w1 (r5, auto at crash): placeBet(auto 77856, 0.05 ETH) | 0x71bE63f3… | 0x656d57b34d725380b33a4cc879f53fea53d64acd3d6dc362efe6cda57008400d | 186072 | 330 |
| 63 | w2 (r5, auto at crash): placeBet(auto 77856, 0.05 ETH) | 0xFABB0ac9… | 0x000970dc0c61e2ed333065ee9f5c8e99b1ea4cde487fc93f422dccd01a2de797 | 114971 | 331 |
| 64 | w3 (r5, auto at crash): placeBet(auto 77856, 0.05 ETH) | 0x1CBd3b27… | 0x9af637f6b80ec4e5e3f9214a62c5fcb891fd9d033b88028269f5c05c6b69b7cb | 114971 | 332 |
| 65 | w4 (r5, auto at crash): placeBet(auto 77856, 0.05 ETH) | 0xdF3e18d6… | 0x5bc1ed72ada6149b3cb39e1b9cfc38b47e796958dcf7b129e64036aa65b42f2e | 114971 | 333 |
| 66 | keeper.registerResult(4, w1 (r4, auto at crash)) — won | 0xBcd4042D… | 0xfbe9a0067d6fe2e403b218fdb0280f27a5f559babadf98c9831f9b9850fff5cb | 162702 | 334 |
| 67 | keeper.registerResult(4, w2 (r4, auto at crash)) — won | 0xBcd4042D… | 0xad069c53394ea1782fb8f67b3439df1e0849244618fe535a160740dc61f98220 | 128502 | 335 |
| 68 | keeper.registerResult(4, w3 (r4, auto at crash)) — won | 0xBcd4042D… | 0x979a50390e8dd423e0cf1328be86b6b971e19a101cd667b60e5ba4c053354624 | 128502 | 336 |
| 69 | keeper.registerResult(4, w4 (r4, auto at crash)) — won | 0xBcd4042D… | 0xa154216768dc05c673c1374f3f9d4603422be5296989300dade5f8462bf3d986 | 128502 | 337 |
| 70 | keeper.claim(4, w1 (r4, auto at crash)) — payout 0.059771475 ETH | 0xBcd4042D… | 0xb8c1a15c92dd85158778eede15705a9ac3d2869e5dd8a8615fcd55be6380ca05 | 112582 | 389 |
| 71 | keeper.claim(4, w2 (r4, auto at crash)) — payout 0.059771475 ETH | 0xBcd4042D… | 0xfe1a28be7f007fd0eac7c3ecac9fec9dccf2079f1c337b9ac3e5f25eb921ff14 | 112582 | 390 |
| 72 | keeper.claim(4, w3 (r4, auto at crash)) — payout 0.059771475 ETH | 0xBcd4042D… | 0x969a7eb44bd5b849206c5b07f1cc40f608b9d2fd824eb35cf06cdc260d485fad | 112582 | 391 |
| 73 | keeper.claim(4, w4 (r4, auto at crash)) — payout 0.059771475 ETH | 0xBcd4042D… | 0x4908a50bb94453ba94b45f6ad2886ce500a816356355b18836b15e1a86ddac28 | 112582 | 392 |
| 74 | round 4 summary: seed 0.0480859 ETH, distributable 0.2390859 ETH, paid 0.2390859 ETH, excess 0.0 ETH | 0x8A791620… | (summary) | — | — |
| 75 | keeper.lockRound (block ts pinned to 1785211331) — round 5 | 0xBcd4042D… | 0xf05d2b40c7faeb8edddbc1c8e783b8d1de5aeb14f7059569ab4e126636258f17 | 180224 | 393 |
| 76 | relayer.beacon.submitRound(19230107, REAL evmnet BLS sig) — verified by BN254 pairing precompile | 0xa0Ee7A14… | 0x7c6652b175ec9f6ed0f7279cb5918a67f67fcb2ae695965f189d430acd5cde0b | 204608 | 394 |
| 77 | w1 (r5, auto at crash): cashOut(5) after relay (belt) — REVERTED CashOutWindowClosed (expected) — negative control | 0x71bE63f3… | (reverted, not mined) | — | — |
| 78 | relayer.revealEntropy(5) — true crash 77760 bps @ 491 blocks | 0xa0Ee7A14… | 0x191e1b9af7ae536159c8fb48c0f2c70c9ee0b1836406dffcab62be682a4ffdde | 86980 | 395 |
| 79 | keeper.settleRound(5) | 0xBcd4042D… | 0x4163d174b95df423f9947b7fc74c467755994bc3f59bee1e073df53e6584b372 | 287347 | 885 |
| 80 | w1 (r6, auto at crash): placeBet(auto 15920, 0.05 ETH) | 0x71bE63f3… | 0xad4ee2db72dc86a045b8616ba4c52790c4372a60c14da396c5959c4143713a38 | 186046 | 886 |
| 81 | w2 (r6, auto at crash): placeBet(auto 15920, 0.05 ETH) | 0xFABB0ac9… | 0x7130cb7da147b1b4f67bfb636ee5b16300fb33e788335fdc0b6b554a216d0275 | 114945 | 887 |
| 82 | w3 (r6, auto at crash): placeBet(auto 15920, 0.05 ETH) | 0x1CBd3b27… | 0xee27906a83d1408e4b433f1994e8fce04156f74b61461fc6fbf87df9e33deac9 | 114945 | 888 |
| 83 | w4 (r6, auto at crash): placeBet(auto 15920, 0.05 ETH) | 0xdF3e18d6… | 0x140f4f5418d4f6a3a4e910af38704004972c573f96deb7fcab4753252ed930b9 | 114945 | 889 |
| 84 | keeper.registerResult(5, w1 (r5, auto at crash)) — won | 0xBcd4042D… | 0x6e7c6f8df8a9116505099754f766597ff9fc970bdab822acd7e3a11284e61153 | 162660 | 890 |
| 85 | keeper.registerResult(5, w2 (r5, auto at crash)) — won | 0xBcd4042D… | 0xce59a09542860c5f156258a866359f58107dcef9bc92bfb5d21e7b966e681bbe | 128460 | 891 |
| 86 | keeper.registerResult(5, w3 (r5, auto at crash)) — won | 0xBcd4042D… | 0x4958e4b4d9ffcb3d43bc1e694130d8abb1ff4be99894fbbe31f0bede20c72381 | 128460 | 892 |
| 87 | keeper.registerResult(5, w4 (r5, auto at crash)) — won | 0xBcd4042D… | 0xbc33d0b945b389d805c88aa68143e93cbeb7519ec3a4e1004aa7fd4b89c8fa2b | 128460 | 893 |
| 88 | keeper.claim(5, w1 (r5, auto at crash)) — payout 0.059466066925206252 ETH | 0xBcd4042D… | 0x85d16f5bca923e4f732c3be794b06d5eb341fec3687c22981e6923f6f262f7ac | 95482 | 945 |
| 89 | keeper.claim(5, w2 (r5, auto at crash)) — payout 0.059466066925206252 ETH | 0xBcd4042D… | 0x232075d0c84d1fa14ad74aea7717a21809f39a8647d6bbbbbc1a2b9ecc5c8f03 | 95482 | 946 |
| 90 | keeper.claim(5, w3 (r5, auto at crash)) — payout 0.059466066925206252 ETH | 0xBcd4042D… | 0x5469f6f1b896e732d624c0288d859b7b707c08803a14289e628e4a65fdaed0b3 | 95482 | 947 |
| 91 | keeper.claim(5, w4 (r5, auto at crash)) — payout 0.059466066925206252 ETH | 0xBcd4042D… | 0x625943107b013f01e8e99648cc53d9ed15f9d907dff5a039ac0bf739047f1ee0 | 95482 | 948 |
| 92 | round 5 summary: seed 0.04686426770082501 ETH, distributable 0.23786426770082501 ETH, paid 0.237864267700825008 ETH, excess 0.0 ETH | 0x8A791620… | (summary) | — | — |
| 93 | keeper.lockRound (block ts pinned to 1785212231) — round 6 | 0xBcd4042D… | 0x4c71610d9728a4ef408ea83c8a2d7871feb37c1871d62765975f03dd597d31be | 180224 | 949 |
| 94 | relayer.beacon.submitRound(19230407, REAL evmnet BLS sig) — verified by BN254 pairing precompile | 0xa0Ee7A14… | 0x27b6eeedc416f8795b7347adb9e8b8626332e1276a131535b53e6867519c57e8 | 195813 | 950 |
| 95 | w1 (r6, auto at crash): cashOut(6) after relay (belt) — REVERTED CashOutWindowClosed (expected) — negative control | 0x71bE63f3… | (reverted, not mined) | — | — |
| 96 | relayer.revealEntropy(6) — true crash 15847 bps @ 99 blocks | 0xa0Ee7A14… | 0xc8d13d167b5a10f07000867c1614fc184736465e037056d7774e8ffd18545670 | 86966 | 951 |
| 97 | keeper.settleRound(6) | 0xBcd4042D… | 0x5e1740de98bb401629c2d6b997bf4f5c79141dcb8bb37ef339cd52e48d2553a6 | 287347 | 1049 |
| 98 | w1 (r7, auto at crash): placeBet(auto 14993, 0.05 ETH) | 0x71bE63f3… | 0x784df3e258f295f2fb4b158e4426ec77be364504d9cd164e95bc95bb12fbfb9c | 186074 | 1050 |
| 99 | w2 (r7, auto at crash): placeBet(auto 14993, 0.05 ETH) | 0xFABB0ac9… | 0x93007e33400d5948ec776013dd69d769bad99dfa84fb15ef91dd9e2e10612c26 | 114973 | 1051 |
| 100 | w3 (r7, auto at crash): placeBet(auto 14993, 0.05 ETH) | 0x1CBd3b27… | 0x94ccc26ff20672fff1067e3f6f82a899ada36e8b16ba14ddfbc215b33ed81f06 | 114973 | 1052 |
| 101 | w4 (r7, auto at crash): placeBet(auto 14993, 0.05 ETH) | 0xdF3e18d6… | 0xf3056efe0cd6a5943478987811e15d6d87fb5b59e5ae837135abd59edb9564c6 | 114973 | 1053 |
| 102 | keeper.registerResult(6, w1 (r6, auto at crash)) — won | 0xBcd4042D… | 0x41fe485b8ee6a636ea8e7e7265ab0e8593bb885196434bacef0c3fd15304cf4d | 162646 | 1054 |
| 103 | keeper.registerResult(6, w2 (r6, auto at crash)) — won | 0xBcd4042D… | 0x3ec9bad93dff958e4ef2383a9c930161d55984a98bcef90fd665074b94b74d09 | 128446 | 1055 |
| 104 | keeper.registerResult(6, w3 (r6, auto at crash)) — won | 0xBcd4042D… | 0xe72faf460c10e6f80ca9184a33408c75637284eb1b055a9d8838821154188f0f | 128446 | 1056 |
| 105 | keeper.registerResult(6, w4 (r6, auto at crash)) — won | 0xBcd4042D… | 0xc0a53df34e1929ab8a6b2bfbdab0e8e01642858cfc8a28366825825e15f76f27 | 128446 | 1057 |
| 106 | keeper.claim(6, w1 (r6, auto at crash)) — payout 0.05892211357894594 ETH | 0xBcd4042D… | 0x65a934a963cdb1c00cdd2e31a99244a9051d17d6ade8baec9a2736ef31907f89 | 95482 | 1109 |
| 107 | keeper.claim(6, w2 (r6, auto at crash)) — payout 0.05892211357894594 ETH | 0xBcd4042D… | 0x3cff6b3ed212c503098a98a6641481fea97a5a831ff44bb23cd3fae278a429ff | 95482 | 1110 |
| 108 | keeper.claim(6, w3 (r6, auto at crash)) — payout 0.05892211357894594 ETH | 0xBcd4042D… | 0x0a4b9053d0ecff24371617906a6ed76a6939799962c75e872e0e498453a88c35 | 95482 | 1111 |
| 109 | keeper.claim(6, w4 (r6, auto at crash)) — payout 0.05892211357894594 ETH | 0xBcd4042D… | 0x243393d20d12d2924dee9be4e4bba98719d0ade29e9eb149ad3e19a328bd0811 | 95482 | 1112 |
| 110 | round 6 summary: seed 0.04468845431578376 ETH, distributable 0.23568845431578376 ETH, paid 0.23568845431578376 ETH, excess 0.0 ETH | 0x8A791620… | (summary) | — | — |
| 111 | keeper.lockRound (block ts pinned to 1785214031) — round 7 | 0xBcd4042D… | 0x1937fd214d032cf63e9b2b351295819bfd74b2aa0f09de707f7704118267d898 | 180224 | 1113 |
| 112 | relayer.beacon.submitRound(19231007, REAL evmnet BLS sig) — verified by BN254 pairing precompile | 0xa0Ee7A14… | 0x792fd04eba3270b5e6db95178a4ce570e548d5a81328a94596309036e4994399 | 200274 | 1114 |
| 113 | w1 (r7, auto at crash): cashOut(7) after relay (belt) — REVERTED CashOutWindowClosed (expected) — negative control | 0x71bE63f3… | (reverted, not mined) | — | — |
| 114 | relayer.revealEntropy(7) — true crash 14932 bps @ 87 blocks | 0xa0Ee7A14… | 0x38df0d34674212db89ef8579046b2f5ca6a967f9388e0ff38ef2c5b490566a96 | 86994 | 1115 |
| 115 | keeper.settleRound(7) | 0xBcd4042D… | 0x68eb25ff3bd6af40100195fb8fda6bf0a1132c50ddbc8167f92def7e2a010479 | 245967 | 1201 |
| 116 | keeper.registerResult(7, w1 (r7, auto at crash)) — won | 0xBcd4042D… | 0x2e26bbb5b04bab2983478f01d248b358b71a3e1a0d88236473f8730f97497813 | 162674 | 1202 |
| 117 | keeper.registerResult(7, w2 (r7, auto at crash)) — won | 0xBcd4042D… | 0x8b88c837963f633be219eedbe65d902cc92d02579ef52ae9db3f009229dd416c | 128474 | 1203 |
| 118 | keeper.registerResult(7, w3 (r7, auto at crash)) — won | 0xBcd4042D… | 0xe7fc07401ed3ffb394c19a5ac3dd9462f4d3dafa9bdbe017487bd4bdf9239868 | 128474 | 1204 |
| 119 | keeper.registerResult(7, w4 (r7, auto at crash)) — won | 0xBcd4042D… | 0xfe8a79f7d1e05a02c170900d62335a79df37d4e212bdba96d0b584b1195bb25c | 128474 | 1205 |
| 120 | keeper.claim(7, w1 (r7, auto at crash)) — payout 0.058405357899998643 ETH | 0xBcd4042D… | 0xbb0c7f7b2df03665fba84977906b27b1a8a8ac4d2e8a633ade4edb5dee946418 | 95482 | 1257 |
| 121 | keeper.claim(7, w2 (r7, auto at crash)) — payout 0.058405357899998643 ETH | 0xBcd4042D… | 0xd9878eab1460cd3bfd8e3f3f8c25314716d8d24992a5a9619c608d269d721587 | 95482 | 1258 |
| 122 | keeper.claim(7, w3 (r7, auto at crash)) — payout 0.058405357899998643 ETH | 0xBcd4042D… | 0x2b26bf1d23f29b6501c1c2c2fab31ada5e8417044d6ea8c76f80df6ec27d72d2 | 95482 | 1259 |
| 123 | keeper.claim(7, w4 (r7, auto at crash)) — payout 0.058405357899998643 ETH | 0xBcd4042D… | 0x0beef30bdc6f2410978ac268b649155aa43fc9f877a6254aff00b3f7f2acfa6a | 95482 | 1260 |
| 124 | round 7 summary: seed 0.042621431599994572 ETH, distributable 0.233621431599994572 ETH, paid 0.233621431599994572 ETH, excess 0.0 ETH | 0x8A791620… | (summary) | — | — |
| 125 | daily circuit TRIPPED at round 8 start: reserve 0.813155200399896875 ETH vs window peak 1.0 ETH (18.68% > 15%) | 0x8A791620… | (state) | — | — |
| 126 | keeper.lockRound → round 8 voided (empty) after +24h warp — seeding RESUMED: round 9 seeded 0.013155200399896875 ETH (income budget (NEW-1) binds) | 0xBcd4042D… | 0xdd96fe58a949827a6d0961b8bb466eeaf6eabffa90c073862d8bdaf8962ccad3 | 177634 | 1262 |
| 127 | keeper.claimRake() — 0.037665 ETH → escrow for the distributor | 0xBcd4042D… | 0x009953150d94100378c07db7502eba0d449d34e94fcbe259cf899503fca379e2 | 61188 | 1263 |
| 128 | keeper.withdrawPayments(distributor) → PlankRakeDistributor.receive — burn 0.007533 / airdrop 0.015066 / treasury 0.015066 ETH | 0xBcd4042D… | 0xc72869caa87133d5b1740a24614ce266484fcc50aff1e45daf9817a46e77b761 | 185244 | 1264 |
| 129 | keeper.withdrawPayments(keeper) (lock/reveal/settle bounties) — 0.002475 ETH | 0xBcd4042D… | 0x559e228b0ebded384e77a83510b36b51ba42f2cd1d2243e9ae742a054d88704d | 35713 | 1265 |
| 130 | relayer.withdrawPayments(relayer) (reveal bounties) — 0.000675 ETH | 0xa0Ee7A14… | 0x7445ef8cbd8fe46798d1fb36b1ce5312ecc415c624eeabbdaa00049389ed9d37 | 35725 | 1266 |

## Invariant checks (after EVERY mined transaction)
- **Reserve conservation**: `reserve == Σfunded − Σseeded + ΣreserveCut + Σreturned + Σswept − Σspilled`
  (all terms from the contract's own events / the pre-tx seed snapshot of a voided round).
- **Seed-income budget (NEW-1/NEW-5)**: `seedBudget == bootstrap + ΣreserveCut − Σseeded + Σreturned`
  (equality, hence the spec's ≤ bound), where Σreturned = rescued seeds of voided rounds + capped-payout excess.
- **Reserve ≥ floor** (floor 0) and **≤ cap** (live Powerboard sink).
- **Pool conservation / ETH identity**: `balance(crash) == reserve + accumulatedRake + Σ open pools
  + Σ (distributable − paid − excess) of crashed rounds + Σ uncarried stakes of voided rounds`;
  bounties and payouts leave through the PullPayment escrow only.
- Per step: `revealNotBefore == emission − 2 periods`, `targetDrandRound` == the real round,
  `trueCrashElapsedBlocks` == offline derivation, bounties escrowed to settler/revealer/locker,
  `reserveCut == 40% of net rake`, won/lost flags, payout + excess == uncapped share.
All passed.

## What was exercised
- ≥2 full rounds (5 settled): placeBet with auto targets > 10000 and manual play (auto 0); PlankBank
  `deposit → bet (placeBetFor) → cashOut (cashOutFor)`, `setPayoutRedirect(bank)` → win recycled via `creditFor`, `withdrawAll`.
- lockRound (revealNotBefore asserted), manual cashOut inside the window, cashOut at revealNotBefore
  → `CashOutWindowClosed`, cashOut after the relay (belt) → `CashOutWindowClosed`.
- Real signature relay → revealEntropy → settleRound (three bounties via pull) → registerResult (won and lost) → claim.
- Payout cap (`PayoutCapped`, excess back to the Vault) reached in round 3.
- Voided under-threshold round (round 2, one bettor) → `_rescueSeed`; `carryForwardStake` with the committed target.
- claimRake → `withdrawPayments(distributor)` → burn / airdrop (Powerboard `fund`) / treasury legs; Powerboard `claimTickets` from a real crash stake.
- Daily-loss circuit: TRIPPED (SeedHalted reason 1) after rounds 4, 5, 6, 7; +24 h warp decayed the window peak and seeding RESUMED (income budget/5% cap asserted).

### Note on the daily circuit at full Stage-1 funding
With the Vault funded to the full 2 ETH cap, the daily circuit CANNOT trip before rake income
exists: seeds are bounded by the 0.2 ETH bootstrap plus ΣreserveCut, so the Vault's net loss
is at most the bootstrap = 10% of the cap < the 15% daily threshold. This proof funds 1 ETH
(bootstrap = 20% of it) so the circuit is reachable; the bound itself is the NEW-1 identity
asserted after every transaction.

## Final state
- reserve: 0.8 ETH (HWM 1.0, window peak 0.85)
- seedBudget: 0.0 ETH
- currentRoundId: 9
- Powerboard jackpot: 0.015066 ETH (airdrop leg of the rake)

## Not covered here
voidStaleRound (reveal timeout), sweepBustedRound (all-lose round), whale-dominated void, the HWM
circuit, PlankBank session keys (betVia/cashOutVia), FuelBooster burnFuel (needs a primed TWAP),
Powerboard draws — all exercised in `test/contracts/*.test.ts`, not in this proof.

## Failures / skips
None.
