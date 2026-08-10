import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { mine } from "./helpers/network-helpers.js";

/**
 * ==========================================================================
 *  DIVIDEND-LEG VEST — audit H-2/H-3.
 *
 *  THE BUG. `_creditRoutedValue` sent `dividendShare` straight to
 *  `_creditDividends`, unvested, while the sibling `reserveShare` went
 *  through a 300-block `_addReserveVest`. And `mintProRata` fires
 *  `_attemptOpportunisticReconcile` AFTER minting — so an attacker's own mint
 *  triggers the credit that accrues to the shares that mint just created.
 *  mint -> credit -> redeemProRata -> claimDividend, atomically, profitable
 *  whenever `dividendBps > BPS - dividendBps - buybackBps`, and
 *  `dividendBps = 10000` was legal.
 *
 *  THE PROPERTY THAT KILLS IT, and the one this file proves: value credited
 *  in block N is releasable in EXACTLY ZERO amount in block N. Every step of
 *  the attack happens in one block, so the attacker captures nothing.
 *
 *  Every assertion here goes red if `DividendVestStorage.add` stops arming
 *  the window, or if `releasable` stops subtracting the unvested portion.
 *
 *  LOCAL HARDHAT ONLY.
 * ==========================================================================
 */

const WAD = 10n ** 18n;
const VEST = 300n; // IndexFacetBase.STREAM_VEST_BLOCKS

describe("Dividend-leg vest (audit H-2/H-3)", () => {
  async function harness() {
    const H = await ethers.getContractFactory("DividendVestHarness");
    const h: any = await H.deploy();
    await h.waitForDeployment();
    return h;
  }

  it("THE SNIPE: crediting and drawing in the SAME transaction yields exactly zero", async () => {
    const h = await harness();
    await h.addAndTakeSameBlock(1_000n * WAD, VEST);

    expect(await h.lastTaken()).to.equal(
      0n,
      "an atomic credit-then-claim extracted value: the dividend leg is still snipeable"
    );
    // And nothing was destroyed doing it — the value is HELD, not lost.
    expect(await h.pending()).to.equal(1_000n * WAD);
  });

  it("CONTROL: the same value IS fully releasable once the window has elapsed", async () => {
    const h = await harness();
    await h.add(1_000n * WAD, VEST);

    await mine(Number(VEST) + 1);

    expect(await h.releasable()).to.equal(1_000n * WAD);
    await h.take();
    expect(await h.lastTaken()).to.equal(1_000n * WAD);
    expect(await h.pending()).to.equal(0n, "conservation: a delay, not a haircut");
  });

  it("LINEARITY: release is monotone and proportional to elapsed blocks, never early", async () => {
    const h = await harness();
    await h.add(1_000n * WAD, VEST);

    await mine(Number(VEST) / 2);
    const half = await h.releasable();
    // Half the window: about half. Generous bounds — the point is that it is
    // strictly between "nothing" and "everything", which is what a linear
    // vest means and what an unvested credit would violate in both
    // directions.
    expect(half).to.be.greaterThan(400n * WAD);
    expect(half).to.be.lessThan(600n * WAD);

    await mine(Number(VEST) / 4);
    expect(await h.releasable()).to.be.greaterThan(half);
  });

  it("NO RETRO-LOCK: a later credit cannot re-freeze value an earlier one had already matured", async () => {
    // A griefing shape worth closing explicitly: if `add` simply overwrote
    // the window, a steady trickle of fresh routed value would keep pushing
    // already-matured dividends back under lock forever, and holders would
    // never be paid.
    const h = await harness();
    await h.add(1_000n * WAD, VEST);
    await mine(Number(VEST) + 1);

    const maturedBefore = await h.releasable();
    expect(maturedBefore).to.equal(1_000n * WAD);

    await h.add(500n * WAD, VEST); // fresh credit, full window re-armed

    expect(await h.releasable()).to.equal(
      maturedBefore,
      "a later credit re-locked value that had already matured"
    );
    expect(await h.pending()).to.equal(1_500n * WAD);
  });

  it("CONSERVATION: repeated partial takes never exceed, and eventually equal, what was credited", async () => {
    const h = await harness();
    await h.add(900n * WAD, VEST);

    let total = 0n;
    for (let i = 0; i < 3; i++) {
      await mine(Number(VEST) / 3);
      await h.take();
      total += await h.lastTaken();
      expect(total).to.be.lessThanOrEqual(900n * WAD);
    }
    await mine(Number(VEST));
    await h.take();
    total += await h.lastTaken();

    expect(total).to.equal(900n * WAD);
    expect(await h.pending()).to.equal(0n);
  });
});
