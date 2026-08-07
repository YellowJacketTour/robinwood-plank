import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import fs from "node:fs";
import path from "node:path";

/**
 * F-1 — drand round numbering, checked against drand's REAL convention rather
 * than against the contract's own view of it.
 *
 * drand publishes round 1 AT genesis_time, so
 *
 *     TimeOfRound(r) = genesis + (r - 1) * period
 *     RoundAt(t)     = floor((t - genesis) / period) + 1        (t >= genesis)
 *
 * The pre-existing test "the target round is in the future at request time"
 * compares the vault's target against `beacon.currentRoundAt(...)` — the
 * contract's OWN formula — so it passes whether or not that formula is right.
 * Every assertion below computes the expected round with the formula above, in
 * TypeScript, from real published drand data, and never asks the contract what
 * it thinks the current round is.
 */

const FIXTURE = path.join(import.meta.dirname, "fixtures", "drand-round.json");

/** drand's real round_at(t), computed independently of any contract. */
function roundAt(t: number, genesis: number, period: number): number {
  if (t < genesis) return 0;
  return Math.floor((t - genesis) / period) + 1;
}

/** drand's real TimeOfRound(r), computed independently of any contract. */
function timeOfRound(r: number, genesis: number, period: number): number {
  return genesis + (r - 1) * period;
}

describe("DrandBeacon — round numbering matches drand's real convention (F-1)", () => {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const GENESIS: number = fx.genesis;
  const PERIOD: number = fx.period;

  async function deployRealBeacon() {
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    return (await Beacon.deploy(
      fx.chainHash,
      fx.publicKey.map((v: string) => BigInt(v)),
      BigInt(GENESIS),
      BigInt(PERIOD),
      ethers.toUtf8Bytes(fx.domain)
    )) as any;
  }

  it("the fixture itself is self-consistent with drand's published schedule", () => {
    // Ground truth: round 19229507 of evmnet is published at 1785209593.
    // genesis + (19229507 - 1) * 3 == 1785209593. This is the anchor the rest
    // of the file leans on, asserted here so a bad fixture can't hide a bug.
    expect(timeOfRound(fx.round, GENESIS, PERIOD)).to.equal(1785209593);
    expect(roundAt(1785209593, GENESIS, PERIOD)).to.equal(fx.round);
  });

  it("currentRoundAt agrees with drand's round_at at and around real round boundaries", async () => {
    const beacon = await deployRealBeacon();
    const anchor = timeOfRound(fx.round, GENESIS, PERIOD);

    const probes = [
      GENESIS, // round 1 is published AT genesis
      GENESIS + 1,
      GENESIS + PERIOD,
      GENESIS + PERIOD * 10 + 2,
      anchor - 1,
      anchor, // the exact instant the fixture's round is published
      anchor + 1,
      anchor + PERIOD,
    ];

    for (const t of probes) {
      expect(await beacon.currentRoundAt(t)).to.equal(
        BigInt(roundAt(t, GENESIS, PERIOD)),
        `currentRoundAt(${t}) disagrees with drand's round_at`
      );
    }

    // The fixture's real round, at its real publication instant, must be the
    // round the contract calls current. Under the off-by-one it is one less.
    expect(await beacon.currentRoundAt(anchor)).to.equal(BigInt(fx.round));

    // Before genesis stays 0 (no round exists yet) and never underflows.
    expect(await beacon.currentRoundAt(GENESIS - 1)).to.equal(0n);
    expect(await beacon.currentRoundAt(0)).to.equal(0n);
  });

  it("nextRoundAfter is the first round whose publication time is strictly after t", async () => {
    const beacon = await deployRealBeacon();
    const anchor = timeOfRound(fx.round, GENESIS, PERIOD);

    for (const t of [GENESIS, GENESIS + 1, anchor - 1, anchor, anchor + 2]) {
      const next: bigint = await beacon.nextRoundAfter(t);
      // Independent definition, not "current + 1".
      expect(timeOfRound(Number(next), GENESIS, PERIOD)).to.be.greaterThan(
        t,
        `nextRoundAfter(${t}) returned a round already published at t`
      );
      expect(timeOfRound(Number(next) - 1, GENESIS, PERIOD)).to.be.lessThanOrEqual(
        t,
        `nextRoundAfter(${t}) skipped an unpublished round`
      );
    }
  });
});

describe("MarketplankVault — the request's real lead over drand's wall clock (F-1)", () => {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const GENESIS: number = fx.genesis;
  const PERIOD: number = fx.period;

  it("a request targets a round at least ROUND_LEAD+1 full periods in the future by drand's own clock", async () => {
    const [, treasury, alice] = await ethers.getSigners();
    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft: any = await Nft.deploy();
    // The REAL beacon on the REAL evmnet schedule — no mock, so the schedule
    // under test is the one that will be deployed.
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    const beacon: any = await Beacon.deploy(
      fx.chainHash,
      fx.publicKey.map((v: string) => BigInt(v)),
      BigInt(GENESIS),
      BigInt(PERIOD),
      ethers.toUtf8Bytes(fx.domain)
    );
    const Vault = await ethers.getContractFactory("MarketplankVault");
    const vault: any = await Vault.deploy(
      await nft.getAddress(),
      "V",
      "V",
      0,
      0,
      0,
      treasury.address,
      await beacon.getAddress()
    );

    for (const id of [1, 2, 3]) {
      await nft.mint(alice.address, id);
      await nft.connect(alice).approve(await vault.getAddress(), id);
      await vault.connect(alice).deposit(id);
    }

    const tx = await vault.connect(alice).requestRandomRedeem();
    const rcpt = await tx.wait();
    const block = await ethers.provider.getBlock(rcpt!.blockNumber);
    const t = block!.timestamp;

    const [target] = await vault.pendingRound();
    const targetNum = Number(target);

    // The round that is current at request time, per drand — NOT per the
    // contract. This is the whole point: the old test asked the contract.
    const nowRound = roundAt(t, GENESIS, PERIOD);

    // ROUND_LEAD = 1, so target = currentRound + 2: one round to get past
    // "already published", one more for the documented safety margin.
    expect(targetNum - nowRound).to.be.greaterThanOrEqual(
      2,
      "the target round does not carry the full documented lead over drand's real clock"
    );

    // The same margin in seconds. A request lands at an arbitrary offset d in
    // [0, period) past its current round's publication, so the wall-clock gap
    // to round (current + 2) is 2*period - d: at most 2 periods, and STRICTLY
    // MORE THAN ONE period in the worst case. That worst case is the number
    // that matters — it is the amount of chain-clock lag the design tolerates
    // before the target round could already be public at request time.
    //
    // Under the off-by-one the target was (current + 1), so the same worst case
    // was period - d, i.e. it could be arbitrarily close to ZERO. That is the
    // gap this assertion closes.
    const margin = timeOfRound(targetNum, GENESIS, PERIOD) - t;
    expect(margin).to.be.greaterThan(
      PERIOD,
      "worst-case wall-clock margin before the target round publishes is not more than one full period"
    );
    expect(margin).to.be.lessThanOrEqual(2 * PERIOD);

    // And it is unambiguously unpublished right now by drand's own schedule.
    expect(timeOfRound(targetNum, GENESIS, PERIOD)).to.be.greaterThan(t);
  });
});
