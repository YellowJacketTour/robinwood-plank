import { expect } from "chai";
import { ethers, artifacts } from "./helpers/hardhat.js";
import { scanOpcodes, deployedSize, EIP170_LIMIT, selectorsOf ,
  fullInit} from "./helpers/diamond.js";

/**
 * ============================================================================
 *  Diamond.bytecode — the always-on facet opcode guard.
 *
 *  Design doc section 6.4 lists two mechanical risks that a diamond creates and
 *  the monolith could not have:
 *
 *   - a facet containing SELFDESTRUCT, which under DELEGATECALL destroys the
 *     DIAMOND rather than the facet, taking every pooled reserve with it;
 *   - a facet containing DELEGATECALL, which is a pivot: it runs arbitrary code
 *     in the diamond's storage with the diamond's authority, so the finalized
 *     facet set stops bounding what can touch the namespaces.
 *
 *  The guard is not a lint rule and not a documented intention. It is
 *  `LibBytecodeScan.assertNoDangerousOpcodes`, called by `LibDiamond._addFunctions`
 *  on EVERY Add and Replace — which means it runs inside the one atomic
 *  deployment transaction, on every facet, on the only cut a production diamond
 *  ever receives. This suite proves it fires, proves it does NOT over-fire, and
 *  separately re-checks every artifact off-chain with an independent
 *  implementation of the same sweep.
 * ============================================================================
 */
describe("Diamond facet bytecode guard", () => {
  const INIT = fullInit({
    timelockDelay: 48 * 3600,
    seeder: "0x0000000000000000000000000000000000000B0B",
    dividendAsset: "0x000000000000000000000000000000000000dEaD",
    });

  /** Build a one-facet diamond deployment attempt around `facetName`. */
  async function tryDeployWith(facetName: string) {
    const cut = await (await ethers.getContractFactory("DiamondCutFacet")).deploy();
    const loupe = await (await ethers.getContractFactory("DiamondLoupeFacet")).deploy();
    const evil = await (await ethers.getContractFactory(facetName)).deploy();

    const manifest = [
      { facet: await loupe.getAddress(), selectors: await selectorsOf("DiamondLoupeFacet") },
      { facet: await evil.getAddress(), selectors: await selectorsOf(facetName) },
    ];
    const Deployer = await ethers.getContractFactory("IndexDeployer");
    return {
      attempt: Deployer.deploy(
        await cut.getAddress(),
        manifest,
        [],
        INIT,
        ethers.ZeroHash // hash is irrelevant: the scan reverts before finalize
      ),
      evil: await evil.getAddress(),
    };
  }

  describe("the guard fires, on-chain, during the deployment transaction", () => {
    it("a facet containing SELFDESTRUCT cannot be cut in — the whole deployment reverts", async () => {
      const { attempt, evil } = await tryDeployWith("SelfdestructFacet");
      await expect(attempt)
        .to.be.revertedWithCustomError(
          await ethers.getContractFactory("DiamondCutFacet"),
          "FacetContainsSelfdestruct"
        )
        .withArgs(evil, (n: bigint) => n >= 0n);
    });

    it("a facet containing DELEGATECALL cannot be cut in — the whole deployment reverts", async () => {
      const { attempt, evil } = await tryDeployWith("DelegatecallFacet");
      await expect(attempt)
        .to.be.revertedWithCustomError(
          await ethers.getContractFactory("DiamondCutFacet"),
          "FacetContainsDelegatecall"
        )
        .withArgs(evil, (n: bigint) => n >= 0n);
    });

    it("no diamond exists at all after a rejected facet — this is an atomic revert, not a partial deploy", async () => {
      // The point of doing the scan inside the deployment transaction rather
      // than in a deploy script: a rejected facet leaves NOTHING behind. There
      // is no half-built diamond to clean up and none to accidentally use.
      const { attempt } = await tryDeployWith("SelfdestructFacet");
      await expect(attempt).to.be.reverted;
      // A reverted CREATE leaves no code; nothing to assert about an address
      // that was never returned. The absence of a returned address IS the
      // property, and the revert above is its proof.
    });

    it("an external `public` library call is rejected too — the scan and the library conversion are ONE decision", async () => {
      // Design doc section 2.4: the five `public` libraries are converted back to
      // `internal` BECAUSE an external library call site compiles to
      // DELEGATECALL. This test is what makes that coupling checked rather than
      // merely asserted in prose — a future contributor who re-externalises a
      // library finds out here.
      const lib = await (await ethers.getContractFactory("ExternalPublicLibrary")).deploy();
      const Facet = await ethers.getContractFactory("ExternalLibraryFacet", {
        libraries: { ExternalPublicLibrary: await lib.getAddress() },
      });
      const facet = await Facet.deploy();

      const cut = await (await ethers.getContractFactory("DiamondCutFacet")).deploy();
      const Deployer = await ethers.getContractFactory("IndexDeployer");
      await expect(
        Deployer.deploy(
          await cut.getAddress(),
          [{ facet: await facet.getAddress(), selectors: await selectorsOf("ExternalLibraryFacet") }],
          [],
          INIT,
          ethers.ZeroHash
        )
      ).to.be.revertedWithCustomError(
        await ethers.getContractFactory("DiamondCutFacet"),
        "FacetContainsDelegatecall"
      );
    });

    it("an address with no code is rejected, so a typo'd manifest entry cannot become a silently-dead selector", async () => {
      const cut = await (await ethers.getContractFactory("DiamondCutFacet")).deploy();
      const Deployer = await ethers.getContractFactory("IndexDeployer");
      await expect(
        Deployer.deploy(
          await cut.getAddress(),
          [{ facet: "0x00000000000000000000000000000000cafebabe", selectors: ["0x12345678"] }],
          [],
          INIT,
          ethers.ZeroHash
        )
      ).to.be.revertedWithCustomError(
        await ethers.getContractFactory("DiamondCutFacet"),
        "FacetHasNoCode"
      );
    });
  });

  describe("the guard does NOT over-fire", () => {
    it("a clean facet installs normally", async () => {
      const cut = await (await ethers.getContractFactory("DiamondCutFacet")).deploy();
      const clean = await (await ethers.getContractFactory("CleanFacet")).deploy();
      const loupeF = await (await ethers.getContractFactory("DiamondLoupeFacet")).deploy();

      const manifest = [
        { facet: await loupeF.getAddress(), selectors: await selectorsOf("DiamondLoupeFacet") },
        { facet: await clean.getAddress(), selectors: await selectorsOf("CleanFacet") },
      ];
      const { facetSetHash } = require("./helpers/diamond");
      const hash = facetSetHash(manifest.map((m) => ({ name: "", ...m })));

      const Deployer = await ethers.getContractFactory("IndexDeployer");
      const dep: any = await Deployer.deploy(await cut.getAddress(), manifest, [], INIT, hash);
      const diamond = await dep.diamond();
      const handle: any = await ethers.getContractAt("CleanFacet", diamond);
      expect(await handle.ok()).to.equal(42n);
    });

    it("a facet whose PUSH DATA contains the bytes 0xff and 0xf4 installs normally", async () => {
      // THE FALSE-POSITIVE CONTROL, and it is the test that makes the guard
      // usable at all. A naive byte-frequency scan rejects this contract — and
      // would reject essentially every real facet, since 0xff and 0xf4 appear
      // constantly inside constants and jump targets. A correct PUSH-skipping
      // sweep accepts it.
      //
      // The soundness argument in the other direction: a byte inside PUSH data
      // is, by the EVM's own jumpdest analysis (the same linear sweep), not a
      // valid JUMPDEST, so it can never be jumped to and executed. Skipping it
      // therefore creates no false negative either.
      const cut = await (await ethers.getContractFactory("DiamondCutFacet")).deploy();
      const push = await (await ethers.getContractFactory("PushDataFacet")).deploy();
      // The loupe is not optional in a manifest: IndexDeployer's self-check
      // reads `isFinalized`/`isDevMode`/`facetAddress` back off the diamond
      // before it will accept the deployment, so a manifest without a loupe
      // cannot finalize. That is deliberate — a diamond nobody can inspect is a
      // diamond whose anchor rule nobody can check.
      const loupeF = await (await ethers.getContractFactory("DiamondLoupeFacet")).deploy();
      const manifest = [
        { facet: await loupeF.getAddress(), selectors: await selectorsOf("DiamondLoupeFacet") },
        { facet: await push.getAddress(), selectors: await selectorsOf("PushDataFacet") },
      ];
      const { facetSetHash } = require("./helpers/diamond");
      const hash = facetSetHash(manifest.map((m) => ({ name: "", ...m })));

      const Deployer = await ethers.getContractFactory("IndexDeployer");
      const dep: any = await Deployer.deploy(await cut.getAddress(), manifest, [], INIT, hash);
      const handle: any = await ethers.getContractAt("PushDataFacet", await dep.diamond());
      const [a, b] = await handle.constants();
      expect(a).to.equal(0xffn);
      expect(b).to.equal(0xf4n);
    });

    it("and the control is not vacuous: PushDataFacet's raw bytes really do contain 0xff and 0xf4", async () => {
      const art = await artifacts.readArtifact("PushDataFacet");
      const raw = Buffer.from(art.deployedBytecode.slice(2), "hex");
      expect(raw.includes(0xff), "no 0xff byte present — control proves nothing").to.equal(true);
      expect(raw.includes(0xf4), "no 0xf4 byte present — control proves nothing").to.equal(true);
      // …and the PUSH-aware sweep finds none of them at an executable position.
      const scan = scanOpcodes(art.deployedBytecode);
      expect(scan.selfdestructAt).to.deep.equal([]);
      expect(scan.delegatecallAt).to.deep.equal([]);
    });
  });

  describe("independent off-chain re-check of every production facet", () => {
    // Deliberately a SECOND implementation of the sweep (helpers/diamond.ts),
    // not a call into LibBytecodeScan. If the guard and its test shared one
    // implementation, a bug in that implementation would pass both.
    const PRODUCTION_FACETS = ["DiamondCutFacet", "DiamondLoupeFacet"];

    for (const name of PRODUCTION_FACETS) {
      it(`${name} contains no executable SELFDESTRUCT or DELEGATECALL`, async () => {
        const art = await artifacts.readArtifact(name);
        const scan = scanOpcodes(art.deployedBytecode);
        expect(scan.selfdestructAt, `SELFDESTRUCT at ${scan.selfdestructAt}`).to.deep.equal([]);
        expect(scan.delegatecallAt, `DELEGATECALL at ${scan.delegatecallAt}`).to.deep.equal([]);
      });

      it(`${name} is comfortably under the EIP-170 limit`, async () => {
        // The entire point of the refactor. GlobalIndexVault sat at 24,528 of
        // 24,576 bytes — 48 bytes of headroom — and five library extractions
        // had already been spent, one of which made the contract BIGGER.
        const size = await deployedSize(name);
        expect(size, `${name} is ${size} bytes`).to.be.lessThan(EIP170_LIMIT);
      });
    }

    it("the independent sweep is real: it finds the opcodes in the attack facets", async () => {
      // Negative control for the off-chain scanner itself.
      const sd = scanOpcodes((await artifacts.readArtifact("SelfdestructFacet")).deployedBytecode);
      expect(sd.selfdestructAt.length).to.be.greaterThan(0);

      const dc = scanOpcodes((await artifacts.readArtifact("DelegatecallFacet")).deployedBytecode);
      expect(dc.delegatecallAt.length).to.be.greaterThan(0);
    });
  });

  describe("the Diamond proxy itself", () => {
    it("contains DELEGATECALL — and that is correct, because the proxy is not a facet and is never scanned", async () => {
      // Stated explicitly so nobody later "fixes" the proxy to satisfy a scan
      // that was never meant to apply to it. The proxy's DELEGATECALL is the
      // dispatch; the guard exists to stop a FACET from adding a second,
      // uncontrolled one.
      const scan = scanOpcodes((await artifacts.readArtifact("Diamond")).deployedBytecode);
      expect(scan.delegatecallAt.length).to.equal(1);
      expect(scan.selfdestructAt).to.deep.equal([]);
    });
  });
});
