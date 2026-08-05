import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

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
 * The vault's math and parameter key-space now live in two external
 * `library`s (contracts/lib/IndexMath.sol, contracts/lib/IndexParams.sol),
 * which the compiler reaches by DELEGATECALL and which therefore have to be
 * deployed and LINKED before the vault can be deployed at all. Every test that
 * deploys a GlobalIndexVault goes through this one helper so the link map is
 * written once — a per-test copy would be twelve places for the two names to
 * drift apart.
 */
export async function indexVaultFactory() {
  const IndexMath = await ethers.getContractFactory("IndexMath");
  const indexMath = await IndexMath.deploy();
  const IndexParams = await ethers.getContractFactory("IndexParams");
  const indexParams = await IndexParams.deploy();
  return ethers.getContractFactory("GlobalIndexVault", {
    libraries: {
      IndexMath: await indexMath.getAddress(),
      IndexParams: await indexParams.getAddress(),
    },
  });
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

  const Vault = await indexVaultFactory();
  const vault: any = await Vault.deploy(
    "Marketplank Global Index",
    "gPLNK",
    [roleAdmin.address, admission.address, risk.address, allocation.address],
    seeder.address,
    TIMELOCK,
    paramsTuple({ ...defaultParams, ...overrides })
  );
  const vaultAddr = await vault.getAddress();

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

/** Advance time and lay down `n` fresh observations on every constituent. */
export async function warmCheckpoints(fx: IndexFixture, n: number) {
  for (let i = 0; i < n; i++) {
    await time.increase(MIN_CHECKPOINT + 1);
    await fx.vault.checkpointAll();
  }
}

export const maxIn = (n: number) => new Array(n).fill(ethers.MaxUint256);
export const zeroOut = (n: number) => new Array(n).fill(0n);
