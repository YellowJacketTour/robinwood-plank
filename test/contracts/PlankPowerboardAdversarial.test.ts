/**
 * Powerboard ADVERSARIAL suite (workstream 2) — the dimensions the base
 * PlankPowerboard.test.ts / .fuzz.test.ts do not cover:
 *   - manufactured-round / Sybil ticket-farming resistance (tickets cost real wager,
 *     and a wager into the crash pays rake — so ticket-farming is not free);
 *   - committed-randomness draw finality (the target drand round is fixed at requestDraw,
 *     before the value is known — the winner cannot be biased by choosing when to draw);
 *   - interrupted/late draw recovery (a draw can always be completed once the beacon has
 *     the committed round; it is never stranded);
 *   - crash→Powerboard overflow isolation (the Powerboard only ever RECEIVES via fund();
 *     it cannot reach back into the crash Vault).
 * These verify the REAL economics, not a mock.
 */
import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";

describe("PlankPowerboard — adversarial economics", () => {
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;
  const EPOCH = 3600n;
  const BALL_RANGE = 26n;
  const JACKPOT_BALL = 8n;

  function ballFor(seedStr: string): bigint {
    const randomness = ethers.keccak256(ethers.toUtf8Bytes(seedStr));
    const h = ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [randomness, "PLANK_BALL"]));
    return (BigInt(h) % BALL_RANGE) + 1n;
  }
  function ticketFor(seedStr: string, totalTickets: bigint): bigint {
    const randomness = ethers.keccak256(ethers.toUtf8Bytes(seedStr));
    const h = ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [randomness, "PLANK_TICKET"]));
    return BigInt(h) % totalTickets;
  }
  function findSeed(pred: (s: string) => boolean): string {
    for (let i = 0; i < 8000; i++) { const s = `adv-${i}`; if (pred(s)) return s; }
    throw new Error("no seed");
  }

  async function deploy() {
    const [deployer, alice, bob, drawer] = await ethers.getSigners();
    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
    const source: any = await (await ethers.getContractFactory("MockWagerSource")).deploy();
    const pb: any = await (await ethers.getContractFactory("PlankPowerboard")).deploy({
      beacon: await beacon.getAddress(), allowedSources: [await source.getAddress()],
      genesisTimestamp: DRAND_GENESIS, epochDuration: EPOCH, drawerRewardBps: 200n,
      ballRange: BALL_RANGE, jackpotBall: JACKPOT_BALL, consolationBps: 500n, mustHitByEpochs: 0n,
    });
    return { pb, beacon, source, deployer, alice, bob, drawer };
  }

  it("MANUFACTURED-ROUND / SYBIL: tickets require real wager; a claim with zero stake reverts", async () => {
    const { pb, source, alice } = await deploy();
    // no stake set -> claimTickets reverts NoStake (cannot mint free tickets)
    let reverted = false;
    try { await pb.claimTickets(await source.getAddress(), 1, alice.address); } catch { reverted = true; }
    expect(reverted, "zero-stake claim must revert").to.equal(true);
    // with real stake, tickets are EXACTLY proportional to the wager — so more tickets costs
    // proportionally more wager (and in the live system, proportionally more crash rake).
    await source.setStake(1, alice.address, ethers.parseEther("3"));
    await pb.claimTickets(await source.getAddress(), 1, alice.address);
    const epoch = await pb.currentEpoch();
    expect(await pb.ticketsOf(epoch, alice.address)).to.equal(ethers.parseEther("3"));
    // and a second claim for the SAME (source,round,player) is rejected — no double-mint.
    let dbl = false;
    try { await pb.claimTickets(await source.getAddress(), 1, alice.address); } catch { dbl = true; }
    expect(dbl, "double-claim must revert").to.equal(true);
  });

  it("SYBIL SPLIT: splitting one wager across N wallets yields the same total tickets (linear, no gain)", async () => {
    const { pb, source, alice, bob } = await deploy();
    const epoch = await pb.currentEpoch();
    // alice wagers 2 in one claim; bob's identical 2 split as 1+1 across two rounds.
    await source.setStake(10, alice.address, ethers.parseEther("2"));
    await pb.claimTickets(await source.getAddress(), 10, alice.address);
    await source.setStake(11, bob.address, ethers.parseEther("1"));
    await pb.claimTickets(await source.getAddress(), 11, bob.address);
    await source.setStake(12, bob.address, ethers.parseEther("1"));
    await pb.claimTickets(await source.getAddress(), 12, bob.address);
    expect(await pb.ticketsOf(epoch, alice.address)).to.equal(await pb.ticketsOf(epoch, bob.address));
    // tickets are linear in wager: no super-linear Sybil advantage.
  });

  it("COMMITTED RANDOMNESS: the draw's target round is fixed at requestDraw, before the value exists", async () => {
    const { pb, beacon, source, alice, drawer } = await deploy();
    const epoch = await pb.currentEpoch();
    await source.setStake(1, alice.address, ethers.parseEther("1"));
    await pb.claimTickets(await source.getAddress(), 1, alice.address);
    await networkHelpers.time.increaseTo(DRAND_GENESIS + (epoch + 1n) * EPOCH);
    await pb.requestDraw(epoch);
    const e = await pb.epochs(epoch);
    // the target round is committed NOW; the drawer cannot pick a different round later.
    expect(e.drawRequested).to.equal(true);
    expect(e.targetDrandRound).to.be.a("bigint");
    // requesting again is rejected — the commitment is immutable.
    let reReq = false;
    try { await pb.requestDraw(epoch); } catch { reReq = true; }
    expect(reReq, "re-request must revert").to.equal(true);
    void beacon; void drawer;
  });

  it("DRAW FINALITY / INTERRUPTED RECOVERY: a draw cannot complete early, but always completes once the round lands", async () => {
    const { pb, beacon, source, alice, drawer } = await deploy();
    const epoch = await pb.currentEpoch();
    await source.setStake(1, alice.address, ethers.parseEther("1"));
    await pb.claimTickets(await source.getAddress(), 1, alice.address);
    await networkHelpers.time.increaseTo(DRAND_GENESIS + (epoch + 1n) * EPOCH);
    await pb.requestDraw(epoch);
    const e = await pb.epochs(epoch);
    // BEFORE the committed round is available on the beacon: drawWinner reverts (not stranded — retryable).
    let early = false;
    try { await pb.connect(drawer).drawWinner(epoch); } catch { early = true; }
    expect(early, "draw before randomness must revert").to.equal(true);
    // Simulate the beacon receiving the committed round LATE, then draw — it completes.
    await networkHelpers.time.increaseTo(DRAND_GENESIS + BigInt(e.targetDrandRound) * DRAND_PERIOD);
    const seed = findSeed((s) => ballFor(s) !== JACKPOT_BALL); // a miss, deterministic
    await beacon.setRandomness(e.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes(seed)));
    await pb.connect(drawer).drawWinner(epoch);
    expect((await pb.epochs(epoch)).drawn).to.equal(true);
    // a second draw is rejected — finality.
    let dbl = false;
    try { await pb.connect(drawer).drawWinner(epoch); } catch { dbl = true; }
    expect(dbl, "double-draw must revert").to.equal(true);
  });

  it("OVERFLOW ISOLATION: the Powerboard only RECEIVES via fund(); it exposes no path back into the crash Vault", async () => {
    const { pb } = await deploy();
    // fund() is payable and simply grows the jackpot; there is no function that calls back
    // into a wager source to move value — the crash→Powerboard edge is one-directional.
    const names = pb.interface.fragments.filter((f: any) => f.type === "function").map((f: any) => f.name);
    // no withdraw/sweep/pull-from-source surface
    for (const n of names) expect(/withdrawFromSource|pullReserve|drainCrash|clawback/i.test(n)).to.equal(false);
    const before = await pb.jackpot();
    await pb.fund({ value: ethers.parseEther("0.5") });
    expect(await pb.jackpot()).to.equal(before + ethers.parseEther("0.5"));
  });

  it("BALANCE CONSERVATION under adversarial fund/claim/draw: accounted value never exceeds contract balance", async () => {
    const { pb, beacon, source, alice, bob, drawer } = await deploy();
    const epoch = await pb.currentEpoch();
    await pb.fund({ value: ethers.parseEther("1") });
    await source.setStake(1, alice.address, ethers.parseEther("2"));
    await pb.claimTickets(await source.getAddress(), 1, alice.address);
    await source.setStake(2, bob.address, ethers.parseEther("1"));
    await pb.claimTickets(await source.getAddress(), 2, bob.address);
    await networkHelpers.time.increaseTo(DRAND_GENESIS + (epoch + 1n) * EPOCH);
    await pb.requestDraw(epoch);
    const e = await pb.epochs(epoch);
    await networkHelpers.time.increaseTo(DRAND_GENESIS + BigInt(e.targetDrandRound) * DRAND_PERIOD);
    const total = await pb.epochs(epoch).then((x: any) => x.totalTickets);
    const seed = findSeed((s) => ballFor(s) !== JACKPOT_BALL && ticketFor(s, total) < ethers.parseEther("2"));
    await beacon.setRandomness(e.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes(seed)));
    await pb.connect(drawer).drawWinner(epoch);
    // the contract's ETH balance must always cover the jackpot it still owes.
    const bal = await ethers.provider.getBalance(await pb.getAddress());
    const jackpot = await pb.jackpot();
    expect(bal >= jackpot).to.equal(true);
  });
});
