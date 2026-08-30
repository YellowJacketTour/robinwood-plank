/**
 * §6.4 WRITE-PATH PROOF for the crash family (PlankCrashDrand + PlankBank +
 * PlankRakeDistributor + PlankPowerboard + PlankFuelBooster, wired exactly the
 * way scripts/deploy-casino.ts wires them) — LOCAL CHAIN ONLY.
 *
 * Drives the stack end-to-end with REAL signed transactions from distinct EOAs
 * on an in-process Hardhat (EDR) chain, chainId 31337. It never touches a
 * public chain: no network name other than the in-process default is used, no
 * RPC URL is read, no private key is read from the environment. Nothing is
 * deployed to chain 4663 (Robinhood Chain) or to any testnet.
 *
 * Randomness: the SHARED `DrandBeacon` is the REAL contract, constructed with
 * the REAL drand evmnet (BN254) parameters from
 * test/contracts/fixtures/drand-round.json. Every settled round's target
 * drand round is relayed with that round's REAL published BLS signature
 * (fixture round 19229507 plus further rounds fetched from api.drand.sh and
 * api2.drand.sh, exact match on both — see REAL_ROUNDS) via `submitRound`,
 * verified on-chain by the BN254 pairing precompile. No mock beacon, no test
 * relay path. To make each crash round target a round we hold a signature
 * for, the chain clock is started before the first round's publish time
 * (`initialDate`) and each lock block is pinned into that round's window with
 * `setNextBlockTimestamp` — the same timestamp mechanics `hardhat node`
 * exposes, on a chain nobody else can see.
 *
 * Because the signatures are public data, the script also knows each round's
 * crash point ahead of time and uses it to choose auto-cash-out targets
 * (so winners, losers, the payout cap and the daily circuit are all reached
 * deterministically). That is a test-authoring convenience on a private
 * chain; on a real chain the target round is chosen at lock time, ~60 s
 * before its signature exists, which is exactly what hardening (a) proves.
 *
 * Constants are the spec's PROPOSED values (SPEC-CRASH-GO-LIVE-HARDENING.md
 * §6 / scripts/deploy-casino.ts defaults) — NOT ratified. The max-multiplier
 * cap is an OWNER decision (spec §6, open question 4) with no default; this
 * script uses a PLACEHOLDER of 100000 bps (10x) purely so the constructor
 * accepts a value. This script proves the write path; it ratifies nothing.
 *
 * Run:  npx hardhat run scripts/crash-writepath-proof.ts
 * Out:  docs/marketplank/WRITEPATH-PROOF-crash-<date>.md
 */
import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";

// ── Real drand evmnet fixture (public data, verified on-chain below) ─────────
const FIXTURE_PATH = path.resolve("test/contracts/fixtures/drand-round.json");
const fx = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
  publicKey: string[];
  domain: string;
  genesis: number;
  period: number;
  chainHash: string;
  round: number;
  signature: string[];
};

/**
 * REAL published evmnet signatures for later rounds. Fetched 2026-08-30 from
 * https://api.drand.sh/<chainHash>/public/<round> and api2.drand.sh (byte-
 * identical on both). The first entry is the committed fixture round and is
 * asserted equal to it at runtime. Each is verified by the pairing precompile
 * in DrandBeacon.submitRound before it can influence anything; a wrong
 * signature here would simply make the relay revert.
 */
const REAL_ROUNDS: { round: number; signature: [string, string] }[] = [
  { round: 19229507, signature: [fx.signature[0], fx.signature[1]] },
  { round: 19229807, signature: ["0x217c0e353fe3841a021fb0a91200fb13a63a3c57f49167181752523d1c0929d9", "0x2b53fe2e7e089e38014d877f8963fd8a3b937fa38bec6868a6f37972cf7cea5c"] },
  { round: 19230107, signature: ["0x1d58f7e2b35adccc1b2bd3b4b9009734f5fdd4250cf6a1398bf19e4e4382e35c", "0x0d1a67eac0290d3419f84fe3d855a184bcd11a158ccda4975227beb52af0f4b5"] },
  { round: 19230407, signature: ["0x1180884ce8513ea3c3dccd559524e73ccbd14783a56ac01de2a0252e5db6b35b", "0x1008e9035a2e9e55c1f3a8b12a417d8b662784b0d35ea7e2382621b2eb9cd350"] },
  { round: 19231007, signature: ["0x040ba095078b8021949ef9033e630cdecae29b8f75c6e0f7083ab53bea305855", "0x05235aa7e10913fc17394bb02c8be13782ec58a4a81f025b3991c5a7a317c14c"] },
  { round: 19231307, signature: ["0x006403d8e57b8bb20b26dbf7d0e53d38844df212e7204b794c7c40b5252dba59", "0x06138664e57d5c2baf63ad44da308b7e9f053606260e53c24812b9ed12f0a800"] },
  { round: 19231607, signature: ["0x2dcc9664fe90c3f88e6db1f4f5927aac00d4738392f815997c2f1bb3f47acff6", "0x008179156b231c18063f37ff3fa83cc51fd572a84510cf6c7c6deefc64e0ae0f"] },
  { round: 19231907, signature: ["0x04d3e544e7a8e3ce5651acaac16467d9d85b85f09798c157a8f90ae80aee7c00", "0x1cc604e12b322b9faa11e8a1f6b3007f0e3d23fcb5d8245d0cfc1d913b39eb51"] },
];
if (REAL_ROUNDS[0].round !== fx.round) throw new Error("first real round must be the committed fixture round");

const PERIOD = BigInt(fx.period);
const GENESIS = BigInt(fx.genesis);
const roundTime = (r: number) => GENESIS + BigInt(r - 1) * PERIOD; // drand TimeOfRound
// PlankCrashDrand.lockRound targets nextRoundAfter(ts) + TARGET_ROUND_SAFETY_PERIODS(20)
// = currentRoundAt(ts) + 21, so to target R we need currentRoundAt(lockTs) == R - 21,
// i.e. lockTs in [roundTime(R) - 21*period, roundTime(R) - 20*period). We pin
// lockTs = roundTime(R) - 62 (period 3: 63 > 62 >= 60).
const TARGET_SAFETY = 20n;
const lockTsFor = (r: number) => roundTime(r) - (TARGET_SAFETY + 1n) * PERIOD + 1n;
const INITIAL_TS = Number(lockTsFor(REAL_ROUNDS[0].round)) - 400;

// ── PROPOSED constants (scripts/deploy-casino.ts defaults, spec §6) — NOT RATIFIED ──
const P = {
  rakeBps: 450n,
  keeperRewardBps: 500n,
  keeperRevealBps: 100n,
  keeperLockBps: 100n,
  seedMaxBps: 500n,
  singlePayoutCapBps: 200n,
  dailyDrawdownBps: 1500n,
  hwmDrawdownBps: 5000n,
  // PLACEHOLDER — owner question #4 (spec §6: "OWNER MUST SUPPLY"). 10x.
  maxMultiplierBps: 100000n,
  burnBps: 2000n,
  airdropBps: 4000n,
  bettingSeconds: 30,
  roundIntervalSeconds: 0,
  maxAwaitBlocks: 3000,
  maxElapsedBlocks: 1800,
  registrationWindowBlocks: 50,
  minParticipants: 2n,
  minPoolWei: 5_000_000_000_000_000n, // 0.005 ETH
  maxStakeBps: 6000n,
  seedNumerator: 1n,
  seedDenominator: 8n,
  reserveShareBps: 4000n,
  reserveFloorWei: 0n,
  reserveCap: 2_000_000_000_000_000_000n, // Stage-1 2 ETH
  mustHitEpochs: 30n,
  epochSeconds: 86400n,
  drawerRewardBps: 200n,
  ballRange: 26n,
  jackpotBall: 8n,
  consolationBps: 500n,
  maxEthPerBurn: 250_000_000_000_000_000n,
  burnKeeperRewardBps: 0n,
  burnMaxSlippageBps: 300n,
  twapWindow: 1800n,
  twapMaxStale: 7200n,
  twapMinReserveWei: 1_000_000_000_000_000_000n,
  fuelMaxPerBurnWei: 100_000_000_000_000_000n,
  fuelMaxPerRoundWei: 500_000_000_000_000_000n,
};
const SEED_BOOTSTRAP = P.reserveCap / 10n; // NEW-1 PROPOSED: reserveCap/10 = 0.2 ETH
const VAULT_FUNDING = 1_000_000_000_000_000_000n; // 1 ETH (see the daily-circuit note in the report)

// ── Chain ───────────────────────────────────────────────────────────────────
const { ethers, networkHelpers, provider } = await hardhat.network.create({
  override: { initialDate: new Date(INITIAL_TS * 1000) },
});
const chainId = Number(await provider.request({ method: "eth_chainId" }));
if (chainId !== 31337) throw new Error(`refusing to run on chainId ${chainId}`);
const signers = await ethers.getSigners();
const [deployer, treasury, alice, bob, carol, dave, erin, frank, gina, relayer, keeper, w1, w2, w3, w4] = signers;
const ROLE: Record<string, string> = {
  [deployer.address]: "deployer", [treasury.address]: "treasury", [alice.address]: "alice", [bob.address]: "bob",
  [carol.address]: "carol", [dave.address]: "dave", [erin.address]: "erin", [frank.address]: "frank", [gina.address]: "gina",
  [relayer.address]: "relayer", [keeper.address]: "keeper", [w1.address]: "w1", [w2.address]: "w2", [w3.address]: "w3", [w4.address]: "w4",
};
const ALL = [deployer, treasury, alice, bob, carol, dave, erin, frank, gina, relayer, keeper, w1, w2, w3, w4];
const E = (v: bigint) => ethers.formatEther(v);
const bal = async (a: string) => BigInt((await provider.request({ method: "eth_getBalance", params: [a, "latest"] })) as string);

// ── Record ──────────────────────────────────────────────────────────────────
type Row = { step: string; from: string; txHash: string; gasUsed: bigint; blockNumber: number; note: string };
const rows: Row[] = [];
const skips: string[] = [];
function eq<T extends bigint | boolean | string | number>(a: T, b: T, what: string) {
  if (a !== b) throw new Error(`${what}: ${a} != ${b}`);
}
const mult = (e: bigint) => 10000n + e * 40n + (e * e) / 5n;

// ── Deploy: DrandBeacon (REAL) + local stand-ins for Uniswap infra ──────────
const Beacon = await ethers.getContractFactory("DrandBeacon", deployer);
const beacon: any = await Beacon.deploy(fx.chainHash, fx.publicKey.map((v) => BigInt(v)), GENESIS, PERIOD, ethers.toUtf8Bytes(fx.domain));
const beaconRc = await beacon.deploymentTransaction().wait();
rows.push({ step: "deploy DrandBeacon (REAL contract, REAL evmnet params)", from: beaconRc.from, txHash: beaconRc.hash, gasUsed: beaconRc.gasUsed, blockNumber: beaconRc.blockNumber, note: `chainHash ${fx.chainHash}` });

async function deployRec(step: string, factoryName: string, args: any[], note = ""): Promise<any> {
  const F = await ethers.getContractFactory(factoryName, deployer);
  const c: any = await F.deploy(...args);
  const rc = await c.deploymentTransaction().wait();
  rows.push({ step, from: rc.from, txHash: rc.hash, gasUsed: rc.gasUsed, blockNumber: rc.blockNumber, note });
  return c;
}
// The real $PLANK / WETH / v2 pair / router do not exist on a private chain;
// the test mocks stand in for them (they are NOT under proof here).
const plank: any = await deployRec("deploy MockERC20Burnable ($PLANK stand-in)", "MockERC20Burnable", []);
const weth: any = await deployRec("deploy MockERC20Burnable (WETH stand-in)", "MockERC20Burnable", []);
const pair: any = await deployRec("deploy MockV2Pair (deep PLANK/WETH stand-in)", "MockV2Pair", [await weth.getAddress(), await plank.getAddress(), ethers.parseEther("100"), ethers.parseEther("100000")]);
const router: any = await deployRec("deploy MockV2Router (stand-in)", "MockV2Router", [await plank.getAddress(), 1000n]);

// ── deploy-casino.ts sequence: oracle → burnEngine → [powerboard, distributor, crash] (nonce-predicted) → bank → fuelBooster ──
const oracle: any = await deployRec("deploy PlankV2TwapOracle", "PlankV2TwapOracle", [await pair.getAddress(), P.twapWindow, P.twapMaxStale, P.twapMinReserveWei]);
const burnEngine: any = await deployRec("deploy PlankBurnEngine", "PlankBurnEngine", [await plank.getAddress(), await router.getAddress(), await weth.getAddress(), await oracle.getAddress(), P.maxEthPerBurn, P.burnKeeperRewardBps, P.burnMaxSlippageBps]);
const nonce = await deployer.getNonce();
const predictedCrash = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 2 });
const powerboard: any = await deployRec("deploy PlankPowerboard (allowedSources=[predicted crash])", "PlankPowerboard", [{
  beacon: await beacon.getAddress(),
  allowedSources: [predictedCrash],
  genesisTimestamp: BigInt(INITIAL_TS),
  epochDuration: P.epochSeconds,
  drawerRewardBps: P.drawerRewardBps,
  ballRange: P.ballRange,
  jackpotBall: P.jackpotBall,
  consolationBps: P.consolationBps,
  mustHitByEpochs: P.mustHitEpochs,
}]);
const distributor: any = await deployRec("deploy PlankRakeDistributor (burn 20% / airdrop 40% / treasury 40%)", "PlankRakeDistributor", [await burnEngine.getAddress(), await powerboard.getAddress(), treasury.address, P.burnBps, P.airdropBps]);
const crashCfg = {
  bettingDurationSeconds: P.bettingSeconds,
  roundIntervalSeconds: P.roundIntervalSeconds,
  maxAwaitBlocks: P.maxAwaitBlocks,
  maxElapsedBlocks: P.maxElapsedBlocks,
  registrationWindowBlocks: P.registrationWindowBlocks,
  rakeBps: P.rakeBps,
  minParticipants: P.minParticipants,
  minPoolSize: P.minPoolWei,
  maxStakePerWalletBps: P.maxStakeBps,
  keeperRewardBps: P.keeperRewardBps,
  seedNumerator: P.seedNumerator,
  seedDenominator: P.seedDenominator,
  reserveShareBps: P.reserveShareBps,
  reserveFloorWei: P.reserveFloorWei,
  reserveCap: P.reserveCap,
  jackpotSink: await powerboard.getAddress(),
  treasury: await distributor.getAddress(),
  beacon: await beacon.getAddress(),
  keeperRevealBps: P.keeperRevealBps,
  keeperLockBps: P.keeperLockBps,
  seedMaxBps: P.seedMaxBps,
  singlePayoutCapBps: P.singlePayoutCapBps,
  dailyDrawdownBps: P.dailyDrawdownBps,
  hwmDrawdownBps: P.hwmDrawdownBps,
  maxMultiplierBps: P.maxMultiplierBps,
  seedBootstrapBudgetWei: SEED_BOOTSTRAP,
};
const crash: any = await deployRec("deploy PlankCrashDrand (PROPOSED constants; maxMultiplierBps PLACEHOLDER 100000)", "PlankCrashDrand", [crashCfg]);
const crashAddr: string = await crash.getAddress();
eq(crashAddr.toLowerCase(), predictedCrash.toLowerCase(), "crash address prediction");
const bank: any = await deployRec("deploy PlankBank([crash])", "PlankBank", [[crashAddr]]);
const bankAddr: string = await bank.getAddress();
const fuelBooster: any = await deployRec("deploy PlankFuelBooster", "PlankFuelBooster", [await plank.getAddress(), await oracle.getAddress(), crashAddr, P.fuelMaxPerBurnWei, P.fuelMaxPerRoundWei]);
// deploy-casino.ts does NOT deploy/wire PlankProgression (only local-casino-setup.ts does); mirrored here: progression stays address(0).
eq(await crash.progression(), ethers.ZeroAddress, "progression unwired (as deploy-casino.ts)");
eq(await crash.seedBudget(), SEED_BOOTSTRAP, "seedBudget == bootstrap at deploy (NEW-1 checklist)");
const MAX_E: bigint = await crash.maxMultiplierElapsedBlocks();
eq(await crash.maxMultiplierBps(), P.maxMultiplierBps, "maxMultiplierBps");

// ── Invariant trackers (from events + pre-tx snapshots) ─────────────────────
const T = { funded: 0n, seeded: 0n, cut: 0n, returned: 0n, spilled: 0n, sweptPlayerPart: 0n };
const seedOf = new Map<bigint, bigint>(); // roundId -> seed drawn at start
const paidOf = new Map<bigint, bigint>(); // roundId -> Σ payouts (claim)
const excessOf = new Map<bigint, bigint>(); // roundId -> Σ excess returned to Vault
const bettors = new Map<bigint, Set<string>>();
const carried = new Map<bigint, bigint>(); // voided roundId -> Σ stakes carried forward
const add = (m: Map<bigint, bigint>, k: bigint, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);
seedOf.set(1n, 0n);

function parseAll(rc: any, iface: any): any[] {
  return rc.logs.map((l: any) => { try { return iface.parseLog(l); } catch { return null; } }).filter(Boolean);
}

async function assertInvariants(step: string) {
  const reserve: bigint = await crash.reserve();
  const seedBudget: bigint = await crash.seedBudget();
  const accRake: bigint = await crash.accumulatedRake();
  // reserve conservation (every credit/debit path is an event or a tracked return)
  const expReserve = T.funded - T.seeded + T.cut + T.returned + T.sweptPlayerPart - T.spilled;
  eq(reserve, expReserve, `[${step}] reserve conservation`);
  // seed-income budget identity (NEW-1/NEW-5): seedBudget == bootstrap + Σcut − Σseeded + Σreturned (⇒ ≤ holds)
  const bound = SEED_BOOTSTRAP + T.cut - T.seeded + T.returned;
  eq(seedBudget, bound, `[${step}] seedBudget == bootstrap + Σcut − Σseeded + Σreturned`);
  if (seedBudget > bound) throw new Error(`[${step}] seedBudget above bound`);
  if (reserve < P.reserveFloorWei) throw new Error(`[${step}] reserve < floor`);
  if (reserve > P.reserveCap) throw new Error(`[${step}] reserve above cap with a live sink`);
  // pool conservation: contract ETH == reserve + accumulatedRake + open pools + unclaimed crashed pools + uncarried voided stakes
  const cur: bigint = await crash.currentRoundId();
  let pools = 0n;
  for (let id = 1n; id <= cur; id++) {
    const r = await crash.rounds(id);
    const phase = Number(r.phase);
    if (phase === 0 || phase === 1) pools += r.pool;
    else if (phase === 2) pools += r.distributable - (paidOf.get(id) ?? 0n) - (excessOf.get(id) ?? 0n);
    else if (await crash.voided(id)) pools += r.pool - (seedOf.get(id) ?? 0n) - (carried.get(id) ?? 0n);
  }
  eq(await bal(crashAddr), reserve + accRake + pools, `[${step}] ETH identity (balance == reserve + rake + pools)`);
}

async function tx(step: string, p: Promise<any>, note = ""): Promise<any> {
  const cur: bigint = await crash.currentRoundId();
  const curSeed: bigint = (await crash.rounds(cur)).rolledOverFromPrevious;
  const sent = await p;
  const rc = await sent.wait();
  for (const ev of parseAll(rc, crash.interface)) {
    switch (ev.name) {
      case "VaultFunded": T.funded += ev.args[1]; break;
      case "VaultSeeded": T.seeded += ev.args[1]; seedOf.set(ev.args[0], ev.args[1]); break;
      case "VaultGrew": T.cut += ev.args[1]; break;
      case "PayoutCapped": T.returned += ev.args[4]; add(excessOf, ev.args[0], ev.args[4]); break;
      case "Claimed": add(paidOf, ev.args[0], ev.args[2]); break;
      case "VaultOverflow": T.spilled += ev.args[0]; break;
      case "RoundVoided": if (ev.args[0] === cur) T.returned += curSeed; break;
      case "PoolRolledOver": { const s = seedOf.get(ev.args[0]) ?? 0n; T.returned += s; T.sweptPlayerPart += ev.args[1] - s; break; }
      case "RoundStarted": if (!seedOf.has(ev.args[0])) seedOf.set(ev.args[0], 0n); break;
    }
  }
  rows.push({ step, from: rc.from, txHash: rc.hash, gasUsed: rc.gasUsed, blockNumber: rc.blockNumber, note });
  await assertInvariants(step);
  return rc;
}
async function expectRevert(step: string, p: () => Promise<any>, err: string, from: string) {
  let hit = false;
  try { await p(); } catch (e: any) { hit = new RegExp(err).test(String(e?.message ?? e)); if (!hit) throw e; }
  if (!hit) throw new Error(`${step}: expected revert ${err}`);
  rows.push({ step: `${step} — REVERTED ${err} (expected)`, from, txHash: "(reverted, not mined)", gasUsed: 0n, blockNumber: 0, note: "negative control" });
}
await assertInvariants("post-deploy");

// ── Helpers ─────────────────────────────────────────────────────────────────
type Bet = { who: any; stake: bigint; auto: bigint; viaBank?: boolean; redirect?: boolean; manualAt?: number; label: string };
async function placeBets(rid: bigint, bets: Bet[]) {
  bettors.set(rid, new Set(bets.map((b) => b.who.address)));
  for (const b of bets) {
    if (b.viaBank) {
      await tx(`${b.label}: bank.bet(crash, ${E(b.stake)} ETH, auto ${b.auto}) → placeBetFor`, bank.connect(b.who).bet(crashAddr, b.stake, b.auto));
      eq(await crash.betFundedBy(rid, b.who.address), bankAddr, "betFundedBy == bank");
    } else {
      await tx(`${b.label}: placeBet(auto ${b.auto}, ${E(b.stake)} ETH)`, crash.connect(b.who).placeBet(b.auto, { value: b.stake }));
    }
    eq(await crash.stakeOf(rid, b.who.address), b.stake, "stakeOf");
    eq(await crash.autoCashOutBps(rid, b.who.address), b.auto, "autoCashOutBps committed");
  }
}
async function lockAt(rid: bigint, drand: number, who: any) {
  const ts = lockTsFor(drand);
  const now = BigInt(await networkHelpers.time.latest());
  if (now >= ts) throw new Error(`chain clock ${now} already past lock window ${ts} for drand round ${drand}`);
  const bettingEndsAt: bigint = (await crash.rounds(rid)).bettingEndsAt;
  if (ts < bettingEndsAt) throw new Error("lock window before bettingEndsAt");
  await networkHelpers.time.setNextBlockTimestamp(ts);
  const rc = await tx(`${ROLE[who.address]}.lockRound (block ts pinned to ${ts}) — round ${rid}`, crash.connect(who).lockRound());
  const r = await crash.rounds(rid);
  eq(r.targetDrandRound, BigInt(drand), "targetDrandRound == real round");
  const expectedRnb = roundTime(drand) - 2n * PERIOD; // CASHOUT_CLOSE_MARGIN_PERIODS = 2
  eq(r.revealNotBefore, expectedRnb, "revealNotBefore == emission − 2 periods");
  eq(r.reserveAtLock, await crash.reserve(), "reserveAtLock");
  eq(r.lockedBy, who.address, "lockedBy");
  return { rc, r };
}
async function crashPointOf(entry: { round: number; signature: [string, string] }): Promise<{ e: bigint; eff: bigint; multBps: bigint }> {
  const randomness = ethers.keccak256(ethers.solidityPacked(["uint256", "uint256"], entry.signature.map((v) => BigInt(v))));
  const [multBps, e] = await crash._deriveCrash(randomness);
  return { e, eff: e < MAX_E ? e : MAX_E, multBps };
}

/** Full LIVE→CRASHED→claims cycle for the current round using a REAL signature. */
async function playRound(rid: bigint, entry: { round: number; signature: [string, string] }, bets: Bet[], opts: { locker: any; revealer: any; settler: any; closedAttempt?: any; ticketsFor?: any }) {
  const cp = await crashPointOf(entry);
  const { r } = await lockAt(rid, entry.round, opts.locker);
  // manual cash-outs inside the window (chain time < revealNotBefore, round not yet relayed)
  for (const b of bets.filter((x) => x.manualAt !== undefined)) {
    const rc = b.viaBank
      ? await tx(`${b.label}: bank.cashOut(crash, ${rid}) → cashOutFor`, bank.connect(b.who).cashOut(crashAddr, rid))
      : await tx(`${b.label}: cashOut(${rid}) (manual, inside window)`, crash.connect(b.who).cashOut(rid));
    const blk = await ethers.provider.getBlock(rc.blockNumber);
    if (BigInt(blk!.timestamp) >= r.revealNotBefore) throw new Error("manual cash-out landed at/after revealNotBefore");
    eq(await crash.cashOutBlockOf(rid, b.who.address), BigInt(rc.blockNumber), "cashOutBlockOf");
    b.manualAt = rc.blockNumber - Number(r.lockBlock);
  }
  // window closes: at revealNotBefore any manual cash-out reverts, revealed or not
  await networkHelpers.time.setNextBlockTimestamp(r.revealNotBefore);
  if (opts.closedAttempt) {
    await expectRevert(`${ROLE[opts.closedAttempt.address]}.cashOut(${rid}) at revealNotBefore`, () => crash.connect(opts.closedAttempt).cashOut(rid), "CashOutWindowClosed", opts.closedAttempt.address);
  }
  // relay the REAL signature from a distinct EOA; beacon verifies via BN254 pairing precompile
  await tx(`relayer.beacon.submitRound(${entry.round}, REAL evmnet BLS sig)`, beacon.connect(relayer).submitRound(BigInt(entry.round), entry.signature.map((v) => BigInt(v))), "verified by BN254 pairing precompile");
  if (!(await beacon.isRoundAvailable(BigInt(entry.round)))) throw new Error("round not available after relay");
  // belt: even if the clock said open, a relayed round closes the window
  const nb = bets.find((x) => x.manualAt === undefined && !x.viaBank && x.who !== opts.closedAttempt);
  if (nb) await expectRevert(`${nb.label}: cashOut(${rid}) after relay (belt)`, () => crash.connect(nb.who).cashOut(rid), "CashOutWindowClosed", nb.who.address);
  await tx(`${ROLE[opts.revealer.address]}.revealEntropy(${rid})`, crash.connect(opts.revealer).revealEntropy(rid), `true crash ${cp.multBps} bps @ ${cp.e} blocks`);
  {
    const rr = await crash.rounds(rid);
    eq(rr.trueCrashElapsedBlocks, cp.e, "trueCrashElapsedBlocks == offline derivation");
    eq(rr.revealedBy, opts.revealer.address, "revealedBy");
  }
  // mine to the crash block, settle (bounties: settle → msg.sender, reveal → revealedBy, lock → lockedBy; all pull)
  const curBlock = BigInt(await ethers.provider.getBlockNumber());
  const target = r.lockBlock + cp.eff;
  if (target > curBlock) await networkHelpers.mine(Number(target - curBlock));
  const payBefore = { settler: await crash.payments(opts.settler.address), revealer: await crash.payments(opts.revealer.address), locker: await crash.payments(opts.locker.address) };
  const src = await crash.rounds(rid);
  const rc = await tx(`${ROLE[opts.settler.address]}.settleRound(${rid})`, crash.connect(opts.settler).settleRound(rid));
  const rr = await crash.rounds(rid);
  eq(Number(rr.phase), 2, "phase CRASHED");
  eq(rr.crashElapsedBlocks, cp.eff, "effective crash elapsed (capped)");
  const playerPool: bigint = BigInt(src.pool) - BigInt(src.rolledOverFromPrevious);
  const rake: bigint = playerPool - (playerPool * (10000n - P.rakeBps)) / 10000n;
  const bounty = (kind: bigint) => (rake * kind) / 10000n;
  const expectedPay = new Map<string, bigint>();
  const addPay = (a: string, v: bigint) => expectedPay.set(a, (expectedPay.get(a) ?? 0n) + v);
  addPay(opts.settler.address, bounty(P.keeperRewardBps));
  addPay(opts.revealer.address, bounty(P.keeperRevealBps));
  addPay(opts.locker.address, bounty(P.keeperLockBps));
  const before = new Map<string, bigint>([[opts.settler.address, payBefore.settler], [opts.revealer.address, payBefore.revealer], [opts.locker.address, payBefore.locker]]);
  for (const [a, v] of expectedPay) eq(await crash.payments(a), before.get(a)! + v, `bounties escrowed (pull) for ${ROLE[a]}`);
  const netRake = rake - bounty(P.keeperRewardBps) - bounty(P.keeperRevealBps) - bounty(P.keeperLockBps);
  const grew = parseAll(rc, crash.interface).find((e: any) => e.name === "VaultGrew");
  eq(grew ? grew.args[1] : 0n, (netRake * P.reserveShareBps) / 10000n, "reserveCut == 40% of net rake");
  const halted = parseAll(rc, crash.interface).find((e: any) => e.name === "SeedHalted");
  // register everyone (won or lost), then claims after the window
  const nextRid: bigint = await crash.currentRoundId();
  return { rc, halted, nextRid, cp, r: rr, register: async () => {
    const winners: Bet[] = [];
    for (const b of bets) {
      const eff = await crash.effectiveCashOutBlock(rid, b.who.address);
      const won = eff !== 0n && eff - r.lockBlock <= cp.eff;
      const rcr = await tx(`keeper.registerResult(${rid}, ${b.label})`, crash.connect(keeper).registerResult(rid, b.who.address), won ? "won" : "lost");
      const ev = parseAll(rcr, crash.interface).find((e: any) => e.name === "ResultRegistered");
      eq(ev.args[2], won, `won flag for ${b.label}`);
      if (won) winners.push(b);
    }
    return winners;
  }, claim: async (winners: Bet[]) => {
    await networkHelpers.mine(P.registrationWindowBlocks + 1);
    let paid = 0n, excess = 0n, capped = 0;
    for (const b of winners) {
      const before = b.redirect ? await bank.balanceOf(b.who.address) : await crash.payments(b.who.address);
      const rcc = await tx(`keeper.claim(${rid}, ${b.label})`, crash.connect(keeper).claim(rid, b.who.address));
      const evs = parseAll(rcc, crash.interface);
      const c = evs.find((e: any) => e.name === "Claimed");
      const pc = evs.find((e: any) => e.name === "PayoutCapped");
      paid += c.args[2];
      if (pc) { excess += pc.args[4]; capped++; eq(pc.args[2], pc.args[3] + pc.args[4], "PayoutCapped: uncapped == paid + excess"); }
      const after = b.redirect ? await bank.balanceOf(b.who.address) : await crash.payments(b.who.address);
      eq(after, before + c.args[2], b.redirect ? "win recycled into bank via creditFor" : "payout escrowed (pull)");
      rows[rows.length - 1].note = `payout ${E(c.args[2])} ETH${pc ? `, CAPPED: excess ${E(pc.args[4])} ETH → Vault` : ""}`;
    }
    const D: bigint = (await crash.rounds(rid)).distributable;
    // pool conservation of the seed: seed − Σ(seed paid) == Σexcess ⇒ paid + excess ≤ D, and the player pot is fully paid
    if (paid + excess > D) throw new Error("paid + excess > distributable");
    return { paid, excess, capped, D };
  } };
}

async function warpTo(ts: bigint) {
  const now = BigInt(await networkHelpers.time.latest());
  if (ts > now) await networkHelpers.time.increaseTo(ts);
}

// ── Round 1: empty → fund the Vault → lock voids it (under-threshold, seed 0) ──
eq(await crash.currentRoundId(), 1n, "round 1 open");
await tx(`treasury.fundVault(${E(VAULT_FUNDING)} ETH)`, crash.connect(treasury).fundVault({ value: VAULT_FUNDING }));
eq(await crash.reserve(), VAULT_FUNDING, "reserve funded");
eq(await crash.nextSeed(), (VAULT_FUNDING * P.seedMaxBps) / 10000n, "nextSeed == 5% (seedMaxBps binds over 1/8)");
await warpTo((await crash.rounds(1n)).bettingEndsAt);
{
  const rc = await tx("keeper.lockRound → round 1 voided (no bettors)", crash.connect(keeper).lockRound());
  eq(await crash.voided(1n), true, "round 1 voided");
  const seeded = parseAll(rc, crash.interface).find((e: any) => e.name === "VaultSeeded");
  eq(seeded.args[1], (VAULT_FUNDING * P.seedMaxBps) / 10000n, "round 2 seeded with 5% of the Vault");
}

// ── Round 2: seeded, ONE bettor → void under-threshold → _rescueSeed ─────────
const R2 = 2n;
eq(await crash.currentRoundId(), R2, "round 2 open");
const seed2: bigint = (await crash.rounds(R2)).rolledOverFromPrevious;
await placeBets(R2, [{ who: frank, stake: ethers.parseEther("0.05"), auto: 0n, label: "frank" }]);
await warpTo((await crash.rounds(R2)).bettingEndsAt);
{
  const reserveBefore: bigint = await crash.reserve();
  const budgetBefore: bigint = await crash.seedBudget();
  const rc = await tx("keeper.lockRound → round 2 voided (1 participant < minParticipants 2) → _rescueSeed", crash.connect(keeper).lockRound(), `seed ${E(seed2)} ETH returned`);
  eq(await crash.voided(R2), true, "round 2 voided");
  eq((await crash.rounds(R2)).rolledOverFromPrevious, 0n, "rescued seed zeroed on the voided round");
  const seeded = parseAll(rc, crash.interface).find((e: any) => e.name === "VaultSeeded");
  // rescue (+seed2) then round-3 draw (−seed3): reserve == before + seed2 − seed3; budget likewise
  eq(await crash.reserve(), reserveBefore + seed2 - seeded.args[1], "reserve after rescue + re-seed");
  eq(await crash.seedBudget(), budgetBefore + seed2 - seeded.args[1], "seedBudget after rescue + re-seed");
}
const R3 = 3n;
eq(await crash.currentRoundId(), R3, "round 3 open");

// ── Round 3: first FULL round (seeded) — mixed manual/auto, bank path, cap path, REAL sig #1 ──
const cp3 = await crashPointOf(REAL_ROUNDS[0]);
// deposits into the bank first (they don't touch the round)
await tx("erin.bank.deposit(0.1 ETH)", bank.connect(erin).deposit({ value: ethers.parseEther("0.1") }));
await tx("gina.bank.deposit(0.1 ETH)", bank.connect(gina).deposit({ value: ethers.parseEther("0.1") }));
await tx("erin.crash.setPayoutRedirect(bank)", crash.connect(erin).setPayoutRedirect(bankAddr));
const bets3: Bet[] = [
  { who: alice, stake: ethers.parseEther("0.2"), auto: mult(cp3.eff), label: "alice (auto at the crash block)" },
  { who: bob, stake: ethers.parseEther("0.15"), auto: 0n, manualAt: 0, label: "bob (manual)" },
  { who: carol, stake: ethers.parseEther("0.1"), auto: 0n, label: "carol (rides, loses)" },
  { who: dave, stake: ethers.parseEther("0.1"), auto: mult(cp3.eff + 60n), label: "dave (auto above the crash, loses)" },
  { who: erin, stake: ethers.parseEther("0.05"), auto: mult(cp3.eff), viaBank: true, redirect: true, label: "erin (bank, auto at crash, redirect→bank)" },
  { who: gina, stake: ethers.parseEther("0.05"), auto: 0n, viaBank: true, manualAt: 0, label: "gina (bank, manual via cashOutFor)" },
];
await placeBets(R3, bets3);
// frank's voided-round stake carries forward WITH its (0) auto target
add(carried, R2, ethers.parseEther("0.05")); // tracker first: the invariant runs inside tx()
await tx("frank.carryForwardStake(2) → round 3", crash.connect(frank).carryForwardStake(R2));
bettors.get(R3)!.add(frank.address);
bets3.push({ who: frank, stake: ethers.parseEther("0.05"), auto: 0n, label: "frank (carried, rides, loses)" });
eq(await crash.stakeOf(R3, frank.address), ethers.parseEther("0.05"), "carried stake");
await expectRevert("alice.placeBet again (AlreadyBet)", () => crash.connect(alice).placeBet(0n, { value: 1n }), "AlreadyBet", alice.address);
await expectRevert("w1.placeBet(auto 10000 = 1.00x)", () => crash.connect(w1).placeBet(10000n, { value: ethers.parseEther("0.01") }), "BadAutoTarget", w1.address);
await expectRevert("w1.placeBet(auto > maxMultiplierBps)", () => crash.connect(w1).placeBet(P.maxMultiplierBps + 1n, { value: ethers.parseEther("0.01") }), "BadAutoTarget", w1.address);

const play3 = await playRound(R3, REAL_ROUNDS[0], bets3, { locker: keeper, revealer: relayer, settler: deployer, closedAttempt: dave });
// bets for round 4 go in right after settle (betting is only 30 s), BEFORE round 3's registrations/claims
const R4 = play3.nextRid;
if (seedOf.get(R4)! === 0n) throw new Error("round 4 should be seeded");
const lossBets = (label: string, eff: bigint): Bet[] => [w1, w2, w3, w4].map((w) => ({ who: w, stake: ethers.parseEther("0.05"), auto: mult(eff), label: `${ROLE[w.address]} (${label}, auto at crash)` }));
await placeBets(R4, lossBets("r4", (await crashPointOf(REAL_ROUNDS[1])).eff));
const winners3 = await play3.register();
eq(winners3.map((b) => b.who.address).sort().join(), [alice, bob, erin, gina].map((s) => s.address).sort().join(), "round-3 winners == alice, bob, erin, gina");
const claims3 = await play3.claim(winners3);
if (claims3.capped === 0) throw new Error("payout cap path not reached in round 3");
rows.push({ step: `round 3 summary: distributable ${E(claims3.D)} ETH, paid ${E(claims3.paid)} ETH, capped excess ${E(claims3.excess)} ETH → Vault`, from: crashAddr, txHash: "(summary)", gasUsed: 0n, blockNumber: 0, note: "" });
// Powerboard: tickets for a real crash bet, read from crash.stakeOf (allowlisted source)
{
  const rc = await tx("alice.powerboard.claimTickets(crash, 3, alice)", powerboard.connect(alice).claimTickets(crashAddr, R3, alice.address));
  const ev = parseAll(rc, powerboard.interface).find((e: any) => e.name === "TicketsClaimed");
  eq(ev.args[4], ethers.parseEther("0.2"), "tickets == stake");
}
// winners pull their escrow; erin's win already sits in the bank
{
  const owed: bigint = await crash.payments(alice.address);
  const before = await bal(alice.address);
  const rc = await tx("alice.withdrawPayments(alice) (pull)", crash.connect(alice).withdrawPayments(alice.address), `${E(owed)} ETH`);
  eq(await bal(alice.address), before + owed - BigInt(rc.gasUsed) * BigInt(rc.gasPrice), "alice received escrow");
  const erinBank: bigint = await bank.balanceOf(erin.address);
  const eb = await bal(erin.address);
  const rc2 = await tx("erin.bank.withdrawAll()", bank.connect(erin).withdrawAll(), `${E(erinBank)} ETH (stake change + recycled win)`);
  eq(await bal(erin.address), eb + erinBank - BigInt(rc2.gasUsed) * BigInt(rc2.gasPrice), "erin withdrew bank balance");
}

// ── Rounds 4..: seeded rounds the house loses, until the DAILY circuit trips ──
// Bets for round `rid` (against REAL_ROUNDS[idx]) are already placed on loop entry.
let rid = R4;
let idx = 1;
let halted: any = null;
const lossRounds: bigint[] = [];
while (true) {
  const entry = REAL_ROUNDS[idx];
  const cp = await crashPointOf(entry);
  const bets = lossBets(`r${rid}`, cp.eff);
  const seedNow: bigint = (await crash.rounds(rid)).rolledOverFromPrevious;
  if (seedNow === 0n) throw new Error(`round ${rid} unexpectedly unseeded without SeedHalted`);
  lossRounds.push(rid);
  const play = await playRound(rid, entry, bets, { locker: keeper, revealer: relayer, settler: keeper });
  halted = play.halted;
  const nextRid = play.nextRid;
  idx++;
  // next round's bets first (30 s betting window), only if the house is still seeding and a real round is left
  const more = !halted && idx < REAL_ROUNDS.length;
  if (more) await placeBets(nextRid, lossBets(`r${nextRid}`, (await crashPointOf(REAL_ROUNDS[idx])).eff));
  const winners = await play.register();
  eq(winners.length, 4, `all four auto exits at the crash block win (round ${rid})`);
  const c = await play.claim(winners);
  rows.push({ step: `round ${rid} summary: seed ${E(seedNow)} ETH, distributable ${E(c.D)} ETH, paid ${E(c.paid)} ETH, excess ${E(c.excess)} ETH`, from: crashAddr, txHash: "(summary)", gasUsed: 0n, blockNumber: 0, note: "" });
  rid = nextRid;
  if (halted) break;
  if (!more) { skips.push(`daily circuit did not trip within the ${REAL_ROUNDS.length} fetched real rounds`); break; }
}
const HALT_RID = rid;
let dailyTripped = false;
if (halted) {
  dailyTripped = true;
  eq(Number(halted.args[1]), 1, "SeedHalted reason 1 == daily-loss circuit");
  eq(await crash.seedHaltReason(), 1n, "seedHaltReason() == 1");
  eq(await crash.nextSeed(), 0n, "nextSeed() == 0 while halted");
  eq((await crash.rounds(HALT_RID)).rolledOverFromPrevious, 0n, `round ${HALT_RID} started UNSEEDED`);
  const reserve: bigint = await crash.reserve();
  const peak: bigint = await crash.drawdownWindowPeak();
  if ((peak - reserve) * 10000n <= peak * P.dailyDrawdownBps) throw new Error("halt without a >15% window drawdown");
  rows.push({ step: `daily circuit TRIPPED at round ${HALT_RID} start: reserve ${E(reserve)} ETH vs window peak ${E(peak)} ETH (${Number(((peak - reserve) * 10000n) / peak) / 100}% > 15%)`, from: crashAddr, txHash: "(state)", gasUsed: 0n, blockNumber: 0, note: "" });
  // Time-warp one window (+24h): the peak decays by the allowed drawdown, seeding resumes.
  // (No real signature is used after the warp: the fetched rounds are minutes apart, not a day.)
  await networkHelpers.time.increase(86400 + 1);
  eq(await crash.seedHaltReason(), 0n, "seedHaltReason() == 0 after +24h (peak decayed by 15%)");
  const budget: bigint = await crash.seedBudget();
  const byBps = (reserve * P.seedMaxBps) / 10000n;
  const expectedNext = byBps < budget ? byBps : budget;
  eq(await crash.nextSeed(), expectedNext, "nextSeed() == min(5% of Vault, seedBudget) after the warp");
  // The halted round has no bettors: locking voids it (under-threshold) and the NEXT round is seeded again.
  const rc = await tx(`keeper.lockRound → round ${HALT_RID} voided (empty) after +24h warp`, crash.connect(keeper).lockRound());
  const seededAgain = parseAll(rc, crash.interface).find((e: any) => e.name === "VaultSeeded");
  if (!seededAgain) throw new Error("seeding did not resume after the window rolled");
  eq(seededAgain.args[1], expectedNext, "re-seed == min(5% of Vault, seedBudget)");
  rows[rows.length - 1].note = `seeding RESUMED: round ${seededAgain.args[0]} seeded ${E(seededAgain.args[1])} ETH (${byBps < budget ? "5% cap" : "income budget (NEW-1)"} binds)`;
}

// ── Rake: claimRake → pull to the distributor → burn/airdrop/treasury legs ──
{
  const acc: bigint = await crash.accumulatedRake();
  if (acc === 0n) throw new Error("no rake accumulated");
  await tx("keeper.claimRake()", crash.connect(keeper).claimRake(), `${E(acc)} ETH → escrow for the distributor`);
  eq(await crash.accumulatedRake(), 0n, "accumulatedRake cleared");
  eq(await crash.payments(await distributor.getAddress()), acc, "distributor owed == rake");
  const jackpotBefore: bigint = await powerboard.jackpot();
  const tBefore = await bal(treasury.address);
  const rc = await tx("keeper.withdrawPayments(distributor) → PlankRakeDistributor.receive", crash.connect(keeper).withdrawPayments(await distributor.getAddress()));
  const evs = parseAll(rc, distributor.interface);
  const dist = evs.find((e: any) => e.name === "RakeDistributed");
  eq(dist.args[0], acc, "RakeDistributed amount");
  const stuck = evs.filter((e: any) => e.name === "LegStuck").map((e: any) => `${e.args[0]}:${E(e.args[1])}`);
  eq(await powerboard.jackpot(), jackpotBefore + dist.args[2], "airdrop leg funded the Powerboard jackpot");
  eq(await bal(treasury.address), tBefore + dist.args[3], "treasury leg delivered");
  rows[rows.length - 1].note = `burn ${E(dist.args[1])} / airdrop ${E(dist.args[2])} / treasury ${E(dist.args[3])} ETH${stuck.length ? `; stuck legs: ${stuck.join(", ")}` : ""}`;
  if (stuck.length) skips.push(`distributor legs left for flush(): ${stuck.join(", ")}`);
}
// keeper bounties are pull-payments
{
  const owed: bigint = await crash.payments(keeper.address);
  if (owed === 0n) throw new Error("keeper has no bounties");
  await tx("keeper.withdrawPayments(keeper) (lock/reveal/settle bounties)", crash.connect(keeper).withdrawPayments(keeper.address), `${E(owed)} ETH`);
  eq(await crash.payments(keeper.address), 0n, "keeper escrow cleared");
  const owedR: bigint = await crash.payments(relayer.address);
  await tx("relayer.withdrawPayments(relayer) (reveal bounties)", crash.connect(relayer).withdrawPayments(relayer.address), `${E(owedR)} ETH`);
}
// Powerboard overflow sink is live: the Vault never exceeded its cap here (1 ETH funded of a 2 ETH cap), so no spill occurred.
eq(T.spilled, 0n, "no overflow spill (below cap)");

// ── Report ──────────────────────────────────────────────────────────────────
const final = {
  reserve: await crash.reserve(),
  seedBudget: await crash.seedBudget(),
  hwm: await crash.reserveHighWaterMark(),
  peak: await crash.drawdownWindowPeak(),
  currentRoundId: await crash.currentRoundId(),
  jackpot: await powerboard.jackpot(),
};
const date = new Date().toISOString().slice(0, 10);
const outPath = path.resolve(`docs/marketplank/WRITEPATH-PROOF-crash-${date}.md`);
const uniqueFrom = new Set(rows.filter((r) => r.blockNumber > 0).map((r) => r.from.toLowerCase()));
const relayed = REAL_ROUNDS.slice(0, idx).map((r) => r.round);
const md = `# Crash family — write-path proof (§6.4) — LOCAL CHAIN

**This is a LOCAL chain proof, not a public-chain proof.** Every transaction below was
mined on an in-process Hardhat/EDR chain (chainId **${chainId}**) created by
\`scripts/crash-writepath-proof.ts\` and discarded when the script exited. Nothing was
deployed to chain 4663 (Robinhood Chain), to any testnet, or to any other public network.
No environment private key was read. The transaction hashes are real signed-transaction
hashes on that ephemeral chain and are reproducible only by re-running the script.

- Generated: ${new Date().toISOString()}
- Contracts: \`contracts/PlankCrashDrand.sol\`, \`PlankBank.sol\`, \`PlankRakeDistributor.sol\`,
  \`PlankPowerboard.sol\`, \`PlankFuelBooster.sol\`, \`PlankBurnEngine.sol\`, \`PlankV2TwapOracle.sol\`
  @ commit 5e93fab (branch \`feat/cos-p3-crash-hardening\`)
- Deploy sequence: the same one \`scripts/deploy-casino.ts\` performs (oracle → burn engine →
  nonce-predicted Powerboard → RakeDistributor → PlankCrashDrand → PlankBank → FuelBooster;
  PlankProgression is not wired by deploy-casino.ts and is not wired here). The real $PLANK,
  WETH, v2 pair and router do not exist on a private chain — the repo's test mocks stand in
  for them and are NOT under proof.
- Script: \`scripts/crash-writepath-proof.ts\` (\`npx hardhat run scripts/crash-writepath-proof.ts\`)
- Chain clock started at ${INITIAL_TS} (${new Date(INITIAL_TS * 1000).toISOString()}) so each
  crash round's target drand round could land on a round with a real signature (see Randomness).

## Signers (Hardhat default test accounts — never used with real value)
| Role | Address |
|---|---|
${ALL.map((s) => `| ${ROLE[s.address]} | ${s.address} |`).join("\n")}

Distinct EOAs that signed mined transactions: ${uniqueFrom.size}.

## Deployed addresses (ephemeral)
| Contract | Address |
|---|---|
| DrandBeacon (REAL contract, real evmnet params) | ${await beacon.getAddress()} |
| PlankV2TwapOracle | ${await oracle.getAddress()} |
| PlankBurnEngine | ${await burnEngine.getAddress()} |
| PlankPowerboard | ${await powerboard.getAddress()} |
| PlankRakeDistributor | ${await distributor.getAddress()} |
| PlankCrashDrand | ${crashAddr} |
| PlankBank | ${bankAddr} |
| PlankFuelBooster | ${await fuelBooster.getAddress()} |
| MockERC20Burnable ×2, MockV2Pair, MockV2Router (stand-ins, not under proof) | ${await plank.getAddress()}, ${await weth.getAddress()}, ${await pair.getAddress()}, ${await router.getAddress()} |

## Randomness — REAL drand signatures, no mock, no test relay
The beacon is \`contracts/DrandBeacon.sol\` constructed with the real drand **evmnet**
parameters from \`test/contracts/fixtures/drand-round.json\` (chainHash \`${fx.chainHash}\`,
genesis ${fx.genesis}, period ${fx.period}s, BN254 G2 group key, DST \`${fx.domain}\`).
Every settled round's \`targetDrandRound\` (asserted at lock) was one of these real rounds:
**${relayed.join(", ")}** — the committed fixture round plus later rounds whose published
signatures were fetched from api.drand.sh / api2.drand.sh (byte-identical) and embedded in
the script. The relayer EOA submitted each round's REAL BLS signature via \`submitRound\`,
which the contract verified with the BN254 pairing precompile before caching \`keccak256(sig)\`;
\`revealEntropy\` then derived the crash point from that value (asserted equal to the offline
derivation from the same signature). Because those signatures are public, the script chose
auto-cash-out targets knowing each crash point — a private-chain authoring convenience that
lets winners, losers, the payout cap and the daily circuit be reached deterministically.

## Constants used — PROPOSED (SPEC-CRASH-GO-LIVE-HARDENING.md §6 / deploy-casino.ts defaults), NOT RATIFIED
| Constant | Value |
|---|---|
| rakeBps | ${P.rakeBps} (4.5%) |
| keeperRewardBps / keeperRevealBps / keeperLockBps (of rake) | ${P.keeperRewardBps} / ${P.keeperRevealBps} / ${P.keeperLockBps} |
| seedMaxBps | ${P.seedMaxBps} (bytecode ceiling 1000) |
| singlePayoutCapBps (of reserveAtLock) | ${P.singlePayoutCapBps} |
| dailyDrawdownBps / hwmDrawdownBps | ${P.dailyDrawdownBps} / ${P.hwmDrawdownBps} |
| **maxMultiplierBps** | **${P.maxMultiplierBps} (10x) — PLACEHOLDER, owner question #4; ⇒ maxMultiplierElapsedBlocks ${MAX_E}** |
| reserveCap (Stage-1) | ${E(P.reserveCap)} ETH |
| seedBootstrapBudgetWei | ${E(SEED_BOOTSTRAP)} ETH (= reserveCap/10, NEW-1) |
| seedNumerator/seedDenominator, reserveShareBps, reserveFloorWei | ${P.seedNumerator}/${P.seedDenominator}, ${P.reserveShareBps}, ${P.reserveFloorWei} |
| betting / registration / maxAwait / maxElapsed | ${P.bettingSeconds}s / ${P.registrationWindowBlocks} blocks / ${P.maxAwaitBlocks} / ${P.maxElapsedBlocks} |
| minParticipants / minPoolSize / maxStakePerWalletBps | ${P.minParticipants} / ${E(P.minPoolWei)} ETH / ${P.maxStakeBps} |
| distributor burn / airdrop / treasury | ${P.burnBps} / ${P.airdropBps} / ${10000n - P.burnBps - P.airdropBps} bps of rake |
| Powerboard epoch / drawerReward / ballRange / jackpotBall / consolation / mustHit | ${P.epochSeconds}s / ${P.drawerRewardBps} / ${P.ballRange} / ${P.jackpotBall} / ${P.consolationBps} / ${P.mustHitEpochs} |
| Vault funding used in this proof | ${E(VAULT_FUNDING)} ETH (below the 2 ETH cap — see the daily-circuit note) |

Bytecode constants in play: CASHOUT_CLOSE_MARGIN_PERIODS 2 (revealNotBefore = emission − 6 s),
TARGET_ROUND_SAFETY_PERIODS 20, SEED_INCOME_MULTIPLE_BPS 10000, DRAWDOWN_WINDOW 24 h.

## Transactions
| # | Step | From | Tx hash | Gas | Block |
|---|---|---|---|---|---|
${rows.map((r, i) => `| ${i + 1} | ${r.step}${r.note ? ` — ${r.note}` : ""} | ${r.from.slice(0, 10)}… | ${r.txHash} | ${r.gasUsed || "—"} | ${r.blockNumber || "—"} |`).join("\n")}

## Invariant checks (after EVERY mined transaction)
- **Reserve conservation**: \`reserve == Σfunded − Σseeded + ΣreserveCut + Σreturned + Σswept − Σspilled\`
  (all terms from the contract's own events / the pre-tx seed snapshot of a voided round).
- **Seed-income budget (NEW-1/NEW-5)**: \`seedBudget == bootstrap + ΣreserveCut − Σseeded + Σreturned\`
  (equality, hence the spec's ≤ bound), where Σreturned = rescued seeds of voided rounds + capped-payout excess.
- **Reserve ≥ floor** (floor ${P.reserveFloorWei}) and **≤ cap** (live Powerboard sink).
- **Pool conservation / ETH identity**: \`balance(crash) == reserve + accumulatedRake + Σ open pools
  + Σ (distributable − paid − excess) of crashed rounds + Σ uncarried stakes of voided rounds\`;
  bounties and payouts leave through the PullPayment escrow only.
- Per step: \`revealNotBefore == emission − 2 periods\`, \`targetDrandRound\` == the real round,
  \`trueCrashElapsedBlocks\` == offline derivation, bounties escrowed to settler/revealer/locker,
  \`reserveCut == 40% of net rake\`, won/lost flags, payout + excess == uncapped share.
All passed.

## What was exercised
- ≥2 full rounds (${lossRounds.length + 1} settled): placeBet with auto targets > 10000 and manual play (auto 0); PlankBank
  \`deposit → bet (placeBetFor) → cashOut (cashOutFor)\`, \`setPayoutRedirect(bank)\` → win recycled via \`creditFor\`, \`withdrawAll\`.
- lockRound (revealNotBefore asserted), manual cashOut inside the window, cashOut at revealNotBefore
  → \`CashOutWindowClosed\`, cashOut after the relay (belt) → \`CashOutWindowClosed\`.
- Real signature relay → revealEntropy → settleRound (three bounties via pull) → registerResult (won and lost) → claim.
- Payout cap (\`PayoutCapped\`, excess back to the Vault) reached in round 3.
- Voided under-threshold round (round 2, one bettor) → \`_rescueSeed\`; \`carryForwardStake\` with the committed target.
- claimRake → \`withdrawPayments(distributor)\` → burn / airdrop (Powerboard \`fund\`) / treasury legs; Powerboard \`claimTickets\` from a real crash stake.
- Daily-loss circuit: ${dailyTripped ? `TRIPPED (SeedHalted reason 1) after rounds ${lossRounds.join(", ")}; +24 h warp decayed the window peak and seeding RESUMED (income budget/5% cap asserted).` : "NOT reached (see Failures/skips)."}

### Note on the daily circuit at full Stage-1 funding
With the Vault funded to the full 2 ETH cap, the daily circuit CANNOT trip before rake income
exists: seeds are bounded by the 0.2 ETH bootstrap plus ΣreserveCut, so the Vault's net loss
is at most the bootstrap = 10% of the cap < the 15% daily threshold. This proof funds 1 ETH
(bootstrap = 20% of it) so the circuit is reachable; the bound itself is the NEW-1 identity
asserted after every transaction.

## Final state
- reserve: ${E(final.reserve)} ETH (HWM ${E(final.hwm)}, window peak ${E(final.peak)})
- seedBudget: ${E(final.seedBudget)} ETH
- currentRoundId: ${final.currentRoundId}
- Powerboard jackpot: ${E(final.jackpot)} ETH (airdrop leg of the rake)

## Not covered here
voidStaleRound (reveal timeout), sweepBustedRound (all-lose round), whale-dominated void, the HWM
circuit, PlankBank session keys (betVia/cashOutVia), FuelBooster burnFuel (needs a primed TWAP),
Powerboard draws — all exercised in \`test/contracts/*.test.ts\`, not in this proof.
${skips.length ? `\n## Failures / skips\n${skips.map((f) => `- ${f}`).join("\n")}\n` : "\n## Failures / skips\nNone.\n"}`;
fs.writeFileSync(outPath, md);
console.log(md);
console.log(`\nwritten: ${outPath}`);
