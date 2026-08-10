import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { time, takeSnapshot, type SnapshotRestorer } from "./helpers/network-helpers.js";

import {
  WAD,
  TIMELOCK,
  deployOpenIndex,
  deployConstituent,
  armVaultRegistry,
} from "./helpers/index-vault.js";

/**
 * RED TEAM — AUDIT C-6, **INVERTED**: the attack that extracted 681.66 ETH is
 * now impossible, and this file is the proof.
 *
 * ── THE ORIGINAL FINDING ──────────────────────────────────────────────────
 * `queueListing` accepted an ARBITRARY `token` and an ARBITRARY
 * `IIndexPriceSource`, with no validation at queue time and none at execute
 * time. So `ROLE_CONSTITUENT_ADMISSION` could list a token it minted itself,
 * priced by an oracle it wrote itself, warm eight checkpoints (a CONSTANT price
 * makes the persistence check hold perfectly, since every observation equals
 * the TWAP), mint index shares against the whole real basket with
 * `mintSingleAsset` up to the concentration cap, and walk out through
 * `redeemProRata` — the deliberately unblockable, price-free exit door.
 *
 * The PoC extracted 681.66 ETH of real reserves from a ~3,500 ETH basket, and
 * contradicted `IndexGovernanceFacet`'s own header: literally true that no
 * privileged function moves a reserve, materially false because the key
 * MANUFACTURES the share-burning redeemer.
 *
 * ── WHY IT IS DEAD ────────────────────────────────────────────────────────
 * `IndexFacetBase._requireAdmissible`, enforced at BOTH `queueListing` and
 * `_list`. A post-open constituent must be a vault the configured
 * `CollectionVaultFactory` deployed, and its price source must not be the token
 * or the lister. The attacker cannot enter that registry without deploying a
 * genuine vault through the genuine factory — and a genuine vault has a genuine
 * curve, which §1.3's realizable pricing then measures. Modelled here by simply
 * NOT registering the token the attacker minted, which is exactly what the real
 * factory would do.
 *
 * The tests below walk the original attack forward step by step and assert it
 * dies at the FIRST step, then confirm each remaining gate independently, so a
 * regression in any one of them shows up here rather than being masked by the
 * others.
 *
 * LOCAL HARDHAT ONLY.
 */
describe("RED TEAM (inverted) — a hostile constituent admission is now rejected", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  it("the admission key cannot even QUEUE a self-minted, self-priced token — the registry has never heard of it", async () => {
    const fx = await deployOpenIndex();
    const { vault, vaultAddr, admission, alice } = fx;

    await vault.connect(alice).mintProRata(500n * WAD, [
      ethers.MaxUint256,
      ethers.MaxUint256,
      ethers.MaxUint256,
    ]);

    const fake = await deployConstituent("FAKE", 100n * WAD, 100n * WAD);
    await fake.token.mint(admission.address, 1_000_000n * WAD);
    await fake.token.connect(admission).approve(vaultAddr, ethers.MaxUint256);

    // A real registry is configured, and it covers the REAL basket — the
    // attacker's token is simply not one the factory deployed.
    await armVaultRegistry(fx);

    await expect(
      vault.connect(admission).queueListing(fake.addr, await fake.source.getAddress(), 3_000, false)
    )
      .to.be.revertedWithCustomError(vault, "UnverifiedConstituent")
      .withArgs(fake.addr);

    // ...and the whole attack chain is therefore unreachable: nothing was
    // queued, so nothing can be executed either.
    await time.increase(TIMELOCK + 1);
    await expect(vault.executeListing(fake.addr)).to.be.revertedWithCustomError(
      vault,
      "NothingQueued"
    );
  });

  it("with NO registry configured, admission is closed entirely — the fail-closed default", async () => {
    const fx = await deployOpenIndex();
    const { vault, admission } = fx;

    const fake = await deployConstituent("FAKE2", 100n * WAD, 100n * WAD);

    // Nothing was armed. An unconfigured trust root admits NOTHING, rather
    // than admitting everything — which is what makes a deployment that
    // forgets to wire the factory safe rather than catastrophic. (Since
    // `diamondCut` is renounced at birth, "safe" is the only acceptable
    // direction for that mistake.)
    await expect(
      vault.connect(admission).queueListing(fake.addr, await fake.source.getAddress(), 3_000, false)
    ).to.be.revertedWithCustomError(vault, "VaultRegistryUnset");
  });

  it("source independence is enforced separately: a token cannot price itself, and the lister cannot be the oracle", async () => {
    const fx = await deployOpenIndex();
    const { vault, admission } = fx;
    await armVaultRegistry(fx);

    const fake = await deployConstituent("FAKE3", 100n * WAD, 100n * WAD);

    // The token as its own price source.
    await expect(vault.connect(admission).queueListing(fake.addr, fake.addr, 1_000, false))
      .to.be.revertedWithCustomError(vault, "PriceSourceNotIndependent")
      .withArgs(fake.addr, fake.addr);

    // The lister's own EOA as the price source. Note this is caught by the
    // has-no-code clause too — an EOA cannot be a price source — which is why
    // both clauses live in one check rather than being separately bypassable.
    await expect(
      vault.connect(admission).queueListing(fake.addr, admission.address, 1_000, false)
    ).to.be.revertedWithCustomError(vault, "PriceSourceNotIndependent");
  });

  it("REGRESSION FLOOR: a legitimately factory-deployed constituent is still admissible — the gate is not simply 'reject everything'", async () => {
    const fx = await deployOpenIndex();
    const { vault, admission } = fx;

    const good = await deployConstituent("GOOD", 100n * WAD, 100n * WAD);
    // The registry vouches for it, exactly as the real factory would for a
    // vault it deployed.
    await armVaultRegistry(fx, [...fx.addrs, good.addr]);

    await vault.connect(admission).queueListing(good.addr, await good.source.getAddress(), 1_000, false);
    await time.increase(TIMELOCK + 1);
    await expect(vault.executeListing(good.addr)).to.not.be.revert(ethers);

    const listed: string[] = await vault.listConstituents();
    expect(listed.map((a) => a.toLowerCase())).to.include(good.addr.toLowerCase());
  });
});
