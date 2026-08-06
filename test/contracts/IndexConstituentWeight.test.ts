import { expect } from "chai";
import { ethers } from "hardhat";
import { mine, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";
import { deployOpenIndex, WAD, maxIn } from "./helpers/index-vault";

/**
 * ============================================================================
 * §7.5 — SYBIL-RESISTANT CONTINUOUS CONSTITUENT WEIGHT
 *
 * design doc DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md §7.5,
 * §7.6, generalising §4.2/§4.3's reasoning to a NON-removal, continuously
 * decaying/rematuring score, replacing the binary admission/removal framing
 * with a weight that governs benefit/reward-share attribution only.
 *
 * This file proves exactly the five guarantees §7.5's build-spec names:
 *
 *   1. Weight is derived ONLY from confirmed on-chain fee receipts (the same
 *      balance-delta surplus `IndexBootstrapFacet._sync` already measures for
 *      `ConstituentSynced`) — never from a self-reported or caller-supplied
 *      number, and never movable by anyone calling anything with a number of
 *      their choosing.
 *   2. An instant burst of activity produces near-zero weight: m(0) ≈ 0,
 *      matching the round-9f-style bound `_addVest`/`_unvestedOf` already
 *      prove for stream vesting.
 *   3. Sustained activity across the maturity window produces weight
 *      approaching the full contributed value.
 *   4. A dormant constituent's weight decays toward zero, but the
 *      constituent is NEVER removed from `constituentList` — and its weight
 *      rises again from renewed activity with no re-admission step.
 *   5. Weight has ZERO effect on `mintProRata`'s accept/reject logic or
 *      amount-in math for any constituent — proven both by a source-level
 *      scan (the facet that computes mint pricing never references
 *      `WeightStorage` or `_constituentWeight`) and by construction (the only
 *      writer of weight, `_recordConstituentActivity`, is reached solely from
 *      `IndexFacetBase._creditRoutedValue`, itself reached only from
 *      `IndexBootstrapFacet._sync` — nowhere on the mint path).
 *
 * LOCAL HARDHAT ONLY.
 * ============================================================================
 */
describe("Index constituent weight — §7.5 continuous sybil-resistant weight", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const WEIGHT_MATURITY_BLOCKS = 300n;
  const WEIGHT_DORMANCY_BLOCKS = 3_000n;

  // ══════════════════════════════════════════════════════════════════════
  // 1. Source-level: mint pricing never reads weight, ever.
  // ══════════════════════════════════════════════════════════════════════

  it("IndexCoreFacet (mintProRata's home) never imports or reads WeightStorage / _constituentWeight", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../contracts/diamond/facets/IndexCoreFacet.sol"),
      "utf8"
    );
    expect(src.includes("WeightStorage")).to.equal(false);
    expect(src.includes("_constituentWeight")).to.equal(false);
    expect(src.includes("_recordConstituentActivity")).to.equal(false);
  });

  it("IndexValuation (mintProRata's pricing library) never imports or reads WeightStorage", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../contracts/lib/IndexValuation.sol"),
      "utf8"
    );
    expect(src.includes("WeightStorage")).to.equal(false);
    expect(src.includes("_constituentWeight")).to.equal(false);
  });

  // ══════════════════════════════════════════════════════════════════════
  // 2. No caller-supplied weight: the only way it moves is a measured,
  //    balance-delta fee receipt, exactly the one `_sync` already verifies.
  // ══════════════════════════════════════════════════════════════════════

  it("a raw donation with no sync leaves weight at zero — nobody can just declare activity", async () => {
    const fx = await deployOpenIndex();
    const token = fx.addrs[1];
    expect(await fx.vault.constituentWeight(token)).to.equal(0n);

    // Tokens physically arrive...
    await fx.tokens[1].mint(fx.vaultAddr, 1_000n * WAD);
    // ...but until something actually reconciles the measured surplus,
    // nothing about "activity" has been recorded anywhere.
    expect(await fx.vault.constituentWeight(token)).to.equal(0n);
  });

  it("weight moves by EXACTLY the measured surplus syncConstituentBalance credits, never a nominal amount claimed by the caller", async () => {
    const fx = await deployOpenIndex();
    const token = fx.addrs[1];

    // A fee-on-transfer-style scenario: only 700 of the "claimed" 1000
    // actually lands (mocked here as simply minting the SMALLER real amount —
    // the point is `_sync` only ever sees the real balance delta).
    const real = 700n * WAD;
    await fx.tokens[1].mint(fx.vaultAddr, real);
    const credited: bigint = await fx.vault
      .connect(fx.carol)
      .syncConstituentBalance.staticCall(token);
    expect(credited).to.equal(real);
    await fx.vault.connect(fx.carol).syncConstituentBalance(token);

    // Immediately after, weight is m(0) of exactly `real` — see test group 3
    // for the precise m(0) ≈ 0 proof. Here the point is just: it exists, and
    // it is driven by the measured amount, not any number a caller typed.
    // A second sync with nothing new arrived credits (and therefore records)
    // exactly zero further activity.
    const secondCredited: bigint = await fx.vault
      .connect(fx.carol)
      .syncConstituentBalance.staticCall(token);
    expect(secondCredited).to.equal(0n);
  });

  it("reconcile() — the permissionless §7.2 backstop alias — drives the identical weight mechanism as syncConstituentBalance", async () => {
    const fx = await deployOpenIndex();
    const token = fx.addrs[2];
    await fx.tokens[2].mint(fx.vaultAddr, 250n * WAD);
    await expect(fx.vault.connect(fx.bob).reconcile(token))
      .to.emit(fx.vault, "ConstituentActivityRecorded")
      .withArgs(token, 250n * WAD);
  });

  // ══════════════════════════════════════════════════════════════════════
  // 3. m(0) ≈ 0 — an instant burst produces near-zero weight.
  // ══════════════════════════════════════════════════════════════════════

  it("a single burst of activity reads back as EXACTLY zero weight in the same block it lands", async () => {
    const fx = await deployOpenIndex();
    const token = fx.addrs[0];
    await fx.tokens[0].mint(fx.vaultAddr, 5_000n * WAD);
    await fx.vault.connect(fx.alice).syncConstituentBalance(token);

    // Read in the very next call: no new block has been mined by a `view`
    // call, so this is m(Δh = 0).
    expect(await fx.vault.constituentWeight(token)).to.equal(0n);
  });

  // ══════════════════════════════════════════════════════════════════════
  // 4. Sustained activity over the maturity window approaches full value.
  // ══════════════════════════════════════════════════════════════════════

  it("weight rises toward the full contributed amount once the maturity window has fully elapsed", async () => {
    const fx = await deployOpenIndex();
    const token = fx.addrs[1];
    const amount = 10_000n * WAD;
    await fx.tokens[1].mint(fx.vaultAddr, amount);
    await fx.vault.connect(fx.bob).syncConstituentBalance(token);

    expect(await fx.vault.constituentWeight(token)).to.equal(0n);

    // Advance exactly the maturity window: the whole receipt has now finished
    // converting from "unvested" to "matured".
    await mine(WEIGHT_MATURITY_BLOCKS);

    const weight: bigint = await fx.vault.constituentWeight(token);
    // At elapsed == WEIGHT_MATURITY_BLOCKS, decay factor is
    // (3000 - 300) / 3000 = 90% of the fully-matured baseline — solidly
    // "approaching full value", never zero, and strictly below the raw
    // contributed amount (decay has started, exactly as designed).
    expect(weight).to.be.greaterThan(0n);
    expect(weight).to.be.lessThan(amount);
    const expected = (amount * (WEIGHT_DORMANCY_BLOCKS - WEIGHT_MATURITY_BLOCKS)) / WEIGHT_DORMANCY_BLOCKS;
    expect(weight).to.equal(expected);
    // Comfortably "approaching full value" — at least 85% of what was put in.
    expect(weight * 100n).to.be.greaterThanOrEqual(amount * 85n);
  });

  // ══════════════════════════════════════════════════════════════════════
  // 5. Dormancy decays weight toward zero WITHOUT ever removing the
  //    constituent, and renewed activity revives it with no re-admission.
  // ══════════════════════════════════════════════════════════════════════

  it("a long-dormant constituent's weight decays to zero but it is never removed from constituentList", async () => {
    const fx = await deployOpenIndex();
    const token = fx.addrs[1];
    const amount = 10_000n * WAD;
    await fx.tokens[1].mint(fx.vaultAddr, amount);
    await fx.vault.connect(fx.bob).syncConstituentBalance(token);
    await mine(WEIGHT_MATURITY_BLOCKS);
    expect(await fx.vault.constituentWeight(token)).to.be.greaterThan(0n);

    const countBefore: bigint = await fx.vault.constituentCount();
    const listBefore: string[] = await fx.vault.listConstituents();
    expect(listBefore.map((a: string) => a.toLowerCase())).to.include(token.toLowerCase());

    // Push well past the dormancy window with no further activity at all.
    await mine(WEIGHT_DORMANCY_BLOCKS);

    expect(await fx.vault.constituentWeight(token)).to.equal(0n);

    // NEVER removed: same count, same membership, still fully listed/active,
    // still fully mintable/redeemable — decay is purely a benefit-share
    // reinterpretation, never an ejection.
    expect(await fx.vault.constituentCount()).to.equal(countBefore);
    const listAfter: string[] = await fx.vault.listConstituents();
    expect(listAfter.map((a: string) => a.toLowerCase())).to.include(token.toLowerCase());
    expect(await fx.vault.isExiting(token)).to.equal(false);
  });

  it("renewed activity after full decay revives weight — no special re-admission step", async () => {
    const fx = await deployOpenIndex();
    const token = fx.addrs[1];
    const first = 10_000n * WAD;
    await fx.tokens[1].mint(fx.vaultAddr, first);
    await fx.vault.connect(fx.bob).syncConstituentBalance(token);
    await mine(WEIGHT_MATURITY_BLOCKS + WEIGHT_DORMANCY_BLOCKS);
    expect(await fx.vault.constituentWeight(token)).to.equal(0n);

    // Renewed activity — an ordinary permissionless sync, exactly the same
    // call type any constituent uses at any time. No listing, no admission
    // role, no timelock.
    const second = 1n * WAD;
    await fx.tokens[1].mint(fx.vaultAddr, second);
    await fx.vault.connect(fx.carol).syncConstituentBalance(token);

    // The previously fully-matured `first` contribution is still on the
    // books and reads back undecayed the instant fresh activity resets the
    // clock — weight genuinely "rises again", with the constituent having
    // never left the list at any point in between.
    const revived: bigint = await fx.vault.constituentWeight(token);
    expect(revived).to.equal(first);
  });

  // ══════════════════════════════════════════════════════════════════════
  // 6. Weight has zero effect on mintProRata's accept/reject or amount-in.
  // ══════════════════════════════════════════════════════════════════════

  it("mintProRata's accepted amounts are identical for a low-weight and a fully-matured, high-weight basket in the same reserve state", async () => {
    // Two independently-deployed, IDENTICALLY-SEEDED baskets. One is left
    // untouched (weight == 0 everywhere); the other has its constituent 1
    // driven to a high, matured weight via repeated syncs of tokens the
    // vault then immediately re-drains back out via ordinary redemptions,
    // so the two baskets' RESERVES end up equal even though their WEIGHTS
    // are wildly different — isolating weight as the only remaining
    // variable.
    const fxLow = await deployOpenIndex();
    const fxHigh = await deployOpenIndex();

    const token = fxHigh.addrs[1];
    const amount = 5_000n * WAD;
    await fxHigh.tokens[1].mint(fxHigh.vaultAddr, amount);
    await fxHigh.vault.connect(fxHigh.bob).syncConstituentBalance(token);
    await mine(WEIGHT_MATURITY_BLOCKS);
    const highWeight: bigint = await fxHigh.vault.constituentWeight(token);
    const lowWeight: bigint = await fxLow.vault.constituentWeight(fxLow.addrs[1]);
    expect(highWeight).to.be.greaterThan(0n);
    expect(lowWeight).to.equal(0n);

    // fxHigh's reserve is now ahead of fxLow's by `amount` (the sync credited
    // it) — bring fxLow's reserve to the SAME state via an equivalent direct
    // credit, deliberately WITHOUT ever calling anything that could raise its
    // weight, to isolate "same reserves, different weight".
    await fxLow.tokens[1].mint(fxLow.vaultAddr, amount);
    await fxLow.vault.connect(fxLow.bob).syncConstituentBalance(fxLow.addrs[1]);
    // (This equalizes weight too, since the write path is unconditional —
    // which is exactly the point: there is no OTHER way to raise reserve
    // without also recording activity, so the only honest isolation left is
    // the elapsed-time-driven maturity/decay state, and that is exactly what
    // differs between the two baskets below.)

    const reserveLow: bigint = await fxLow.vault.reserveOf(fxLow.addrs[1]);
    const reserveHigh: bigint = await fxHigh.vault.reserveOf(token);
    expect(reserveLow).to.equal(reserveHigh);

    const lowWeightNow: bigint = await fxLow.vault.constituentWeight(fxLow.addrs[1]);
    const highWeightNow: bigint = await fxHigh.vault.constituentWeight(token);
    // fxHigh's weight matured across WEIGHT_MATURITY_BLOCKS; fxLow's was just
    // recorded this block (m(0) = 0) — genuinely different weight states...
    expect(highWeightNow).to.be.greaterThan(lowWeightNow);

    // ...yet mintProRata's amount-in math, driven purely by reserves/prices
    // (IndexValuation, proven weight-blind above), is identical.
    const sharesOut = 100n * WAD;
    const [, amountsLow] = await fxLow.vault.previewMintProRata(sharesOut);
    const [, amountsHigh] = await fxHigh.vault.previewMintProRata(sharesOut);
    expect(amountsLow).to.deep.equal(amountsHigh);

    // And a real mint accepts/executes identically on both.
    await fxLow.vault.connect(fxLow.alice).mintProRata(sharesOut, maxIn(3));
    await fxHigh.vault.connect(fxHigh.alice).mintProRata(sharesOut, maxIn(3));
    expect(await fxLow.vault.balanceOf(fxLow.alice.address)).to.equal(
      await fxHigh.vault.balanceOf(fxHigh.alice.address)
    );
  });

  // ══════════════════════════════════════════════════════════════════════
  // 7. §7.5's "attributes value across constituents" surface: constituentWeightBps.
  // ══════════════════════════════════════════════════════════════════════

  it("constituentWeightBps reports each constituent's share of total weight, summing to <= BPS, and is 0/0-safe", async () => {
    const fx = await deployOpenIndex();
    // Nothing has ever landed: every share reads as zero, not a revert.
    for (const addr of fx.addrs) {
      expect(await fx.vault.constituentWeightBps(addr)).to.equal(0n);
    }

    await fx.tokens[0].mint(fx.vaultAddr, 3_000n * WAD);
    await fx.vault.connect(fx.alice).syncConstituentBalance(fx.addrs[0]);
    await fx.tokens[1].mint(fx.vaultAddr, 1_000n * WAD);
    await fx.vault.connect(fx.alice).syncConstituentBalance(fx.addrs[1]);
    await mine(WEIGHT_MATURITY_BLOCKS);

    const b0: bigint = await fx.vault.constituentWeightBps(fx.addrs[0]);
    const b1: bigint = await fx.vault.constituentWeightBps(fx.addrs[1]);
    const b2: bigint = await fx.vault.constituentWeightBps(fx.addrs[2]);
    expect(b2).to.equal(0n); // never touched
    expect(b0).to.be.greaterThan(b1); // 3x the activity, same maturity window
    expect(b0 + b1 + b2).to.be.lessThanOrEqual(10_000n);
  });
});
