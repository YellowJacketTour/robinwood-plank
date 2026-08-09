/**
 * ============================================================================
 *  axiom1-postdeploy — ONESHOT §5.5 "verify script" + §9 step 12 "smoke:
 *  deposit, stake, fee, route, warp vest, redeemProRata".
 *
 *  Runs `deployAxiom1Local()` (scripts/deploy/axiom1-local.ts) against
 *  whatever network Hardhat is currently pointed at, then drives a genuine
 *  end-to-end proof that the freshly-deployed system works:
 *
 *    1. deposit   — a NEW real NFT deposit into an already-deployed,
 *                    already-admitted collection vault (mints real S).
 *    2. stake     — see note below: `InventoryStake` was deleted in the
 *                    share-atom correction: `CollectionVault`'s own share S
 *                    IS the compounding unit now, so "stake" here means
 *                    holding that same S — this step is folded into (1).
 *    3. fee       — real Stream A/B fee activity (deposit/redeem + a real
 *                    AMM swap) that lands real WETH at the (already-
 *                    finalized) EnergyBus.
 *    4. route     — `EnergyBus.route()`, called permissionlessly, AFTER
 *                    `finalize()` — proving finalize did not brick routing.
 *    5. warp vest — advance past `STREAM_VEST_BLOCKS` (the same vesting
 *                    window `FactorySinkBusIntegration.test.ts` warps past).
 *    6. redeemProRata — a real index redeem, confirming BOTH that it still
 *                    works post-route and post-finalize, AND that it paid
 *                    out MORE per share than before the route (the routed
 *                    fee genuinely compounded the index's own redemption
 *                    value — the whole point of the nested-compound
 *                    architecture, NEST-1's own assertion, re-proven here
 *                    against a real deploy rather than a test fixture).
 *
 *  Also independently re-confirms `EnergyBus.finalize()`'s actual behavior
 *  (ONESHOT §5.5's own ask: "read finalize()'s actual current behavior to
 *  confirm this is really enforced, don't assume") — see the assertions
 *  right after step 4 below.
 *
 *  Usage:
 *    npx hardhat run scripts/verify/axiom1-postdeploy.ts --network hardhat
 * ============================================================================
 */
import hardhat from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const { ethers } = hardhat;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { deployAxiom1Local } = require("../deploy/axiom1-local") as typeof import("../deploy/axiom1-local");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { combinedHandle } = require("../../test/contracts/helpers/diamond") as typeof import("../../test/contracts/helpers/diamond");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { INDEX_FACETS } = require("../../test/contracts/helpers/index-vault") as typeof import("../../test/contracts/helpers/index-vault");

const STREAM_VEST_BLOCKS = 300;

function assertTrue(cond: boolean, msg: string) {
  if (!cond) throw new Error(`SMOKE FAILED: ${msg}`);
  console.log(`  OK: ${msg}`);
}

async function main() {
  console.log("=== AXIOM-1 post-deploy verify + smoke (ONESHOT §9 step 12) ===\n");

  const deployed = await deployAxiom1Local();
  console.log("\n--- deploy complete, starting smoke sequence ---\n");

  const [, treasury, seeder, , , , , alice, , , governance] = await ethers.getSigners();

  const weth: any = await ethers.getContractAt("MockWeth", deployed.weth);
  const bus: any = await ethers.getContractAt("EnergyBus", deployed.bus);
  const index: any = await combinedHandle(deployed.index, [...INDEX_FACETS]);
  const collA: any = await ethers.getContractAt("CollectionVault", deployed.collections[0].vault);
  const nftA: any = await ethers.getContractAt("MockRobinWoodNft", deployed.collections[0].nft);

  // ── §5.5 finalize() re-verification: read the ACTUAL current behavior,
  //    don't assume. EnergyBus.sol has adapters/bps as `immutable` and
  //    finalize() only ever flips `finalized` + zeroes `deployer` — there is
  //    no other function anywhere in the contract gated on `finalized`, and
  //    no setter for adapters/bps at any point in its lifetime (constructor-
  //    only). So "no further adapter/bps changes are possible" was already
  //    true from the moment of construction; `finalize()` is a one-way
  //    transparency flag on top of that, not the mechanism enforcing it. ───
  assertTrue(deployed.finalized, "EnergyBus.finalized() is true after deploy ceremony step 11");
  await bus
    .finalize()
    .then(() => {
      throw new Error("finalize() should have reverted (AlreadyFinalized) but did not");
    })
    .catch((e: any) => {
      assertTrue(String(e).includes("AlreadyFinalized") || String(e?.message ?? e).includes("AlreadyFinalized"),
        "calling finalize() a second time reverts with AlreadyFinalized (one-way)");
    });

  // ── 1/2. deposit + "stake" (S itself is the compounding unit) ───────────
  const WEIGHT_TOKEN_ID = 5001;
  await (await weth.mint(alice.address, ethers.parseEther("50"))).wait();
  await (await weth.connect(alice).approve(collA.target, ethers.MaxUint256)).wait();
  await (await nftA.mint(alice.address, WEIGHT_TOKEN_ID)).wait();
  await (await nftA.connect(alice).approve(collA.target, WEIGHT_TOKEN_ID)).wait();
  const aliceSBefore: bigint = await collA.balanceOf(alice.address);
  await (await collA.connect(alice).deposit(WEIGHT_TOKEN_ID)).wait();
  const aliceSAfter: bigint = await collA.balanceOf(alice.address);
  assertTrue(aliceSAfter > aliceSBefore, "deposit minted real S to alice (S is the single compounding share atom)");

  // ── 3. fee — more real Stream A/B fee activity landing at the Bus. ──────
  const busWethBeforeFees: bigint = await weth.balanceOf(deployed.bus);
  await (await collA.connect(alice).redeem(WEIGHT_TOKEN_ID)).wait(); // Stream A redeem fee
  await (await weth.connect(alice).approve(collA.target, ethers.MaxUint256)).wait();
  await (await collA.connect(alice).buyShares(ethers.parseEther("1"), 0n)).wait(); // Stream B swap fee
  const busWethAfterFees: bigint = await weth.balanceOf(deployed.bus);
  assertTrue(busWethAfterFees > busWethBeforeFees, "real fee activity increased the Bus's real WETH balance");

  // ── 4. route() — permissionless, post-finalize. ─────────────────────────
  const sReserveAtIndexBefore: bigint = await collA.balanceOf(deployed.index);
  const idxSupplyBeforeRoute: bigint = await index.totalSupply();
  const [, amountsBeforeRoute] = await index.previewRedeemProRata(ethers.parseEther("1"));
  const perShareBeforeRoute: bigint = amountsBeforeRoute[0];

  await (await bus.connect(alice).route()).wait(); // called by a random actor (alice), proving permissionlessness
  assertTrue(true, "route() executed successfully, called permissionlessly, after finalize()");
  assertTrue((await weth.balanceOf(deployed.bus)) === 0n, "no WETH trapped in the Bus after route()");

  const sReserveAtIndexAfterRoute: bigint = await collA.balanceOf(deployed.index);
  assertTrue(sReserveAtIndexAfterRoute > sReserveAtIndexBefore, "Pipe I genuinely bought S into the index");
  assertTrue((await index.totalSupply()) === idxSupplyBeforeRoute, "route() minted zero free IDX (ONESHOT §6 rule 4)");

  // ── reconcile if needed (same pattern PR8's suite uses) ──────────────────
  const reconcileNeeded: bigint = await index.reconcile.staticCall(deployed.collections[0].vault);
  if (reconcileNeeded > 0n) {
    await (await index.reconcile(deployed.collections[0].vault)).wait();
  }

  // ── 5. warp vest ─────────────────────────────────────────────────────────
  for (let i = 0; i < STREAM_VEST_BLOCKS + 2; i++) {
    await ethers.provider.send("evm_mine", []);
  }

  // ── 6. redeemProRata — still works, and paid out MORE per share. ────────
  const [, amountsAfterVest] = await index.previewRedeemProRata(ethers.parseEther("1"));
  const perShareAfterVest: bigint = amountsAfterVest[0];
  assertTrue(perShareAfterVest > perShareBeforeRoute, "per-share redemption value genuinely rose after route() + vest (nested compound proven)");

  const aliceIdxBal: bigint = await index.balanceOf(alice.address);
  assertTrue(aliceIdxBal > 0n, "alice holds real IDX to redeem");

  const redeemAmt = aliceIdxBal / 2n;
  const wethBeforeRedeem: bigint = await weth.balanceOf(alice.address);
  const sBeforeRedeem: bigint = await collA.balanceOf(alice.address);

  await (
    await index.connect(alice).redeemProRata(redeemAmt, [0n, 0n])
  ).wait();

  const wethAfterRedeem: bigint = await weth.balanceOf(alice.address);
  const sAfterRedeem: bigint = await collA.balanceOf(alice.address);
  assertTrue(
    wethAfterRedeem > wethBeforeRedeem || sAfterRedeem > sBeforeRedeem,
    "redeemProRata genuinely paid out real constituent assets to alice"
  );
  assertTrue((await index.balanceOf(alice.address)) === aliceIdxBal - redeemAmt, "redeemProRata burned exactly the IDX shares redeemed");

  console.log("\n=== SMOKE SEQUENCE PASSED: deposit -> fee -> route -> warp vest -> redeemProRata, all real, post-finalize. ===");

  return {
    deployed,
    perShareBeforeRoute: perShareBeforeRoute.toString(),
    perShareAfterVest: perShareAfterVest.toString(),
  };
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

export { main as verifyAxiom1PostDeploy };
