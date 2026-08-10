import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { selectorsOf, facetSetHash } from "./helpers/diamond.js";
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { INDEX_FACETS } from "./helpers/index-vault.js";

/**
 * ============================================================================
 *  DeployIndexVault.script — proves scripts/deploy-index-vault.ts is a
 *  faithful, EXECUTABLE version of the deploy-cut-finalize sequence
 *  Diamond.finalize.test.ts already proves correct, not a divergent
 *  reimplementation (design doc §7.8, item 5).
 *
 *  This suite deliberately does NOT re-derive the finalization properties
 *  from scratch: it runs the REAL script entry point
 *  (`deployIndexVault` from scripts/deploy-index-vault.ts, the exact function
 *  `npx hardhat run scripts/deploy-index-vault.ts` calls) against the local
 *  Hardhat network, then asserts the SAME invariants
 *  Diamond.finalize.test.ts's "the frozen end state" block asserts about a
 *  diamond built directly through `deployIndexDiamond`. Both scripts share
 *  the same `deployIndexDiamond` implementation on purpose (see
 *  deploy-index-vault.ts's header) — this test is what makes "the script
 *  path and the test-proven path are the same path" a checked claim rather
 *  than an assertion in a comment.
 * ============================================================================
 */
describe("deploy-index-vault script — faithful to IndexDeployer's proven sequence", () => {
  const SEEDER = "0x0000000000000000000000000000000000000B0B";
  const DIVIDEND = "0x000000000000000000000000000000000000dEaD";

  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    const [, admin, admission, risk, allocation] = [
      "0x00000000000000000000000000000000000001",
    ];
    process.env.MARKET_INDEX_SEEDER = SEEDER;
    process.env.MARKET_INDEX_DIVIDEND_ASSET = DIVIDEND;
    process.env.MARKET_INDEX_ROLE_ADMIN = "0x00000000000000000000000000000000000000A1";
    process.env.MARKET_INDEX_ROLE_ADMISSION = "0x00000000000000000000000000000000000000A2";
    process.env.MARKET_INDEX_ROLE_RISK = "0x00000000000000000000000000000000000000A3";
    process.env.MARKET_INDEX_ROLE_ALLOCATION = "0x00000000000000000000000000000000000000A4";
    process.env.MARKET_INDEX_NAME = "Marketplank Global Index";
    process.env.MARKET_INDEX_SYMBOL = "gPLNK";
    process.env.MARKET_INDEX_TIMELOCK_DELAY = String(48 * 3600);
    void admin;
    void admission;
    void risk;
    void allocation;
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("produces a diamond whose finalized state matches what IndexDeployer's own test suite proves", async () => {
    // No cache-busting needed under ESM: `process.env` is read INSIDE
    // deployIndexVault()'s own call graph (scripts/config/index-vault-deploy-
    // config.ts's helpers read it at call time, not at module load), so a
    // plain dynamic import already picks up whatever beforeEach just set —
    // there is no stale module-level snapshot to invalidate, unlike
    // CommonJS's require.cache.
    const { deployIndexVault } = await import("../../scripts/deploy-index-vault.js");

    const result = await deployIndexVault();

    // ── Diamond.finalize.test.ts's "the frozen end state" block, re-run
    //    against the SCRIPT'S output rather than a direct deployIndexDiamond
    //    call. ──────────────────────────────────────────────────────────
    const loupe = await ethers.getContractAt("DiamondLoupeFacet", result.diamondAddress);

    expect(await loupe.isFinalized(), "isFinalized() must be true").to.equal(true);
    expect(await loupe.isDevMode(), "must be Tier A, not Tier B").to.equal(false);

    for (const sel of await selectorsOf("DiamondCutFacet")) {
      expect(
        await loupe.facetAddress(sel),
        `cut selector ${sel} must not route anywhere post-finalize`
      ).to.equal(ethers.ZeroAddress);
    }

    // Every facet in the real production manifest (INDEX_FACETS) routes to
    // itself, and nothing else is installed.
    const addrs: string[] = await loupe.facetAddresses();
    expect(addrs.length).to.equal(INDEX_FACETS.length);
    for (const m of result.manifest) {
      for (const sel of m.selectors) {
        expect(await loupe.facetAddress(sel), `${m.name}'s selector ${sel}`).to.equal(m.facet);
      }
    }

    // The committed hash the script reports is independently re-derivable
    // from the published manifest, exactly as a reviewer would check it —
    // and it matches what the deployed diamond itself reports.
    expect(facetSetHash(result.manifest)).to.equal(result.committedFacetSetHash);
    expect(await loupe.facetSetHash()).to.equal(result.committedFacetSetHash);
    expect(await loupe.currentFacetSetHash()).to.equal(result.committedFacetSetHash);

    // No observable cuttable window: the deploy tx itself contains both the
    // DiamondCut and Finalized events, exactly like
    // Diamond.finalize.test.ts's "there is no observable window" block.
    const receipt = await ethers.provider.getTransactionReceipt(result.txHash);
    const topics = receipt!.logs.map((l) => l.topics[0]);
    expect(topics).to.include(ethers.id("DiamondCut((address,uint8,bytes4[])[],address,bytes)"));
    expect(topics).to.include(ethers.id("Finalized(bytes32,uint256,uint256)"));

    // Roles landed exactly as the config specified — the script's own
    // "initial governance role assignments" claim (§7.8 item 3), checked
    // through the diamond's real getter rather than assumed from input.
    const gov = await ethers.getContractAt("IndexGovernanceFacet", result.diamondAddress);
    expect(await gov.roleHolder(await gov.ROLE_ADMIN())).to.equal(
      ethers.getAddress("0x00000000000000000000000000000000000000A1")
    );
    expect(await gov.roleHolder(await gov.ROLE_CONSTITUENT_ADMISSION())).to.equal(
      ethers.getAddress("0x00000000000000000000000000000000000000A2")
    );
    expect(await gov.roleHolder(await gov.ROLE_RISK_PARAM())).to.equal(
      ethers.getAddress("0x00000000000000000000000000000000000000A3")
    );
    expect(await gov.roleHolder(await gov.ROLE_PLATFORM_ALLOCATION())).to.equal(
      ethers.getAddress("0x00000000000000000000000000000000000000A4")
    );

    const bootstrap = await ethers.getContractAt("IndexBootstrapFacet", result.diamondAddress);
    expect(await bootstrap.seeder()).to.equal(ethers.getAddress(SEEDER));
    expect(await bootstrap.dividendAsset()).to.equal(ethers.getAddress(DIVIDEND));
    expect(await bootstrap.indexOpen()).to.equal(false);
  });

  it("two independent script runs never collide — each produces its own diamond", async () => {
    const { deployIndexVault } = await import("../../scripts/deploy-index-vault.js");
    const a = await deployIndexVault();
    const b = await deployIndexVault();
    expect(a.diamondAddress).to.not.equal(b.diamondAddress);
    const loupeA = await ethers.getContractAt("DiamondLoupeFacet", a.diamondAddress);
    const loupeB = await ethers.getContractAt("DiamondLoupeFacet", b.diamondAddress);
    expect(await loupeA.isFinalized()).to.equal(true);
    expect(await loupeB.isFinalized()).to.equal(true);
  });
});
