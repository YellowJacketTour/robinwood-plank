import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";

/**
 * PlankProgression in isolation -- no PlankCrashDrand/FuelBooster/Powerboard
 * involved, since this contract's own correctness (rank thresholds, cap and
 * premium derivation, access control on the record* functions) doesn't
 * depend on them. The integration itself (placeBet actually calling this,
 * the premium actually landing in the Vault) is covered separately in
 * PlankCrashDrand.progression.test.ts against the real crash contract.
 */
describe("PlankProgression", () => {
  const RANK = {
    Sapling: 0,
    Stick: 1,
    Board: 2,
    Plank: 3,
    BigBeam: 4,
    WoodenWhale: 5,
  };

  async function deploy() {
    const [deployer, player, crashStandIn, fuelStandIn, pbStandIn] = await ethers.getSigners();
    // Tests act AS the "crash"/"fuelBooster"/"powerboard" callers directly
    // (ordinary EOAs standing in for what would be contract addresses in
    // production) -- onlyCrash/onlyFuelBooster/onlyPowerboard only check
    // msg.sender, so this exercises the exact same access-control path.
    const progression = await (
      await ethers.getContractFactory("PlankProgression")
    ).deploy(crashStandIn.address, fuelStandIn.address, pbStandIn.address);
    return { progression, deployer, player, crashStandIn, fuelStandIn, pbStandIn };
  }

  it("starts every wallet at Sapling with the Sapling cap and premium", async () => {
    const { progression, player } = await deploy();
    expect(await progression.rankOf(player.address)).to.equal(RANK.Sapling);
    expect(await progression.capFor(player.address)).to.equal(ethers.parseEther("0.02"));
    expect(await progression.premiumBpsFor(player.address, ethers.parseEther("1"))).to.equal(1500n);
  });

  it("exempts any bet at or below the first-bet threshold from the premium, regardless of rank", async () => {
    const { progression, player } = await deploy();
    const exempt = await progression.FIRST_BET_EXEMPT_WEI();
    expect(await progression.premiumBpsFor(player.address, exempt)).to.equal(0n);
    expect(await progression.premiumBpsFor(player.address, exempt + 1n)).to.equal(1500n);
  });

  it("only the wired crash address can record a bet", async () => {
    const { progression, player, deployer } = await deploy();
    await expect(progression.connect(deployer).recordBet(player.address, 1n)).to.be.revertedWithCustomError(
      progression,
      "NotAuthorizedSource"
    );
  });

  it("only the wired fuelBooster address can record a fuel burn", async () => {
    const { progression, player, deployer } = await deploy();
    await expect(progression.connect(deployer).recordFuelBurn(player.address)).to.be.revertedWithCustomError(
      progression,
      "NotAuthorizedSource"
    );
  });

  it("only the wired powerboard address can record a ticket claim", async () => {
    const { progression, player, deployer } = await deploy();
    await expect(progression.connect(deployer).recordPowerboardClaim(player.address)).to.be.revertedWithCustomError(
      progression,
      "NotAuthorizedSource"
    );
  });

  it("reaches Stick once rounds AND wagered volume both clear their floor -- not either alone", async () => {
    const { progression, player, crashStandIn } = await deploy();
    const stickRounds = await progression.STICK_ROUNDS();
    const stickWagered = await progression.STICK_WAGERED();

    // Enough rounds, not enough volume yet -- still Sapling.
    for (let i = 0n; i < stickRounds; i++) {
      await progression.connect(crashStandIn).recordBet(player.address, 1n);
    }
    expect(await progression.rankOf(player.address)).to.equal(RANK.Sapling);

    // One more bet that finally clears the wagered floor too -- now Stick.
    await progression.connect(crashStandIn).recordBet(player.address, stickWagered);
    expect(await progression.rankOf(player.address)).to.equal(RANK.Stick);
  });

  it("Plank requires Board-level wagered volume AND at least one fuel burn", async () => {
    const { progression, player, crashStandIn, fuelStandIn } = await deploy();
    const plankWagered = await progression.PLANK_WAGERED();
    const boardRounds = await progression.BOARD_ROUNDS();

    for (let i = 0n; i < boardRounds; i++) {
      const perRound: bigint = plankWagered / boardRounds + 1n;
      await progression.connect(crashStandIn).recordBet(player.address, perRound);
    }
    // Wagered + rounds clear Board's own floor, but no fuel burn yet.
    expect(await progression.rankOf(player.address)).to.equal(RANK.Board);

    await progression.connect(fuelStandIn).recordFuelBurn(player.address);
    expect(await progression.rankOf(player.address)).to.equal(RANK.Plank);
  });

  it("Big Beam requires a Powerboard claim on top of Plank's own requirements", async () => {
    const { progression, player, crashStandIn, fuelStandIn, pbStandIn } = await deploy();
    const bigBeamWagered = await progression.BIG_BEAM_WAGERED();

    await progression.connect(crashStandIn).recordBet(player.address, bigBeamWagered);
    await progression.connect(fuelStandIn).recordFuelBurn(player.address);
    expect(await progression.rankOf(player.address)).to.equal(RANK.Plank);

    await progression.connect(pbStandIn).recordPowerboardClaim(player.address);
    expect(await progression.rankOf(player.address)).to.equal(RANK.BigBeam);
  });

  it("Wooden Whale additionally requires real tenure -- cannot be bought in one block", async () => {
    const { progression, player, crashStandIn, fuelStandIn, pbStandIn } = await deploy();
    const whaleWagered = await progression.WOODEN_WHALE_WAGERED();

    await progression.connect(crashStandIn).recordBet(player.address, whaleWagered);
    await progression.connect(fuelStandIn).recordFuelBurn(player.address);
    await progression.connect(pbStandIn).recordPowerboardClaim(player.address);
    // Every non-time condition satisfied in the same block -- still capped at BigBeam.
    expect(await progression.rankOf(player.address)).to.equal(RANK.BigBeam);

    const tenure = await progression.WOODEN_WHALE_TENURE();
    await networkHelpers.time.increase(Number(tenure) + 1);
    expect(await progression.rankOf(player.address)).to.equal(RANK.WoodenWhale);
    expect(await progression.capFor(player.address)).to.equal(ethers.MaxUint256);
    expect(await progression.premiumBpsFor(player.address, whaleWagered)).to.equal(0n);
  });

  it("wageredNeededForNextRank reports the real remaining gap and 0 at max rank", async () => {
    const { progression, player, crashStandIn, fuelStandIn, pbStandIn } = await deploy();
    const stickWagered = await progression.STICK_WAGERED();
    expect(await progression.wageredNeededForNextRank(player.address)).to.equal(stickWagered);

    await progression.connect(crashStandIn).recordBet(player.address, stickWagered / 2n);
    expect(await progression.wageredNeededForNextRank(player.address)).to.equal(stickWagered - stickWagered / 2n);

    // Drive to Wooden Whale, confirm the getter bottoms out at 0.
    const whaleWagered = await progression.WOODEN_WHALE_WAGERED();
    await progression.connect(crashStandIn).recordBet(player.address, whaleWagered);
    await progression.connect(fuelStandIn).recordFuelBurn(player.address);
    await progression.connect(pbStandIn).recordPowerboardClaim(player.address);
    await networkHelpers.time.increase(Number(await progression.WOODEN_WHALE_TENURE()) + 1);
    expect(await progression.rankOf(player.address)).to.equal(RANK.WoodenWhale);
    expect(await progression.wageredNeededForNextRank(player.address)).to.equal(0n);
  });

  it("tracks each wallet independently -- one player's history never leaks into another's", async () => {
    const { progression, player, crashStandIn } = await deploy();
    const [, , , , , otherPlayer] = await ethers.getSigners();
    const stickWagered = await progression.STICK_WAGERED();
    const stickRounds = await progression.STICK_ROUNDS();

    for (let i = 0n; i < stickRounds; i++) {
      await progression.connect(crashStandIn).recordBet(player.address, stickWagered / stickRounds + 1n);
    }
    expect(await progression.rankOf(player.address)).to.equal(RANK.Stick);
    expect(await progression.rankOf(otherPlayer.address)).to.equal(RANK.Sapling);
  });
});
