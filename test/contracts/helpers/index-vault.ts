import { ethers, artifacts } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployIndexDiamond, combinedHandle } from "./diamond";

/**
 * Shared fixture for the GlobalIndexVault suites. Mirrors the shape
 * VaultV3.audit.test.ts's `seededVault()` uses: build a realistic opened
 * basket, hand back everything a test needs to attack it.
 *
 * LOCAL HARDHAT ONLY. Nothing here has a network, an RPC, or a key.
 */

export const WAD = 10n ** 18n;
export const BPS = 10_000n;

export const MIN_CHECKPOINT = 600; // 10 min
export const STALE_AFTER = 7_200; // 2 h
export const RAMP_DURATION = 30 * 24 * 3_600;
export const TIMELOCK = 48 * 3_600;
export const CONCENTRATION_CAP_BPS = 4_000n;
export const LARGE_OP_WEI = ethers.parseEther("10");

export const defaultParams = {
  concentrationCapBps: CONCENTRATION_CAP_BPS,
  baseImbalanceFeeBps: 10n,
  imbalanceSlopeBps: 500n,
  maxImbalanceFeeBps: 600n,
  bandBps: 100n,
  priceCapBps: 500n,
  minCheckpointInterval: BigInt(MIN_CHECKPOINT),
  staleAfter: BigInt(STALE_AFTER),
  persistenceCheckpoints: 3n,
  persistenceToleranceBps: 500n,
  largeOpValueWei: LARGE_OP_WEI,
  rampDuration: BigInt(RAMP_DURATION),
};

export type ParamStruct = typeof defaultParams;

export function paramsTuple(p: ParamStruct) {
  return [
    p.concentrationCapBps,
    p.baseImbalanceFeeBps,
    p.imbalanceSlopeBps,
    p.maxImbalanceFeeBps,
    p.bandBps,
    p.priceCapBps,
    p.minCheckpointInterval,
    p.staleAfter,
    p.persistenceCheckpoints,
    p.persistenceToleranceBps,
    p.largeOpValueWei,
    p.rampDuration,
  ];
}

/** Deploy a constituent (mock v-token + its own constant-product price source). */
export async function deployConstituent(
  name: string,
  ethSide: bigint,
  tokenSide: bigint
) {
  const Token = await ethers.getContractFactory("MockIndexToken");
  const token: any = await Token.deploy(name, name);
  const Source = await ethers.getContractFactory("MockIndexPriceSource");
  const source: any = await Source.deploy(ethSide, tokenSide);
  return { token, source, addr: await token.getAddress() };
}

export interface IndexFixture {
  /** ROLE_ADMIN — reassigns role holders, and can do nothing else. */
  roleAdmin: any;
  /** ROLE_CONSTITUENT_ADMISSION — queueListing / queueMetric. */
  admission: any;
  /** ROLE_RISK_PARAM — queueParam over the risk surface. */
  risk: any;
  /** ROLE_PLATFORM_ALLOCATION — platformAllocationBps / platformTreasury. */
  allocation: any;
  seeder: any;
  alice: any;
  bob: any;
  carol: any;
  vault: any;
  vaultAddr: string;
  tokens: any[];
  sources: any[];
  addrs: string[];
}

/**
 * Three constituents at 1.0 / 0.5 / 2.0 ETH each, 1000 units of each seeded,
 * 1000e18 seed shares locked to address(0), index open.
 */
/**
 * The FACET SET the index diamond is cut from, in manifest order.
 *
 * This list is the single declaration site. `deployOpenIndex` cuts exactly
 * these, `combinedHandle` unions exactly these ABIs, and
 * `Diamond.selectors.test.ts` asserts the union is 4-byte-unique — so a facet
 * cannot be added to the deployment without also being added to the surface the
 * tests enumerate.
 *
 * `DiamondCutFacet` is deliberately absent: it is installed by `IndexDeployer`
 * and REMOVED again by `finalize`, inside the same transaction, so it is never
 * part of the live set. See docs/DESIGN-DIAMOND-UNIFIED-ARCHITECTURE.md section 6.
 */
export const INDEX_FACETS = [
  "DiamondLoupeFacet",
  "IndexShareFacet",
  "IndexCoreFacet",
  "IndexBootstrapFacet",
  "IndexTradeFacet",
  "IndexOracleFacet",
  "IndexEligibilityFacet",
  "IndexGovernanceFacet",
  "IndexDividendFacet",
  "IndexLensFacet",
  "IndexStreamFacet",
  "HookRegistryFacet",
  "IndexPoolFacet",
  "IndexBuybackFacet",
  "IndexDevFundFacet",
  "IndexSocialFiTreasuryFacet",
  "IndexEnergyFacet",
  "IndexZapFacet",
] as const;

/**
 * Deploy the index diamond, frozen, and hand back a combined-ABI handle.
 *
 * WHAT REPLACED WHAT. This helper used to deploy five `public` libraries, build
 * a link map, and hand back a `GlobalIndexVault` factory. All of that is gone:
 * the libraries are `internal` now (design doc section 2.4 — five DELEGATECALL
 * targets removed from the runtime graph, and required anyway, because
 * `LibBytecodeScan` rejects opcode 0xf4 in any facet), and there is no link map
 * to reproduce.
 *
 * The returned handle is an ethers Contract over the UNION of every facet ABI,
 * pointed at the diamond. `IndexFixture.vault` is typed `any`, so every existing
 * call site — `vault.redeemProRata(...)`, `vault.balanceOf(...)` — resolves
 * exactly as it did through the monolith's ABI. The CLAIM each test makes is
 * unchanged; only the address it lands on and the dispatch behind it.
 */
export async function deployIndexVault(args: {
  name: string;
  symbol: string;
  roles: [string, string, string, string, string];
  seeder: string;
  timelockDelay: number | bigint;
  params: any[];
  dividendAsset: string;
}): Promise<{ vault: any; vaultAddr: string; diamond: any }> {
  const d = await deployIndexDiamond([...INDEX_FACETS], {
    timelockDelay: args.timelockDelay,
    seeder: args.seeder,
    dividendAsset: args.dividendAsset,
    name: args.name,
    symbol: args.symbol,
    roles: args.roles,
    params: args.params,
  });
  const vault = await combinedHandle(d.address, [...INDEX_FACETS]);
  return { vault, vaultAddr: d.address, diamond: d };
}

/**
 * BACKWARDS-COMPATIBLE DEPLOY SHIM for the suites that build a bespoke vault
 * rather than using `deployOpenIndex`.
 *
 * It keeps the monolith's exact constructor CALL SHAPE —
 * `(name, symbol, roles[4], seeder, timelockDelay, params, dividendAsset)` —
 * and deploys the diamond behind it. That is deliberate: the claims those
 * suites make are about SEEDING, PRICING and GOVERNANCE, not about how many
 * arguments a constructor takes, so re-pointing them at the diamond without
 * touching their bodies is the honest adaptation. `.interface` is the union of
 * every facet's ABI plus the deployer's and the diamond's own errors, so
 * `revertedWithCustomError(Vault, ...)` still resolves.
 */
export async function indexVaultFactory() {
  const abi: any[] = [];
  const seen = new Set<string>();
  for (const n of [...INDEX_FACETS, "IndexDeployer", "Diamond"]) {
    const art = await artifacts.readArtifact(n);
    for (const frag of art.abi) {
      const key = JSON.stringify(frag);
      if (seen.has(key)) continue;
      seen.add(key);
      abi.push(frag);
    }
  }
  return {
    interface: new ethers.Interface(abi),
    async deploy(
      name: string,
      symbol: string,
      roles: string[],
      seeder: string,
      timelockDelay: number | bigint,
      params: any[],
      dividendAsset: string
    ) {
      const { vault } = await deployIndexVault({
        name,
        symbol,
        // ROLE_STREAM_LISTER joins the set under unification. Seeded to the
        // admission holder, exactly as `deployOpenIndex` does.
        roles: [roles[0], roles[1], roles[2], roles[3], roles[1]] as [
          string,
          string,
          string,
          string,
          string
        ],
        seeder,
        timelockDelay,
        params,
        dividendAsset,
      });
      return vault;
    },
  };
}

export async function deployOpenIndex(
  overrides: Partial<ParamStruct> = {},
  reserves: bigint[] = [1000n * WAD, 1000n * WAD, 1000n * WAD]
): Promise<IndexFixture> {
  const [, roleAdmin, seeder, alice, bob, carol, admission, risk, allocation] =
    await ethers.getSigners();

  const c0 = await deployConstituent("cA", 100n * WAD, 100n * WAD); // 1.0
  const c1 = await deployConstituent("cB", 50n * WAD, 100n * WAD); // 0.5
  const c2 = await deployConstituent("cC", 200n * WAD, 100n * WAD); // 2.0
  const cs = [c0, c1, c2];

  const { vault, vaultAddr } = await deployIndexVault({
    name: "Marketplank Global Index",
    symbol: "gPLNK",
    roles: [
      roleAdmin.address,
      admission.address,
      risk.address,
      allocation.address,
      // ROLE_STREAM_LISTER. The wrapper's listing capability joins the vault's
      // role set under unification (design doc section 2.3); it is seeded to
      // the admission holder so the fixture has a live holder for it, and it
      // reaches no value path either way.
      admission.address,
    ],
    seeder: seeder.address,
    timelockDelay: TIMELOCK,
    params: paramsTuple({ ...defaultParams, ...overrides }),
    // Dividends are denominated in the first constituent. Written once at
    // deploy and reachable by no function, so every fixture-based test
    // exercises a vault whose dividend asset is real.
    dividendAsset: c0.addr,
  });

  for (let i = 0; i < cs.length; i++) {
    await vault
      .connect(seeder)
      .seedConstituent(cs[i].addr, await cs[i].source.getAddress(), 3_333);
    await cs[i].token.mint(seeder.address, reserves[i]);
    await cs[i].token.connect(seeder).approve(vaultAddr, reserves[i]);
    await vault.connect(seeder).seedDeposit(cs[i].addr, reserves[i]);
  }
  await vault.connect(seeder).openIndex(1000n * WAD);

  // Fund the actors generously so a test never fails on a missing balance.
  for (const who of [alice, bob, carol]) {
    for (const c of cs) {
      await c.token.mint(who.address, 500_000n * WAD);
      await c.token.connect(who).approve(vaultAddr, ethers.MaxUint256);
    }
  }

  return {
    roleAdmin,
    admission,
    risk,
    allocation,
    seeder,
    alice,
    bob,
    carol,
    vault,
    vaultAddr,
    tokens: cs.map((c) => c.token),
    sources: cs.map((c) => c.source),
    addrs: cs.map((c) => c.addr),
  };
}

/**
 * Point an opened index at a provenance registry and register `tokens` in it.
 *
 * AUDIT C-6. Post-open constituent admission (`queueListing`/`executeListing`)
 * and every `zapMint` leg now require the token to be a vault the configured
 * `CollectionVaultFactory` deployed — `IndexFacetBase._requireAdmissible`. The
 * default is `address(0)`, which admits NOTHING, so any suite that lists a
 * constituent after `openIndex` must arm the registry first.
 *
 * `MockVaultFactory` stands in for the real factory's `isVault` registry, and
 * the fact that a test must EXPLICITLY register a token is the point: an
 * attacker cannot register their own token in the real factory without
 * deploying a genuine vault through it, and `RedTeam.HostileConstituentAdmission`
 * models exactly that by declining to register the token it minted.
 */
export async function armVaultRegistry(fx: IndexFixture, tokens?: string[]) {
  const F = await ethers.getContractFactory("MockVaultFactory");
  const factory: any = await F.deploy();
  for (const t of tokens ?? fx.addrs) await factory.setVault(t, true);
  await fx.vault.connect(fx.admission).queueVaultFactory(await factory.getAddress());
  await time.increase(TIMELOCK + 1);
  await fx.vault.executeVaultFactory();
  return factory;
}

/** Advance time and lay down `n` fresh observations on every constituent. */
export async function warmCheckpoints(fx: IndexFixture, n: number) {
  for (let i = 0; i < n; i++) {
    await time.increase(MIN_CHECKPOINT + 1);
    await fx.vault.checkpointAll();
  }
}

export const maxIn = (n: number) => new Array(n).fill(ethers.MaxUint256);
export const zeroOut = (n: number) => new Array(n).fill(0n);
