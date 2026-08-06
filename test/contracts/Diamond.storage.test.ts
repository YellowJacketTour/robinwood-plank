import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployIndexDiamond, combinedHandle } from "./helpers/diamond";

/**
 * ============================================================================
 *  Diamond.storage — the namespaces cannot collide, and every facet agrees.
 *
 *  This suite exists because the diamond introduces a failure mode the
 *  pre-diamond design could not have: several separately-compiled contracts
 *  executing against ONE storage space. If two of them disagree about where a
 *  value lives, the vault does not revert — it silently returns wrong numbers,
 *  or silently corrupts the routing table, and every other proof in the suite
 *  becomes a proof about a corrupted object.
 *
 *  Nothing here is inherited from the 519 baseline properties. All of it is new
 *  obligation created by the refactor (design doc section 7.4).
 * ============================================================================
 */
describe("Diamond storage namespaces", () => {
  const SEEDER = "0x0000000000000000000000000000000000000B0B";
  const DIVIDEND = "0x000000000000000000000000000000000000dEaD";
  const TIMELOCK = 48 * 3600;

  async function fx() {
    const d = await deployIndexDiamond(
      ["DiamondLoupeFacet", "CoreProbeFacetA", "CoreProbeFacetB"],
      { timelockDelay: TIMELOCK, seeder: SEEDER, dividendAsset: DIVIDEND }
    );
    const handle = await combinedHandle(d.address, [
      "DiamondLoupeFacet",
      "CoreProbeFacetA",
      "CoreProbeFacetB",
    ]);
    return { ...d, handle };
  }

  describe("slot derivation", () => {
    it("every namespace root is distinct, and none of them is slot 0", async () => {
      const probe: any = await (
        await ethers.getContractFactory("StorageSlotProbe")
      ).deploy();
      const slots: string[] = await probe.slots();
      const names: string[] = await probe.names();

      // The last entry is slot 0 itself — not a namespace, but the thing every
      // namespace must avoid, since a facet that declares a state variable
      // lands there and slot 0 is where the selector table's first mapping is.
      const namespaces = slots.slice(0, -1);
      expect(slots[slots.length - 1]).to.equal(ethers.ZeroHash);

      const seen = new Map<string, string>();
      for (let i = 0; i < namespaces.length; i++) {
        const s = namespaces[i].toLowerCase();
        expect(s, `${names[i]} must not be slot 0`).to.not.equal(ethers.ZeroHash);
        expect(seen.has(s), `${names[i]} collides with ${seen.get(s)}`).to.equal(false);
        seen.set(s, names[i]);
      }
      expect(seen.size).to.equal(12);
    });

    it("every ERC-7201 root is 256-slot aligned, so appending a struct member cannot walk into a neighbour", async () => {
      const probe: any = await (
        await ethers.getContractFactory("StorageSlotProbe")
      ).deploy();
      const slots: string[] = await probe.slots();
      const names: string[] = await probe.names();

      for (let i = 0; i < slots.length - 1; i++) {
        // The diamond namespace is the ONE deliberate exception: it is pinned
        // to the canonical `diamond.standard.diamond.storage` slot so
        // third-party loupe tooling can read the table directly. That is an
        // interoperability decision, recorded in IndexStorage.sol, not an
        // oversight — and it is safe because that namespace's Layout is fixed
        // by EIP-2535 and does not grow.
        if (names[i] === "diamond") continue;
        const low = BigInt(slots[i]) & 0xffn;
        expect(low, `${names[i]} is not 256-aligned`).to.equal(0n);
      }
    });

    it("no two namespace roots are within 256 slots of each other", async () => {
      const probe: any = await (
        await ethers.getContractFactory("StorageSlotProbe")
      ).deploy();
      const slots: string[] = await probe.slots();
      const names: string[] = await probe.names();

      const sorted = slots
        .slice(0, -1)
        .map((s, i) => ({ v: BigInt(s), n: names[i] }))
        .sort((a, b) => (a.v < b.v ? -1 : 1));

      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i].v - sorted[i - 1].v;
        expect(
          gap >= 256n,
          `${sorted[i - 1].n} and ${sorted[i].n} are only ${gap} slots apart`
        ).to.equal(true);
      }
    });
  });

  describe("cross-facet agreement", () => {
    it("a value written by the diamond's constructor reads identically through two independent facets", async () => {
      const { handle } = await loadFixture(fx);

      expect(await handle.probeA_timelockDelay()).to.equal(
        await handle.probeB_timelockDelay()
      );
      expect(await handle.probeA_seeder()).to.equal(await handle.probeB_seeder());
      expect(await handle.probeA_dividendAsset()).to.equal(
        await handle.probeB_dividendAsset()
      );

      // …and the values are the ones that were passed in, not zero. A pair of
      // facets that both read the WRONG slot would also agree with each other.
      expect(await handle.probeA_timelockDelay()).to.equal(TIMELOCK);
      expect(await handle.probeA_seeder()).to.equal(ethers.getAddress(SEEDER));
      expect(await handle.probeA_dividendAsset()).to.equal(ethers.getAddress(DIVIDEND));
    });

    it("the two facets carry DIFFERENT per-facet immutables, proving the agreement above is about storage and not luck", async () => {
      const { handle } = await loadFixture(fx);

      // This is the control for the previous test. An `immutable` under
      // DELEGATECALL resolves to whichever FACET is executing, so these differ
      // — which is exactly why timelockDelay/seeder/dividendAsset had to stop
      // being `immutable` (design doc section 3.3 rule 2 / section 12 item 1).
      // If they had not, they would differ here in the same way.
      expect(await handle.probeA_marker()).to.equal(0xaaaan);
      expect(await handle.probeB_marker()).to.equal(0xbbbbn);
      expect(await handle.probeA_marker()).to.not.equal(await handle.probeB_marker());
    });

    it("a write through facet A is read back identically through facet B, in three separate namespaces at once", async () => {
      const { handle } = await loadFixture(fx);
      const role = ethers.id("role.test");
      const holder = "0x00000000000000000000000000000000deadbeef";

      await handle.probeA_write(123_456n, role, holder, 2n);

      expect(await handle.probeB_totalSupply()).to.equal(123_456n);
      expect(await handle.probeB_roleHolder(role)).to.equal(
        ethers.getAddress(holder)
      );
      expect(await handle.probeB_reentrancy()).to.equal(2n);
    });

    it("writing every other namespace leaves the diamond's own routing table intact", async () => {
      const { handle, loupe, manifest } = await loadFixture(fx);

      const before = await handle.probeB_facetCount();
      const addrsBefore = await loupe.facetAddresses();

      await handle.probeA_write(
        ethers.MaxUint256,
        ethers.id("role.hostile"),
        "0x00000000000000000000000000000000deadbeef",
        ethers.MaxUint256
      );

      // The classic diamond catastrophe is a namespace whose growth reaches
      // slot 0 and overwrites `selectorToFacetAndPosition`. If that happened,
      // the facet count would move or the dispatch would start failing.
      expect(await handle.probeB_facetCount()).to.equal(before);
      expect(await loupe.facetAddresses()).to.deep.equal(addrsBefore);
      expect(addrsBefore.length).to.equal(manifest.length);

      // And dispatch still works after the maximal write.
      expect(await handle.probeA_timelockDelay()).to.equal(TIMELOCK);
    });

    it("the shared reentrancy word is ONE word for the whole diamond, not one per facet", async () => {
      const { handle } = await loadFixture(fx);

      // Primed by the diamond's constructor to NOT_ENTERED = 1.
      expect(await handle.probeB_reentrancy()).to.equal(1n);

      await handle.probeA_write(0n, ethers.id("x"), ethers.ZeroAddress, 2n);

      // Facet B sees facet A's guard state. Under OpenZeppelin's per-contract
      // ReentrancyGuard each facet would have had its own word, and a
      // `nonReentrant` on facet A would NOT have excluded a reentrant call into
      // facet B — a silent loss of the existing "a reentrant token cannot
      // double-credit" / "a reentrant claimer…" properties. One shared word is
      // strictly stronger than the pre-diamond per-contract guard.
      expect(await handle.probeB_reentrancy()).to.equal(2n);
    });
  });

  describe("no facet declares storage of its own", () => {
    it("every production facet's compiler-emitted storageLayout is empty", async () => {
      // The rule (design doc section 3.3 rule 1) is checked against the
      // compiler's own output rather than by reading the source, because the
      // dangerous case is INHERITED storage — a facet that looks clean but
      // extends OZ's ERC20 or ReentrancyGuard and silently lands a balance
      // mapping on the diamond's slot 0.
      const facets = ["DiamondCutFacet", "DiamondLoupeFacet"];
      const { execSync } = require("child_process");
      void execSync;

      for (const name of facets) {
        const layout = await storageLayoutOf(name);
        expect(layout, `${name} declares state variables: ${JSON.stringify(layout)}`)
          .to.deep.equal([]);
      }
    });

    it("the check is real: a facet that DOES declare a state variable is detected", async () => {
      // Negative control. Without this, "every facet's layout is empty" is
      // equally consistent with a reader that always returns [].
      const layout = await storageLayoutOf("StateVariableFacet");
      expect(layout.length).to.be.greaterThan(0);
      expect(layout.map((s: any) => s.label)).to.include("slot0");
      // …and it lands exactly where the disaster is: slot 0.
      expect(layout[0].slot).to.equal("0");
    });
  });
});

/**
 * Read solc's `storageLayout` for a contract out of the build info.
 *
 * Hardhat does not surface this on the artifact, so it comes from the build-info
 * file. Emitting it requires the `storageLayout` output selection, which
 * hardhat.config.ts enables for `contracts/diamond` and `contracts/test`.
 */
async function storageLayoutOf(contractName: string): Promise<any[]> {
  const { artifacts } = require("hardhat");
  const fqn = (await artifacts.getAllFullyQualifiedNames()).find(
    (n: string) => n.endsWith(`:${contractName}`)
  );
  if (!fqn) throw new Error(`no artifact for ${contractName}`);
  const buildInfo = await artifacts.getBuildInfo(fqn);
  if (!buildInfo) throw new Error(`no build info for ${fqn}`);
  const [source, name] = fqn.split(":");
  const out = buildInfo.output.contracts[source][name] as any;
  if (!out.storageLayout) {
    throw new Error(
      `solc did not emit storageLayout for ${fqn} — the outputSelection in ` +
        `hardhat.config.ts is what makes this check possible; without it this ` +
        `suite would silently pass by checking nothing.`
    );
  }
  return out.storageLayout.storage ?? [];
}
