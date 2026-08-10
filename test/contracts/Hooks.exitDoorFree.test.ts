import { expect } from "chai";
import { ethers, artifacts } from "./helpers/hardhat.js";
import { loadFixture, time, takeSnapshot, SnapshotRestorer } from "./helpers/network-helpers.js";

import {
  deployOpenIndex,
  warmCheckpoints,
  maxIn,
  armVaultRegistry,
} from "./helpers/index-vault.js";

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  Stage 6 — `HookRegistryFacet` and the `_fireHook` call site, proved
 *  against every non-negotiable in the task brief / design doc section 8.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * LOCAL HARDHAT ONLY.
 */

function openIndexFixture() {
  return deployOpenIndex();
}

const HOOK_GAS = 50_000n;

/**
 * `queueHook` -> wait out the timelock -> `executeHook`, the identical
 * two-call shape every other `ROLE_RISK_PARAM_`-gated risk-surface change
 * goes through (`queueParam`/`executeParam`). Registration is no longer a
 * single-transaction write (Finding 1 fix).
 */
async function registerHook(vault: any, risk: any, point: string, hookAddr: string, permissions = 0) {
  await vault.connect(risk).queueHook(point, hookAddr, permissions);
  await time.increase(48 * 3_600 + 1);
  return vault.executeHook(point);
}

describe("HookRegistryFacet — the de-fanged observer hooks (design doc section 8)", () => {
  // This file's registerHook() helper now advances the shared Hardhat clock
  // by a full timelock delay per call (Finding 1 fix: registration queues
  // rather than writing immediately). Mocha shares one network across files,
  // so without restoring afterwards the fixed-endTime Seaport orders in
  // later suites silently expire — same reasoning as
  // ScopedRoles.isolation.test.ts's identical guard.
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  // ────────────────────────────────────────────────────────────────────────
  //  1. No hook point exists on the exit door, structurally
  // ────────────────────────────────────────────────────────────────────────

  it("IndexCoreFacet never imports HooksStorage — no hook call site exists on redeemProRata / claimPending*", async () => {
    const fs = await import("fs");
    const raw = fs.readFileSync("contracts/diamond/facets/IndexCoreFacet.sol", "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code.includes("HooksStorage"), "IndexCoreFacet reaches HooksStorage").to.equal(false);
    expect(code.includes("_fireHook"), "IndexCoreFacet calls _fireHook").to.equal(false);
  });

  it("the exit-door facet's whole selector surface is enumerated and contains no hook function", async () => {
    const art = await artifacts.readArtifact("IndexCoreFacet");
    const iface = new ethers.Interface(art.abi);
    const fns: string[] = [];
    iface.forEachFunction((f) => fns.push(f.name));
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

  it("registerHook REJECTS a point outside the compile-time enumerated set — a hook can never be wired onto the exit path", async () => {
    const fx = await loadFixture(openIndexFixture);
    const { vault, risk } = fx;

    // The exit-door selectors, hashed the way an attacker aiming for them
    // would try to — none of these are valid hook points.
    const forged = [
      ethers.id("redeemProRata"),
      ethers.id("claimPending"),
      ethers.id("claimPendingMany"),
      ethers.keccak256(ethers.toUtf8Bytes("hook.after_redeem")), // not a real point either
    ];
    const Mock = await ethers.getContractFactory("MockHook");
    const hook = await Mock.deploy(0); // RECORD

    for (const point of forged) {
      await expect(vault.connect(risk).queueHook(point, await hook.getAddress(), 0))
        .to.be.revertedWithCustomError(vault, "InvalidHookPoint")
        .withArgs(point);
    }

    // The only three points that exist at all — none of them is the exit door.
    const real = [await vault.AFTER_LISTING(), await vault.AFTER_CHECKPOINT(), await vault.AFTER_SYNC()];
    for (const p of real) {
      expect(forged.includes(p)).to.equal(false);
    }
  });

  it("queueHook is ROLE_RISK_PARAM-gated", async () => {
    const fx = await loadFixture(openIndexFixture);
    const { vault, alice } = fx;
    const Mock = await ethers.getContractFactory("MockHook");
    const hook = await Mock.deploy(0);
    const point = await vault.AFTER_SYNC();
    await expect(
      vault.connect(alice).queueHook(point, await hook.getAddress(), 0)
    ).to.be.revertedWithCustomError(vault, "NotRoleHolder");
  });

  it("executeHook enforces the timelock — cannot be applied before the queued eta, and cannot be applied twice", async () => {
    const fx = await loadFixture(openIndexFixture);
    const { vault, risk } = fx;
    const Mock = await ethers.getContractFactory("MockHook");
    const hook = await Mock.deploy(0);
    const hookAddr = await hook.getAddress();
    const point = await vault.AFTER_SYNC();

    await expect(vault.executeHook(point)).to.be.revertedWithCustomError(vault, "NothingQueued");

    await vault.connect(risk).queueHook(point, hookAddr, 0);
    await expect(vault.executeHook(point)).to.be.revertedWithCustomError(vault, "TimelockNotElapsed");

    await time.increase(48 * 3_600 + 1);
    await expect(vault.executeHook(point))
      .to.emit(vault, "HookRegistered")
      .withArgs(point, hookAddr, 0);
    expect(await vault.hooksFor(point)).to.equal(hookAddr);

    // Cannot be re-applied: the queued entry was consumed.
    await expect(vault.executeHook(point)).to.be.revertedWithCustomError(vault, "NothingQueued");
  });

  // ────────────────────────────────────────────────────────────────────────
  //  2. Non-reverting: a hostile hook cannot block the underlying operation
  // ────────────────────────────────────────────────────────────────────────

  it("a hook that ALWAYS REVERTS does not block checkpoint() — the underlying op commits and HookFailed fires", async () => {
    const fx = await loadFixture(openIndexFixture);
    const { vault, risk, addrs } = fx;

    const Mock = await ethers.getContractFactory("MockHook");
    const hook = await Mock.deploy(1); // REVERT
    const hookAddr = await hook.getAddress();
    const point = await vault.AFTER_CHECKPOINT();
    await registerHook(vault, risk, point, hookAddr, 0);

    await time.increase(700);
    const tx = await vault.checkpoint(addrs[0]);
    const receipt = await tx.wait();

    // The checkpoint itself committed — Checkpointed fired.
    const iface = vault.interface;
    const checkpointed = receipt.logs
      .map((l: any) => {
        try {
          return iface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter((p: any) => p && p.name === "Checkpointed");
    expect(checkpointed.length).to.be.greaterThan(0);

    // The failed hook is disclosed, not swallowed silently.
    const failed = receipt.logs
      .map((l: any) => {
        try {
          return iface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter((p: any) => p && p.name === "HookFailed");
    expect(failed.length).to.equal(1);
    expect(failed[0].args.point).to.equal(point);
    expect(failed[0].args.hook).to.equal(hookAddr);

    // And the hook itself never actually recorded the call.
    expect(await hook.calls()).to.equal(0n);
  });

  it("a hook that always reverts does not block a real listing (AFTER_LISTING), through executeListing's internal _list", async () => {
    // Post-open, listing goes through IndexGovernanceFacet's timelocked
    // queueListing -> executeListing -> IndexFacetBase._list path, which is
    // where AFTER_LISTING fires. Register a REVERT hook first, then queue and
    // execute a real fourth-constituent listing, and confirm it still lands.
    const fx = await loadFixture(openIndexFixture);
    const { vault, risk, admission } = fx;

    const Mock = await ethers.getContractFactory("MockHook");
    const hook = await Mock.deploy(1); // REVERT
    const point = await vault.AFTER_LISTING();
    await registerHook(vault, risk, point, await hook.getAddress(), 0);

    const Token = await ethers.getContractFactory("MockIndexToken");
    const token = await Token.deploy("cD", "cD");
    const Source = await ethers.getContractFactory("MockIndexPriceSource");
    const source = await Source.deploy(100n * 10n ** 18n, 100n * 10n ** 18n);
    const tokenAddr = await token.getAddress();

    // AUDIT C-6: post-open admission requires factory provenance.
    await armVaultRegistry(fx, [...fx.addrs, tokenAddr]);
    await vault.connect(admission).queueListing(tokenAddr, await source.getAddress(), 1_000, false);
    await time.increase(48 * 3_600 + 1);

    await expect(vault.executeListing(tokenAddr)).to.not.be.revert(ethers);

    // The listing genuinely landed.
    const listed = await vault.listConstituents();
    expect(listed.map((a: string) => a.toLowerCase())).to.include(tokenAddr.toLowerCase());
  });

  // ────────────────────────────────────────────────────────────────────────
  //  3. Gas-bounding: a hostile hook cannot starve the caller
  // ────────────────────────────────────────────────────────────────────────

  it("a hook that burns all its forwarded gas does not starve checkpoint()'s remaining execution", async () => {
    const fx = await loadFixture(openIndexFixture);
    const { vault, risk, addrs } = fx;

    const Mock = await ethers.getContractFactory("MockHook");
    const hook = await Mock.deploy(2); // BURN_GAS
    const hookAddr = await hook.getAddress();
    const point = await vault.AFTER_CHECKPOINT();
    await registerHook(vault, risk, point, hookAddr, 0);

    await time.increase(700);

    // If the gas bound were not real, a hostile hook consuming "all remaining
    // gas" would either revert the whole checkpoint (out of gas) or require
    // the caller to supply an enormous gas limit to survive it. Neither is
    // true here: a perfectly ordinary gas limit succeeds.
    const gasEstimate = await vault.checkpoint.estimateGas(addrs[0]);
    expect(gasEstimate).to.be.lessThan(500_000n);

    const tx = await vault.checkpoint(addrs[0], { gasLimit: 600_000n });
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1);

    const iface = vault.interface;
    const failed = receipt.logs
      .map((l: any) => {
        try {
          return iface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter((p: any) => p && p.name === "HookFailed");
    expect(failed.length).to.equal(1);
  });

  it("AFTER_SYNC does not starve syncConstituentBalance when its hook burns gas", async () => {
    const fx = await loadFixture(openIndexFixture);
    const { vault, risk, addrs, tokens, seeder } = fx;

    const Mock = await ethers.getContractFactory("MockHook");
    const hook = await Mock.deploy(2); // BURN_GAS
    const point = await vault.AFTER_SYNC();
    await registerHook(vault, risk, point, await hook.getAddress(), 0);

    // Strand a surplus balance directly on the vault so there is something to sync.
    await tokens[0].mint(seeder.address, 10n ** 18n);
    await tokens[0].connect(seeder).transfer(await vault.getAddress(), 10n ** 18n);

    const gasEstimate = await vault.syncConstituentBalance.estimateGas(addrs[0]);
    expect(gasEstimate).to.be.lessThan(500_000n);

    const credited = await vault.syncConstituentBalance.staticCall(addrs[0]);
    expect(credited).to.equal(10n ** 18n);

    const tx = await vault.syncConstituentBalance(addrs[0]);
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1);
  });

  // ────────────────────────────────────────────────────────────────────────
  //  4. CALL, never DELEGATECALL
  // ────────────────────────────────────────────────────────────────────────

  it("HookRegistryFacet contains no DELEGATECALL or SELFDESTRUCT opcode", async () => {
    const { scanOpcodes } = await import("./helpers/diamond");
    const art = await artifacts.readArtifact("HookRegistryFacet");
    const { selfdestructAt, delegatecallAt } = scanOpcodes(art.deployedBytecode);
    expect(delegatecallAt, "HookRegistryFacet contains DELEGATECALL").to.deep.equal([]);
    expect(selfdestructAt, "HookRegistryFacet contains SELFDESTRUCT").to.deep.equal([]);
  });

  it("IndexFacetBase's hook-firing site contains no DELEGATECALL in ANY facet that inlines it", async () => {
    const { scanOpcodes } = await import("./helpers/diamond");
    const { INDEX_FACETS } = await import("./helpers/index-vault");
    for (const n of INDEX_FACETS) {
      const art = await artifacts.readArtifact(n);
      const { delegatecallAt } = scanOpcodes(art.deployedBytecode);
      expect(delegatecallAt, `${n} contains DELEGATECALL`).to.deep.equal([]);
    }
  });

  it("a hook fired for real receives a CALL (has its own msg.sender == the diamond, its own storage) — the hook's state actually changed", async () => {
    const fx = await loadFixture(openIndexFixture);
    const { vault, risk, addrs } = fx;

    const Mock = await ethers.getContractFactory("MockHook");
    const hook = await Mock.deploy(0); // RECORD
    const point = await vault.AFTER_CHECKPOINT();
    await registerHook(vault, risk, point, await hook.getAddress(), 0);

    await time.increase(700);
    await vault.checkpoint(addrs[0]);

    // If this were a DELEGATECALL, the hook's own storage slots would never
    // change (the diamond's storage would change instead) and `hook.calls()`
    // would read 0 forever. A CALL means the mock's own state moved.
    expect(await hook.calls()).to.equal(1n);
    expect(await hook.lastPoint()).to.equal(point);
  });

  // ────────────────────────────────────────────────────────────────────────
  //  5. Registration end-to-end, and it is genuinely observe-only
  // ────────────────────────────────────────────────────────────────────────

  it("queueHook / executeHook / hooksFor / hookPermissions round-trip, and a hook succeeding changes NOTHING about vault accounting", async () => {
    const fx = await loadFixture(openIndexFixture);
    const { vault, risk, alice, addrs } = fx;

    const Mock = await ethers.getContractFactory("MockHook");
    const hook = await Mock.deploy(0); // RECORD
    const hookAddr = await hook.getAddress();
    const point = await vault.AFTER_CHECKPOINT();

    await expect(vault.connect(risk).queueHook(point, hookAddr, 7))
      .to.emit(vault, "HookQueued");

    await time.increase(48 * 3_600 + 1);
    await expect(vault.executeHook(point))
      .to.emit(vault, "HookRegistered")
      .withArgs(point, hookAddr, 7);

    expect(await vault.hooksFor(point)).to.equal(hookAddr);
    expect(await vault.hookPermissions(hookAddr)).to.equal(7n);

    await warmCheckpoints(fx, 1);
    expect(await hook.calls()).to.be.greaterThan(0n);

    // A holder's mint/redeem accounting is identical whether or not a hook is
    // registered and successfully observing — rule 6, "never on a value path".
    const before = await vault.balanceOf(alice.address);
    await vault.connect(alice).mintProRata(100n * 10n ** 18n, maxIn(3));
    const after = await vault.balanceOf(alice.address);
    expect(after - before).to.equal(100n * 10n ** 18n);
  });

  it("clearing a hook (registering address(0)) is honoured — hooksFor returns zero and _fireHook no-ops", async () => {
    const fx = await loadFixture(openIndexFixture);
    const { vault, risk, addrs } = fx;
    const Mock = await ethers.getContractFactory("MockHook");
    const hook = await Mock.deploy(0);
    const point = await vault.AFTER_CHECKPOINT();
    await registerHook(vault, risk, point, await hook.getAddress(), 0);
    await registerHook(vault, risk, point, ethers.ZeroAddress, 0);
    expect(await vault.hooksFor(point)).to.equal(ethers.ZeroAddress);

    await time.increase(700);
    // No revert, no HookFailed — a cleared point is simply skipped.
    const tx = await vault.checkpoint(addrs[0]);
    const receipt = await tx.wait();
    const failed = receipt.logs
      .map((l: any) => {
        try {
          return vault.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter((p: any) => p && p.name === "HookFailed");
    expect(failed.length).to.equal(0);
  });

  // ────────────────────────────────────────────────────────────────────────
  //  6. checkpoint()/checkpointAll() are nonReentrant (Finding 2)
  // ────────────────────────────────────────────────────────────────────────

  it("a hostile AFTER_CHECKPOINT hook that tries to reenter checkpoint() is rejected by the shared reentrancy guard", async () => {
    const fx = await loadFixture(openIndexFixture);
    const { vault, risk, addrs } = fx;

    const Mock = await ethers.getContractFactory("MockHook");
    const hook = await Mock.deploy(3); // REENTER
    const hookAddr = await hook.getAddress();
    const point = await vault.AFTER_CHECKPOINT();
    await registerHook(vault, risk, point, hookAddr, 0);

    // Wire the hook to call straight back into `checkpoint(addrs[0])` on the
    // SAME vault it was fired from — the reentrant attempt.
    const reentrantCalldata = vault.interface.encodeFunctionData("checkpoint", [addrs[0]]);
    await hook.setReentrantTarget(await vault.getAddress(), reentrantCalldata);

    await time.increase(700);

    // The outer checkpoint() still commits — a hostile hook never blocks the
    // operation it observed (rule 3) — but the reentrant call it attempted
    // must have failed, and specifically with `ReentrantCall`, not merely
    // "ran out of gas" or some other unrelated failure.
    const tx = await vault.checkpoint(addrs[0]);
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1);

    expect(await hook.calls()).to.equal(1n);
    expect(await hook.reentrantOk()).to.equal(false);
    const returnData: string = await hook.reentrantReturnData();
    const ReentrantCallSelector = vault.interface.getError("ReentrantCall")!.selector;
    expect(returnData.slice(0, 10)).to.equal(ReentrantCallSelector);

    // No HookFailed either: the hook's OWN top-level call (onHook) succeeded
    // — it caught the reentrant sub-call's revert itself via `.call(...)`
    // rather than propagating it, exactly like a real hostile integration
    // would to keep probing. This confirms the guard is what stopped the
    // reentry, not `_fireHook`'s own non-reverting wrapper.
    const failed = receipt.logs
      .map((l: any) => {
        try {
          return vault.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter((p: any) => p && p.name === "HookFailed");
    expect(failed.length).to.equal(0);
  });

  it("a hostile AFTER_CHECKPOINT hook that tries to reenter checkpointAll() is rejected by the shared reentrancy guard", async () => {
    const fx = await loadFixture(openIndexFixture);
    const { vault, risk, addrs } = fx;

    const Mock = await ethers.getContractFactory("MockHook");
    const hook = await Mock.deploy(3); // REENTER
    const hookAddr = await hook.getAddress();
    const point = await vault.AFTER_CHECKPOINT();
    await registerHook(vault, risk, point, hookAddr, 0);

    const reentrantCalldata = vault.interface.encodeFunctionData("checkpointAll", []);
    await hook.setReentrantTarget(await vault.getAddress(), reentrantCalldata);

    await time.increase(700);

    const tx = await vault.checkpointAll();
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1);

    expect(await hook.calls()).to.be.greaterThan(0n);
    expect(await hook.reentrantOk()).to.equal(false);
    const returnData: string = await hook.reentrantReturnData();
    const ReentrantCallSelector = vault.interface.getError("ReentrantCall")!.selector;
    expect(returnData.slice(0, 10)).to.equal(ReentrantCallSelector);
  });
});
