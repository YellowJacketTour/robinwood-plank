import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import {
  loadFixture,
  time,
  mine,
  takeSnapshot,
  type SnapshotRestorer,
} from "./helpers/network-helpers.js";

import { deployOpenIndex, maxIn, zeroOut, WAD } from "./helpers/index-vault.js";

/**
 * AUDIT PoC (2026-08-09), **INVERTED**. Both claims this file originally
 * DISPROVED are now true, and it asserts them in the same shapes it used to
 * refute them, against the same fixture.
 *
 *  A. H-1 — the §7.6 reserve-vest guard was enforced at `redeemProRata` only.
 *     `IndexValuation` read the RAW `c.reserve` (lines 140/147/262), so
 *     `redeemSingleAsset` paid out freshly-credited, still-unvested value in
 *     the block it landed. Both doors now net through the identical
 *     `_netReserve` arithmetic. The full treatment, including the fee-on-the-
 *     whole-exit half of H-1, is in `ReserveVest.test.ts` — the file this
 *     codebase cited as proof of the vesting mechanism while it did not exist.
 *
 *  B. F-3 — an AFTER_SYNC hook WAS invoked during `redeemProRata`, through
 *     `_attemptOpportunisticReconcile` -> `autoReconcile` -> `_reconcileCore`
 *     -> `_fireHook`. That call is gone from the exit path. The full treatment,
 *     including the control proving the hook fires elsewhere, is in
 *     `ExitDoorSacred.test.ts`.
 *
 * LOCAL HARDHAT ONLY.
 */
describe("AUDIT PoC (inverted) — reserve vest holds at BOTH doors, exit door fires no hook", () => {
  const fixture = () => deployOpenIndex();

  // Test B advances the shared clock past a hook timelock; restore it so the
  // fixed-endTime Seaport orders in later suites do not silently expire.
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  it("A: redeemSingleAsset no longer pays out reserve that redeemProRata withholds as unvested", async () => {
    const fx = await loadFixture(fixture);
    const { vault, vaultAddr, alice, addrs, tokens } = fx;

    await vault.connect(alice).mintProRata(100n * WAD, maxIn(3));
    const shares: bigint = await vault.balanceOf(alice.address);

    // A routed injection lands on leg 1 (not the dividend asset) and is
    // reconciled — `_creditRoutedValue` -> `_addReserveVest` marks it unvested.
    const INJECT = 200n * WAD;
    await tokens[1].mint(alice.address, INJECT);
    await tokens[1].connect(alice).transfer(vaultAddr, INJECT);
    await vault.reconcile(addrs[1]);

    // The ORIGINAL assertion was `singleOut > proRata[1]`, which is a weak
    // claim (the priced exit also converts the OTHER legs into leg-1 units, so
    // it exceeds the leg-1 pro-rata slice even when correct). The sharp claim
    // is about MATURITY: if the priced door read the raw reserve, its quote
    // would be identical before and after the vest window, because nothing
    // else changes. It is not.
    const whileUnvested: bigint = await vault.previewRedeemSingleAsset(shares, addrs[1]);
    await mine(301); // STREAM_VEST_BLOCKS + 1
    const afterVesting: bigint = await vault.previewRedeemSingleAsset(shares, addrs[1]);

    expect(afterVesting).to.be.greaterThan(
      whileUnvested,
      "the priced door is blind to vesting — it is reading a raw reserve again (H-1)"
    );

    // And the unvested quote really is materially held back, not held back by
    // a wei: the injection is 200 units against a 1000-unit leg.
    expect(afterVesting - whileUnvested).to.be.greaterThan(WAD);
  });

  it("B: NO hook is invoked during redeemProRata", async () => {
    const fx = await loadFixture(fixture);
    const { vault, vaultAddr, alice, risk, addrs, tokens } = fx;

    const hook: any = await (await ethers.getContractFactory("MockHook")).deploy(0); // RECORD
    const hookAddr = await hook.getAddress();
    const point = await vault.AFTER_SYNC();
    await vault.connect(risk).queueHook(point, hookAddr, 0);
    await time.increase(48 * 3600 + 1);
    await vault.executeHook(point);

    await vault.connect(alice).mintProRata(100n * WAD, maxIn(3));

    // An unreconciled surplus, so an opportunistic reconcile on the exit path
    // would genuinely credit — and therefore genuinely fire AFTER_SYNC — if
    // one still ran there.
    await tokens[1].mint(alice.address, 50n * WAD);
    await tokens[1].connect(alice).transfer(vaultAddr, 50n * WAD);

    const before: bigint = await hook.calls();
    await vault.connect(alice).redeemProRata(10n * WAD, zeroOut(3));
    expect(await hook.calls()).to.equal(
      before,
      "an external hook fired on the exit door (F-3)"
    );
  });
});
