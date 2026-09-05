import { AbiCoder, keccak256, toBeHex } from "ethers";
import { ethers, networkHelpers } from "./hardhat.js";

/**
 * Shared fixture for the CCS-2L casino stack: DrandBeaconMock + mock
 * PLANK/WETH/pair/router (the only external pieces) and the REAL
 * PlankV2TwapOracle, PlankBurnEngine, PlankLottery, PlankRakeRouter,
 * PlankCrash and PlankBank, wired exactly as scripts/deploy-casino.ts wires
 * them (lottery[nonce] -> router[nonce+1] -> crash[nonce+2]).
 */
export const DRAND_PERIOD = 3n;
export const DRAND_GENESIS = 1727521075n;
export const CREDIT = 10n ** 12n; // 1 credit = 1e-6 ETH
export const BPS = 10_000n;
export const RESULT_DOMAIN = keccak256(Buffer.from("PLANKCRASH_RESULT_V2"));
export const TICKET_DOMAIN = keccak256(Buffer.from("PLANK_TICKET_V1"));
export const BALL_DOMAIN = keccak256(Buffer.from("PLANK_BALL_V1"));
const abi = AbiCoder.defaultAbiCoder();

export type CrashConfig = {
  beacon: string; router: string; lottery: string; bank: string;
  bettingDurationSeconds: bigint; roundIntervalSeconds: bigint;
  rakeBps: bigint; rakeFloorBps: bigint; rakeStepBps: bigint; rakeVolumeStepWei: bigint;
  keeperRewardBps: bigint; minParticipants: bigint; minPoolWei: bigint; minStakeWei: bigint;
  maxStakePerWalletBps: bigint; maxTargetBps: bigint; maxSeats: bigint; crashSeedWei: bigint;
  emissionBufferCapWei: bigint; protectedPrincipalBps: bigint; floorBps: bigint; houseCapBps: bigint;
  seedBootstrapBudgetWei: bigint; refundTimeoutSeconds: bigint;
};
export type LotteryConfig = {
  source: string; founderSink: string; founderFeeBps: bigint; oddsOneIn: bigint; mustHitByRounds: bigint;
  carveMinBps: bigint; carveMaxBps: bigint; carveHalfSaturationWei: bigint;
};

export const DEFAULT_CRASH: Omit<CrashConfig, "beacon" | "router" | "lottery" | "bank"> = {
  bettingDurationSeconds: 120n,
  roundIntervalSeconds: 0n,
  rakeBps: 450n,
  rakeFloorBps: 250n,
  rakeStepBps: 25n,
  rakeVolumeStepWei: 25_000_000n * CREDIT,
  keeperRewardBps: 0n,
  minParticipants: 2n,
  minPoolWei: ethers.parseEther("0.005"),
  minStakeWei: 500n * CREDIT,
  maxStakePerWalletBps: 6000n,
  maxTargetBps: 100_000_000n,
  maxSeats: 128n,
  crashSeedWei: 10_000n * CREDIT,
  emissionBufferCapWei: 1_000_000n * CREDIT,
  protectedPrincipalBps: 5000n,
  floorBps: 7500n,
  houseCapBps: 1000n,
  seedBootstrapBudgetWei: 200_000n * CREDIT,
  refundTimeoutSeconds: 86400n,
};
export const DEFAULT_LOTTERY: Omit<LotteryConfig, "source" | "founderSink"> = {
  founderFeeBps: 1000n,
  oddsOneIn: 16n,
  mustHitByRounds: 96n,
  carveMinBps: 1000n,
  carveMaxBps: 3000n,
  carveHalfSaturationWei: 250_000n * CREDIT,
};

export interface CasinoEnv {
  beacon: any; plank: any; weth: any; pair: any; oracle: any; v2Router: any; burnEngine: any;
  lottery: any; rakeRouter: any; crash: any; bank: any;
  deployer: any; treasury: any; alice: any; bob: any; carol: any; dave: any; keeper: any; signers: any[];
  crashAddr: string; chainId: bigint;
  crashConfig: CrashConfig; lotteryConfig: LotteryConfig;
}

export async function deployCasino(opts: {
  crash?: Partial<CrashConfig>;
  lottery?: Partial<LotteryConfig>;
  communityLotteryBps?: bigint;
} = {}): Promise<CasinoEnv> {
  const signers = await ethers.getSigners();
  const [deployer, treasury, alice, bob, carol, dave, keeper] = signers;
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
  const plank: any = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
  const weth: any = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
  const pair: any = await (
    await ethers.getContractFactory("MockV2Pair")
  ).deploy(await weth.getAddress(), await plank.getAddress(), ethers.parseEther("100"), ethers.parseEther("100000"));
  const oracle: any = await (await ethers.getContractFactory("PlankV2TwapOracle")).deploy(await pair.getAddress(), 60n, 240n, 1n);
  const v2Router: any = await (await ethers.getContractFactory("MockV2Router")).deploy(await plank.getAddress(), 1000n);
  const burnEngine: any = await (
    await ethers.getContractFactory("PlankBurnEngine")
  ).deploy(await plank.getAddress(), await v2Router.getAddress(), await weth.getAddress(), await oracle.getAddress(), ethers.parseEther("100"), 100n, 500n);

  const nonce = await deployer.getNonce();
  const predictedCrash = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 2 });
  const predictedBank = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 3 });

  const lotteryConfig: LotteryConfig = { source: predictedCrash, founderSink: treasury.address, ...DEFAULT_LOTTERY, ...(opts.lottery ?? {}) };
  const lottery: any = await (await ethers.getContractFactory("PlankLottery")).deploy(lotteryConfig);
  const rakeRouter: any = await (
    await ethers.getContractFactory("PlankRakeRouter")
  ).deploy(predictedCrash, await burnEngine.getAddress(), await lottery.getAddress(), predictedCrash, treasury.address, opts.communityLotteryBps ?? 6500n);
  const crashConfig: CrashConfig = {
    beacon: await beacon.getAddress(),
    router: await rakeRouter.getAddress(),
    lottery: await lottery.getAddress(),
    bank: predictedBank,
    ...DEFAULT_CRASH,
    ...(opts.crash ?? {}),
  };
  const crash: any = await (await ethers.getContractFactory("PlankCrash")).deploy(crashConfig);
  const crashAddr = await crash.getAddress();
  if (crashAddr.toLowerCase() !== predictedCrash.toLowerCase()) throw new Error("crash address prediction failed");
  const bank: any = await (await ethers.getContractFactory("PlankBank")).deploy([crashAddr]);
  if ((await bank.getAddress()).toLowerCase() !== predictedBank.toLowerCase()) throw new Error("bank address prediction failed");

  return {
    beacon, plank, weth, pair, oracle, v2Router, burnEngine, lottery, rakeRouter, crash, bank,
    deployer, treasury, alice, bob, carol, dave, keeper, signers, crashAddr, chainId, crashConfig, lotteryConfig,
  };
}

// ── Pure mirrors of the contract's derivations ─────────────────────────

export function resultSeedOf(env: CasinoEnv, roundId: bigint, target: bigint, randomness: string, beaconAddr: string): string {
  return keccak256(abi.encode(
    ["bytes32", "uint256", "address", "address", "uint256", "uint64", "bytes32"],
    [RESULT_DOMAIN, env.chainId, env.crashAddr, beaconAddr, roundId, target, randomness],
  ));
}

export function crashFromSeed(seed: string): bigint {
  const r = BigInt(seed) % BPS;
  return r === 0n ? BPS : (BPS * BPS) / (BPS - r);
}

export function ballHits(seed: string, oddsOneIn: bigint): boolean {
  return BigInt(keccak256(abi.encode(["bytes32", "bytes32"], [BALL_DOMAIN, seed]))) % oddsOneIn === 0n;
}

export function ticketOf(seed: string, playerPool: bigint): bigint {
  return BigInt(keccak256(abi.encode(["bytes32", "bytes32"], [TICKET_DOMAIN, seed]))) % playerPool;
}

export function winnerOf(seats: Array<{ player: string; stake: bigint }>, seed: string): string {
  const pool = seats.reduce((a, s) => a + s.stake, 0n);
  const ticket = ticketOf(seed, pool);
  let acc = 0n;
  for (const s of seats) {
    acc += s.stake;
    if (ticket < acc) return s.player;
  }
  return seats[seats.length - 1].player;
}

/** Deterministic search for a mock randomness whose derived crash/ball satisfy `pred`. */
export async function findRandomness(
  env: CasinoEnv,
  roundId: bigint,
  target: bigint,
  pred: (crashBps: bigint, seed: string) => boolean,
  start = 1n,
): Promise<string> {
  const beaconAddr = await env.beacon.getAddress();
  for (let c = start; c < start + 200_000n; c++) {
    const r = toBeHex(c, 32);
    const seed = resultSeedOf(env, roundId, target, r, beaconAddr);
    if (pred(crashFromSeed(seed), seed)) return r;
  }
  throw new Error("no randomness satisfies the predicate");
}

// ── Lifecycle helpers ───────────────────────────────────────────────────

export async function bet(env: CasinoEnv, signer: any, eth: string, targetBps: bigint) {
  return env.crash.connect(signer).placeBet(targetBps, { value: ethers.parseEther(eth) });
}

/**
 * Commit a seat FOR `player` the only way the contract allows: as the fixed
 * PlankBank (placeBetFor is bank-only after the 2026-09-05 hardening). The
 * bank is impersonated so fuzz tests can seat many distinct players without
 * funding wallets; on the real bank this is exactly what bet()/betVia() do.
 */
export async function betFor(env: CasinoEnv, player: string, targetBps: bigint, valueWei: bigint) {
  const bankAddr = await env.bank.getAddress();
  await networkHelpers.impersonateAccount(bankAddr);
  await networkHelpers.setBalance(bankAddr, ethers.parseEther("1000000"));
  const bankSigner = await ethers.getSigner(bankAddr);
  return env.crash.connect(bankSigner).placeBetFor(player, targetBps, { value: valueWei });
}

/** A deterministic, valid, never-colliding player address (no key derivation). */
let _addrCounter = 0x1000n;
export function freshAddress(): string {
  _addrCounter += 1n;
  return ethers.getAddress("0x" + _addrCounter.toString(16).padStart(40, "0"));
}

export async function increaseToAtLeast(t: bigint) {
  const now = BigInt(await networkHelpers.time.latest());
  if (now < t) await networkHelpers.time.increaseTo(t);
}

export async function closeBetting(env: CasinoEnv) {
  const r = await env.crash.currentRound();
  await increaseToAtLeast(BigInt(r.bettingEndsAt));
}

/** Relay `randomness` for the current round's target and settle it. */
export async function settleCurrent(env: CasinoEnv, randomness: string, signer: any = env.keeper) {
  const id: bigint = await env.crash.currentRoundId();
  const r = await env.crash.rounds(id);
  await increaseToAtLeast(BigInt(r.bettingEndsAt));
  await env.beacon.setRandomness(r.targetDrandRound, randomness);
  const tx = await env.crash.connect(signer).settleRound();
  const receipt = await tx.wait();
  const seed = resultSeedOf(env, id, BigInt(r.targetDrandRound), randomness, await env.beacon.getAddress());
  return { id, receipt, seed, crashBps: crashFromSeed(seed), round: await env.crash.rounds(id) };
}

/** Physical-ETH conservation (S-8 / R-1): every contract's balance == its accounting. */
export async function assertConserved(env: CasinoEnv, expect: any) {
  for (const [name, c] of [["crash", env.crash], ["lottery", env.lottery], ["router", env.rakeRouter]] as const) {
    const bal = await ethers.provider.getBalance(await c.getAddress());
    expect(bal, `${name}: balance == accountedBalance`).to.equal(await c.accountedBalance());
  }
}

export async function seatsOf(env: CasinoEnv, roundId: bigint): Promise<Array<{ player: string; stake: bigint; targetBps: bigint }>> {
  const raw = await env.crash.seatsOf(roundId);
  return raw.map((s: any) => ({ player: s.player, stake: BigInt(s.stake), targetBps: BigInt(s.targetBps) }));
}
