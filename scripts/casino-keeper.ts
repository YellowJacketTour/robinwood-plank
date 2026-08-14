/**
 * plank.love casino keeper -- drives the whole game loop automatically.
 *
 * THE TWO PROPERTIES THIS RELIES ON, AND WHY THEY COEXIST:
 *
 *   PUBLIC    Every function this calls is permissionless -- there is no
 *             owner, no admin, and no access control anywhere in
 *             PlankCrashDrand / PlankPowerboard / PlankBurnEngine /
 *             PlankRakeDistributor / DrandBeacon. Anyone can run this
 *             script, or call any step by hand, and the game advances.
 *
 *   AUTOMATIC This process calls them on a timer so it happens reliably
 *             without anyone watching.
 *
 * Those are not in tension -- together they are the point. The default
 * operator (this bot) makes the game punctual; permissionlessness makes it
 * UNSTOPPABLE, because if this bot dies, anyone else can run the same
 * script (or their own) and keep the game running. Several steps pay a
 * real reward (settleRound, executeBurn, drawWinner), so a third party has
 * an actual economic reason to step in rather than pure goodwill. The
 * contracts' own void/rollover fallbacks are the last-resort safety net if
 * nobody does -- see docs/CASINO-ARCHITECTURE.md §4b.
 *
 * ZERO PRIVILEGE: the signer here is a gas-only wallet, exactly like
 * scripts/relay-drand.ts's. It cannot influence any outcome -- randomness
 * is verified on-chain against drand, results are computed from state
 * already on chain, and every payout is escrowed to the PLAYER, never to
 * whoever submitted the transaction. Losing this key loses gas money and
 * nothing else.
 *
 * Usage:
 *   KEEPER_RPC_URL=... KEEPER_PK=... CRASH_ADDRESS=... POWERBOARD_ADDRESS=... \
 *   BEACON_ADDRESS=... DISTRIBUTOR_ADDRESS=... npx hardhat run scripts/casino-keeper.ts
 *
 * Optional:
 *   BURN_ENGINE_ADDRESS   enable the burn step (needs a real swap route; see below)
 *   KEEPER_INTERVAL_MS    tick cadence (default 2000)
 *   KEEPER_ONCE=1         run a single tick and exit (used by the test)
 *   KEEPER_MOCK_BEACON=1  LOCAL DEV ONLY -- inject randomness into
 *                         DrandBeaconMock instead of relaying a real drand
 *                         signature, so the full loop can be exercised
 *                         against the local stack.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Contract, JsonRpcProvider, Wallet, type Provider, type Signer } from "ethers";
import { fetchRound, parseG1 } from "./relay-drand.js";

const CRASH_ABI = [
  "function currentRoundId() view returns (uint256)",
  "function rounds(uint256) view returns (uint8 phase, uint256 bettingEndsAt, uint256 lockBlock, uint64 targetDrandRound, bool entropyRevealed, uint256 trueCrashElapsedBlocks, uint256 crashElapsedBlocks, uint256 crashMultiplierBps, uint256 pool, uint256 distributable, uint256 totalWinningWeight, uint256 provisionalWinningWeight, uint256 registrationDeadlineBlock, uint256 rolledOverFromPrevious, bool swept)",
  "function maxElapsedBlocks() view returns (uint256)",
  "function minParticipants() view returns (uint256)",
  "function participantCount(uint256) view returns (uint256)",
  "function accumulatedRake() view returns (uint256)",
  "function registered(uint256, address) view returns (bool)",
  "function claimed(uint256, address) view returns (bool)",
  "function payments(address) view returns (uint256)",
  "function lockRound()",
  "function revealEntropy(uint256 roundId)",
  "function settleRound(uint256 roundId)",
  "function sweepBustedRound(uint256 roundId)",
  "function registerResult(uint256 roundId, address player)",
  "function claim(uint256 roundId, address player)",
  "function claimRake()",
  "function withdrawPayments(address payee)",
  "event BetPlaced(uint256 indexed roundId, address indexed player, uint256 amount)",
];

const BEACON_ABI = [
  "function isRoundAvailable(uint64 round) view returns (bool)",
  "function randomnessOrZero(uint64 round) view returns (bytes32)",
  "function submitRound(uint64 round, uint256[2] signature)",
];

const MOCK_BEACON_ABI = ["function setRandomness(uint64 round, bytes32 value)"];

const POWERBOARD_ABI = [
  "function currentEpoch() view returns (uint256)",
  "function epochs(uint256) view returns (uint256 totalTickets, uint64 targetDrandRound, bool drawRequested, bool drawn, bool jackpotHit, uint256 drawnBall, address winner, uint256 prize)",
  "function claimTickets(address source, uint256 sourceRoundId, address player)",
  "function requestDraw(uint256 epoch)",
  "function drawWinner(uint256 epoch)",
];

export type KeeperAction = { step: string; detail?: string };

export type KeeperConfig = {
  crash: string;
  powerboard: string;
  beacon: string;
  distributor: string;
  /** The buyback engine + its TWAP oracle. When both are set, tick()
   * keeps the oracle primed and burns any ETH the distributor has routed
   * to the engine -- closing the value-back-to-holders leg so the whole
   * loop is self-driving, not dependent on an out-of-band caller. */
  burnEngine?: string;
  oracle?: string;
  /** drand HTTP relay + chain hash, only needed when not using a mock beacon. */
  drandApi?: string;
  drandChainHash?: string;
  /** LOCAL DEV ONLY -- see KEEPER_MOCK_BEACON in the header. */
  mockBeacon?: boolean;
};

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

/** Every address that placed a bet in `roundId`, read from the contract's
 * own BetPlaced events -- the keeper never keeps a private list. */
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
  const powerboard = new Contract(cfg.powerboard, POWERBOARD_ABI, signer);

  const roundId: bigint = await crash.currentRoundId();
  const now = BigInt((await provider.getBlock("latest"))!.timestamp);
  const blockNumber = BigInt(await provider.getBlockNumber());

  // ── 1. Close betting once the window has passed ───────────────────
  const round = await crash.rounds(roundId);
  if (Number(round.phase) === 0 && now >= round.bettingEndsAt) {
    await attempt(actions, "lockRound", () => crash.lockRound(), `round ${roundId}`);
  }

  // ── 2..4. Advance every LIVE round: relay -> reveal -> settle ──────
  // Walk a few recent rounds, not just the current one, so a round that
  // was missed while this process was down still gets finished.
  const oldest = roundId > 5n ? roundId - 5n : 1n;
  for (let id = oldest; id <= roundId; id++) {
    const r = await crash.rounds(id);
    const phase = Number(r.phase);

    if (phase === 1) {
      // LIVE: make sure the committed drand round is on the beacon.
      if (!r.entropyRevealed) {
        const available: boolean = await beacon.isRoundAvailable(r.targetDrandRound);
        if (!available) {
          if (cfg.mockBeacon) {
            // LOCAL DEV ONLY: stand in for a real relayed signature.
            const mock = new Contract(cfg.beacon, MOCK_BEACON_ABI, signer);
            const filler = "0x" + (id.toString(16).padStart(64, "0"));
            await attempt(actions, "mockBeacon.setRandomness", () =>
              mock.setRandomness(r.targetDrandRound, filler)
            );
          } else if (cfg.drandApi && cfg.drandChainHash) {
            try {
              const drand = await fetchRound(cfg.drandApi, cfg.drandChainHash, BigInt(r.targetDrandRound));
              const sig = parseG1(drand.signature);
              await attempt(actions, "beacon.submitRound", () => beacon.submitRound(r.targetDrandRound, sig),
                `drand round ${r.targetDrandRound}`);
            } catch {
              /* round not published yet -- ordinary, try again next tick */
            }
          }
        }
        await attempt(actions, "revealEntropy", () => crash.revealEntropy(id), `round ${id}`);
      }

      // Settle once real elapsed blocks have reached the crash point.
      const fresh = await crash.rounds(id);
      if (fresh.entropyRevealed) {
        const maxElapsed: bigint = await crash.maxElapsedBlocks();
        const effective =
          fresh.trueCrashElapsedBlocks < maxElapsed ? fresh.trueCrashElapsedBlocks : maxElapsed;
        if (blockNumber - fresh.lockBlock >= effective) {
          await attempt(actions, "settleRound", () => crash.settleRound(id), `round ${id}`);
        }
      }
    }

    // ── 5..7. CRASHED: register everyone, then claim/sweep ──────────
    if (Number((await crash.rounds(id)).phase) === 2) {
      const r2 = await crash.rounds(id);
      const players = await biddersOf(crash, id);

      if (blockNumber <= r2.registrationDeadlineBlock) {
        for (const player of players) {
          if (!(await crash.registered(id, player))) {
            // On-behalf registration: an offline winner no longer forfeits.
            await attempt(actions, "registerResult", () => crash.registerResult(id, player), player);
          }
        }
      } else {
        for (const player of players) {
          if ((await crash.registered(id, player)) && !(await crash.claimed(id, player))) {
            // Payout escrows to the PLAYER; this bot cannot redirect it.
            await attempt(actions, "claim", () => crash.claim(id, player), player);
          }
        }
        // Whole field busted -> roll the pot into the next round instead
        // of letting it sit stranded forever.
        const after = await crash.rounds(id);
        if (after.totalWinningWeight === 0n && !after.swept && after.distributable > 0n) {
          await attempt(actions, "sweepBustedRound", () => crash.sweepBustedRound(id), `round ${id}`);
        }
      }

      // ── 8. Powerboard tickets for every real bettor ──────────────
      for (const player of players) {
        await attempt(actions, "powerboard.claimTickets", () =>
          powerboard.claimTickets(cfg.crash, id, player), player);
      }
    }
  }

  // ── 9. Push accrued rake through the distributor's 3-way split ────
  const rake: bigint = await crash.accumulatedRake();
  if (rake > 0n) {
    await attempt(actions, "claimRake", () => crash.claimRake());
  }
  const owed: bigint = await crash.payments(cfg.distributor);
  if (owed > 0n) {
    await attempt(actions, "withdrawPayments(distributor)", () =>
      crash.withdrawPayments(cfg.distributor), `${owed} wei`);
  }

  // ── 9b. Keep the TWAP fresh and burn any ETH routed to the engine ──
  // Closes the value-back-to-holders leg on-chain: refresh the oracle so
  // executeBurn's fair-price floor is available (update() reverts if a
  // full window hasn't elapsed -- that's fine, caught as a no-op), then
  // buy+burn up to maxEthPerCall of whatever the distributor has sent.
  if (cfg.oracle && cfg.burnEngine) {
    await attempt(actions, "oracle.update", () => new Contract(cfg.oracle!, ORACLE_ABI, signer).update());
    const engine = new Contract(cfg.burnEngine, BURN_ENGINE_ABI, signer);
    const engineBal = await provider.getBalance(cfg.burnEngine);
    if (engineBal > 0n) {
      const cap: bigint = await engine.maxEthPerCall();
      const amount = engineBal < cap ? engineBal : cap;
      // Reverts harmlessly if the oracle isn't primed yet (unprimed/stale)
      // -- the ETH just waits for the next tick, never at risk.
      await attempt(actions, "executeBurn", () => engine.executeBurn(amount), `${amount} wei`);
    }
  }

  // ── 10. Powerboard draw on the fixed schedule ─────────────────────
  const epoch: bigint = await powerboard.currentEpoch();
  if (epoch > 0n) {
    const prev = epoch - 1n;
    const e = await powerboard.epochs(prev);
    if (!e.drawRequested) {
      await attempt(actions, "powerboard.requestDraw", () => powerboard.requestDraw(prev), `epoch ${prev}`);
    } else if (!e.drawn) {
      if (cfg.mockBeacon) {
        const available: boolean = await beacon.isRoundAvailable(e.targetDrandRound);
        if (!available) {
          const mock = new Contract(cfg.beacon, MOCK_BEACON_ABI, signer);
          const filler = "0x" + ((prev + 7n).toString(16).padStart(64, "0"));
          await attempt(actions, "mockBeacon.setRandomness(draw)", () =>
            mock.setRandomness(e.targetDrandRound, filler));
        }
      } else if (cfg.drandApi && cfg.drandChainHash) {
        try {
          const drand = await fetchRound(cfg.drandApi, cfg.drandChainHash, BigInt(e.targetDrandRound));
          await attempt(actions, "beacon.submitRound(draw)", () =>
            beacon.submitRound(e.targetDrandRound, parseG1(drand.signature)));
        } catch {
          /* not published yet */
        }
      }
      await attempt(actions, "powerboard.drawWinner", () => powerboard.drawWinner(prev), `epoch ${prev}`);
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
    powerboard: required("POWERBOARD_ADDRESS"),
    beacon: required("BEACON_ADDRESS"),
    distributor: required("DISTRIBUTOR_ADDRESS"),
    burnEngine: process.env.BURN_ENGINE_ADDRESS?.trim() || undefined,
    oracle: process.env.ORACLE_ADDRESS?.trim() || undefined,
    drandApi: process.env.DRAND_API?.trim() || "https://api.drand.sh",
    drandChainHash: process.env.DRAND_CHAIN_HASH?.trim(),
    mockBeacon: process.env.KEEPER_MOCK_BEACON === "1",
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

// Only auto-run when executed directly -- the same direct-execution guard
// scripts/relay-drand.ts uses -- so tick() above stays importable by tests
// without kicking off an infinite loop on import.
const isDirectRun =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
