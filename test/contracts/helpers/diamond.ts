import { ethers, artifacts } from "../helpers/hardhat.js";

/**
 * Shared helpers for the Index diamond suites.
 *
 * LOCAL HARDHAT ONLY. Nothing here has a network, an RPC, or a key.
 *
 * The one thing worth reading before using this file: `deployIndexDiamond`
 * deploys through `IndexDeployer`'s CONSTRUCTOR, which is the only supported
 * path and the only one that produces a diamond that was never observable in a
 * cuttable state. There is deliberately no helper here that deploys a diamond
 * and leaves it cuttable — `DevIndexDeployer` exists for that and every audit
 * fixture asserts `isDevMode() === false`.
 */

export const CUT_SELECTORS_NAMES = [
  "diamondCut(( address,uint8,bytes4[])[],address,bytes)",
] as const;

/** Every non-constructor, non-fallback selector a contract's ABI exposes. */
export async function selectorsOf(contractName: string): Promise<string[]> {
  const art = await artifacts.readArtifact(contractName);
  const iface = new ethers.Interface(art.abi);
  const out: string[] = [];
  iface.forEachFunction((f) => out.push(f.selector));
  return out;
}

/** Name -> selector map, for tests that need to name a specific function. */
export async function selectorMap(
  contractName: string
): Promise<Record<string, string>> {
  const art = await artifacts.readArtifact(contractName);
  const iface = new ethers.Interface(art.abi);
  const out: Record<string, string> = {};
  iface.forEachFunction((f) => {
    out[f.name] = f.selector;
    out[f.format("sighash")] = f.selector;
  });
  return out;
}

export interface FacetManifestEntry {
  /** Artifact name, for diagnostics. */
  name: string;
  facet: string;
  selectors: string[];
}

/**
 * Re-derive the facet-set hash exactly as `LibDiamond.facetSetHash()` does.
 *
 * XOR of keccak256(facet ++ selector) over every (facet, selector) pair,
 * matching LibDiamond exactly. Order-independent, because the diamond's
 * `facetAddresses` array is swap-and-pop maintained and the cut facet's removal
 * at finalization reorders it — see LibDiamond.facetSetHash for the full
 * argument, including why XOR's usual cancellation hazard does not apply.
 *
 * Computed here from the MANIFEST rather than read off the chain — reading it
 * from the diamond and then asserting the diamond agrees with itself would make
 * the check vacuous, which is the whole failure mode the pre-commitment exists
 * to avoid. This function is what a reviewer runs against the published
 * manifest to confirm a live diamond is the one the source describes.
 */
export function facetSetHash(manifest: FacetManifestEntry[]): string {
  let acc = 0n;
  for (const m of manifest) {
    for (const s of m.selectors) {
      acc ^= BigInt(ethers.keccak256(ethers.concat([m.facet, s])));
    }
  }
  return ethers.zeroPadValue(ethers.toBeHex(acc), 32);
}

/**
 * Fill a partial `CoreInit` out to the full struct the diamond's constructor
 * decodes.
 *
 * The structural diamond suites care about the SELECTOR TABLE, the storage
 * namespaces and the freeze — not about basket economics — so they name only
 * the fields their claim is about and let this supply the rest. It is a helper,
 * not a default: the diamond itself still refuses a zero seeder, a zero role
 * holder, a below-floor delay and an invalid risk set, and the suites that
 * assert those refusals pass the offending value explicitly.
 */
export function fullInit(p: CoreInit): any {
  return {
    timelockDelay: p.timelockDelay,
    seeder: p.seeder,
    dividendAsset: p.dividendAsset,
    name: p.name ?? "Index Diamond",
    symbol: p.symbol ?? "IDX",
    roles: p.roles ?? new Array(5).fill(p.seeder),
    params: p.params ?? STRUCTURAL_PARAMS,
  };
}

/** Deploy a facet contract and return {name, facet, selectors}. */
export async function deployFacet(name: string): Promise<FacetManifestEntry> {
  const f = await (await ethers.getContractFactory(name)).deploy();
  await f.waitForDeployment();
  return {
    name,
    facet: await f.getAddress(),
    selectors: await selectorsOf(name),
  };
}

/**
 * The whole deployment initialiser, written by the DIAMOND'S OWN CONSTRUCTOR
 * before any facet exists to be called.
 *
 * `timelockDelay`, `seeder` and `dividendAsset` used to be `immutable` on the
 * monolith and had to move to storage (design doc section 3.3 rule 2): under
 * DELEGATECALL an `immutable` resolves to the value baked into whichever FACET
 * is executing, so two facets would silently disagree. Everything else here —
 * the ERC-20 metadata, the five role holders, the risk set — was constructor
 * state on the monolith and is written in the same place for the same reason:
 * there must be no post-construction initialiser to call twice.
 */
export interface CoreInit {
  timelockDelay: bigint | number;
  seeder: string;
  dividendAsset: string;
  /** ERC-20 name/symbol of the unified share. */
  name?: string;
  symbol?: string;
  /** [ADMIN, ADMISSION, RISK, ALLOCATION, STREAM_LISTER]. None may be zero. */
  roles?: string[];
  /** The twelve-field risk set, in `IndexParamSet` order. */
  params?: any[];
}

/**
 * A risk set that passes `IndexParams.validate`, for the diamond-structure
 * suites that care about the SELECTOR TABLE and not about basket economics.
 * Deliberately a local constant rather than an import from the vault fixture:
 * the diamond tests must be able to stand up a diamond without pulling in the
 * whole basket bootstrap.
 */
export const STRUCTURAL_PARAMS = [
  4_000n, 10n, 500n, 600n, 100n, 500n, 600n, 7_200n, 3n, 500n, 10n ** 19n, 30n * 24n * 3_600n,
];

export interface DeployedDiamond {
  /** The frozen diamond's address. */
  address: string;
  /** The IndexDeployer that produced it (its constructor did all the work). */
  deployer: any;
  /** Loupe-typed handle. */
  loupe: any;
  manifest: FacetManifestEntry[];
  committedHash: string;
  cutFacet: string;
}

/**
 * Deploy, cut, initialise and finalize in ONE transaction.
 *
 * Facets are deployed in earlier transactions and passed by address on
 * purpose — see IndexDeployer's constructor docs. That is what keeps the
 * deploy-and-freeze inside a single transaction's gas budget.
 */
export async function deployIndexDiamond(
  facetNames: string[],
  init: CoreInit,
  interfaceIds: string[] = []
): Promise<DeployedDiamond> {
  const cut = await (await ethers.getContractFactory("DiamondCutFacet")).deploy();
  await cut.waitForDeployment();
  const cutAddr = await cut.getAddress();

  const manifest: FacetManifestEntry[] = [];
  for (const n of facetNames) manifest.push(await deployFacet(n));

  const committedHash = facetSetHash(manifest);

  const Deployer = await ethers.getContractFactory("IndexDeployer");
  const deployer: any = await Deployer.deploy(
    cutAddr,
    manifest.map((m) => ({ facet: m.facet, selectors: m.selectors })),
    interfaceIds,
    // A structural fixture still needs five NON-ZERO role holders, because the
    // diamond refuses to be born with an unassigned role — an unassigned role is
    // an ungoverned parameter and there is no renounce path anywhere in the
    // facet set that could later vacate one.
    fullInit(init),
    committedHash,
    // Explicit gas ceiling on the one-shot atomic deploy-cut-finalize
    // transaction. This transaction deploys-and-cuts every facet in the
    // manifest in a single call, so its real cost scales with the manifest
    // size and grows every time a facet is added (design doc section 12
    // item 2's own flagged risk). Automatic `eth_estimateGas` binary search
    // is what actually broke here when the manifest crossed ~16.9M gas —
    // not because the transaction was invalid, but because of an unrelated
    // estimation-path quirk that a plain `sendTransaction` with an explicit
    // limit does not hit (confirmed: the identical calldata mines
    // successfully with an explicit `gasLimit`). A generous fixed ceiling,
    // well under the 60,000,000 block gas limit this suite's Hardhat network
    // config uses, is the direct fix rather than a workaround.
    { gasLimit: 40_000_000n }
  );
  await deployer.waitForDeployment();

  const address: string = await deployer.diamond();
  const loupe: any = await ethers.getContractAt("DiamondLoupeFacet", address);

  return { address, deployer, loupe, manifest, committedHash, cutFacet: cutAddr };
}

/**
 * A combined-ABI handle over the diamond: one ethers Contract whose interface
 * is the union of every facet's ABI.
 *
 * This is what lets the ~519 existing tests keep their call shape. `IndexFixture.vault`
 * is typed `any`, so `vault.redeemProRata(...)` resolves through this union
 * exactly as it resolved through the monolith's ABI — the CLAIM each test makes
 * is unchanged, only the address it lands on and the dispatch behind it.
 */
export async function combinedHandle(address: string, facetNames: string[]): Promise<any> {
  const seen = new Set<string>();
  const abi: any[] = [];
  for (const n of facetNames) {
    const art = await artifacts.readArtifact(n);
    for (const frag of art.abi) {
      // De-duplicate across facets. Two facets legitimately declare the same
      // error or event (they share storage libraries); two facets declaring
      // the same FUNCTION is a selector collision and is rejected at cut time
      // and by Diamond.selectors.test.ts, not silently merged here.
      const key = JSON.stringify(frag);
      if (seen.has(key)) continue;
      seen.add(key);
      abi.push(frag);
    }
  }
  return new ethers.Contract(address, abi, (await ethers.getSigners())[0]);
}

/**
 * The two dangerous opcodes, scanned off-chain with the SAME PUSH-skipping
 * sweep `LibBytecodeScan` runs on-chain.
 *
 * Kept as an independent re-implementation rather than a call into the
 * contract: if both the guard and its test share one implementation, a bug in
 * that implementation passes both.
 */
export function scanOpcodes(runtimeHex: string): { selfdestructAt: number[]; delegatecallAt: number[] } {
  const code = Buffer.from(runtimeHex.replace(/^0x/, ""), "hex");
  let len = code.length;

  // Strip solc's CBOR metadata trailer (its last two bytes are its length).
  if (len >= 3) {
    const metaLen = (code[len - 2] << 8) | code[len - 1];
    const total = metaLen + 2;
    if (total < len) {
      const head = code[len - total];
      if (head >= 0xa1 && head <= 0xa9) len -= total;
    }
  }

  const selfdestructAt: number[] = [];
  const delegatecallAt: number[] = [];
  let i = 0;
  while (i < len) {
    const op = code[i];
    if (op === 0xff) selfdestructAt.push(i);
    if (op === 0xf4) delegatecallAt.push(i);
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f + 1;
    else i += 1;
  }
  return { selfdestructAt, delegatecallAt };
}

/** Deployed (runtime) bytecode size in bytes, as EIP-170 counts it. */
export async function deployedSize(contractName: string): Promise<number> {
  const art = await artifacts.readArtifact(contractName);
  return (art.deployedBytecode.length - 2) / 2;
}

export const EIP170_LIMIT = 24576;
