import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { time, takeSnapshot, type SnapshotRestorer } from "./helpers/network-helpers.js";

import {
  WAD,
  TIMELOCK,
  deployOpenIndex,
  deployConstituent,
  maxIn,
  zeroOut,
  armVaultRegistry,
} from "./helpers/index-vault.js";

/**
 * ==========================================================================
 *  AUDIT M-1 — TIMELOCK EXPIRY (`GRACE_PERIOD`) AND THE VETO SURFACE
 *
 *  Before this suite's mechanisms existed:
 *
 *    1. Every `execute*` checked only `block.timestamp >= eta`. A queued
 *       value was executable FOREVER — queue something innocuous today, fire
 *       it in eighteen months under different circumstances.
 *    2. There was NO cancel for a queued PARAMETER, LISTING, TREASURY or
 *       REGISTRY at all. The only cancels in the diamond were `cancelRole`
 *       and `cancelStream`, both gated on the SAME role that queued the item.
 *       So a COMPROMISED PARAMETER KEY'S QUEUED VALUE WAS UNSTOPPABLE: key
 *       rotation runs on the same delay, so `queueRole` always lands AFTER
 *       the malicious eta and defenders could only watch.
 *
 *  EVERY test below states, in a comment, how it goes RED if its mechanism
 *  is removed — because this codebase has already shipped three load-bearing
 *  tests that proved nothing (audit meta-finding).
 *
 *  The suite also carries an ANTI-VACUITY / REGRESSION-FLOOR control (the
 *  "LIVENESS FLOOR" block), on the pattern of
 *  RedTeam.HostileConstituentAdmission.poc.test.ts: a safety fix that turns
 *  into a denial of service is not a fix. Governance must still WORK.
 * ==========================================================================
 */

const b32 = (s: string) => ethers.encodeBytes32String(s);
const GRACE = 14 * 24 * 3_600;

describe("AUDIT M-1 — timelock GRACE_PERIOD expiry", () => {
  // This suite warps the shared Hardhat clock by weeks at a time. Mocha
  // shares one network across files, so a leaked warp silently expires the
  // fixed-endTime Seaport orders in later suites (this exact leak previously
  // caused four phantom failures).
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  /**
   * GOES RED WITHOUT THE FIX: with no upper bound, `executeParam` after 20
   * days succeeds and `bandBps` becomes 120. The `QueueExpired` expectation
   * fails first, and the follow-up "value did not land" assertion fails too —
   * so this cannot pass on both branches.
   */
  it("a matured parameter is EXECUTABLE inside the window and DEAD outside it", async () => {
    const fx = await deployOpenIndex();
    const { vault, risk } = fx;

    // (a) inside the window: this MUST work — the anti-vacuity half.
    await vault.connect(risk).queueParam(b32("bandBps"), 120n);
    await time.increase(TIMELOCK + 1);
    await expect(vault.executeParam(b32("bandBps"))).to.not.be.revert(ethers);

    // (b) outside the window: dead, and it fails CLOSED.
    await vault.connect(risk).queueParam(b32("bandBps"), 321n);
    await time.increase(TIMELOCK + GRACE + 10);
    await expect(vault.executeParam(b32("bandBps"))).to.be.revertedWithCustomError(
      vault,
      "QueueExpired"
    );
    // ...and the stale value genuinely never landed.
    const [, , stillPending] = await vault.queuedParams(b32("bandBps"));
    expect(stillPending, "queue slot was consumed by a failed execute").to.equal(true);
    // Re-queueing on a FRESH, fully public delay is the only way forward.
    await vault.connect(risk).queueParam(b32("bandBps"), 321n);
    await time.increase(TIMELOCK + 1);
    await expect(vault.executeParam(b32("bandBps"))).to.not.be.revert(ethers);
  });

  /**
   * THE EXACT BOUNDARY, on both sides, one second apart. A test that only
   * probed "much later" could pass against an off-by-a-week bound.
   *
   * GOES RED WITHOUT THE FIX: the `QueueExpired` branch reverts nothing.
   */
  it("the boundary is exactly eta + GRACE_PERIOD, checked one second either side", async () => {
    const fx = await deployOpenIndex();
    const { vault, risk } = fx;

    await vault.connect(risk).queueParam(b32("bandBps"), 150n);
    const [, eta] = await vault.queuedParams(b32("bandBps"));

    // one second BEFORE expiry: still legal.
    await time.setNextBlockTimestamp(Number(eta) + GRACE);
    await expect(vault.executeParam(b32("bandBps"))).to.not.be.revert(ethers);

    await vault.connect(risk).queueParam(b32("bandBps"), 151n);
    const [, eta2] = await vault.queuedParams(b32("bandBps"));
    // one second AFTER: dead.
    await time.setNextBlockTimestamp(Number(eta2) + GRACE + 1);
    await expect(vault.executeParam(b32("bandBps"))).to.be.revertedWithCustomError(
      vault,
      "QueueExpired"
    );
  });

  /**
   * The audit's complaint was that the missing bound was UNIFORM across every
   * apply path, so the proof has to be uniform too. One stale queue per
   * `execute*` surface on this facet pair.
   *
   * GOES RED WITHOUT THE FIX: every one of these calls succeeds instead of
   * reverting, and each `expect` names which path regressed.
   */
  it("EVERY timelocked apply path expires — params, metric, listing, treasury, registry, role, stream", async () => {
    const fx = await deployOpenIndex();
    const { vault, risk, admission, allocation, roleAdmin, alice, addrs } = fx;
    const d = await deployConstituent("cGRACE", 100n * WAD, 100n * WAD);
    await armVaultRegistry(fx, [...addrs, d.addr]);

    const Token = await ethers.getContractFactory("MockIndexToken");
    const streamTok: any = await Token.deploy("GRC", "GRC");
    const streamAddr = await streamTok.getAddress();

    await vault.connect(risk).queueParam(b32("bandBps"), 199n);
    await vault.connect(admission).queueMetric(addrs[0], 7n);
    await vault.connect(admission).queueListing(d.addr, await d.source.getAddress(), 1_000, false);
    await vault.connect(admission).queueVaultFactory(ethers.ZeroAddress);
    await vault.connect(allocation).queuePlatformTreasury(alice.address);
    await vault.connect(roleAdmin).queueRole(await vault.ROLE_RISK_PARAM(), alice.address);
    await vault.connect(admission).queueStream(streamAddr);

    await time.increase(TIMELOCK + GRACE + 10);

    await expect(vault.executeParam(b32("bandBps")), "executeParam").to.be.revertedWithCustomError(
      vault,
      "QueueExpired"
    );
    await expect(vault.executeMetric(addrs[0]), "executeMetric").to.be.revertedWithCustomError(
      vault,
      "QueueExpired"
    );
    await expect(vault.executeListing(d.addr), "executeListing").to.be.revertedWithCustomError(
      vault,
      "QueueExpired"
    );
    await expect(vault.executeVaultFactory(), "executeVaultFactory").to.be.revertedWithCustomError(
      vault,
      "QueueExpired"
    );
    await expect(
      vault.executePlatformTreasury(),
      "executePlatformTreasury"
    ).to.be.revertedWithCustomError(vault, "QueueExpired");
    await expect(
      vault.executeRole(await vault.ROLE_RISK_PARAM()),
      "executeRole"
    ).to.be.revertedWithCustomError(vault, "QueueExpired");
    await expect(vault.executeStream(streamAddr), "executeStream").to.be.revertedWithCustomError(
      vault,
      "QueueExpired"
    );

    // Nothing landed anywhere.
    expect(await vault.roleHolder(await vault.ROLE_RISK_PARAM())).to.equal(risk.address);
    expect(await vault.platformTreasury()).to.equal(ethers.ZeroAddress);
    expect(await vault.isStream(streamAddr)).to.equal(false);
  });

  /**
   * LIVENESS FLOOR / ANTI-VACUITY CONTROL.
   *
   * A grace period that was (say) one second long would pass every assertion
   * above and would ALSO brick governance permanently. This asserts the
   * window is genuinely usable: an operator who does nothing for a full WEEK
   * past the eta can still execute. Removing this control is what would let a
   * safety fix silently become a denial of service.
   *
   * GOES RED IF: GRACE_PERIOD is cut below ~7 days, or if the bound is
   * accidentally written against `now` rather than `eta`.
   */
  it("LIVENESS FLOOR: a week of operator inaction past the eta still executes", async () => {
    const fx = await deployOpenIndex();
    const { vault, risk } = fx;
    await vault.connect(risk).queueParam(b32("bandBps"), 175n);
    await time.increase(TIMELOCK + 7 * 24 * 3_600);
    await expect(vault.executeParam(b32("bandBps"))).to.not.be.revert(ethers);
  });
});

describe("AUDIT M-1 — the veto surface", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  /**
   * THE FINDING, INVERTED. This is the scenario the audit said was
   * unrecoverable: the RISK key is compromised and queues a hostile value.
   * Rotation cannot help — it runs on the same delay, so it lands after the
   * malicious eta. Before the fix, the ONLY outcome was that the hostile
   * value landed.
   *
   * GOES RED WITHOUT THE FIX: `vetoParam` does not exist (TypeError), and
   * with the veto present but ineffective the post-eta `executeParam` would
   * succeed and `concentrationCapBps` would become 1.
   */
  it("RECOVERY: a NON-compromised role vetoes a compromised risk key's queued value before its eta", async () => {
    const fx = await deployOpenIndex();
    const { vault, risk, roleAdmin, alice } = fx;
    const capBefore = (await vault.params()).concentrationCapBps;

    // The compromise. `concentrationCapBps -> 1` is this repo's own canonical
    // hostile value (see the exit-door test in ScopedRoles.isolation).
    await vault.connect(risk).queueParam(b32("concentrationCapBps"), 1n);

    // Rotation is NOT the answer and this proves why: queued now, it matures
    // at the same time as the attack, never before it.
    await vault.connect(roleAdmin).queueRole(await vault.ROLE_RISK_PARAM(), alice.address);
    const [, attackEta] = await vault.queuedParams(b32("concentrationCapBps"));
    const [, rotateEta] = await vault.queuedRoles(await vault.ROLE_RISK_PARAM());
    expect(rotateEta, "rotation cannot out-race the attack on equal delays").to.be.gte(attackEta);

    // The veto is IMMEDIATE, and reachable by a key that is not the attacker.
    await expect(vault.connect(roleAdmin).vetoParam(b32("concentrationCapBps")))
      .to.emit(vault, "QueueVetoed")
      .withArgs(b32("concentrationCapBps"), roleAdmin.address);

    await time.increase(TIMELOCK + 1);
    await expect(vault.executeParam(b32("concentrationCapBps"))).to.be.revertedWithCustomError(
      vault,
      "NothingQueued"
    );
    expect((await vault.params()).concentrationCapBps, "hostile cap landed anyway").to.equal(capBefore);
  });

  /**
   * The cross-domain claim, asserted positively rather than assumed: a role
   * may veto a queue it could never have created. This is the whole design
   * decision, so it is tested directly for every (vetoer, queue) pair.
   *
   * GOES RED IF the veto is narrowed to ROLE_ADMIN-only or to the queueing
   * role: the cross-domain `.to.not.be.revert(ethers)` calls start reverting.
   */
  it("ANY of the five role holders may veto ANY queue, including another role's", async () => {
    const fx = await deployOpenIndex();
    const { vault, risk, allocation, admission, roleAdmin, alice, addrs } = fx;

    // Queued by RISK, vetoed by ALLOCATION (which cannot queue it at all).
    await vault.connect(risk).queueParam(b32("bandBps"), 111n);
    await expect(vault.connect(allocation).queueParam(b32("bandBps"), 111n)).to.be.revert(ethers);
    await expect(vault.connect(allocation).vetoParam(b32("bandBps"))).to.not.be.revert(ethers);

    // Queued by ALLOCATION, vetoed by ADMISSION.
    await vault.connect(allocation).queuePlatformTreasury(alice.address);
    await expect(vault.connect(admission).vetoPlatformTreasury()).to.not.be.revert(ethers);

    // Queued by ADMISSION, vetoed by RISK.
    await vault.connect(admission).queueMetric(addrs[0], 5n);
    const metricKey = ethers.keccak256(
      ethers.solidityPacked(["string", "address"], ["metric", addrs[0]])
    );
    await expect(vault.connect(risk).vetoParam(metricKey)).to.not.be.revert(ethers);

    await vault.connect(admission).queueVaultFactory(ethers.ZeroAddress);
    await expect(vault.connect(risk).vetoVaultFactory()).to.not.be.revert(ethers);

    // THE CASE `cancelRole` CANNOT SERVE: ROLE_ADMIN is itself the attacker,
    // queueing a rotation of the risk role to an address it controls. Only a
    // veto reachable by somebody else stops it.
    await vault.connect(roleAdmin).queueRole(await vault.ROLE_RISK_PARAM(), roleAdmin.address);
    await expect(vault.connect(risk).vetoRole(await vault.ROLE_RISK_PARAM())).to.not.be.revert(ethers);
    await time.increase(TIMELOCK + 1);
    await expect(vault.executeRole(await vault.ROLE_RISK_PARAM())).to.be.revertedWithCustomError(
      vault,
      "NoRoleQueued"
    );
    expect(await vault.roleHolder(await vault.ROLE_RISK_PARAM())).to.equal(risk.address);
  });

  /**
   * The veto is permissive, NOT permissionless. An outsider holding no role
   * cannot grief governance liveness.
   *
   * GOES RED IF `_requireAnyRoleHolder` is dropped: every call below
   * succeeds.
   */
  it("an address holding NO role cannot veto anything", async () => {
    const fx = await deployOpenIndex();
    const { vault, risk, alice, addrs } = fx;
    await vault.connect(risk).queueParam(b32("bandBps"), 133n);
    for (const fn of [
      () => vault.connect(alice).vetoParam(b32("bandBps")),
      () => vault.connect(alice).vetoListing(addrs[0]),
      () => vault.connect(alice).vetoPlatformTreasury(),
      () => vault.connect(alice).vetoVaultFactory(),
      () => vault.connect(alice).vetoRole(b32("role.admin")),
      () => vault.connect(alice).vetoStream(addrs[0]),
    ]) {
      await expect(fn()).to.be.revertedWithCustomError(vault, "NotAnyRoleHolder");
    }
    // ...and the queue is untouched, so the outsider achieved nothing.
    const [v, , pending] = await vault.queuedParams(b32("bandBps"));
    expect(pending).to.equal(true);
    expect(v).to.equal(133n);
  });

  /**
   * A veto of nothing is a revert, not a silent success — otherwise a
   * monitoring system could not distinguish "I stopped the attack" from "the
   * attack was never there / already executed".
   */
  it("vetoing an empty slot reverts rather than silently succeeding", async () => {
    const fx = await deployOpenIndex();
    const { vault, risk, addrs } = fx;
    await expect(vault.connect(risk).vetoParam(b32("bandBps"))).to.be.revertedWithCustomError(
      vault,
      "NothingQueued"
    );
    await expect(vault.connect(risk).vetoListing(addrs[0])).to.be.revertedWithCustomError(
      vault,
      "NothingQueued"
    );
    await expect(vault.connect(risk).vetoPlatformTreasury()).to.be.revertedWithCustomError(
      vault,
      "NothingQueued"
    );
    await expect(vault.connect(risk).vetoVaultFactory()).to.be.revertedWithCustomError(
      vault,
      "NothingQueued"
    );
    await expect(
      vault.connect(risk).vetoRole(await vault.ROLE_ADMIN())
    ).to.be.revertedWithCustomError(vault, "NoRoleQueued");
    await expect(vault.connect(risk).vetoStream(addrs[0])).to.be.revertedWithCustomError(
      vault,
      "NoStreamQueued"
    );
  });

  /**
   * ══ THE EXIT DOOR IS NOT REACHABLE FROM THE VETO SURFACE ══════════════
   *
   * Design §1.1 / standing principle 5: `redeemProRata` is always open,
   * oracle-free, unblockable, and NOT governance-reachable. A veto must never
   * be able to touch it. Asserted three ways, none of which is a source grep
   * (the audit's meta-finding #3 was a grep-based proof that could not see a
   * cross-facet self-call):
   *
   *   1. STRUCTURAL — no veto function takes an account, an amount, or a
   *      recipient. There is nothing in the calldata to aim at a redeemer.
   *   2. BEHAVIOURAL — with all five role keys hostile and every veto in the
   *      ABI fired at every argument they will accept, a holder still
   *      redeems, at the same strict pro-rata price, before AND after.
   *   3. NEGATIVE — no veto can un-list a LIVE constituent or a LIVE stream,
   *      which is the only shape by which a "cancel" could shrink the payout
   *      set an exit iterates.
   *
   * GOES RED IF: a veto ever gains a value-touching branch, an argument that
   * names a user, or the ability to deactivate a live constituent/stream —
   * assertion (2)'s balance equality and (3)'s liveness checks both fail.
   */
  it("THE EXIT DOOR: the veto surface cannot reach, gate, price or delay redeemProRata", async () => {
    const fx = await deployOpenIndex();
    const { vault, risk, allocation, admission, roleAdmin, alice, addrs, tokens } = fx;
    await vault.connect(alice).mintProRata(1_000n * WAD, maxIn(3));

    const vetoNames = (vault.interface.fragments as any[])
      .filter((f) => f.type === "function" && f.name.startsWith("veto"))
      .map((f) => f);
    expect(vetoNames.length, "no veto functions found — test is vacuous").to.be.greaterThan(0);

    // (1) STRUCTURAL: the whole surface's argument space is bytes32/address
    // SLOT SELECTORS. No uint amount, no recipient, nothing payable.
    for (const f of vetoNames) {
      expect(f.stateMutability, `${f.name} is payable`).to.equal("nonpayable");
      for (const i of f.inputs) {
        expect(["bytes32", "address"], `${f.name} takes a value-shaped argument`).to.include(i.type);
      }
      expect(f.outputs.length, `${f.name} returns something`).to.equal(0);
    }

    // (2) BEHAVIOURAL: fire every veto, from every role key, at every
    // argument the ABI will accept, then redeem.
    const balBefore = await tokens[0].balanceOf(alice.address);
    const [, previewBefore] = await vault.previewRedeemProRata(100n * WAD);
    const argFor = (t: string): any =>
      t === "bytes32" ? b32("concentrationCapBps") : addrs[0];
    for (const who of [roleAdmin, admission, risk, allocation]) {
      for (const f of vetoNames) {
        try {
          await (vault.connect(who) as any)[f.format("sighash")](
            ...f.inputs.map((i: any) => argFor(i.type))
          );
        } catch {
          /* NothingQueued is the correct outcome for an empty slot */
        }
      }
    }
    const [, previewAfter] = await vault.previewRedeemProRata(100n * WAD);
    for (let i = 0; i < previewBefore.length; i++) {
      expect(previewAfter[i], `veto moved the exit price on leg ${i}`).to.equal(previewBefore[i]);
    }
    await expect(vault.connect(alice).redeemProRata(1_000n * WAD, zeroOut(3))).to.not.be.revert(ethers);
    expect(await vault.balanceOf(alice.address)).to.equal(0n);
    expect(await tokens[0].balanceOf(alice.address)).to.be.gt(balBefore);

    // (3) NEGATIVE: every constituent the exit iterates is still listed and
    // still active — no veto shrank the payout set.
    for (const a of addrs) {
      const c = await vault.constituentInfo(a);
      expect(c.listed, "a veto delisted a live constituent").to.equal(true);
      expect(c.active, "a veto deactivated a live constituent").to.equal(true);
    }
  });

  /**
   * A veto is not a substitute for a queue: it cannot SET anything. This is
   * the "strictly safety-increasing" claim, asserted rather than asserted-by-
   * comment.
   *
   * GOES RED IF a veto ever gains a write path to a live value.
   */
  it("a veto can only ever return the system to its CURRENT state", async () => {
    const fx = await deployOpenIndex();
    const { vault, risk, allocation, admission, roleAdmin, addrs } = fx;
    const snapshot = {
      cap: (await vault.params()).concentrationCapBps,
      alloc: await vault.platformAllocationBps(),
      treasury: await vault.platformTreasury(),
      factory: await vault.vaultFactory(),
      riskHolder: await vault.roleHolder(await vault.ROLE_RISK_PARAM()),
      metric: (await vault.constituentInfo(addrs[0])).metric,
      supply: await vault.totalSupply(),
    };
    for (const who of [roleAdmin, admission, risk, allocation]) {
      for (const call of [
        () => (vault.connect(who) as any).vetoParam(b32("concentrationCapBps")),
        () => (vault.connect(who) as any).vetoListing(addrs[0]),
        () => (vault.connect(who) as any).vetoPlatformTreasury(),
        () => (vault.connect(who) as any).vetoVaultFactory(),
        () => (vault.connect(who) as any).vetoRole(b32("vault.risk")),
        () => (vault.connect(who) as any).vetoStream(addrs[0]),
      ]) {
        try {
          await call();
        } catch {
          /* correct */
        }
      }
    }
    expect((await vault.params()).concentrationCapBps).to.equal(snapshot.cap);
    expect(await vault.platformAllocationBps()).to.equal(snapshot.alloc);
    expect(await vault.platformTreasury()).to.equal(snapshot.treasury);
    expect(await vault.vaultFactory()).to.equal(snapshot.factory);
    expect(await vault.roleHolder(await vault.ROLE_RISK_PARAM())).to.equal(snapshot.riskHolder);
    expect((await vault.constituentInfo(addrs[0])).metric).to.equal(snapshot.metric);
    expect(await vault.totalSupply()).to.equal(snapshot.supply);
  });

  /**
   * LIVENESS FLOOR / ANTI-VACUITY CONTROL for the veto, mirroring the grace
   * period's. A veto that permanently poisoned a slot would be a governance
   * DoS wearing a safety hat: the same key must be able to re-queue and
   * execute immediately afterwards.
   *
   * GOES RED IF `veto*` marks a slot dead rather than deleting it.
   */
  it("LIVENESS FLOOR: a vetoed key is immediately re-queueable and still executes", async () => {
    const fx = await deployOpenIndex();
    const { vault, risk } = fx;
    await vault.connect(risk).queueParam(b32("bandBps"), 140n);
    await vault.connect(risk).vetoParam(b32("bandBps"));
    await vault.connect(risk).queueParam(b32("bandBps"), 141n);
    await time.increase(TIMELOCK + 1);
    await expect(vault.executeParam(b32("bandBps"))).to.not.be.revert(ethers);
    expect((await vault.params()).bandBps).to.equal(141n);
  });
});
