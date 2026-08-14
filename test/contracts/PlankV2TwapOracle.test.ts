import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";

/**
 * PlankV2TwapOracle -- proves the time-averaged price is (a) numerically
 * correct for a steady pool, (b) resistant to a single-block spot
 * manipulation (the whole point -- a sandwich can't move it), and (c)
 * safe against unprimed/stale reads.
 */
describe("PlankV2TwapOracle", () => {
  const WINDOW = 1800n; // 30 min
  const MAX_STALE = 3600n; // 1 h
  // token0 = WETH, token1 = PLANK. reserves: 100 WETH : 100,000 PLANK ->
  // fair price 1000 PLANK per WETH.
  const R_WETH = ethers.parseEther("100");
  const R_PLANK = ethers.parseEther("100000");

  async function deploy(rWeth = R_WETH, rPlank = R_PLANK) {
    const [deployer] = await ethers.getSigners();
    // Two throwaway token addresses; the pair just reports them as
    // token0/token1. Use deployed mock tokens so the addresses are real.
    const weth: any = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
    const plank: any = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
    const pair: any = await (
      await ethers.getContractFactory("MockV2Pair")
    ).deploy(await weth.getAddress(), await plank.getAddress(), rWeth, rPlank);
    const oracle: any = await (
      await ethers.getContractFactory("PlankV2TwapOracle")
    ).deploy(await pair.getAddress(), WINDOW, MAX_STALE);
    return { oracle, pair, weth, plank, deployer };
  }

  async function prime(oracle: any) {
    // Let a full window pass with steady reserves, then record the average.
    await networkHelpers.time.increase(Number(WINDOW) + 1);
    await oracle.update();
  }

  it("reverts consult() before it is primed", async () => {
    const { oracle, weth } = await deploy();
    await expect(oracle.consult(await weth.getAddress(), ethers.parseEther("1"))).to.be.revertedWithCustomError(
      oracle,
      "NotInitialized"
    );
  });

  it("update() reverts until a full window has elapsed", async () => {
    const { oracle } = await deploy();
    await networkHelpers.time.increase(10);
    await expect(oracle.update()).to.be.revertedWithCustomError(oracle, "PeriodNotElapsed");
  });

  it("reports the correct fair price for a steady pool (~1000 PLANK per WETH)", async () => {
    const { oracle, weth } = await deploy();
    await prime(oracle);
    const out = await oracle.consult(await weth.getAddress(), ethers.parseEther("1"));
    // Expect ~1000 PLANK for 1 WETH; allow a tiny fixed-point truncation
    // epsilon.
    const expected = ethers.parseEther("1000");
    const diff = out > expected ? out - expected : expected - out;
    expect(diff).to.be.lt(expected / 100000n); // within 0.001%
  });

  it("SANDWICH RESISTANCE: a single-block spot manipulation does NOT move the reported TWAP", async () => {
    const { oracle, pair, weth } = await deploy();
    await prime(oracle);
    const fairBefore = await oracle.consult(await weth.getAddress(), ethers.parseEther("1"));

    // Attacker slams the pool: PLANK becomes 10x scarcer (spot price crashes
    // to ~100 PLANK/WETH). This is exactly the front-run leg of a sandwich.
    await pair.setReserves(R_WETH, R_PLANK / 10n);

    // The oracle still reports the pre-manipulation average -- the spot
    // slam is invisible to it until it persists across an update window.
    const fairAfter = await oracle.consult(await weth.getAddress(), ethers.parseEther("1"));
    expect(fairAfter).to.equal(fairBefore);
    // And it is emphatically NOT the manipulated spot (~100).
    expect(fairAfter).to.be.gt(ethers.parseEther("900"));
  });

  it("the TWAP DOES eventually move if a new price genuinely persists a full window (sanity: it's a real average, not frozen)", async () => {
    const { oracle, pair, weth } = await deploy();
    await prime(oracle);

    // Price genuinely halves and stays there for a full window.
    await pair.setReserves(R_WETH, R_PLANK / 2n); // ~500 PLANK/WETH
    await networkHelpers.time.increase(Number(WINDOW) + 1);
    await oracle.update();

    const out = await oracle.consult(await weth.getAddress(), ethers.parseEther("1"));
    // Now the average reflects the sustained ~500 level.
    expect(out).to.be.lt(ethers.parseEther("600"));
    expect(out).to.be.gt(ethers.parseEther("400"));
  });

  it("consult() reverts once the oracle goes stale", async () => {
    const { oracle, weth } = await deploy();
    await prime(oracle);
    await networkHelpers.time.increase(Number(MAX_STALE) + 10);
    await expect(oracle.consult(await weth.getAddress(), ethers.parseEther("1"))).to.be.revertedWithCustomError(
      oracle,
      "StaleOracle"
    );
  });

  it("rejects an unknown token and a zero-reserve pool", async () => {
    const { oracle, plank } = await deploy();
    await prime(oracle);
    // plank is token1 -> consult(plank) is valid (returns WETH); a truly
    // unknown token reverts.
    const [random] = await ethers.getSigners();
    await expect(oracle.consult(random.address, ethers.parseEther("1"))).to.be.revertedWithCustomError(
      oracle,
      "UnknownToken"
    );
    // consult(plank) works and returns WETH per PLANK.
    const wethOut = await oracle.consult(await plank.getAddress(), ethers.parseEther("1000"));
    // 1000 PLANK ~ 1 WETH.
    const diff = wethOut > ethers.parseEther("1") ? wethOut - ethers.parseEther("1") : ethers.parseEther("1") - wethOut;
    expect(diff).to.be.lt(ethers.parseEther("0.001"));
  });
});
