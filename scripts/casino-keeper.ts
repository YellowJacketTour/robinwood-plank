/**
 * plank.love casino keeper -- drives the whole game loop automatically.
 *
 * THE TWO PROPERTIES THIS RELIES ON, AND WHY THEY COEXIST:
 *
 *   PUBLIC    Every function this calls is permissionless -- there is no
 *             owner, no admin, and no access control anywhere in
 *             PlankCrash / PlankLottery / PlankRakeRouter / PlankBurnEngine /
 *             DrandBeacon. Anyone can run this script, or call any step by
 *             hand, and the game advances.
 *
 *   AUTOMATIC This process calls them on a timer so it happens reliably
 *             without anyone watching.
 *
 * ZERO PRIVILEGE: the signer here is a gas-only wallet. It cannot influence
 * any outcome -- randomness is verified on-chain against drand, every seat's
 * payout is a pure function of committed data and the crash, and every
 * payout is credited to the PLAYER's pull ledger, never to whoever submitted
 * the transaction. Losing this key loses gas money and nothing else.
 *
 * Usage:
 *   KEEPER_RPC_URL=... KEEPER_PK=... CRASH_ADDRESS=... LOTTERY_ADDRESS=... \
 *   BEACON_ADDRESS=... ROUTER_ADDRESS=... npx hardhat run scripts/casino-keeper.ts
 *
 * Optional:
 *   BURN_ENGINE_ADDRESS + ORACLE_ADDRESS   enable the burn step
 *   KEEPER_INTERVAL_MS    tick cadence (default 2000)
 *   KEEPER_ONCE=1         run a single tick and exit (used by the test)
 *   KEEPER_MOCK_BEACON=1  LOCAL DEV ONLY -- inject randomness into
 *                         DrandBeaconMock instead of relaying a real drand
 *                         signature.
 *   KEEPER_MOCK_MIN_CRASH_BPS  LOCAL TEST ONLY -- search deterministic mock
 *                         input until the domain-separated crash is at least
 *                         this value. Never used with real drand.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AbiCoder, Contract, JsonRpcProvider, Wallet, hexlify, keccak256, randomBytes, toBeHex, type Provider, type Signer } from "ethers";
import { fetchRoundFromApis, parseG1 } from "./relay-drand.js";

export const CRASH_ABI = [
  "function currentRoundId() view returns (uint256)",
  "function rounds(uint256) view returns (uint8 phase, uint64 targetDrandRound, uint64 bettingEndsAt, uint64 revealNotBefore, bytes32 paramsHash, uint256 seed, uint256 playerPool, uint256 reserveAtLock, uint256 largestStake, uint256 crashBps, uint256 effectiveRakeBps, uint256 playerDistributable, uint256 totalPlayerPaid, uint256 totalBonus, uint256 houseReturned, address lotteryWinner)",
  "function refundTimeoutSeconds() view returns (uint256)",
  "function pendingRake() view returns (uint256)",
  "function pendingOverflow() view returns (uint256)",
  "function lockRound()",
  "function settleRound()",
  "function refundRound()",
  "function flushRake() returns (bool)",
  "function deliverOverflow() returns (bool)",
  "event BetPlaced(uint256 indexed roundId, address indexed player, uint256 stake, uint256 targetBps, address indexed fundedBy)",
];

const BEACON_ABI = [
  "function isRoundAvailable(uint64 round) view returns (bool)",
  "function randomnessOrZero(uint64 round) view returns (bytes32)",
  "function submitRound(uint64 round, uint256[2] signature)",
];

const MOCK_BEACON_ABI = ["function setRandomness(uint64 round, bytes32 value)"];

const ROUTER_ABI = [
  "function burnEscrow() view returns (uint256)",
  "function lotteryEscrow() view returns (uint256)",
  "function vaultEscrow() view returns (uint256)",
  "function founderEscrow() view returns (uint256)",
  "function claimBurn()",
  "function claimLottery()",
  "function claimVault()",
  "function claimFounders()",
];

const LOTTERY_ABI = [
  "function founderEscrow() view returns (uint256)",
  "function withdrawFounderFees()",
];

export type KeeperAction = { step: string; detail?: string };

export type KeeperConfig = {
  crash: string;
  lottery: string;
  beacon: string;
  router: string;
  burnEngine?: string;
  oracle?: string;
  /** Independent drand HTTP relays + pinned chain hash (production requires >=2). */
  drandApis?: string[];
  drandChainHash?: string;
  /** LOCAL DEV ONLY -- see KEEPER_MOCK_BEACON in the header. */
  mockBeacon?: boolean;
  /** LOCAL TEST ONLY -- deterministic lower bound for browser tests. */
  mockMinCrashBps?: bigint;
};

const RESULT_DOMAIN = keccak256(Buffer.from("PLANKCRASH_RESULT_V2"));
const abiCoder = AbiCoder.defaultAbiCoder();

async function mockRandomness(
  provider: Provider,
  cfg: KeeperConfig,
  roundId: bigint,
  targetDrandRound: bigint
): Promise<string> {
  if (!cfg.mockMinCrashBps) return hexlify(randomBytes(32));
  const chainId = (await provider.getNetwork()).chainId;
  for (let candidate = 1n; candidate <= 100_000n; candidate += 1n) {
    const filler = toBeHex(candidate, 32);
    const seed = keccak256(abiCoder.encode(
      ["bytes32", "uint256", "address", "address", "uint256", "uint64", "bytes32"],
      [RESULT_DOMAIN, chainId, cfg.crash, cfg.beacon, roundId, targetDrandRound, filler]
    ));
    const residue = BigInt(seed) % 10_000n;
    const multiplierBps = residue === 0n ? 10_000n : 100_000_000n / (10_000n - residue);
    if (multiplierBps >= cfg.mockMinCrashBps) return filler;
  }
  throw new Error("could not find bounded mock randomness for requested crash floor");
}

const ORACLE_ABI = ["function update()"];
const BURN_ENGINE_ABI = [
  "function executeBurn(uint256 ethAmount)",
  "function maxEthPerCall() view returns (uint256)",
];

/** Best-effort send: every step is idempotent, and a revert usually just
 * means "another caller already did this" or "not ready yet" -- both are
 * ordinary, expected outcomes for a permissionless loop, not errors. */
async function attempt(
  actions: KeeperAction[],
  step: string,
  fn: () => Promise<{ wait(): Promise<unknown> }>,
  detail?: string
): Promise<boolean> {
  try {
    const tx = await fn();
    await tx.wait();
    actions.push({ step, detail });
    return true;
  } catch {
    return false;
  }
}

/** Every address that placed a bet in `roundId`, from the contract's own events. */
export async function biddersOf(crash: Contract, roundId: bigint): Promise<string[]> {
  const filter = crash.filters.BetPlaced(roundId);
  const logs = await crash.queryFilter(filter, 0, "latest");
  const seen = new Set<string>();
  for (const log of logs) {
    const player = (log as unknown as { args: { player: string } }).args.player;
    seen.add(player);
  }
  return [...seen];
}

/**
 * Advances everything that is currently actionable, once. Safe to call on
 * a timer: every step re-derives what to do from live chain state, so a
 * missed or duplicated tick can never corrupt anything.
 */
export async function tick(
  provider: Provider,
  signer: Signer,
  cfg: KeeperConfig
): Promise<KeeperAction[]> {
  const actions: KeeperAction[] = [];
  const crash = new Contract(cfg.crash, CRASH_ABI, signer);
  const beacon = new Contract(cfg.beacon, BEACON_ABI, signer);
  const router = new Contract(cfg.router, ROUTER_ABI, signer);
  const lottery = new Contract(cfg.lottery, LOTTERY_ABI, signer);

  const roundId: bigint = await crash.currentRoundId();
  const now = BigInt((await provider.getBlock("latest"))!.timestamp);

  // ── 1. Close betting once the window has passed (voids thin rounds early) ──
  let round = await crash.rounds(roundId);
  if (Number(round.phase) === 0 && now >= round.bettingEndsAt) {
    await attempt(actions, "lockRound", () => crash.lockRound(), `round ${roundId}`);
    round = await crash.rounds(await crash.currentRoundId());
  }

  // ── 2. LIVE: relay the committed drand round, then settle in one pass ──
  if (Number(round.phase) === 1) {
    const id: bigint = await crash.currentRoundId();
    const available: boolean = await beacon.isRoundAvailable(round.targetDrandRound);
    if (!available) {
      if (cfg.mockBeacon) {
        if (now >= round.revealNotBefore) {
          const mock = new Contract(cfg.beacon, MOCK_BEACON_ABI, signer);
          const filler = await mockRandomness(provider, cfg, id, BigInt(round.targetDrandRound));
          await attempt(actions, "mockBeacon.setRandomness", () => mock.setRandomness(round.targetDrandRound, filler));
        }
      } else if (cfg.drandApis && cfg.drandChainHash) {
        try {
          const drand = await fetchRoundFromApis(cfg.drandApis, cfg.drandChainHash, BigInt(round.targetDrandRound));
          const sig = parseG1(drand.signature);
          await attempt(actions, "beacon.submitRound", () => beacon.submitRound(round.targetDrandRound, sig),
            `drand round ${round.targetDrandRound}`);
        } catch {
          /* round not published yet -- ordinary, try again next tick */
        }
      }
    }
    if (await beacon.isRoundAvailable(round.targetDrandRound)) {
      await attempt(actions, "settleRound", () => crash.settleRound(), `round ${id}`);
    } else {
      // Outcome-independent liveness escape, only when drand has truly gone dark.
      const timeout: bigint = await crash.refundTimeoutSeconds();
      if (now >= BigInt(round.revealNotBefore) + timeout) {
        await attempt(actions, "refundRound", () => crash.refundRound(), `round ${id}`);
      }
    }
  }

  // ── 3. Escrow deliveries: net rake -> router, buffer overflow -> lottery ──
  if ((await crash.pendingRake()) > 0n) await attempt(actions, "flushRake", () => crash.flushRake());
  if ((await crash.pendingOverflow()) > 0n) await attempt(actions, "deliverOverflow", () => crash.deliverOverflow());

  // ── 4. Router legs (each pushes to a sink fixed at construction) ──
  if ((await router.burnEscrow()) > 0n) await attempt(actions, "router.claimBurn", () => router.claimBurn());
  if ((await router.lotteryEscrow()) > 0n) await attempt(actions, "router.claimLottery", () => router.claimLottery());
  if ((await router.vaultEscrow()) > 0n) await attempt(actions, "router.claimVault", () => router.claimVault());
  if ((await router.founderEscrow()) > 0n) await attempt(actions, "router.claimFounders", () => router.claimFounders());
  if ((await lottery.founderEscrow()) > 0n) await attempt(actions, "lottery.withdrawFounderFees", () => lottery.withdrawFounderFees());

  // ── 5. Keep the TWAP fresh and burn any ETH routed to the engine ──
  if (cfg.oracle && cfg.burnEngine) {
    await attempt(actions, "oracle.update", () => new Contract(cfg.oracle!, ORACLE_ABI, signer).update());
    const engine = new Contract(cfg.burnEngine, BURN_ENGINE_ABI, signer);
    const engineBal = await provider.getBalance(cfg.burnEngine);
    if (engineBal > 0n) {
      const cap: bigint = await engine.maxEthPerCall();
      const amount = engineBal < cap ? engineBal : cap;
      await attempt(actions, "executeBurn", () => engine.executeBurn(amount), `${amount} wei`);
    }
  }

  return actions;
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

async function main() {
  const provider = new JsonRpcProvider(required("KEEPER_RPC_URL"));
  const signer = new Wallet(required("KEEPER_PK"), provider);
  const cfg: KeeperConfig = {
    crash: required("CRASH_ADDRESS"),
    lottery: required("LOTTERY_ADDRESS"),
    beacon: required("BEACON_ADDRESS"),
    router: required("ROUTER_ADDRESS"),
    burnEngine: process.env.BURN_ENGINE_ADDRESS?.trim() || undefined,
    oracle: process.env.ORACLE_ADDRESS?.trim() || undefined,
    drandApis: (process.env.DRAND_APIS || process.env.DRAND_API ||
      "https://api.drand.sh,https://api2.drand.sh,https://drand.cloudflare.com")
      .split(/[\s,]+/).filter(Boolean),
    drandChainHash: process.env.DRAND_CHAIN_HASH?.trim(),
    mockBeacon: process.env.KEEPER_MOCK_BEACON === "1",
    mockMinCrashBps: process.env.KEEPER_MOCK_MIN_CRASH_BPS
      ? BigInt(process.env.KEEPER_MOCK_MIN_CRASH_BPS)
      : undefined,
  };

  console.log("casino-keeper: gas-only signer", await signer.getAddress());
  console.log("casino-keeper: every step is permissionless -- anyone can run this.");

  const once = process.env.KEEPER_ONCE === "1";
  const interval = Number(process.env.KEEPER_INTERVAL_MS || 2000);
  do {
    try {
      const actions = await tick(provider, signer, cfg);
      for (const a of actions) console.log(`  ${a.step}${a.detail ? " -- " + a.detail : ""}`);
    } catch (err) {
      console.error("tick failed:", err instanceof Error ? err.message : String(err));
    }
    if (!once) await new Promise((r) => setTimeout(r, interval));
  } while (!once);
}

// Only auto-run when executed directly (under `npx hardhat run` the target
// script path is argv[3], not argv[1]) so tick() stays importable by tests.
function resolvedOrUndefined(p: string | undefined): string | undefined {
  if (!p) return undefined;
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}
const thisFile = realpathSync(fileURLToPath(import.meta.url));
const isDirectRun =
  resolvedOrUndefined(process.argv[1]) === thisFile || resolvedOrUndefined(process.argv[3]) === thisFile;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
