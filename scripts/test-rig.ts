/**
 * plank.love LOCAL TEST RIG -- exploratory-testing CLI, NOT a production
 * tool. Everything here either (a) calls a genuinely permissionless
 * contract function any real account could call (fund-vault, fund-jackpot,
 * competitor bets), or (b) directly injects randomness into the LOCAL
 * DrandBeaconMock to pin a specific outcome for testing (rig-crash,
 * rig-jackpot) -- something only possible because this is a mock beacon a
 * real deployment never uses (the real DrandBeacon only accepts a verified
 * drand relay signature; nobody can inject an arbitrary value there).
 *
 * Reads contract addresses from public/arcade/deploy-addresses.local.json
 * (written by local-casino-setup.ts) -- no addresses to paste by hand.
 *
 * Usage (env-var driven -- `hardhat run` does not forward trailing CLI
 * args to the script, only --network/--config/etc, so this matches
 * scripts/casino-keeper.ts's own established convention):
 *
 *   RIG_CMD=status \
 *     npx hardhat run scripts/test-rig.ts --network localhost
 *
 *   RIG_CMD=fund-vault RIG_A1=1.5 \
 *     npx hardhat run scripts/test-rig.ts --network localhost
 *
 *   RIG_CMD=fund-jackpot RIG_A1=0.5 \
 *     npx hardhat run scripts/test-rig.ts --network localhost
 *
 *   RIG_CMD=bet RIG_A1=alice RIG_A2=3.0 \
 *     npx hardhat run scripts/test-rig.ts --network localhost
 *     (accounts: deployer | alice | bob | carol; each holds 10000 ETH by
 *     default on a hardhat node -- if you need more, RIG_CMD=top-up)
 *
 *   RIG_CMD=top-up RIG_A1=alice RIG_A2=50000 \
 *     npx hardhat run scripts/test-rig.ts --network localhost
 *     (hardhat_setBalance -- genuinely unlimited, this is a devnet RPC
 *     method, not a token mint)
 *
 *   RIG_CMD=mint-plank RIG_A1=alice RIG_A2=1000000 \
 *     npx hardhat run scripts/test-rig.ts --network localhost
 *     (mints unlimited mock $PLANK to fuel-burn test with -- the mock
 *     token's mint() is wide open by design for exactly this; the real
 *     $PLANK on mainnet has no such function)
 *
 *   RIG_CMD=claim-tickets RIG_A1=alice RIG_A2=2 \
 *     npx hardhat run scripts/test-rig.ts --network localhost
 *     (claims Powerboard tickets for alice's bet in crash round 2 -- do
 *     this for anyone you want a shot at rig-jackpot; an epoch with zero
 *     claimed tickets is skipped as "no-participants", not drawn)
 *
 *   RIG_CMD=rig-crash RIG_A1=2.5 \
 *     npx hardhat run scripts/test-rig.ts --network localhost
 *     (forces the CURRENT LIVE round to crash at ~2.50x. Races the
 *     background keeper if one is running -- for a deterministic result,
 *     stop the keeper first and drive rounds with RIG_CMD=tick instead)
 *
 *   RIG_CMD=rig-jackpot RIG_A1=hit \
 *     npx hardhat run scripts/test-rig.ts --network localhost
 *     (rigs the most recently-completed, not-yet-drawn epoch's Plank Ball
 *     to hit or miss the jackpot; same keeper-race caveat as rig-crash)
 *
 *   RIG_CMD=tick \
 *     npx hardhat run scripts/test-rig.ts --network localhost
 *     (drives one manual lock/reveal/settle step, like casino-keeper.ts's
 *     own tick(), but WITHOUT overwriting any randomness you've already
 *     rigged -- run this instead of the background keeper while doing
 *     precision outcome testing)
 */
import hardhat from "hardhat";
const { ethers } = await hardhat.network.create();

const CRASH_ABI = [
  "function currentRoundId() view returns (uint256)",
  "function currentRound() view returns (uint8 phase, bool entropyRevealed, bool swept, uint64 targetDrandRound, uint256 bettingEndsAt, uint256 lockBlock, uint256 trueCrashElapsedBlocks, uint256 crashElapsedBlocks, uint256 crashMultiplierBps, uint256 pool, uint256 distributable, uint256 totalWinningWeight, uint256 provisionalWinningWeight, uint256 registrationDeadlineBlock, uint256 rolledOverFromPrevious)",
  "function rounds(uint256) view returns (uint8 phase, bool entropyRevealed, bool swept, uint64 targetDrandRound, uint256 bettingEndsAt, uint256 lockBlock, uint256 trueCrashElapsedBlocks, uint256 crashElapsedBlocks, uint256 crashMultiplierBps, uint256 pool, uint256 distributable, uint256 totalWinningWeight, uint256 provisionalWinningWeight, uint256 registrationDeadlineBlock, uint256 rolledOverFromPrevious)",
  "function placeBet() payable",
  "function lockRound()",
  "function revealEntropy(uint256 roundId)",
  "function settleRound(uint256 roundId)",
  "function fundVault() payable",
  "function reserve() view returns (uint256)",
  "function maxElapsedBlocks() view returns (uint256)",
];
const POWERBOARD_ABI = [
  "function currentEpoch() view returns (uint256)",
  "function epochs(uint256) view returns (uint256 totalTickets, uint64 targetDrandRound, bool drawRequested, bool drawn, bool jackpotHit, uint256 drawnBall, address winner, uint256 prize)",
  "function jackpot() view returns (uint256)",
  "function fund() payable",
  "function requestDraw(uint256 epoch)",
  "function drawWinner(uint256 epoch)",
  "function ballRange() view returns (uint256)",
  "function jackpotBall() view returns (uint256)",
  "function claimTickets(address source, uint256 sourceRoundId, address player)",
];
const BEACON_ABI = [
  "function setRandomness(uint64 round, bytes32 value) external",
  "function isRoundAvailable(uint64 round) view returns (bool)",
];
const PLANK_ABI = [
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) view returns (uint256)",
];

async function loadManifest() {
  const fs = await import("node:fs");
  const url = new URL("../public/arcade/deploy-addresses.local.json", import.meta.url);
  return JSON.parse(fs.readFileSync(url, "utf8"));
}

// Finds a bytes32 whose uint256 value, mod 10000, derives the desired
// crash multiplier via the contract's own _deriveCrash formula:
//   r = uint256(entropy) % 10000
//   multiplierBps = (10000 * 10000) / (10000 - r)     [r == 0 => 10000, i.e. 1.00x]
// Inverting: r = 10000 - 100_000_000 / multiplierBps
function entropyForMultiplier(multiplierBps: bigint): string {
  if (multiplierBps <= 10000n) return ethers.zeroPadValue(ethers.toBeHex(0), 32); // 1.00x (r=0)
  const r = 10000n - 100_000_000n / multiplierBps;
  if (r < 0n || r > 9999n) throw new Error(`multiplier ${multiplierBps} bps has no valid r in [0,9999]`);
  return ethers.zeroPadValue(ethers.toBeHex(r), 32);
}

// Brute-forces a bytes32 whose keccak256(entropy, "PLANK_BALL") % ballRange
// (+1) lands on (or deliberately avoids) jackpotBall. Small search space
// (ballRange is tiny, e.g. 26), trivially fast.
function entropyForBall(wantHit: boolean, ballRange: bigint, jackpotBall: bigint): string {
  for (let i = 0; i < 5000; i++) {
    const candidate = ethers.zeroPadValue(ethers.toBeHex(BigInt(i)), 32);
    const packed = ethers.solidityPacked(["bytes32", "string"], [candidate, "PLANK_BALL"]);
    const ball = (BigInt(ethers.keccak256(packed)) % ballRange) + 1n;
    if (wantHit === (ball === jackpotBall)) return candidate;
  }
  throw new Error("could not find matching entropy within search bound (unexpected for a small ballRange)");
}

async function main() {
  const cmd = process.env.RIG_CMD;
  const a1 = process.env.RIG_A1;
  const a2 = process.env.RIG_A2;
  if (!cmd) {
    console.log("RIG_CMD is required. See the usage comment at the top of scripts/test-rig.ts.");
    process.exitCode = 1;
    return;
  }

  const manifest = await loadManifest();
  const signers = await ethers.getSigners();
  const named: Record<string, any> = { deployer: signers[0], alice: signers[2], bob: signers[3], carol: signers[4] };
  const operator = signers[0];

  const crash = new ethers.Contract(manifest.crash, CRASH_ABI, operator);
  const powerboard = new ethers.Contract(manifest.powerboard, POWERBOARD_ABI, operator);
  const beacon = new ethers.Contract(manifest.beacon, BEACON_ABI, operator);
  const plank = new ethers.Contract(manifest.plank, PLANK_ABI, operator);

  if (cmd === "status") {
    const id = await crash.currentRoundId();
    const r = await crash.rounds(id);
    const reserve = await crash.reserve();
    const epoch = await powerboard.currentEpoch();
    const jackpot = await powerboard.jackpot();
    console.log("round:", id.toString(), "phase:", r.phase.toString(), "pool:", ethers.formatEther(r.pool), "ETH");
    console.log("vault reserve:", ethers.formatEther(reserve), "ETH");
    console.log("powerboard epoch:", epoch.toString(), "jackpot:", ethers.formatEther(jackpot), "ETH");
    for (const [name, signer] of Object.entries(named)) {
      const bal = await ethers.provider.getBalance(signer.address);
      const plankBal = await plank.balanceOf(signer.address);
      console.log(
        ` ${name.padEnd(9)} ${signer.address}  ${ethers.formatEther(bal)} ETH  ${ethers.formatEther(plankBal)} $PLANK`
      );
    }
    return;
  }

  if (cmd === "mint-plank") {
    if (!a1 || !a2) throw new Error("RIG_A1=<account> RIG_A2=<plankAmount> required");
    const signer = named[a1];
    if (!signer) throw new Error(`unknown account "${a1}" -- use deployer|alice|bob|carol`);
    // Permissionless on the mock token (see contracts/test/MockERC20Burnable.sol)
    // -- genuinely unlimited, mints new supply out of thin air. The real
    // $PLANK on mainnet has no such function; never available there.
    const tx = await plank.mint(signer.address, ethers.parseEther(a2));
    await tx.wait();
    console.log(`minted ${a2} $PLANK to ${a1} -- new balance: ${ethers.formatEther(await plank.balanceOf(signer.address))}`);
    return;
  }

  if (cmd === "fund-vault") {
    if (!a1) throw new Error("RIG_A1=<ethAmount> required");
    const tx = await crash.fundVault({ value: ethers.parseEther(a1) });
    await tx.wait();
    console.log(`funded vault with ${a1} ETH -- new reserve: ${ethers.formatEther(await crash.reserve())} ETH`);
    return;
  }

  if (cmd === "fund-jackpot") {
    if (!a1) throw new Error("RIG_A1=<ethAmount> required");
    const tx = await powerboard.fund({ value: ethers.parseEther(a1) });
    await tx.wait();
    console.log(`funded jackpot with ${a1} ETH -- new jackpot: ${ethers.formatEther(await powerboard.jackpot())} ETH`);
    return;
  }

  if (cmd === "bet") {
    if (!a1 || !a2) throw new Error("RIG_A1=<account> RIG_A2=<ethAmount> required");
    const signer = named[a1];
    if (!signer) throw new Error(`unknown account "${a1}" -- use deployer|alice|bob|carol`);
    const tx = await crash.connect(signer).placeBet({ value: ethers.parseEther(a2) });
    await tx.wait();
    console.log(`${a1} placed a competitor bet of ${a2} ETH`);
    return;
  }

  if (cmd === "claim-tickets") {
    if (!a1 || !a2) throw new Error("RIG_A1=<account> RIG_A2=<crashRoundId> required");
    const signer = named[a1];
    if (!signer) throw new Error(`unknown account "${a1}" -- use deployer|alice|bob|carol`);
    const tx = await powerboard.claimTickets(manifest.crash, a2, signer.address);
    await tx.wait();
    console.log(`claimed Powerboard tickets for ${a1}'s bet in crash round ${a2}`);
    return;
  }

  if (cmd === "top-up") {
    if (!a1 || !a2) throw new Error("RIG_A1=<account> RIG_A2=<ethAmount> required");
    const signer = named[a1];
    if (!signer) throw new Error(`unknown account "${a1}" -- use deployer|alice|bob|carol`);
    // hardhat_setBalance is a devnet-only RPC method -- genuinely
    // unlimited, unbounded by any real funding source. Never available
    // against a real chain.
    await ethers.provider.send("hardhat_setBalance", [
      signer.address,
      ethers.toBeHex(ethers.parseEther(a2)),
    ]);
    console.log(`${a1} balance set to ${a2} ETH (hardhat_setBalance -- devnet-only, unlimited)`);
    return;
  }

  if (cmd === "rig-crash") {
    if (!a1) throw new Error("RIG_A1=<targetMultiplier, e.g. 2.5> required");
    const targetBps = BigInt(Math.round(parseFloat(a1) * 10000));
    const id = await crash.currentRoundId();
    const r = await crash.rounds(id);
    if (Number(r.phase) !== 1) throw new Error(`round ${id} is phase ${r.phase}, not LIVE (1) -- lock it first, e.g. RIG_CMD=tick`);
    if (r.entropyRevealed) throw new Error(`round ${id} already revealed its entropy -- too late to rig this one`);
    const entropy = entropyForMultiplier(targetBps);
    await (await beacon.setRandomness(r.targetDrandRound, entropy)).wait();
    // Race the keeper for real by revealing immediately ourselves.
    await (await crash.revealEntropy(id)).wait();
    const after = await crash.rounds(id);
    console.log(
      `round ${id} entropy revealed -- trueCrashElapsedBlocks=${after.trueCrashElapsedBlocks} (targeting ${a1}x).`,
      `If a background keeper is also running, check this landed before assuming it's rigged --`,
      `whoever calls revealEntropy first wins.`
    );
    return;
  }

  if (cmd === "rig-jackpot") {
    if (a1 !== "hit" && a1 !== "miss") throw new Error('RIG_A1 must be "hit" or "miss"');
    const epoch = (await powerboard.currentEpoch()) - 1n;
    if (epoch < 0n) throw new Error("no completed epoch yet to rig");
    const e = await powerboard.epochs(epoch);
    if (e.drawn) throw new Error(`epoch ${epoch} already drawn -- too late to rig this one`);
    const ballRange = await powerboard.ballRange();
    const jackpotBall = await powerboard.jackpotBall();
    const entropy = entropyForBall(a1 === "hit", ballRange, jackpotBall);
    if (!e.drawRequested) await (await powerboard.requestDraw(epoch)).wait();
    const e2 = await powerboard.epochs(epoch);
    await (await beacon.setRandomness(e2.targetDrandRound, entropy)).wait();
    await (await powerboard.drawWinner(epoch)).wait();
    const after = await powerboard.epochs(epoch);
    console.log(
      `epoch ${epoch} drawn -- ball=${after.drawnBall} jackpotHit=${after.jackpotHit} (targeted "${a1}").`,
      `Races a running background keeper the same way rig-crash does.`
    );
    return;
  }

  if (cmd === "tick") {
    // A deliberately minimal, single-shot version of casino-keeper.ts's
    // own tick() -- lock if due, reveal with a RANDOM filler ONLY if
    // nothing rigged it already (setRandomness is overwrite-until-consumed,
    // but this command never overwrites -- it only fills a round that
    // genuinely has no randomness yet), settle if the crash point's
    // arrived. Meant to replace the background keeper while precision-
    // testing a specific rigged outcome, so nothing races your rig-crash/
    // rig-jackpot calls.
    const id = await crash.currentRoundId();
    const r = await crash.rounds(id);
    if (Number(r.phase) === 0 && BigInt(Math.floor(Date.now() / 1000)) >= r.bettingEndsAt) {
      await (await crash.lockRound()).wait();
      console.log(`locked round ${id}`);
      return;
    }
    if (Number(r.phase) === 1 && !r.entropyRevealed) {
      const available = await beacon.isRoundAvailable(r.targetDrandRound);
      if (!available) {
        console.log(`round ${id} not yet due for reveal (targetDrandRound ${r.targetDrandRound} not available) -- nothing to do`);
        return;
      }
      await (await crash.revealEntropy(id)).wait();
      console.log(`revealed entropy for round ${id} (used whatever randomness was already set -- rig-crash first if you wanted a specific outcome)`);
      return;
    }
    if (Number(r.phase) === 1 && r.entropyRevealed) {
      const maxElapsed = await crash.maxElapsedBlocks();
      const effective = r.trueCrashElapsedBlocks < maxElapsed ? r.trueCrashElapsedBlocks : maxElapsed;
      const blockNow = await ethers.provider.getBlockNumber();
      if (BigInt(blockNow) - r.lockBlock >= effective) {
        await (await crash.settleRound(id)).wait();
        console.log(`settled round ${id}`);
      } else {
        console.log(`round ${id} revealed, crash point not reached yet (need block ${r.lockBlock + effective}, at ${blockNow})`);
      }
      return;
    }
    console.log(`round ${id} is phase ${r.phase} -- nothing to do (next round opens automatically on settle)`);
    return;
  }

  console.log(`unknown RIG_CMD "${cmd}". See the usage comment at the top of scripts/test-rig.ts.`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
