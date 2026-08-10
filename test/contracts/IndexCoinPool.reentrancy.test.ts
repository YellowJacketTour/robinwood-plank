import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";

/**
 * ==========================================================================
 *  IndexCoinPool — audit F-4/F-5/F-6 regressions.
 *
 *  Three assertions, each of which goes RED if the corresponding fix is
 *  reverted. That is the bar this repo's audit set for new tests, after
 *  finding three load-bearing proofs that proved nothing:
 *
 *   1. re-entering `swap` from inside the INPUT pull must revert.
 *      Delete `nonReentrant` and the re-entrant call succeeds -> red.
 *   2. the same swap must SUCCEED with the hostile switch off.
 *      This is the anti-vacuity control: without it, assertion 1 would pass
 *      on a pool that reverts every swap for any reason.
 *   3. a fee-on-transfer input must move the reserve by the OBSERVED delta.
 *      Credit the nominal `amountIn` instead and the reserve claims more
 *      than the pool holds -> red.
 *
 *  LOCAL HARDHAT ONLY.
 * ==========================================================================
 */

const WAD = 10n ** 18n;

async function fixture(feeBps = 0n) {
  const [owner, trader] = await ethers.getSigners();

  const Tok = await ethers.getContractFactory("MockHostileSwapToken");
  const payment: any = await Tok.deploy("PAY", "PAY");
  const coin: any = await Tok.deploy("IDX", "IDX");

  const Pool = await ethers.getContractFactory("IndexCoinPool");
  const pool: any = await Pool.deploy(
    await payment.getAddress(),
    await coin.getAddress(),
    owner.address
  );
  const poolAddr = await pool.getAddress();

  // Seed protocol-owned liquidity: push, then register (the pool's own
  // observed-delta `deploy`).
  await payment.mint(poolAddr, 1_000n * WAD);
  await coin.mint(poolAddr, 1_000n * WAD);
  await pool.connect(owner).deploy(0, 0);

  await payment.mint(trader.address, 100n * WAD);
  await coin.mint(trader.address, 100n * WAD);
  await payment.connect(trader).approve(poolAddr, ethers.MaxUint256);
  await coin.connect(trader).approve(poolAddr, ethers.MaxUint256);

  if (feeBps > 0n) await payment.setFeeBps(feeBps);

  return { owner, trader, payment, coin, pool, poolAddr };
}

describe("IndexCoinPool — reentrancy, CEI and observed-delta (audit F-4/F-5/F-6)", () => {
  it("CONTROL: an ordinary swap succeeds and moves both reserves", async () => {
    const { trader, pool } = await fixture();
    const [p0, c0] = await pool.getReserves();
    await pool.connect(trader).swap(true, 10n * WAD, 0, trader.address);
    const [p1, c1] = await pool.getReserves();
    expect(p1).to.equal(p0 + 10n * WAD);
    expect(c1).to.be.lessThan(c0);
  });

  it("REENTRANCY: a swap re-entered from inside the INPUT pull is rejected", async () => {
    const { trader, payment, pool, poolAddr } = await fixture();

    // The hostile payment token calls back into swap() from transferFrom —
    // exactly the window the missing guard left open, where the pool holds
    // the tokens but has not yet written its reserves.
    await payment.arm(poolAddr, true, false, true, 1n * WAD);
    // The token needs its own balance and allowance to attempt the trade.
    await payment.mint(await payment.getAddress(), 10n * WAD);
    await payment.approve(poolAddr, ethers.MaxUint256);

    const [p0, c0] = await pool.getReserves();
    await pool.connect(trader).swap(true, 10n * WAD, 0, trader.address);

    expect(await payment.reenterAttempts()).to.equal(
      1n,
      "the hostile token never actually attempted the re-entrant call — the test would be vacuous"
    );
    expect(await payment.reenterSucceeded()).to.equal(
      false,
      "the re-entrant swap SUCCEEDED: the reentrancy guard is not doing its job"
    );

    // And the pool is exactly where a single honest trade leaves it: the
    // re-entrant attempt moved nothing.
    const [p1, c1] = await pool.getReserves();
    expect(p1).to.equal(p0 + 10n * WAD);
    expect(c0 - c1).to.be.greaterThan(0n);

    // The reserves the attacker OBSERVED mid-pull were the stale, pre-trade
    // ones — which is precisely why the guard, not the ordering, has to be
    // the defence on this leg. Recorded so the reason is visible, not merely
    // asserted in a comment.
    expect(await payment.seenReservePayment()).to.equal(p0);
    expect(await payment.seenReserveCoin()).to.equal(c0);
  });

  it("SOLVENCY: a fee-on-transfer input credits the OBSERVED delta, never the nominal amount", async () => {
    // 10% burned in flight. A nominal credit would book 10 tokens against 9
    // actually received.
    const { trader, payment, coin, pool, poolAddr } = await fixture(1_000n);

    const [p0] = await pool.getReserves();
    await pool.connect(trader).swap(true, 10n * WAD, 0, trader.address);
    const [p1, c1] = await pool.getReserves();

    expect(p1 - p0).to.equal(9n * WAD, "reserve moved by the nominal amount, not the received amount");

    // The invariant that actually matters: the pool can pay what it claims.
    expect(await payment.balanceOf(poolAddr)).to.be.greaterThanOrEqual(p1);
    expect(await coin.balanceOf(poolAddr)).to.be.greaterThanOrEqual(c1);
  });
});
