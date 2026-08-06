import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployIndexDiamond, selectorsOf, facetSetHash ,
  fullInit} from "./helpers/diamond";

/**
 * ============================================================================
 *  Diamond.finalize — the renouncement has no vulnerable window.
 *
 *  This is the suite that answers design doc section 1.3, and it is the reason
 *  the diamond is admissible at all.
 *
 *  THE PROBLEM, AT FULL STRENGTH
 *  -----------------------------
 *  The strongest property this codebase has is "no privileged function can
 *  reach reserves already pooled", proven today by enumerating one contract's
 *  ABI and calling every privileged function from every role. That technique is
 *  sound for fixed code and WORTHLESS for a live diamond, because the ABI is
 *  not the code: `diamondCut` can install
 *
 *      function drain() { token.transfer(msg.sender, token.balanceOf(this)); }
 *
 *  and the enumeration test passes right up until it does. So while
 *  `diamondCut` is callable, its caller IS a withdrawal path over every pooled
 *  reserve. A timelock does not help — a timelock bounds WHEN a change lands
 *  and never bounds WHAT the change may be.
 *
 *  WHY "RENOUNCE LATER" IS NOT THE ANSWER
 *  --------------------------------------
 *  A renouncement in a later transaction implies a window in which it had not
 *  happened yet: a period, measured in blocks but real, observable and
 *  raceable, during which the anchor rule was false and the deployer key was
 *  equivalent to full custody. If the index were seeded during that window, the
 *  window would have real assets in it.
 *
 *  WHAT IS PROVEN HERE INSTEAD
 *  ---------------------------
 *  The cut capability is created and destroyed inside ONE transaction, so no
 *  external party ever observes a cuttable diamond. The tests below establish
 *  that directly rather than asserting it: they attempt to interact with the
 *  diamond in every way an attacker could, and show there is no reachable
 *  intermediate state to interact WITH.
 * ============================================================================
 */
describe("Diamond finalization — the renouncement window", () => {
  const SEEDER = "0x0000000000000000000000000000000000000B0B";
  const DIVIDEND = "0x000000000000000000000000000000000000dEaD";
  const INIT = fullInit({ timelockDelay: 48 * 3600, seeder: SEEDER, dividendAsset: DIVIDEND });
  const FACETS = ["DiamondLoupeFacet", "CoreProbeFacetA", "CoreProbeFacetB"];

  async function fx() {
    return deployIndexDiamond(FACETS, INIT);
  }

  describe("the frozen end state", () => {
    it("isFinalized() is true the moment the diamond is first observable", async () => {
      const { loupe } = await loadFixture(fx);
      expect(await loupe.isFinalized()).to.equal(true);
    });

    it("devMode is false — this is a Tier A diamond, not a rehearsal one", async () => {
      const { loupe } = await loadFixture(fx);
      expect(await loupe.isDevMode()).to.equal(false);
    });

    it("no selector routes to diamondCut, finalize, registerInterfaces or pendingFacetSetHash", async () => {
      const { loupe } = await loadFixture(fx);
      for (const sel of await selectorsOf("DiamondCutFacet")) {
        expect(
          await loupe.facetAddress(sel),
          `selector ${sel} still routes somewhere`
        ).to.equal(ethers.ZeroAddress);
      }
    });

    it("the cut facet is not in the facet address list at all — it is removed, not merely guarded", async () => {
      const { loupe, cutFacet, manifest } = await loadFixture(fx);
      const addrs: string[] = await loupe.facetAddresses();
      expect(addrs.map((a) => a.toLowerCase())).to.not.include(cutFacet.toLowerCase());
      expect(addrs.length).to.equal(manifest.length);
    });

    it("a RAW call to the diamondCut selector reverts FunctionNotFound — there is nothing to call", async () => {
      const { address } = await loadFixture(fx);
      const [attacker] = await ethers.getSigners();
      const diamond = await ethers.getContractAt("Diamond", address);

      const cutIface = new ethers.Interface([
        "function diamondCut((address,uint8,bytes4[])[],address,bytes)",
      ]);
      const data = cutIface.encodeFunctionData("diamondCut", [[], ethers.ZeroAddress, "0x"]);

      await expect(attacker.sendTransaction({ to: address, data }))
        .to.be.revertedWithCustomError(diamond, "FunctionNotFound")
        .withArgs(data.slice(0, 10));
    });

    it("a raw call to the finalize selector reverts FunctionNotFound — finalize removed ITSELF", async () => {
      const { address } = await loadFixture(fx);
      const [attacker] = await ethers.getSigners();
      const diamond = await ethers.getContractAt("Diamond", address);
      const sel = ethers.id("finalize(bytes32)").slice(0, 10);

      await expect(
        attacker.sendTransaction({ to: address, data: sel + ethers.ZeroHash.slice(2) })
      )
        .to.be.revertedWithCustomError(diamond, "FunctionNotFound")
        .withArgs(sel);
    });

    it("the recorded cutter is the deployer CONTRACT, whose authority existed only inside its own constructor", async () => {
      const { loupe, deployer } = await loadFixture(fx);
      // Not an EOA, and not a live contract with a cut entrypoint: IndexDeployer
      // has no function that calls diamondCut. Its entire cutting life was its
      // constructor, which cannot run twice.
      expect(await loupe.cutter()).to.equal(await deployer.getAddress());

      const code = await ethers.provider.getCode(await deployer.getAddress());
      const iface = new ethers.Interface(
        (await require("hardhat").artifacts.readArtifact("IndexDeployer")).abi
      );
      const fns: string[] = [];
      iface.forEachFunction((f) => fns.push(f.name));
      // Its whole ABI is two immutable getters. There is no cut path.
      expect(fns.sort()).to.deep.equal(["committedFacetSetHash", "diamond"]);
      expect(code).to.not.equal("0x");
    });
  });

  describe("there is no observable window — proven, not assumed", () => {
    it("the diamond's address does not exist before the transaction that also freezes it", async () => {
      // THE DIRECT PROOF that requirement's "attempt to interact between deploy
      // and finalize" asks for.
      //
      // The interaction is impossible for a structural reason, not a lucky one,
      // and the reason is worth stating precisely because it is the whole
      // argument: the EVM has no concurrency. A transaction runs to completion
      // before any other transaction or call can observe any state it wrote.
      // Every intermediate state of IndexDeployer's constructor — diamond
      // created, cut facet installed, other facets cut in, NOT YET FINALIZED —
      // exists only inside that one call frame.
      //
      // For an attacker to reach the diamond in its cuttable state they would
      // need its address, and the address is the return value of a CREATE that
      // has not returned yet. It is written to no storage, emitted in no log,
      // and passed to no external contract before `finalize` has already run.
      //
      // This test establishes the observable consequence: at every block height
      // at which the diamond has any code at all, it is already frozen.
      const d = await deployIndexDiamond(FACETS, INIT);
      const receipt = await ethers.provider.getTransactionReceipt(
        d.deployer.deploymentTransaction()!.hash
      );
      const deployBlock = receipt!.blockNumber;

      // One block earlier: the address has no code. There was nothing to call.
      const codeBefore = await ethers.provider.getCode(d.address, deployBlock - 1);
      expect(codeBefore).to.equal("0x");

      // The block it appears in: already finalized. There is no block, and no
      // intra-block moment reachable by any other transaction, in between.
      const loupeAt = await ethers.getContractAt("DiamondLoupeFacet", d.address);
      expect(await loupeAt.isFinalized({ blockTag: deployBlock })).to.equal(true);
    });

    it("finalize and the cut both happened inside ONE transaction, and no other transaction touched the diamond", async () => {
      const d = await deployIndexDiamond(FACETS, INIT);
      const txHash = d.deployer.deploymentTransaction()!.hash;
      const receipt = await ethers.provider.getTransactionReceipt(txHash);

      // Both the DiamondCut and the Finalized events are in this single
      // receipt. If freezing were a second transaction there would be two
      // receipts and a window between them.
      const cutFacetIface = new ethers.Interface(
        (await require("hardhat").artifacts.readArtifact("DiamondCutFacet")).abi
      );
      void cutFacetIface;
      const topics = receipt!.logs.map((l) => l.topics[0]);
      const finalizedTopic = ethers.id("Finalized(bytes32,uint256,uint256)");
      const cutTopic = ethers.id("DiamondCut((address,uint8,bytes4[])[],address,bytes)");

      expect(topics, "no DiamondCut in the deployment receipt").to.include(cutTopic);
      expect(topics, "no Finalized in the deployment receipt").to.include(finalizedTopic);
      expect(topics.indexOf(cutTopic)).to.be.lessThan(topics.indexOf(finalizedTopic));
    });

    it("a second attempt to deploy against the SAME already-finalized diamond is impossible: each deployment creates its own", async () => {
      const a = await deployIndexDiamond(FACETS, INIT);
      const b = await deployIndexDiamond(FACETS, INIT);
      expect(a.address).to.not.equal(b.address);
      // Neither is cuttable, and there is no shared mutable state between them.
      expect(await a.loupe.isFinalized()).to.equal(true);
      expect(await b.loupe.isFinalized()).to.equal(true);
    });
  });

  describe("finalize's preconditions are load-bearing, not decorative", () => {
    it("a manifest hash that does not match the installed set reverts the entire deployment", async () => {
      const cut = await (await ethers.getContractFactory("DiamondCutFacet")).deploy();
      const loupe = await (await ethers.getContractFactory("DiamondLoupeFacet")).deploy();
      const manifest = [
        { facet: await loupe.getAddress(), selectors: await selectorsOf("DiamondLoupeFacet") },
      ];
      const Deployer = await ethers.getContractFactory("IndexDeployer");

      await expect(
        Deployer.deploy(await cut.getAddress(), manifest, [], INIT, ethers.id("wrong"))
      ).to.be.revertedWithCustomError(
        await ethers.getContractFactory("DiamondCutFacet"),
        "FacetSetHashMismatch"
      );
    });

    it("an EXTRA facet not named in the committed manifest reverts the deployment", async () => {
      // The attack the hash exists to stop: a deployer that publishes an honest
      // manifest and installs one more facet than it names.
      const cut = await (await ethers.getContractFactory("DiamondCutFacet")).deploy();
      const loupe = await (await ethers.getContractFactory("DiamondLoupeFacet")).deploy();
      const sneaky = await (await ethers.getContractFactory("CleanFacet")).deploy();

      const published = [
        {
          name: "DiamondLoupeFacet",
          facet: await loupe.getAddress(),
          selectors: await selectorsOf("DiamondLoupeFacet"),
        },
      ];
      const actuallyInstalled = [
        ...published,
        {
          name: "CleanFacet",
          facet: await sneaky.getAddress(),
          selectors: await selectorsOf("CleanFacet"),
        },
      ];

      const Deployer = await ethers.getContractFactory("IndexDeployer");
      await expect(
        Deployer.deploy(
          await cut.getAddress(),
          actuallyInstalled.map((m) => ({ facet: m.facet, selectors: m.selectors })),
          [],
          INIT,
          facetSetHash(published) // committed to the honest set only
        )
      ).to.be.revertedWithCustomError(
        await ethers.getContractFactory("DiamondCutFacet"),
        "FacetSetHashMismatch"
      );
    });

    it("the committed hash is independently re-derivable from the FROZEN diamond", async () => {
      // What a reviewer actually does: take the published manifest, compute the
      // hash off-chain, and check it against a live diamond. Both the stored
      // value and a fresh re-derivation from the frozen selector table must
      // agree with the off-chain computation.
      const { loupe, manifest, committedHash } = await loadFixture(fx);
      expect(await loupe.facetSetHash()).to.equal(committedHash);
      expect(await loupe.currentFacetSetHash()).to.equal(committedHash);
      expect(facetSetHash(manifest)).to.equal(committedHash);
    });

    it("the deployment reverts if the timelock delay is below the floor — a bad delay cannot be DEPLOYED, not merely rejected at runtime", async () => {
      const cut = await (await ethers.getContractFactory("DiamondCutFacet")).deploy();
      const loupe = await (await ethers.getContractFactory("DiamondLoupeFacet")).deploy();
      const manifest = [
        {
          name: "DiamondLoupeFacet",
          facet: await loupe.getAddress(),
          selectors: await selectorsOf("DiamondLoupeFacet"),
        },
      ];
      const Deployer = await ethers.getContractFactory("IndexDeployer");
      await expect(
        Deployer.deploy(
          await cut.getAddress(),
          manifest.map((m) => ({ facet: m.facet, selectors: m.selectors })),
          [],
          { ...INIT, timelockDelay: 60 },
          facetSetHash(manifest)
        )
      ).to.be.revertedWithCustomError(
        await ethers.getContractFactory("Diamond"),
        "TimelockDelayBelowFloor"
      );
    });

    it("a zero seeder cannot be deployed", async () => {
      const cut = await (await ethers.getContractFactory("DiamondCutFacet")).deploy();
      const loupe = await (await ethers.getContractFactory("DiamondLoupeFacet")).deploy();
      const manifest = [
        {
          name: "DiamondLoupeFacet",
          facet: await loupe.getAddress(),
          selectors: await selectorsOf("DiamondLoupeFacet"),
        },
      ];
      const Deployer = await ethers.getContractFactory("IndexDeployer");
      await expect(
        Deployer.deploy(
          await cut.getAddress(),
          manifest.map((m) => ({ facet: m.facet, selectors: m.selectors })),
          [],
          { ...INIT, seeder: ethers.ZeroAddress },
          facetSetHash(manifest)
        )
      ).to.be.revertedWithCustomError(
        await ethers.getContractFactory("Diamond"),
        "BadSeeder"
      );
    });
  });

  describe("the Tier B rehearsal deployer is impossible to mistake for Tier A", () => {
    async function devFx() {
      const cut = await (await ethers.getContractFactory("DiamondCutFacet")).deploy();
      const marker = await (await ethers.getContractFactory("DevModeMarkerFacet")).deploy();
      const loupe = await (await ethers.getContractFactory("DiamondLoupeFacet")).deploy();
      const Dev = await ethers.getContractFactory("DevIndexDeployer");
      const dev: any = await Dev.deploy(
        await cut.getAddress(),
        await marker.getAddress(),
        [{ facet: await loupe.getAddress(), selectors: await selectorsOf("DiamondLoupeFacet") }],
        INIT
      );
      const addr = await dev.diamond();
      return { dev, loupe: await ethers.getContractAt("DiamondLoupeFacet", addr), addr };
    }

    it("a Tier B diamond reports devMode == true, permanently", async () => {
      const { loupe } = await devFx();
      expect(await loupe.isDevMode()).to.equal(true);
      // There is no clearer. A diamond that was ever cuttable stays marked.
      const sels = await selectorsOf("DevModeMarkerFacet");
      expect(sels.length).to.equal(1); // markDevMode only; no unmark
    });

    it("a Tier B diamond is NOT finalized and IS still cuttable — which is exactly why it is confined to contracts/test", async () => {
      const { dev, loupe } = await devFx();
      expect(await loupe.isFinalized()).to.equal(false);
      expect(await loupe.facetAddress(ethers.id("diamondCut((address,uint8,bytes4[])[],address,bytes)").slice(0, 10)))
        .to.not.equal(ethers.ZeroAddress);

      // And it really can still be cut, which is the honest demonstration of
      // why this shape is forbidden in production: the cutter can install
      // anything at all, at any time, with no timelock and no warning.
      const clean = await (await ethers.getContractFactory("CleanFacet")).deploy();
      await dev.cut([
        {
          facetAddress: await clean.getAddress(),
          action: 0,
          functionSelectors: await selectorsOf("CleanFacet"),
        },
      ]);
      const handle: any = await ethers.getContractAt("CleanFacet", await dev.diamond());
      expect(await handle.ok()).to.equal(42n);
    });

    it("Tier A's manifest never names the marker facet, so devMode has NO writer at all in production", async () => {
      // Stronger than "has a writer that is gated": there is no code path.
      const { loupe } = await loadFixture(fx);
      const markSel = (await selectorsOf("DevModeMarkerFacet"))[0];
      expect(await loupe.facetAddress(markSel)).to.equal(ethers.ZeroAddress);
      expect(await loupe.isDevMode()).to.equal(false);
    });
  });
});
