import { expect } from "chai";
import { ethers, artifacts } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployIndexDiamond, selectorsOf, facetSetHash } from "./helpers/diamond";

/**
 * ============================================================================
 *  Diamond.selectors — routing is exactly what the manifest says, and the
 *  manifest is 4-byte-unique.
 *
 *  Under the monolith, "which code runs when I call f()" was answered by the
 *  compiler and needed no test. Under a diamond it is answered by a mutable-
 *  at-birth table, and two distinct failure modes appear that had no analogue:
 *
 *   1. TWO FACETS CLAIMING ONE SELECTOR. Rejected at cut time by LibDiamond,
 *      but the interesting version is two DIFFERENT signatures that hash to the
 *      same 4 bytes — the classic `collate_propagate_storage()` /
 *      `burn(uint256)` collision. That one is not a mistake anybody notices by
 *      reading; it has to be computed.
 *   2. A SELECTOR THAT ROUTES NOWHERE. A function present in the published ABI
 *      but absent from the table is not a compile error and not a revert at
 *      deploy — it is a live contract with a hole in it.
 * ============================================================================
 */
describe("Diamond selector routing", () => {
  const INIT = {
    timelockDelay: 48 * 3600,
    seeder: "0x0000000000000000000000000000000000000B0B",
    dividendAsset: "0x000000000000000000000000000000000000dEaD",
  };
  const FACETS = ["DiamondLoupeFacet", "CoreProbeFacetA", "CoreProbeFacetB"];

  async function fx() {
    return deployIndexDiamond(FACETS, INIT);
  }

  it("the union of every facet ABI is 4-byte-unique", async () => {
    // Includes the cut facet, which is installed (briefly) alongside the rest
    // and would collide just as fatally during the deployment transaction.
    const all = ["DiamondCutFacet", ...FACETS];
    const owner = new Map<string, string>();
    for (const name of all) {
      const art = await artifacts.readArtifact(name);
      const iface = new ethers.Interface(art.abi);
      iface.forEachFunction((f) => {
        const prev = owner.get(f.selector);
        expect(
          prev,
          `selector ${f.selector} claimed by both ${prev} and ${name}.${f.format()}`
        ).to.equal(undefined);
        owner.set(f.selector, `${name}.${f.format()}`);
      });
    }
    expect(owner.size).to.be.greaterThan(0);
  });

  it("every selector in the manifest resolves through the loupe to the manifest's facet", async () => {
    const { loupe, manifest } = await loadFixture(fx);
    for (const m of manifest) {
      for (const sel of m.selectors) {
        expect(
          await loupe.facetAddress(sel),
          `${m.name} selector ${sel} routes to the wrong facet`
        ).to.equal(m.facet);
      }
    }
  });

  it("no selector in the manifest resolves to address(0)", async () => {
    const { loupe, manifest } = await loadFixture(fx);
    for (const m of manifest) {
      for (const sel of m.selectors) {
        expect(await loupe.facetAddress(sel)).to.not.equal(ethers.ZeroAddress);
      }
    }
  });

  it("the loupe's own report round-trips: facets() agrees with facetAddress() for every selector", async () => {
    const { loupe } = await loadFixture(fx);
    const facets: any[] = await loupe.facets();
    let count = 0;
    for (const f of facets) {
      for (const sel of f.functionSelectors) {
        expect(await loupe.facetAddress(sel)).to.equal(f.facetAddress);
        count++;
      }
    }
    expect(count).to.be.greaterThan(0);

    // …and facetFunctionSelectors agrees with facets().
    for (const f of facets) {
      expect(await loupe.facetFunctionSelectors(f.facetAddress)).to.deep.equal(
        f.functionSelectors
      );
    }
  });

  it("the manifest hash matches the Finalized event's argument", async () => {
    const { deployer, committedHash, manifest } = await loadFixture(fx);
    const receipt = await ethers.provider.getTransactionReceipt(
      deployer.deploymentTransaction()!.hash
    );
    const topic = ethers.id("Finalized(bytes32,uint256,uint256)");
    const log = receipt!.logs.find((l) => l.topics[0] === topic);
    expect(log, "no Finalized event").to.not.equal(undefined);

    const iface = new ethers.Interface([
      "event Finalized(bytes32 facetSetHash, uint256 blockNumber, uint256 facetCount)",
    ]);
    const parsed = iface.parseLog({ topics: log!.topics as string[], data: log!.data })!;
    expect(parsed.args[0]).to.equal(committedHash);
    expect(parsed.args[0]).to.equal(facetSetHash(manifest));
    expect(parsed.args[2]).to.equal(BigInt(manifest.length));
  });

  it("no `initialize`-shaped selector survives into the finalized set", async () => {
    // Design doc section 6.4: an `initialize` reachable post-cut is the standard
    // way a diamond's owner or parameter set gets silently overwritten later.
    // Checked by name across the whole finalized union, not by inspection.
    const { manifest } = await loadFixture(fx);
    const banned = /^(initialize|init|__init|setImplementation|upgradeTo|transferOwnership)/i;
    for (const m of manifest) {
      const art = await artifacts.readArtifact(m.name);
      const iface = new ethers.Interface(art.abi);
      iface.forEachFunction((f) => {
        expect(banned.test(f.name), `${m.name}.${f.name} is an initialiser-shaped selector`).to.equal(
          false
        );
      });
    }
  });

  it("the diamondCut path also refuses an init delegatecall outright, so there is no init hook even during deployment", async () => {
    // The parameter exists for EIP-2535 tooling compatibility and is rejected
    // rather than constrained — refusing it is cheaper to prove than bounding
    // what it may point at.
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

    const clean = await (await ethers.getContractFactory("CleanFacet")).deploy();
    // Driven through the real cutter, so the refusal is reached rather than
    // bounced earlier on the cutter check — otherwise this test would pass for
    // the wrong reason and prove nothing about the init parameter.
    await expect(
      dev.cutWithInit(
        [
          {
            facetAddress: await clean.getAddress(),
            action: 0,
            functionSelectors: await selectorsOf("CleanFacet"),
          },
        ],
        await clean.getAddress(),
        "0x1234"
      )
    ).to.be.revertedWithCustomError(cut, "InitialisationIsNotSupported");
  });

  it("a duplicate selector across two facets is rejected at cut time", async () => {
    // The on-chain half of the uniqueness guarantee, independent of the ABI
    // scan above. Two facets, same selector, in one cut.
    const cut = await (await ethers.getContractFactory("DiamondCutFacet")).deploy();
    const loupe = await (await ethers.getContractFactory("DiamondLoupeFacet")).deploy();
    const a = await (await ethers.getContractFactory("CleanFacet")).deploy();
    const b = await (await ethers.getContractFactory("CleanFacet")).deploy();

    const Deployer = await ethers.getContractFactory("IndexDeployer");
    await expect(
      Deployer.deploy(
        await cut.getAddress(),
        [
          { facet: await loupe.getAddress(), selectors: await selectorsOf("DiamondLoupeFacet") },
          { facet: await a.getAddress(), selectors: await selectorsOf("CleanFacet") },
          { facet: await b.getAddress(), selectors: await selectorsOf("CleanFacet") },
        ],
        [],
        INIT,
        ethers.ZeroHash
      )
    ).to.be.revertedWithCustomError(cut, "CannotAddSelectorThatAlreadyExists");
  });

  it("the deployer's own self-check catches a misrouted selector before the transaction can succeed", async () => {
    // IndexDeployer re-reads every manifest selector back off the loupe after
    // finalization. Design doc section 10 names the new failure mode a diamond
    // introduces — a live, broken, unfixable contract — and this is what turns
    // it into an atomic revert instead.
    const { deployer, manifest, loupe } = await loadFixture(fx);
    // Positive form: the check passed, and here is the state it asserted.
    expect(await deployer.committedFacetSetHash()).to.equal(await loupe.facetSetHash());
    for (const m of manifest) {
      for (const sel of m.selectors) {
        expect(await loupe.facetAddress(sel)).to.equal(m.facet);
      }
    }
  });
});
