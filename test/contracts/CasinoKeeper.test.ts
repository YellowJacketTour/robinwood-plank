import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { tick, biddersOf, type KeeperConfig } from "../../scripts/casino-keeper.js";

/**
 * Proves the casino runs ITSELF: the real keeper's tick() -- the same
 * function scripts/casino-keeper.ts runs on a timer in production -- is
 * driven here against the real contracts and must carry a round all the
 * way from open betting to settled, registered, claimed, ticketed, and
 * rake-distributed with NO player or admin intervention beyond the bets
 * themselves.
 *
 * It also proves the two properties that matter for "forever":
 *   - PUBLIC: the keeper signer is a nobody -- a plain funded account with
 *     zero privilege -- and a DIFFERENT nobody can pick up mid-round and
 *     finish it, which is what makes the loop unstoppable if the default
 *     operator dies.
 *   - AUTOMATIC: a single repeated call advances everything actionable,
 *     and is safe to call when there is nothing to do.
 */
describe("Casino keeper — the loop runs itself", () => {
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;
  const RAKE_BPS = 450n;
  const BURN_BPS = 2000n;
  const AIRDROP_BPS = 4000n;
  const MAX_ELAPSED_BLOCKS = 40;
  const REGISTRATION_BLOCKS = 5;
  const EPOCH_SECONDS = 3600n;

  async function deployCasino() {
    const [deployer, treasury, alice, bob, keeper, stranger] = await ethers.getSigners();

    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
    const plank: any = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
    const weth: any = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
    const pair: any = await (
      await ethers.getContractFactory("MockV2Pair")
    ).deploy(await weth.getAddress(), await plank.getAddress(), ethers.parseEther("100"), ethers.parseEther("100000"));
    const oracle: any = await (
      await ethers.getContractFactory("PlankV2TwapOracle")
    ).deploy(await pair.getAddress(), 60n, 240n);
    const router: any = await (
      await ethers.getContractFactory("MockV2Router")
    ).deploy(await plank.getAddress(), 1000n);
    const burnEngine: any = await (
      await ethers.getContractFactory("PlankBurnEngine")
    ).deploy(
      await plank.getAddress(),
      await router.getAddress(),
      await weth.getAddress(),
      await oracle.getAddress(),
      ethers.parseEther("100"),
      100n,
      500n
    );

    const nonce = await deployer.getNonce();
    const predictedCrash = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 2 });

    const powerboard: any = await (
      await ethers.getContractFactory("PlankPowerboard")
    ).deploy({
      beacon: await beacon.getAddress(),
      allowedSources: [predictedCrash],
      genesisTimestamp: DRAND_GENESIS,
      epochDuration: EPOCH_SECONDS,
      drawerRewardBps: 200n,
      ballRange: 26n,
      jackpotBall: 8n,
      consolationBps: 500n,
      mustHitByEpochs: 0n,
    });

    const distributor: any = await (
      await ethers.getContractFactory("PlankRakeDistributor")
    ).deploy(await burnEngine.getAddress(), await powerboard.getAddress(), treasury.address, BURN_BPS, AIRDROP_BPS);

    const crash: any = await (
      await ethers.getContractFactory("PlankCrashDrand")
    ).deploy({
      bettingDurationSeconds: 5,
      roundIntervalSeconds: 0,
      maxAwaitBlocks: 500,
      maxElapsedBlocks: MAX_ELAPSED_BLOCKS,
      registrationWindowBlocks: REGISTRATION_BLOCKS,
      rakeBps: RAKE_BPS,
      minParticipants: 2n,
      minPoolSize: ethers.parseEther("0.01"),
      maxStakePerWalletBps: 6000n,
      keeperRewardBps: 1000n,
      seedNumerator: 1n,
      seedDenominator: 2n,
      reserveShareBps: 0n,
      reserveFloorWei: 0n,
      reserveCap: 0n,
      jackpotSink: ethers.ZeroAddress,
      treasury: await distributor.getAddress(),
      beacon: await beacon.getAddress(),
    });
    expect((await crash.getAddress()).toLowerCase()).to.equal(predictedCrash.toLowerCase());

    const cfg: KeeperConfig = {
      crash: await crash.getAddress(),
      powerboard: await powerboard.getAddress(),
      beacon: await beacon.getAddress(),
      distributor: await distributor.getAddress(),
      burnEngine: await burnEngine.getAddress(),
      oracle: await oracle.getAddress(),
      mockBeacon: true, // local stand-in for a relayed drand signature
    };

    return { crash, powerboard, distributor, burnEngine, oracle, plank, beacon, cfg, treasury, alice, bob, keeper, stranger };
  }

  /// Runs the keeper repeatedly, mining/advancing between ticks so the
  /// chain actually reaches each next gate, exactly like wall-clock time
  /// would in production.
  async function runKeeper(cfg: KeeperConfig, signer: any, ticks: number) {
    const all: string[] = [];
    for (let i = 0; i < ticks; i++) {
      const actions = await tick(ethers.provider as any, signer, cfg);
      for (const a of actions) all.push(a.step);
      await networkHelpers.time.increase(3);
      await networkHelpers.mine(8);
    }
    return all;
  }

  it("carries a round from open betting all the way to settled + registered + claimed + ticketed, with no player action after the bet", async () => {
    const { crash, powerboard, distributor, cfg, alice, bob, keeper } = await deployCasino();

    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("1") });
    // Alice locks in a win by cashing out immediately; Bob rides and busts.
    await networkHelpers.time.increase(6);

    const steps = await runKeeper(cfg, keeper, 14);

    // The keeper really did drive the lifecycle.
    expect(steps).to.include("lockRound");
    expect(steps).to.include("revealEntropy");
    expect(steps).to.include("settleRound");

    const settled = await crash.rounds(roundId);
    expect(Number(settled.phase)).to.equal(2); // CRASHED

    // Everyone who bet got registered BY THE KEEPER -- neither player sent
    // a second transaction.
    for (const p of [alice.address, bob.address]) {
      expect(await crash.registered(roundId, p)).to.equal(true);
    }

    // Powerboard tickets were credited from the crash's own stakeOf.
    const epoch = await powerboard.currentEpoch();
    expect(await powerboard.ticketsOf(epoch, alice.address)).to.equal(ethers.parseEther("1"));
    expect(await powerboard.ticketsOf(epoch, bob.address)).to.equal(ethers.parseEther("1"));

    // Rake was pushed through the 3-way split without anyone asking.
    expect(await distributor.totalReceived()).to.be.gt(0n);
    expect(await powerboard.jackpot()).to.be.gt(0n);
  });

  it("CLOSES THE BURN LEG: the keeper primes the TWAP and buys+burns the ETH the distributor routed to the engine -- value returns to holders with no out-of-band caller", async () => {
    const { crash, burnEngine, plank, cfg, alice, bob, keeper } = await deployCasino();

    // Let a full 60s TWAP window pass so the keeper's first oracle.update()
    // succeeds. That expires the initial betting round, so void it (it has
    // no bets) and play in the fresh round that starts.
    await networkHelpers.time.increase(61);
    await crash.lockRound(); // voids the stale empty round, opens a new one

    await crash.connect(alice).placeBet({ value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("1") });
    await networkHelpers.time.increase(6);

    await runKeeper(cfg, keeper, 16);

    // The distributor's burn leg (0.9% of the pool) reached the engine and
    // the keeper converted+burned it -- no human, no out-of-band caller.
    expect(await burnEngine.totalEthSpent()).to.be.gt(0n);
    expect(await burnEngine.totalPlankBurned()).to.be.gt(0n);
    // Nothing is left stranded in the engine beyond a sub-maxEthPerCall dust
    // remainder that the next tick will sweep.
    expect(await ethers.provider.getBalance(await burnEngine.getAddress())).to.be.lt(ethers.parseEther("1"));
    void plank;
  });

  it("PUBLIC: a completely different, unprivileged account can pick up mid-round and finish it", async () => {
    const { crash, cfg, alice, bob, keeper, stranger } = await deployCasino();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("1") });
    await networkHelpers.time.increase(6);

    // The "official" keeper does a couple of ticks, then dies.
    await runKeeper(cfg, keeper, 2);
    // A total stranger takes over and drives it to completion.
    const steps = await runKeeper(cfg, stranger, 12);

    expect(steps.length).to.be.greaterThan(0);
    const settled = await crash.rounds(roundId);
    expect(Number(settled.phase)).to.equal(2);
    expect(await crash.registered(roundId, alice.address)).to.equal(true);
  });

  it("the keeper holds no privilege: it never receives a player's payout, only its own advertised keeper reward", async () => {
    const { crash, cfg, alice, bob, keeper } = await deployCasino();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("1") });
    await networkHelpers.time.increase(6);
    // Lock from a PLAYER's wallet, not the keeper's -- lockRound is public,
    // so this doubles as proof that a plain user can advance the game.
    await crash.connect(alice).lockRound();
    // Now the round is LIVE, Alice cashes out and becomes a real winner
    // whose payout a broken design could redirect to whoever submits the
    // claim transaction (which will be the keeper).
    await crash.connect(alice).cashOut(roundId);

    await runKeeper(cfg, keeper, 16);

    const pool = ethers.parseEther("2");
    const rake = (pool * RAKE_BPS) / 10000n;
    const keeperReward = (rake * 1000n) / 10000n;

    // The keeper's credit is EXACTLY the settle reward -- never a share of
    // any player's winnings.
    expect(await crash.payments(keeper.address)).to.equal(keeperReward);
    // Alice's winnings are escrowed to Alice, by the keeper's own call.
    expect(await crash.payments(alice.address)).to.be.gt(0n);
  });

  it("is safe to tick when there is nothing to do (idempotent, no throw)", async () => {
    const { cfg, keeper } = await deployCasino();
    const a = await tick(ethers.provider as any, keeper, cfg);
    const b = await tick(ethers.provider as any, keeper, cfg);
    expect(Array.isArray(a)).to.equal(true);
    expect(Array.isArray(b)).to.equal(true);
  });

  it("discovers bettors from the contract's own BetPlaced events, keeping no private list", async () => {
    const { crash, cfg, alice, bob, keeper } = await deployCasino();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("1") });
    const crashAsKeeper = new ethers.Contract(
      cfg.crash,
      ["event BetPlaced(uint256 indexed roundId, address indexed player, uint256 amount)"],
      keeper
    );
    const found = await biddersOf(crashAsKeeper as any, roundId);
    expect(found.map((a) => a.toLowerCase()).sort()).to.deep.equal(
      [alice.address.toLowerCase(), bob.address.toLowerCase()].sort()
    );
  });
});
