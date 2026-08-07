/**
 * ============================================================================
 *  configure-index-vault-governance — parameter-setting script for EVERY
 *  risk parameter introduced across §7.2-§7.12 (design doc §7.8, item 3),
 *  driven entirely by scripts/config/index-vault-deploy-config.ts.
 *
 *  Covers: §7.2's swap-fee split (`ecosystemFeeSplitBps`, `ecosystemSink`)
 *  and the operator allocation (`platformAllocationBps`, `platformTreasury`);
 *  §7.3's three-way split (`valueAccrualSplitBps`, packing dividend+buyback
 *  bps — the reserve share is always the derived remainder, never set
 *  directly); §7.5's admission/weight thresholds (`targetHhiBps`,
 *  `minEligibilityFeesWei`, `minEligibilityBlocks`); §7.7's buyback
 *  sub-split (the `valueAccrualBuybackBps` half of the §7.3 pair, capped at
 *  its own 50% ceiling); §7.10's dedicated pool wiring and dilution cap
 *  (`indexPool`, `maxPoolShareBps`); §7.11's dev-fund PLANK-buy percentage
 *  and router/treasury (`devFundRouter`, `devFundTreasury`, `devFundBps`,
 *  2% ceiling); §7.12's platform socialfi carve-out and treasury
 *  (`socialFiTreasury`, `socialFiTreasuryBps`, 5% ceiling).
 *
 *  Every one of these is queue-then-execute behind the diamond's timelock —
 *  this script never bypasses that. Every setter it calls is the SAME
 *  setter `IndexGovernanceFacet.test.ts` / `IndexDevFundFacet.test.ts` /
 *  `IndexSocialFiTreasuryFacet.test.ts` / `IndexPoolFacet.test.ts` already
 *  exercise — no bespoke on-chain path exists for "deploy tooling only".
 *
 *  Usage (two passes, separated by the timelock delay):
 *    MODE=queue   MARKET_INDEX_DIAMOND=0x.. <governance env vars> \
 *      DEPLOYER_PK=... npx hardhat run scripts/configure-index-vault-governance.ts --network <net>
 *    ...wait timelockDelay...
 *    MODE=execute MARKET_INDEX_DIAMOND=0x.. \
 *      DEPLOYER_PK=... npx hardhat run scripts/configure-index-vault-governance.ts --network <net>
 * ============================================================================
 */
import hardhat from "hardhat";
import { BPS, GovernanceConfig, assertProductionReady, loadGovernanceConfig, validateGovernanceConfig } from "./config/index-vault-deploy-config";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { INDEX_FACETS } = require("../test/contracts/helpers/index-vault") as typeof import("../test/contracts/helpers/index-vault");
const { ethers } = hardhat as unknown as { ethers: typeof import("ethers") & Record<string, unknown> };

type Mode = "queue" | "execute";

function reqAddr(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} before running this script.`);
  return v;
}

/** Every {queueParam key, execute} pair this script is willing to drive, keyed by the config field name that must be set (non-zero/defined) to include it in this pass. */
function paramPlan(g: GovernanceConfig): Array<{ key: string; value: bigint; include: boolean }> {
  return [
    { key: "platformAllocationBps", value: g.platformAllocationBps, include: g.platformAllocationBps > 0n },
    { key: "ecosystemFeeSplitBps", value: g.ecosystemFeeSplitBps, include: g.ecosystemFeeSplitBps > 0n },
    {
      key: "ecosystemSink",
      value: g.ecosystemSink ? BigInt(g.ecosystemSink) : 0n,
      include: g.ecosystemSink !== undefined,
    },
    {
      key: "valueAccrualSplitBps",
      // Packed exactly as IndexGovernanceFacet._applyValueAccrualSplit
      // unpacks it: value = dividendBps * BPS + buybackBps.
      value: g.valueAccrualDividendBps * BPS + g.valueAccrualBuybackBps,
      include: g.valueAccrualDividendBps > 0n || g.valueAccrualBuybackBps > 0n,
    },
    { key: "targetHhiBps", value: g.targetHhiBps, include: g.targetHhiBps > 0n },
    { key: "minEligibilityFeesWei", value: g.minEligibilityFeesWei, include: g.minEligibilityFeesWei > 0n },
    { key: "minEligibilityBlocks", value: g.minEligibilityBlocks, include: g.minEligibilityBlocks > 0n },
  ].filter((p) => p.include);
}

export async function configureIndexVaultGovernance(diamondAddress: string, mode: Mode) {
  const g = loadGovernanceConfig();
  validateGovernanceConfig(g);
  assertProductionReady(hardhat.network.name, g);

  const [signer] = (await (ethers as any).getSigners()) as any[];
  const abi: any[] = [];
  const seen = new Set<string>();
  for (const n of INDEX_FACETS) {
    const art = await (hardhat as any).artifacts.readArtifact(n);
    for (const frag of art.abi) {
      const key = JSON.stringify(frag);
      if (seen.has(key)) continue;
      seen.add(key);
      abi.push(frag);
    }
  }
  const vault = new (ethers as any).Contract(diamondAddress, abi, signer);

  const applied: string[] = [];

  // ── generic queueParam/executeParam keys ────────────────────────────
  for (const p of paramPlan(g)) {
    if (mode === "queue") {
      console.log(`queueParam(${p.key}, ${p.value})`);
      await (await vault.queueParam(p.key, p.value)).wait();
    } else {
      console.log(`executeParam(${p.key})`);
      await (await vault.executeParam(p.key)).wait();
    }
    applied.push(p.key);
  }

  // ── platformTreasury (dedicated pair, not queueParam) ───────────────
  if (g.platformTreasury) {
    if (mode === "queue") {
      console.log(`queuePlatformTreasury(${g.platformTreasury})`);
      await (await vault.queuePlatformTreasury(g.platformTreasury)).wait();
    } else {
      console.log(`executePlatformTreasury()`);
      await (await vault.executePlatformTreasury()).wait();
    }
    applied.push("platformTreasury");
  }

  // ── §7.11 dev fund ───────────────────────────────────────────────────
  if (g.devFundRouter) {
    if (mode === "queue") await (await vault.queueDevFundRouter(g.devFundRouter)).wait();
    else await (await vault.executeDevFundRouter()).wait();
    applied.push("devFundRouter");
  }
  if (g.devFundTreasury) {
    if (mode === "queue") await (await vault.queueDevFundTreasury(g.devFundTreasury)).wait();
    else await (await vault.executeDevFundTreasury()).wait();
    applied.push("devFundTreasury");
  }
  if (g.devFundBps > 0n) {
    if (mode === "queue") await (await vault.queueDevFundBps(g.devFundBps)).wait();
    else await (await vault.executeDevFundBps()).wait();
    applied.push("devFundBps");
  }

  // ── §7.12 socialfi treasury ──────────────────────────────────────────
  if (g.socialFiTreasury) {
    if (mode === "queue") await (await vault.queueSocialFiTreasury(g.socialFiTreasury)).wait();
    else await (await vault.executeSocialFiTreasury()).wait();
    applied.push("socialFiTreasury");
  }
  if (g.socialFiTreasuryBps > 0n) {
    if (mode === "queue") await (await vault.queueSocialFiTreasuryBps(g.socialFiTreasuryBps)).wait();
    else await (await vault.executeSocialFiTreasuryBps()).wait();
    applied.push("socialFiTreasuryBps");
  }

  // ── §7.10 pool wiring (ONE-WAY — queueIndexPool reverts if already set) ─
  if (g.indexPool) {
    if (mode === "queue") await (await vault.queueIndexPool(g.indexPool)).wait();
    else await (await vault.executeIndexPool()).wait();
    applied.push("indexPool");
  }
  // maxPoolShareBps only via queueMaxPoolShareBps/executeMaxPoolShareBps
  // AFTER the pool is wired (executeIndexPool already seeds the 5% default);
  // this only runs if the operator wants to override that default.
  if (g.maxPoolShareBps !== undefined) {
    if (mode === "queue") await (await vault.queueMaxPoolShareBps(g.maxPoolShareBps)).wait();
    else await (await vault.executeMaxPoolShareBps()).wait();
    applied.push("maxPoolShareBps");
  }

  console.log(`${mode} complete: ${applied.join(", ") || "(nothing to do — no governance env vars set)"}`);
  return { mode, applied };
}

async function main() {
  const diamondAddress = reqAddr("MARKET_INDEX_DIAMOND");
  const mode = (process.env.MODE || "").toLowerCase();
  if (mode !== "queue" && mode !== "execute") {
    throw new Error('Set MODE=queue or MODE=execute before running this script.');
  }
  const result = await configureIndexVaultGovernance(diamondAddress, mode as Mode);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
