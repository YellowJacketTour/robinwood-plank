import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";

import {
  deployOpenIndex,
  armVaultRegistry,
  WAD,
  TIMELOCK,
  MIN_CHECKPOINT,
} from "./helpers/index-vault";

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  DESIGN §1.3 — SETTLEMENT PRICES ARE REALIZABLE-INTEGRAL PRICES.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The claim under test: a deposit into `mintSingleAsset` is credited at
 * `min(band mark, what the constituent's own pool would actually pay for it)`.
 *
 * For a constant-product pool `(x` payment, `y` shares`)` the spot mark of `s`
 * shares is `s·x/y` and the realizable amount is `x·s/(y+s)`. Depositing
 * `s = y/2` therefore realizes exactly `2/3` of its mark. That ratio is the
 * assertion — a number derived from the curve, not chosen.
 *
 * THREE VARIANTS OF THE SAME CONSTITUENT, IDENTICAL IN EVERY OTHER RESPECT:
 *   A — honest thin curve      → the cap BINDS, credit ≈ 2/3 of mark
 *   B — quotes revert          → no curve, credit falls back to the mark
 *   C — quotes inflated 1000x  → lying UP gains nothing, credit == B
 *
 * B is the control that makes A meaningful (without it, "A credits less" could
 * be any unrelated fee). C is the adversarial case that justifies asking an
 * UNTRUSTED address about itself at all: `min` means a lie can only ever
 * short-change the liar.
 *
 * LOCAL HARDHAT ONLY.
 */

const POOL_PAYMENT = 10n * WAD; // x
const POOL_SHARES = 1000n * WAD; // y  =>  price 0.01 ETH per unit
const DEPOSIT = 500n * WAD; // s = y/2  =>  realizable / mark = 2/3

type Mode = "honest" | "noCurve" | "liar";

describe("§1.3 realizable settlement pricing — mintSingleAsset", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  /**
   * Build an opened index, admit ONE extra constituent whose realizable curve
   * is configured per `mode`, and return the shares a fixed deposit mints.
   *
   * A fresh deployment per mode is deliberate: `_mintFeeBps` depends on the
   * basket's current weight vector, so minting all three into one basket would
   * let each mint move the next one's fee and confound the comparison.
   */
  async function sharesFor(mode: Mode): Promise<bigint> {
    const fx = await deployOpenIndex();
    const { vault, vaultAddr, admission, alice } = fx;

    const T = await ethers.getContractFactory("MockRealizableIndexToken");
    const token: any = await T.deploy("cR", "cR");
    const tokenAddr = await token.getAddress();

    const S = await ethers.getContractFactory("MockIndexPriceSource");
    const source: any = await S.deploy(POOL_PAYMENT, POOL_SHARES);

    await token.setPool(POOL_PAYMENT, POOL_SHARES);
    if (mode === "noCurve") await token.setQuotesRevert(true);
    if (mode === "liar") await token.setLieMultiplier(1_000n);

    // Post-open admission now requires provenance (audit C-6).
    await armVaultRegistry(fx, [...fx.addrs, tokenAddr]);

    await vault.connect(admission).queueListing(tokenAddr, await source.getAddress(), 1_000, false);
    await time.increase(TIMELOCK + 1);
    await vault.executeListing(tokenAddr);

    for (let i = 0; i < 3; i++) {
      await time.increase(MIN_CHECKPOINT + 1);
      await vault.checkpointAll();
    }

    await token.mint(alice.address, DEPOSIT * 10n);
    await token.connect(alice).approve(vaultAddr, ethers.MaxUint256);

    const before: bigint = await vault.balanceOf(alice.address);
    await vault.connect(alice).mintSingleAsset(tokenAddr, DEPOSIT, 0n);
    return (await vault.balanceOf(alice.address)) - before;
  }

  it("credits a thin-pool deposit at its realizable value, not its mark (~2/3), while a curveless one still prices at the mark", async () => {
    const honest = await sharesFor("honest");
    const noCurve = await sharesFor("noCurve");

    expect(honest).to.be.greaterThan(0n);
    expect(noCurve).to.be.greaterThan(0n);

    // The cap binds, and it binds by the amount the curve says it should.
    // `x·s/(y+s) / (s·x/y) = y/(y+s) = 2/3` for s = y/2.
    const ratioBps = (honest * 10_000n) / noCurve;
    expect(ratioBps).to.be.greaterThan(6_500n);
    expect(ratioBps).to.be.lessThan(6_800n);

    // eslint-disable-next-line no-console
    console.log(
      `\n  realizable/mark credit ratio: ${Number(ratioBps) / 100}% ` +
        `(constant-product prediction for s = y/2: 66.67%)`
    );
  });

  it("a constituent that LIES upward about its own realizable depth gains nothing — min() only ever revises down", async () => {
    const liar = await sharesFor("liar");
    const noCurve = await sharesFor("noCurve");

    // A 1000x inflated quote cannot raise the credit above the band mark,
    // because the quote is used as a cap and never as the value. This is the
    // whole reason it is safe to consult an untrusted address here.
    expect(liar).to.equal(
      noCurve,
      "an inflated self-reported quote moved the settlement price — the cap is applied in the wrong direction"
    );
  });
});
