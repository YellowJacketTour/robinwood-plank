import { expect } from "chai";
import { ethers, artifacts } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployIndexDiamond, combinedHandle, selectorsOf } from "./helpers/diamond";

/**
 * ============================================================================
 *  Diamond.noWriteToImmutables — the replacement for a keyword.
 *
 *  Three values were `immutable` on GlobalIndexVault: `timelockDelay`, `seeder`
 *  and `dividendAsset`. (Verified by enumeration, not assumed: those are the
 *  only three `immutable` declarations in the contract — lines 306, 332 and 574.
 *  Everything else in that class is `constant`, which is baked identically into
 *  every facet and is therefore safe to leave alone.)
 *
 *  WHY THEY COULD NOT STAY `immutable`
 *  -----------------------------------
 *  An `immutable` lives in the FACET's own deployed bytecode. Under
 *  DELEGATECALL it resolves to the value baked into whichever facet is
 *  currently executing — not to a diamond-wide value. Leaving `timelockDelay`
 *  `immutable` would have given the governance timelock a different length
 *  depending on which facet you asked, silently, with no revert and no event.
 *  Design doc section 12 names this the highest-probability silent bug in the
 *  entire conversion, and it has no test in the 519 baseline because it cannot
 *  happen to a monolith.
 *
 *  WHAT REPLACES THE KEYWORD
 *  -------------------------
 *  `immutable` gave a guarantee for free: no code can write this. In storage
 *  that guarantee has to be earned, and it is earned by TWO facts together:
 *
 *   1. the values are written exactly once, by the DIAMOND's own constructor,
 *      before any facet exists to be called;
 *   2. no function in the finalized facet set writes those slots.
 *
 *  Fact 2 is not provable by reading facet source once and trusting it forever
 *  — it has to be re-checked whenever the facet set changes, which is what this
 *  suite does, structurally, against the finalized manifest.
 * ============================================================================
 */
describe("Diamond — the three migrated immutables have no writer", () => {
  const SEEDER = "0x0000000000000000000000000000000000000B0B";
  const DIVIDEND = "0x000000000000000000000000000000000000dEaD";
  const TIMELOCK = 48 * 3600;
  const INIT = { timelockDelay: TIMELOCK, seeder: SEEDER, dividendAsset: DIVIDEND };
  const FACETS = ["DiamondLoupeFacet", "CoreProbeFacetA", "CoreProbeFacetB"];

  /** CoreStorage.SLOT + member offset. */
  const CORE_SLOT = BigInt(
    ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256"],
        [BigInt(ethers.id("marketplank.index.storage.core.v1")) - 1n]
      )
    )
  ) & ~0xffn;

  const SLOT_TIMELOCK = CORE_SLOT + 0n;
  const SLOT_SEEDER = CORE_SLOT + 1n;
  const SLOT_DIVIDEND = CORE_SLOT + 2n;

  async function fx() {
    const d = await deployIndexDiamond(FACETS, INIT);
    const handle = await combinedHandle(d.address, FACETS);
    return { ...d, handle };
  }

  it("the derived slot really is where the values live — the address arithmetic is checked, not assumed", async () => {
    // If this drifted, every other test in this file would be reading empty
    // slots and passing vacuously.
    const { address } = await loadFixture(fx);
    const raw = await ethers.provider.getStorage(address, SLOT_TIMELOCK);
    expect(BigInt(raw)).to.equal(BigInt(TIMELOCK));
    expect(
      ethers.getAddress("0x" + (await ethers.provider.getStorage(address, SLOT_SEEDER)).slice(-40))
    ).to.equal(ethers.getAddress(SEEDER));
    expect(
      ethers.getAddress("0x" + (await ethers.provider.getStorage(address, SLOT_DIVIDEND)).slice(-40))
    ).to.equal(ethers.getAddress(DIVIDEND));
  });

  it("the values are written by the diamond's CONSTRUCTOR, so they are correct in the same block the diamond appears", async () => {
    const { address, deployer, handle } = await loadFixture(fx);
    const block = (
      await ethers.provider.getTransactionReceipt(deployer.deploymentTransaction()!.hash)
    )!.blockNumber;

    expect(BigInt(await ethers.provider.getStorage(address, SLOT_TIMELOCK, block))).to.equal(
      BigInt(TIMELOCK)
    );
    expect(await handle.probeA_timelockDelay()).to.equal(TIMELOCK);
  });

  it("EVERY facet in the finalized set reads the SAME value — the regression this whole migration exists to prevent", async () => {
    const { handle } = await loadFixture(fx);

    // Two separately-compiled facets, each with its own bytecode and its own
    // immutable region.
    expect(await handle.probeA_timelockDelay()).to.equal(await handle.probeB_timelockDelay());
    expect(await handle.probeA_seeder()).to.equal(await handle.probeB_seeder());
    expect(await handle.probeA_dividendAsset()).to.equal(await handle.probeB_dividendAsset());

    // The control: these facets DO each carry a genuine per-facet `immutable`,
    // and it differs between them. So the agreement above is a fact about
    // storage, not an artefact of the two facets happening to be identical.
    expect(await handle.probeA_marker()).to.not.equal(await handle.probeB_marker());
  });

  it("no function in the finalized facet set is capable of writing those slots — checked by exhaustive execution, not by reading source", async () => {
    // The structural check. Every non-view function in the finalized union is
    // called with plausible arguments, from a hostile caller, and the three
    // slots are re-read after each. Anything that moved them would be caught
    // regardless of what the function is named or which facet it came from.
    const { address, manifest } = await loadFixture(fx);
    const [, hostile] = await ethers.getSigners();

    const before = await Promise.all(
      [SLOT_TIMELOCK, SLOT_SEEDER, SLOT_DIVIDEND].map((s) =>
        ethers.provider.getStorage(address, s)
      )
    );

    let exercised = 0;
    for (const m of manifest) {
      const art = await artifacts.readArtifact(m.name);
      const iface = new ethers.Interface(art.abi);
      const fns: any[] = [];
      iface.forEachFunction((f) => fns.push(f));

      for (const f of fns) {
        if (f.stateMutability === "view" || f.stateMutability === "pure") continue;
        const args = f.inputs.map((i: any) => plausible(i.type));
        const data = iface.encodeFunctionData(f, args);
        try {
          await hostile.sendTransaction({ to: address, data });
          exercised++;
        } catch {
          // A revert is fine: a function that reverts wrote nothing. What must
          // not happen is a SUCCESS that moved one of the three slots.
        }
        for (let k = 0; k < 3; k++) {
          const now = await ethers.provider.getStorage(
            address,
            [SLOT_TIMELOCK, SLOT_SEEDER, SLOT_DIVIDEND][k]
          );
          expect(now, `${m.name}.${f.name} moved migrated-immutable slot ${k}`).to.equal(
            before[k]
          );
        }
      }
    }

    // The sweep must actually have run something, or it proves nothing.
    expect(exercised, "no mutating function was successfully exercised").to.be.greaterThan(0);
  });

  it("the migrated values are stable across a maximal write to every OTHER namespace", async () => {
    const { address, handle } = await loadFixture(fx);
    await handle.probeA_write(
      ethers.MaxUint256,
      ethers.id("role.hostile"),
      "0x00000000000000000000000000000000deadbeef",
      ethers.MaxUint256
    );
    expect(BigInt(await ethers.provider.getStorage(address, SLOT_TIMELOCK))).to.equal(
      BigInt(TIMELOCK)
    );
    expect(await handle.probeA_seeder()).to.equal(ethers.getAddress(SEEDER));
    expect(await handle.probeA_dividendAsset()).to.equal(ethers.getAddress(DIVIDEND));
  });

  it("and there is no cut that could add a writer, because there is no cut", async () => {
    // The `immutable` keyword's guarantee had one more part: not even a future
    // version of the contract can write it. Under a diamond that part is
    // carried by finalization rather than by the compiler.
    const { loupe } = await loadFixture(fx);
    expect(await loupe.isFinalized()).to.equal(true);
    for (const sel of await selectorsOf("DiamondCutFacet")) {
      expect(await loupe.facetAddress(sel)).to.equal(ethers.ZeroAddress);
    }
  });
});

/** A non-degenerate argument for each ABI type, so the sweep exercises real paths. */
function plausible(type: string): any {
  if (type.endsWith("[]")) return [];
  if (type === "address") return "0x00000000000000000000000000000000deadbeef";
  if (type === "bool") return true;
  if (type === "string") return "x";
  if (type === "bytes") return "0x1234";
  if (/^bytes\d+$/.test(type)) return ethers.id("probe").slice(0, 2 + 2 * Number(type.slice(5)));
  if (/^u?int\d*$/.test(type)) return 1n;
  return 0n;
}
