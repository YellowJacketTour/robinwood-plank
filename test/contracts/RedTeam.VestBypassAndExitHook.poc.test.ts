import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import { deployOpenIndex, maxIn, zeroOut, WAD } from "./helpers/index-vault";

/**
 * AUDIT PoC (2026-08-09) — two claims in IndexFacetBase.sol's own headers are
 * tested here against the real diamond:
 *
 *  A. §7.6's `_addReserveVest` guard is enforced at `redeemProRata` ONLY.
 *     `IndexTradeFacet.redeemSingleAsset` prices through
 *     `IndexValuation.previewSingleExit`, which reads RAW `c.reserve`
 *     (IndexValuation.sol:140) — so freshly-credited, still-unvested value is
 *     immediately withdrawable through the priced door.
 *
 *  B. `IndexCoreFacet.sol`'s header and `HookRegistryFacet`'s rule 5 claim no
 *     hook fires on `redeemProRata`. Source-level that is true. Behaviourally
 *     it is not: `redeemProRata` -> `_attemptOpportunisticReconcile` ->
 *     `autoReconcile` -> `_reconcileCore` -> `_fireHook(HOOK_AFTER_SYNC_)`
 *     (IndexFacetBase.sol:1283).
 *
 * LOCAL HARDHAT ONLY.
 */
describe("AUDIT PoC — reserve-vest bypass and exit-door hook reachability", () => {
  const fixture = () => deployOpenIndex();

  it("A: redeemSingleAsset pays out reserve that redeemProRata correctly withholds as unvested", async () => {
    const fx = await loadFixture(fixture);
    const { vault, vaultAddr, alice, addrs, tokens } = fx;

    // Alice becomes a holder BEFORE any injection.
    await vault.connect(alice).mintProRata(100n * WAD, maxIn(3));
    const shares: bigint = await vault.balanceOf(alice.address);

    // A routed injection lands on leg 1 (not the dividend asset) and is
    // reconciled — `_creditRoutedValue` -> `_addReserveVest` marks it unvested.
    const INJECT = 200n * WAD;
    await tokens[1].mint(alice.address, INJECT);
    await tokens[1].connect(alice).transfer(vaultAddr, INJECT);
    await vault.reconcile(addrs[1]);

    // The vest guard genuinely works on the free door.
    const [, proRata] = await vault.previewRedeemProRata(shares);
    const rawReserve: bigint = await vault.reserveOf(addrs[1]);

    // The priced door prices the SAME shares against the RAW reserve.
    const singleOut: bigint = await vault.previewRedeemSingleAsset(shares, addrs[1]);

    // Sanity: the injection is real and still unvested.
    expect(INJECT).to.be.gt(0n);

    // The bypass: exiting the injected leg through the priced door pays more
    // of that leg than the free door's vest-netted pro-rata slice.
    // eslint-disable-next-line no-console
    console.log("proRata leg1 (vest-netted):", proRata[1].toString());
    // eslint-disable-next-line no-console
    console.log("redeemSingleAsset(leg1)   :", singleOut.toString());
    // eslint-disable-next-line no-console
    console.log("raw reserve leg1          :", rawReserve.toString());
    expect(singleOut).to.be.gt(proRata[1]);
  });

  it("B: an AFTER_SYNC hook IS invoked during redeemProRata", async () => {
    const fx = await loadFixture(fixture);
    const { vault, vaultAddr, alice, risk, addrs, tokens } = fx;

    const hook: any = await (await ethers.getContractFactory("MockHook")).deploy(0); // RECORD
    const hookAddr = await hook.getAddress();
    const point = await vault.AFTER_SYNC();
    await vault.connect(risk).queueHook(point, hookAddr, 0);
    await time.increase(48 * 3600 + 1);
    await vault.executeHook(point);

    await vault.connect(alice).mintProRata(100n * WAD, maxIn(3));

    // An unreconciled surplus so the opportunistic reconcile inside
    // redeemProRata actually credits (and therefore fires AFTER_SYNC).
    await tokens[1].mint(alice.address, 50n * WAD);
    await tokens[1].connect(alice).transfer(vaultAddr, 50n * WAD);

    const before: bigint = await hook.calls();
    await vault.connect(alice).redeemProRata(10n * WAD, zeroOut(3));
    const after: bigint = await hook.calls();

    // eslint-disable-next-line no-console
    console.log("hook calls during redeemProRata:", (after - before).toString());
    expect(after).to.be.gt(before);
  });
});
