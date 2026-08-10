import { expect } from "chai";
import { ethers, artifacts } from "./helpers/hardhat.js";
import { loadFixture } from "./helpers/network-helpers.js";

import { deployedSize, EIP170_LIMIT, scanOpcodes } from "./helpers/diamond.js";
import { INDEX_FACETS, deployOpenIndex, maxIn, zeroOut } from "./helpers/index-vault.js";

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  THE FACET SET ITSELF — sizing, purity, and the exit door's isolation.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * These are properties of the SPLIT, not of the arithmetic. Every claim the
 * refactor makes about *why* it was worth doing is asserted here mechanically,
 * so that "the byte budget is no longer a design constraint" and "the exit door
 * imports nothing privileged" stay true as facets grow rather than being true
 * once, on the day they were written.
 *
 * LOCAL HARDHAT ONLY.
 */

/** `loadFixture` refuses anonymous functions — it keys its snapshot on identity. */
function openIndexFixture() {
  return deployOpenIndex();
}

/** Facets plus the cut facet, which is installed and removed inside one tx. */
const ALL_FACETS = [...INDEX_FACETS, "DiamondCutFacet"];

describe("Diamond facet set — sizing and purity", () => {
  // ────────────────────────────────────────────────────────────────────────
  //  1. The byte budget
  // ────────────────────────────────────────────────────────────────────────

  it("every facet is under EIP-170, and none is even close to the wall the monolith died against", async () => {
    const rows: Array<[string, number]> = [];
    for (const n of [...ALL_FACETS, "Diamond", "IndexDeployer"]) {
      rows.push([n, await deployedSize(n)]);
    }
    for (const [n, size] of rows) {
      expect(size, `${n} exceeds EIP-170`).to.be.lessThan(EIP170_LIMIT);
    }

    // The monolith finished at 24,528 of 24,576 — 48 bytes of headroom — after
    // five library extractions and a per-file `runs: 1` + `viaIR` override had
    // been spent buying it back under the limit. The point of the split is that
    // no single object is anywhere near that wall any more. 80% is a deliberately
    // loose bar: it is not a style rule, it is an alarm for the case where one
    // facet has quietly re-accumulated the monolith's problem and needs its views
    // moved to IndexLensFacet (design doc section 2.1 rule 2).
    const worst = rows.reduce((a, b) => (a[1] >= b[1] ? a : b));
    expect(worst[1], `${worst[0]} is within 20% of EIP-170 — move its views to IndexLensFacet`)
      .to.be.lessThan(EIP170_LIMIT * 0.8);

    // eslint-disable-next-line no-console
    console.log(
      "\n      deployed bytecode (limit 24,576):\n" +
        rows
          .sort((a, b) => b[1] - a[1])
          .map(([n, s]) => `        ${String(s).padStart(6)}  ${n}`)
          .join("\n")
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  //  2. No facet declares state — the rule the whole namespace design rests on
  // ────────────────────────────────────────────────────────────────────────

  it("no facet declares a state variable, so nothing can land on the diamond's own slot 0", async () => {
    // HH3's ArtifactManager returns a Set (no .filter) from
    // getAllFullyQualifiedNames(), and splits build info into an ID plus a
    // separate OUTPUT file path rather than one object returned by
    // getBuildInfo(fqn) — see Diamond.storage.test.ts's storageLayoutOf for
    // the same pattern in helper form.
    for (const name of ALL_FACETS) {
      const fq = [...(await artifacts.getAllFullyQualifiedNames())].find((f) => f.endsWith(`:${name}`));
      if (!fq) throw new Error(`no artifact for ${name}`);
      const buildInfoId = await artifacts.getBuildInfoId(fq);
      if (!buildInfoId) throw new Error(`no build info id for ${fq}`);
      const outputPath = await artifacts.getBuildInfoOutputPath(buildInfoId);
      if (!outputPath) throw new Error(`no build info output path for ${fq}`);
      const { readFile } = await import("node:fs/promises");
      // Same wrapper shape as Diamond.storage.test.ts's storageLayoutOf: the
      // real contracts map is nested at `.output.contracts`, not top-level.
      const wrapper = JSON.parse(await readFile(outputPath, "utf8"));
      const [file, contract] = fq.split(":");
      // The solc source-file KEYS in this wrapper carry an HH3 build-system
      // root marker ("project/contracts/...") the artifact-facing fqn does
      // not — search by suffix instead of an exact match.
      const fileKey = Object.keys(wrapper.output.contracts).find((k) => k.endsWith(file));
      if (!fileKey) throw new Error(`no output.contracts entry ending in ${file}`);
      const layout = wrapper.output.contracts[fileKey][contract].storageLayout;
      expect(layout.storage, `${name} declares state: ${JSON.stringify(layout.storage)}`).to.deep.equal(
        []
      );
    }
  });

  it("no facet contains SELFDESTRUCT or DELEGATECALL — which is also why the lib/ libraries had to go internal", async () => {
    for (const name of ALL_FACETS) {
      const art = await artifacts.readArtifact(name);
      const { selfdestructAt, delegatecallAt } = scanOpcodes(art.deployedBytecode);
      expect(selfdestructAt, `${name} contains SELFDESTRUCT`).to.deep.equal([]);
      expect(delegatecallAt, `${name} contains DELEGATECALL`).to.deep.equal([]);
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  //  3. The exit door's isolation (design doc section 2.1 rule 1)
  // ────────────────────────────────────────────────────────────────────────

  it("IndexCoreFacet — the exit door — reads no roles, no governance and no hook registry", async () => {
    // Source-level, deliberately: the claim is about what a REVIEWER can
    // confirm by reading one short file, so the test reads the same file.
    //
    // COMMENTS ARE STRIPPED FIRST, and that is not a convenience — this facet's
    // header EXPLAINS that it does not read `RolesStorage`, so a naive substring
    // scan would fail on the very sentence that documents the property. What is
    // being asserted is about CODE.
    const raw = (await import("fs")).readFileSync(
      "contracts/diamond/facets/IndexCoreFacet.sol",
      "utf8"
    );
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of [
      "RolesStorage",
      "GovernanceStorage",
      "HooksStorage",
      "onlyRole",
      "ParamsStorage",
    ]) {
      expect(code.includes(forbidden), `IndexCoreFacet reaches ${forbidden}`).to.equal(false);
    }
  });

  it("no function on the exit-door facet carries a role gate — enumerated, not asserted", async () => {
    const art = await artifacts.readArtifact("IndexCoreFacet");
    const iface = new ethers.Interface(art.abi);
    const fns: string[] = [];
    iface.forEachFunction((f) => fns.push(f.name));
    // The whole surface, named, so that ADDING a function to the exit door is a
    // change a reviewer has to make deliberately here as well as there.
    expect(fns.sort()).to.deep.equal(
      [
        "claimPending",
        "claimPendingMany",
        "claimableRedeemRequest",
        "mintProRata",
        "pendingClaim",
        "pendingRedeemRequest",
        "redeemProRata",
        "reservedClaims",
      ].sort()
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  //  4. Cross-facet reentrancy exclusion — STRONGER than the monolith's guard
  // ────────────────────────────────────────────────────────────────────────

  it("the reentrancy guard is ONE word for the whole diamond, so facet A excludes a re-entry into facet B", async () => {
    // A per-facet guard would be the silent regression here: `nonReentrant` on
    // IndexCoreFacet would no longer exclude a reentrant call into
    // IndexDividendFacet, because they would be different contracts with
    // different slot-0 words. The namespaced word makes the exclusion global.
    //
    // Asserted STRUCTURALLY rather than by bytecode sniffing, because the
    // optimiser is free to materialise the slot constant however it likes:
    //
    //  (a) `ReentrancyStorage` — the only declaration of the guard word — exists
    //      exactly once in the whole tree, so there is no second word to drift
    //      to; and
    //  (b) no facet declares its own guard, i.e. none of them contains a
    //      `nonReentrant` MODIFIER DEFINITION or an OpenZeppelin
    //      `ReentrancyGuard` import. They can only be using the one in
    //      `IndexFacetBase`, which reads that single namespace.
    //
    // Together those are the property: one declaration, one reader, every facet.
    const fs = await import("fs");
    const declarations = fs
      .readdirSync("contracts/diamond/storage")
      .map((f: string) => fs.readFileSync(`contracts/diamond/storage/${f}`, "utf8"))
      .join("\n")
      .match(/library ReentrancyStorage/g);
    expect(declarations, "ReentrancyStorage is not declared exactly once").to.have.lengthOf(1);

    for (const n of INDEX_FACETS) {
      const src = fs.readFileSync(`contracts/diamond/facets/${n}.sol`, "utf8");
      expect(src.includes("modifier nonReentrant"), `${n} declares its own guard`).to.equal(false);
      expect(src.includes("ReentrancyGuard"), `${n} imports OpenZeppelin's per-contract guard`)
        .to.equal(false);
    }
    const base = fs.readFileSync("contracts/diamond/facets/IndexFacetBase.sol", "utf8");
    expect(base.includes("modifier nonReentrant")).to.equal(true);
    expect(base.includes("ReentrancyStorage.layout()")).to.equal(true);
  });

  // ────────────────────────────────────────────────────────────────────────
  //  5. The dispatch overhead, measured and disclosed (design doc section 10)
  // ────────────────────────────────────────────────────────────────────────

  it("the fallback's selector lookup is measured and disclosed, not hand-waved", async () => {
    const fx = await loadFixture(openIndexFixture);
    const { vault, alice } = fx;

    await vault.connect(alice).mintProRata(1000n * 10n ** 18n, maxIn(3));

    const transferGas = await vault
      .connect(alice)
      .transfer.estimateGas(fx.bob.address, 1n * 10n ** 18n);
    const redeemGas = await vault
      .connect(alice)
      .redeemProRata.estimateGas(100n * 10n ** 18n, zeroOut(3));

    // eslint-disable-next-line no-console
    console.log(
      `\n      diamond dispatch overhead, disclosed:\n` +
        `        share transfer      ${transferGas}\n` +
        `        3-leg redeemProRata ${redeemGas}`
    );

    // The honest statement from the design doc: on a 32-leg redemption the
    // fallback's ~2.6k lookup plus a DELEGATECALL is noise; on a plain transfer
    // it is not nothing. These bounds are loose on purpose — they exist to catch
    // an ORDER-OF-MAGNITUDE regression in dispatch, not to pin a gas golf score.
    expect(transferGas).to.be.lessThan(200_000n);
    expect(redeemGas).to.be.lessThan(1_000_000n);
  });

  // ────────────────────────────────────────────────────────────────────────
  //  6. The exit door still works with every role key hostile, post-finalize
  // ────────────────────────────────────────────────────────────────────────

  it("redeemProRata succeeds against a FINALIZED diamond with every role holder acting against the redeemer", async () => {
    const fx = await loadFixture(openIndexFixture);
    const { vault, alice, roleAdmin, admission, risk, allocation, addrs } = fx;

    // The diamond is frozen — this is the premise the anchor rule now rests on,
    // and it is asserted HERE as well as in Diamond.finalize.test.ts, because a
    // redemption test that ran against a cuttable diamond would prove nothing.
    expect(await vault.isFinalized()).to.equal(true);
    expect(await vault.isDevMode()).to.equal(false);

    await vault.connect(alice).mintProRata(500n * 10n ** 18n, maxIn(3));

    // Every role does the worst thing it is permitted to do, simultaneously.
    await vault.connect(risk).queueParam(ethers.encodeBytes32String("bandBps"), 2_000n);
    await vault.connect(admission).queueListing(addrs[0], addrs[0], 0n, true);
    await vault.connect(allocation).queuePlatformTreasury(roleAdmin.address);
    await vault.connect(roleAdmin).queueRole(await vault.ROLE_RISK_PARAM(), roleAdmin.address);

    const before = await Promise.all(fx.tokens.map((t: any) => t.balanceOf(alice.address)));
    await vault.connect(alice).redeemProRata(500n * 10n ** 18n, zeroOut(3));
    const after = await Promise.all(fx.tokens.map((t: any) => t.balanceOf(alice.address)));

    for (let i = 0; i < 3; i++) {
      expect(after[i]).to.be.greaterThan(before[i], `leg ${i} paid nothing`);
    }
    expect(await vault.balanceOf(alice.address)).to.equal(0n);
  });
});
