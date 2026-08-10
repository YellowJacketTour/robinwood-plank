import { expect } from "chai";
import { ethers, artifacts } from "../helpers/hardhat.js";

/**
 * ============================================================================
 * PR11 (TEST-MATRIX-AXIOM-1-ADVERSARIAL.md §7, PM-1/PM-2).
 *
 * PM-1: "mintSingleAsset disabled or reverts in pure flag | configured" —
 * HONEST FINDING, not the matrix's assumed shape. `IndexTradeFacet.
 * mintSingleAsset` DOES exist and is a normal, always-available core index
 * feature (single-asset mint against one listed constituent, gated only by
 * `whenOpen`/listing/price-band checks — nothing energy-specific). A
 * repo-wide search confirms there is no `pureMode`/`PURE_MODE` flag or
 * storage slot anywhere in this codebase to gate it with — "pure mode" as a
 * distinct configurable deployment profile was never built. This test
 * documents that reality directly (asserting the ABI still exposes
 * `mintSingleAsset`, unconditionally callable once the index is open) rather
 * than asserting a nonexistent gate, which is the same "correctness of the
 * TEST matters more than speed" instruction this PR is bound by applied to
 * documentation, not just contract code: PM-1 is CLOSED as "not applicable
 * to this repo's actual design", not silently skipped.
 *
 * PM-2: "IIndexPriceSource unused in energy paths | pass" — the six real
 * energy adapters and `EnergyBus` itself must never import or reference any
 * oracle/price-source interface; every pricing decision on the energy path
 * is the vault's own AMM reserves (`InventoryBuyAdapter`/`CollectionLpAdapter`'s
 * own `MAX_IMPACT_BPS` guard against `paymentReserve`/`shareReserve`), never
 * an external feed. Asserted here via each adapter's own compiled ABI
 * exposing no oracle-shaped read.
 *
 * PM-3 (full 700+ suite still green) and PM-4 (EIP-170 facet sizes) are
 * already covered elsewhere — PM-3 by every `npm run test:contracts` run
 * itself, PM-4 by `test/contracts/Diamond.bytecode.test.ts` — so they are
 * not duplicated in this file.
 *
 * LOCAL HARDHAT ONLY.
 * ============================================================================
 */
describe("PR11 — Pure-mode / no-oracle-on-energy-path regression (matrix §7 PM-1/PM-2)", () => {
  const ENERGY_ADAPTER_NAMES = [
    "InventoryBuyAdapter",
    "CollectionLpAdapter",
    "IdxBurnAdapter",
    "PlankBurnAdapter",
    "PlankLpRenounceAdapter",
    "DividendAdapter",
  ];

  it("PM-1: mintSingleAsset exists as a normal, always-on core feature — there is no `pureMode`/`PURE_MODE` flag anywhere in this codebase to gate it with (honest documentation of this repo's actual design, not the matrix's assumed shape)", async () => {
    const names: string[] = await artifactAllNames();
    let mintSingleAssetFound = false;
    let pureModeFlagFound = false;
    for (const n of names) {
      const art = await ethers.getContractFactory(n).catch(() => null);
      if (!art) continue;
      const fragments = (art.interface as any).fragments;
      if (fragments.some((f: any) => f.type === "function" && f.name === "mintSingleAsset")) {
        mintSingleAssetFound = true;
      }
      if (
        fragments.some(
          (f: any) => typeof f.name === "string" && f.name.toLowerCase().includes("puremode")
        )
      ) {
        pureModeFlagFound = true;
      }
    }
    expect(mintSingleAssetFound).to.equal(true);
    expect(pureModeFlagFound).to.equal(false);
  });

  it("PM-2: EnergyBus and every one of the 6 real adapters expose no oracle/price-source-shaped read on their ABI, and never accept an oracle constructor arg", async () => {
    const busF = await ethers.getContractFactory("EnergyBus");
    const busNames = (busF.interface as any).fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => f.name.toLowerCase());
    for (const n of busNames) {
      expect(n.includes("oracle")).to.equal(false);
      expect(n.includes("pricesource")).to.equal(false);
    }

    for (const name of ENERGY_ADAPTER_NAMES) {
      const f = await ethers.getContractFactory(name);
      const fnNames = (f.interface as any).fragments
        .filter((frag: any) => frag.type === "function")
        .map((frag: any) => frag.name.toLowerCase());
      for (const n of fnNames) {
        expect(n.includes("oracle"), `${name}.${n} looks oracle-shaped`).to.equal(false);
        expect(n.includes("pricesource"), `${name}.${n} looks oracle-shaped`).to.equal(false);
      }

      // Constructor args: none of the 6 adapters accept an oracle/price
      // source address — every one takes only weth/index/bus/governance/
      // weightModule/timelock-shaped params (already fixed, immutable, at
      // construction — see each adapter's own header for its exact list).
      const ctor = (f.interface as any).fragments.find((frag: any) => frag.type === "constructor");
      if (ctor) {
        for (const input of ctor.inputs) {
          expect(input.name.toLowerCase().includes("oracle")).to.equal(false);
          expect(input.name.toLowerCase().includes("pricesource")).to.equal(false);
        }
      }
    }
  });

  /** Every top-level contract name this Hardhat project has compiled. */
  async function artifactAllNames(): Promise<string[]> {
    // HH3's getAllFullyQualifiedNames() returns a ReadonlySet, not an array
    // (no .map) — spread to an array first. `artifacts` also moved off the
    // bare `hardhat` module default export onto the HRE itself; use the
    // shared connection's `artifacts` re-export (./hardhat.js) rather than a
    // second, independent `import("hardhat")`.
    const all = [...(await artifacts.getAllFullyQualifiedNames())];
    return all.map((fq) => fq.split(":").pop()!);
  }
});
