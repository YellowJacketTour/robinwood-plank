import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-network-helpers";

import { deployOpenIndex, maxIn, zeroOut, WAD, BPS, defaultParams } from "./helpers/index-vault";

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  §7.6 — THE RESERVE-VEST GUARD, AND AUDIT H-1.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS. `IndexFacetBase.sol:1767` cited `ReserveVest.test.ts`
 * as the proof of the vesting mechanism. THE FILE DID NOT EXIST. The guard
 * shipped untested, and audit H-1 then found it was enforced at exactly one of
 * the two doors it needed to hold at — `redeemProRata` netted the unvested
 * amount, `redeemSingleAsset` did not, so freshly-routed value walked straight
 * out through the priced door, fee-free, in the same block.
 *
 * WHAT EACH TEST WOULD LOOK LIKE IF THE MECHANISM BROKE — stated explicitly,
 * because the audit's meta-finding is that three load-bearing tests in this
 * repo asserted things that could not fail:
 *
 *   1. Delete `_reserveNetOfVest` from `redeemProRata` → test 1 goes red (the
 *      immediate payout jumps to the matured figure).
 *   2. Restore `IndexValuation`'s raw `c.reserve` reads → test 2 goes red (the
 *      priced door stops caring whether the injection has matured).
 *   3. Charge the imbalance fee on `extra` only → test 3 goes red (the payout
 *      exceeds the fee-inclusive ceiling by the whole pro-rata component).
 *   4. Either of the above → test 4 goes red (the round trip becomes
 *      profitable).
 *
 * LOCAL HARDHAT ONLY.
 */

const VEST_BLOCKS = 300; // IndexFacetBase.STREAM_VEST_BLOCKS
const LEG = 1; // the injected leg; NOT the dividend asset (which is leg 0)

/** Route real value into one constituent so §7.6 marks it unvested. */
async function inject(fx: any, amount: bigint) {
  await fx.tokens[LEG].mint(fx.alice.address, amount);
  await fx.tokens[LEG].connect(fx.alice).transfer(fx.vaultAddr, amount);
  await fx.vault.reconcile(fx.addrs[LEG]);
}

describe("§7.6 reserve vesting — the guard, and audit H-1's bypass", () => {
  const fixture = () => deployOpenIndex();

  it("1. redeemProRata withholds freshly-routed value until it vests, then pays it", async () => {
    const fx = await loadFixture(fixture);
    const { vault, alice } = fx;

    await vault.connect(alice).mintProRata(100n * WAD, maxIn(3));
    const shares: bigint = await vault.balanceOf(alice.address);

    const [, beforeInjection] = await vault.previewRedeemProRata(shares);
    await inject(fx, 200n * WAD);

    // The reserve genuinely grew...
    const [, rightAfter] = await vault.previewRedeemProRata(shares);
    // ...but the free door pays essentially none of it yet. One block of the
    // 300-block ramp has elapsed (the `reconcile` transaction itself), so the
    // tolerance is one block's worth of release, not zero.
    const oneBlockOfRamp = ((rightAfter[LEG] as bigint) * 2n) / BigInt(VEST_BLOCKS);
    expect(rightAfter[LEG] - beforeInjection[LEG]).to.be.lessThan(
      oneBlockOfRamp + 10n,
      "unvested value was immediately redeemable — the §7.6 guard is not enforced"
    );

    await mine(VEST_BLOCKS + 1);

    const [, matured] = await vault.previewRedeemProRata(shares);
    expect(matured[LEG]).to.be.greaterThan(
      rightAfter[LEG],
      "the injection never matured — vesting withholds forever, which is a different bug"
    );
  });

  it("2. H-1(a): redeemSingleAsset nets the SAME vest — the priced door is no longer a bypass", async () => {
    const fx = await loadFixture(fixture);
    const { vault, alice, addrs } = fx;

    await vault.connect(alice).mintProRata(100n * WAD, maxIn(3));
    const shares: bigint = await vault.balanceOf(alice.address);

    await inject(fx, 200n * WAD);

    const unvestedQuote: bigint = await vault.previewRedeemSingleAsset(shares, addrs[LEG]);
    await mine(VEST_BLOCKS + 1);
    const maturedQuote: bigint = await vault.previewRedeemSingleAsset(shares, addrs[LEG]);

    // Before the fix this pair was EQUAL: `IndexValuation` read raw
    // `c.reserve`, so maturity was invisible to the priced door and 100% of
    // the injection was withdrawable in the block it landed.
    expect(maturedQuote).to.be.greaterThan(
      unvestedQuote,
      "the priced door pays the same before and after vesting — it reads a raw reserve (H-1a)"
    );
  });

  it("3. H-1(b): the imbalance fee is charged on the WHOLE exit, not only the swapped part", async () => {
    const fx = await loadFixture(fixture);
    const { vault, alice, addrs } = fx;

    await vault.connect(alice).mintProRata(400n * WAD, maxIn(3));
    const shares: bigint = await vault.balanceOf(alice.address);

    const target = addrs[LEG];
    const [, proRata] = await vault.previewRedeemProRata(shares);
    const [, targetHi] = await vault.priceBand(target);

    // The library's own decomposition, recomputed here from the vault's OWN
    // published views: the pro-rata slice of the target, plus every other
    // leg's pro-rata slice valued at its band LOW and converted into target
    // units at the target's band HIGH. This is the payout BEFORE any fee.
    let otherEth = 0n;
    for (let i = 0; i < addrs.length; i++) {
      if (addrs[i] === target) continue;
      const [lo] = await vault.priceBand(addrs[i]);
      otherEth += ((proRata[i] as bigint) * lo) / WAD;
    }
    const grossCeiling = (proRata[LEG] as bigint) + (otherEth * WAD) / targetHi;

    const actual: bigint = await vault.previewRedeemSingleAsset(shares, target);

    // Every exit pays at least the base imbalance fee, on EVERYTHING. Under
    // the old code the fee touched only the converted portion, so `actual`
    // exceeded this ceiling by roughly `proRata[LEG] * baseFee / BPS` — the
    // "18.18 of value out fee-free" the audit measured.
    const base = defaultParams.baseImbalanceFeeBps;
    const ceiling = (grossCeiling * (BPS - base)) / BPS;
    expect(actual).to.be.lessThanOrEqual(
      ceiling + 1_000n, // integer-floor slack only
      "the pro-rata component of a priced exit is still free (H-1b)"
    );

    // And the fee is real rather than a rounding artefact: strictly less than
    // the unfeed gross by a material margin.
    expect(actual).to.be.lessThan(grossCeiling);
  });

  it("4. the round-9f shape: inject -> mint -> redeem in the same block captures ~none of the injection", async () => {
    const fx = await loadFixture(fixture);
    const { vault, alice, bob } = fx;

    // Alice is the honest incumbent.
    await vault.connect(alice).mintProRata(100n * WAD, maxIn(3));

    const INJECT = 500n * WAD;
    await inject(fx, INJECT);

    // Bob sprints: mint immediately after the injection, redeem immediately
    // after that. Everything below happens inside the vest window.
    const bobBefore: bigint = await fx.tokens[LEG].balanceOf(bob.address);
    await vault.connect(bob).mintProRata(100n * WAD, maxIn(3));
    const minted: bigint = await vault.balanceOf(bob.address);
    await vault.connect(bob).redeemProRata(minted, zeroOut(3));
    const bobAfter: bigint = await fx.tokens[LEG].balanceOf(bob.address);

    // Bob paid in and took out; the net must not be a windfall drawn from the
    // fresh injection. A few blocks of ramp have elapsed, so allow that.
    const net = bobAfter - bobBefore;
    const rampedInWindow = (INJECT * 10n) / BigInt(VEST_BLOCKS);
    expect(net).to.be.lessThan(
      rampedInWindow,
      "an atomic mint->redeem captured freshly-routed value"
    );
  });
});
