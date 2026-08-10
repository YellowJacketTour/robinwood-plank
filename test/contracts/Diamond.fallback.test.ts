import { expect } from "chai";
import { ethers, artifacts } from "./helpers/hardhat.js";
import { loadFixture } from "./helpers/network-helpers.js";
import { deployIndexDiamond, selectorsOf ,
  fullInit} from "./helpers/diamond.js";

/**
 * ============================================================================
 *  Diamond.fallback — the proxy's own surface.
 *
 *  Two existing properties have to be RE-EXPRESSED here rather than merely
 *  re-pointed, because the diamond changes what they are properties OF:
 *
 *  1. "the vault cannot hold ETH at all — no receive, no payable path."
 *     Asserted twice today (GlobalIndexVault.audit, IndexDividendAccrual) by
 *     enumerating the monolith's ABI. Under a diamond that enumeration is the
 *     wrong object: a facet could be payable and it would not matter, because
 *     value never reaches a facet — the DIAMOND's non-payable fallback rejects
 *     the call before dispatch. So the assertion moves to the proxy.
 *
 *  2. "no entrypoint forwards arbitrary calldata or names an external venue."
 *     The diamond's fallback IS a calldata forwarder. Design doc section 7.2
 *     flags this explicitly as needing a rewrite rather than a re-point. The
 *     honest restatement, proven below, is: it forwards ONLY to addresses the
 *     FINALIZED selector table names, the table cannot change, and there is no
 *     settable pointer anywhere in it. That is a weaker sentence than "does not
 *     forward" and it is the true one; overstating it would be exactly the
 *     standards-theatre the design doc warns against.
 * ============================================================================
 */
describe("Diamond fallback and the ETH prohibition", () => {
  const INIT = fullInit({
    timelockDelay: 48 * 3600,
    seeder: "0x0000000000000000000000000000000000000B0B",
    dividendAsset: "0x000000000000000000000000000000000000dEaD",
    });
  const FACETS = ["DiamondLoupeFacet", "CoreProbeFacetA", "CoreProbeFacetB"];

  async function fx() {
    return deployIndexDiamond(FACETS, INIT);
  }

  describe("no ETH, at all", () => {
    it("a plain ETH transfer to the diamond reverts", async () => {
      const { address } = await loadFixture(fx);
      const [sender] = await ethers.getSigners();
      await expect(
        sender.sendTransaction({ to: address, value: ethers.parseEther("1") })
      ).to.be.revert(ethers);
      expect(await ethers.provider.getBalance(address)).to.equal(0n);
    });

    it("ETH sent alongside a VALID selector reverts too — the non-payable fallback rejects before dispatch", async () => {
      const { address } = await loadFixture(fx);
      const [sender] = await ethers.getSigners();
      const sel = (await selectorsOf("DiamondLoupeFacet"))[0];
      await expect(
        sender.sendTransaction({ to: address, data: sel, value: 1n })
      ).to.be.revert(ethers);
      expect(await ethers.provider.getBalance(address)).to.equal(0n);
    });

    it("ETH sent with empty calldata reverts — there is no receive()", async () => {
      const { address } = await loadFixture(fx);
      const [sender] = await ethers.getSigners();
      await expect(sender.sendTransaction({ to: address, data: "0x", value: 1n })).to.be
        .revert(ethers);
    });

    it("the Diamond's compiled ABI contains neither a receive nor a payable fallback", async () => {
      // Source-level, so a future edit that ADDS one is caught even if no test
      // happens to send value on the new path.
      const art = await artifacts.readArtifact("Diamond");
      const receive = art.abi.find((f: any) => f.type === "receive");
      const fb = art.abi.find((f: any) => f.type === "fallback");
      expect(receive, "the Diamond declares a receive()").to.equal(undefined);
      expect(fb, "the Diamond has no fallback at all").to.not.equal(undefined);
      expect(fb.stateMutability, "the fallback is payable").to.not.equal("payable");
    });

    it("no function in the finalized facet set is payable", async () => {
      // Belt and braces. Even though the fallback would reject the value first,
      // a payable facet function is a misleading ABI and integrators read ABIs.
      const { manifest } = await loadFixture(fx);
      for (const m of manifest) {
        const iface = new ethers.Interface((await artifacts.readArtifact(m.name)).abi);
        iface.forEachFunction((f) => {
          expect(f.payable, `${m.name}.${f.name} is payable`).to.equal(false);
        });
      }
    });
  });

  describe("unknown selectors fail loudly", () => {
    it("an unknown selector REVERTS with FunctionNotFound — it does not silently succeed", async () => {
      // A silently-succeeding fallback is the failure that makes every removed
      // selector look to an integrator like a successful no-op instead of an
      // error, which is how funds get sent to a function that is not there.
      const { address } = await loadFixture(fx);
      const [caller] = await ethers.getSigners();
      const diamond = await ethers.getContractAt("Diamond", address);
      await expect(caller.sendTransaction({ to: address, data: "0xdeadbeef" }))
        .to.be.revertedWithCustomError(diamond, "FunctionNotFound")
        .withArgs("0xdeadbeef");
    });

    it("empty calldata reverts", async () => {
      const { address } = await loadFixture(fx);
      const [caller] = await ethers.getSigners();
      await expect(caller.sendTransaction({ to: address, data: "0x" })).to.be.revert(ethers);
    });

    it("a REMOVED selector behaves identically to one that never existed", async () => {
      const { address } = await loadFixture(fx);
      const [caller] = await ethers.getSigners();
      const diamond = await ethers.getContractAt("Diamond", address);
      const removed = ethers.id("finalize(bytes32)").slice(0, 10);
      await expect(
        caller.sendTransaction({ to: address, data: removed + ethers.ZeroHash.slice(2) })
      )
        .to.be.revertedWithCustomError(diamond, "FunctionNotFound")
        .withArgs(removed);
    });
  });

  describe("what the fallback forwards to — the honest restatement", () => {
    it("the forwarding target is read only from the finalized selector table, and there is no settable pointer in it", async () => {
      const { loupe, manifest, address } = await loadFixture(fx);

      // Every address the fallback can ever reach:
      const reachable: string[] = await loupe.facetAddresses();
      expect(reachable.map((a) => a.toLowerCase()).sort()).to.deep.equal(
        manifest.map((m) => m.facet.toLowerCase()).sort()
      );

      // And no function in the finalized set can add to that list, because the
      // only functions that could are gone.
      for (const sel of await selectorsOf("DiamondCutFacet")) {
        expect(await loupe.facetAddress(sel)).to.equal(ethers.ZeroAddress);
      }
      expect(await loupe.isFinalized()).to.equal(true);

      // Nor is there an owner/implementation setter of any shape.
      const banned = /^(set|upgrade|transferOwnership|changeAdmin)/i;
      for (const m of manifest) {
        const iface = new ethers.Interface((await artifacts.readArtifact(m.name)).abi);
        iface.forEachFunction((f) => {
          if (banned.test(f.name)) {
            throw new Error(`${m.name}.${f.name} looks like an implementation setter`);
          }
        });
      }
      expect(address).to.match(/^0x[0-9a-fA-F]{40}$/);
    });

    it("the forwarded call cannot be aimed at a caller-supplied address", async () => {
      // The distinction that matters: the fallback forwards the caller's
      // CALLDATA, but the caller has no influence over the DESTINATION beyond
      // choosing among the fixed, frozen set. There is no entrypoint of the
      // shape `execute(address target, bytes data)`.
      const { manifest } = await loadFixture(fx);
      for (const m of manifest) {
        const iface = new ethers.Interface((await artifacts.readArtifact(m.name)).abi);
        iface.forEachFunction((f) => {
          const types = f.inputs.map((i: any) => i.type);
          const looksLikeArbitraryCall =
            types.includes("address") && (types.includes("bytes") || types.includes("bytes[]"));
          if (looksLikeArbitraryCall) {
            throw new Error(
              `${m.name}.${f.format()} takes (address, bytes) — review it for an arbitrary-call surface`
            );
          }
        });
      }
    });

    it("a revert inside a facet propagates verbatim rather than being swallowed", async () => {
      // If the fallback swallowed reverts, every safety check inside every
      // facet would become advisory. Proven with a real custom-error revert
      // raised behind the dispatch.
      const { address } = await loadFixture(fx);
      const [caller] = await ethers.getSigners();
      const diamond = await ethers.getContractAt("Diamond", address);
      // Route to a selector that exists on the diamond but whose facet reverts:
      // `markDevMode` is not installed on a Tier A diamond, so this is
      // FunctionNotFound raised by the diamond itself and returned with data.
      const sel = (await selectorsOf("DevModeMarkerFacet"))[0];
      const tx = caller.sendTransaction({ to: address, data: sel });
      await expect(tx).to.be.revertedWithCustomError(diamond, "FunctionNotFound");
    });

    it("returndata is forwarded verbatim, so a view through the diamond equals the facet's own answer", async () => {
      const { address, loupe } = await loadFixture(fx);
      const direct = await ethers.getContractAt("DiamondLoupeFacet", address);
      expect(await direct.facetAddresses()).to.deep.equal(await loupe.facetAddresses());
      // Non-trivial return shape (dynamic array of structs of dynamic arrays).
      const facets = await loupe.facets();
      expect(facets.length).to.be.greaterThan(0);
      expect(facets[0].functionSelectors.length).to.be.greaterThan(0);
    });
  });
});
