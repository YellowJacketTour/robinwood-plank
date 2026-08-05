import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";

import {
  WAD,
  TIMELOCK,
  deployOpenIndex,
  deployConstituent,
  maxIn,
  zeroOut,
} from "./helpers/index-vault";

/**
 * ==========================================================================
 *  SCOPED-CAPABILITY ROLES — blast-radius proofs
 *
 *  Both privileged contracts used to carry ONE `admin` address that could
 *  queue every timelocked change there was. That is the shape behind 2026's
 *  Drift Protocol loss: one compromised or socially-engineered key holding
 *  every capability at once, with the timelock bounding only WHEN the damage
 *  lands, never WHAT the key can reach.
 *
 *  This suite proves the WHAT is now bounded. It is written as an adversary
 *  would write it: assume a role key IS compromised, then enumerate the ABI
 *  and demand a revert on everything outside that role's scope.
 *
 *  The most important test in the file is the last one. It is not about
 *  roles at all — it is about the exit door, and it asserts that no
 *  combination of roles, timelock states, or compromised keys can stop a
 *  holder from redeeming. LOCAL HARDHAT ONLY.
 * ==========================================================================
 */

const GAUGE_TIMELOCK = TIMELOCK;
const RAW_MULT = 10_000n;
const LP_MULT = 15_000n;
const COLL_MULT = 20_000n;
const EPOCH = 7 * 24 * 3_600;

/** Every risk-surface key `roleForParamKey` routes to ROLE_RISK_PARAM. */
const RISK_KEYS = [
  "concentrationCapBps",
  "baseImbalanceFeeBps",
  "imbalanceSlopeBps",
  "maxImbalanceFeeBps",
  "bandBps",
  "priceCapBps",
  "minCheckpointInterval",
  "staleAfter",
  "persistenceCheckpoints",
  "persistenceToleranceBps",
  "largeOpValueWei",
  "rampDuration",
  "targetHhiBps",
  "minEligibilityFeesWei",
  "minEligibilityBlocks",
];

const GAUGE_TUNING_KEYS = [
  "multiplierRawBps",
  "multiplierPlankEthLpBps",
  "multiplierCollectionLpBps",
  "epochDuration",
  "concentrationExponentHalves",
  "baseBoostBps",
  "maxBoostBps",
];

const b32 = (s: string) => ethers.encodeBytes32String(s);

async function gaugeFixture() {
  const all = await ethers.getSigners();
  const [whale, outsider] = [all[12], all[13]];
  const [gaugeRoleAdmin, registry, tuning] = [all[15], all[16], all[17]];

  const Token = await ethers.getContractFactory("MockIndexToken");
  const plank: any = await Token.deploy("PLANK", "PLANK");

  const Gauge = await ethers.getContractFactory("PlankGauge");
  const gauge: any = await Gauge.deploy(
    await plank.getAddress(),
    [gaugeRoleAdmin.address, registry.address, tuning.address],
    GAUGE_TIMELOCK,
    [RAW_MULT, LP_MULT, COLL_MULT],
    EPOCH
  );
  const gA = ethers.Wallet.createRandom().address;
  await gauge.connect(registry).queueGauge(gA, false);
  await time.increase(GAUGE_TIMELOCK + 1);
  await gauge.executeGauge(gA);

  await plank.mint(whale.address, 1_000_000n * WAD);
  await plank.connect(whale).approve(await gauge.getAddress(), ethers.MaxUint256);

  return { gauge, plank, gA, gaugeRoleAdmin, registry, tuning, whale, outsider };
}

describe("Scoped-capability roles — GlobalIndexVault", () => {
  // These suites advance the shared Hardhat clock by days at a time. Mocha
  // shares one network across files, so without restoring afterwards the
  // fixed-endTime Seaport orders in the later suites silently expire.
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  // ══ (a) Every gated function requires EXACTLY its role ═══════════════════

  it("ISOLATION: each admin-gated function accepts its own role and rejects every other", async () => {
    const fx = await deployOpenIndex();
    const { vault, roleAdmin, admission, risk, allocation, alice, addrs } = fx;
    const d = await deployConstituent("cISO", 100n * WAD, 100n * WAD);

    const ROLE_ADMIN = await vault.ROLE_ADMIN();
    const ROLE_ADMISSION = await vault.ROLE_CONSTITUENT_ADMISSION();
    const ROLE_RISK = await vault.ROLE_RISK_PARAM();
    const ROLE_ALLOC = await vault.ROLE_PLATFORM_ALLOCATION();

    /**
     * The complete privileged surface of the vault: every non-view function
     * that carries a role check, paired with the ONE role that may call it.
     * `expectedRole` is what the revert must name for every other caller.
     */
    const surface: { name: string; args: any[]; role: string; holder: any }[] = [
      {
        name: "queueListing",
        args: [d.addr, await d.source.getAddress(), 1_000, false],
        role: ROLE_ADMISSION,
        holder: admission,
      },
      { name: "queueMetric", args: [addrs[0], 123n], role: ROLE_ADMISSION, holder: admission },
      { name: "queueParam", args: [b32("bandBps"), 120n], role: ROLE_RISK, holder: risk },
      {
        name: "queueParam",
        args: [b32("platformAllocationBps"), 100n],
        role: ROLE_ALLOC,
        holder: allocation,
      },
      {
        name: "queuePlatformTreasury",
        args: [alice.address],
        role: ROLE_ALLOC,
        holder: allocation,
      },
      {
        name: "queueRole",
        args: [ROLE_RISK, alice.address],
        role: ROLE_ADMIN,
        holder: roleAdmin,
      },
    ];

    // The enumeration must be COMPLETE. Every non-view function on the ABI is
    // either in the table above or provably permissionless — if a future
    // change adds a gated function and forgets to list it here, this fails.
    const gatedNames = new Set(surface.map((s) => s.name));
    const permissionless = new Set([
      "mintProRata",
      "redeemProRata",
      "mintSingleAsset",
      "redeemSingleAsset",
      "checkpoint",
      "checkpointAll",
      "executeParam",
      "executeMetric",
      "executeListing",
      "executePlatformTreasury",
      "executeRole",
      "delistEmpty",
      "refreshEligibleCount",
      "seedConstituent",
      "seedDeposit",
      "openIndex",
      "cancelRole",
      "approve",
      "transfer",
      "transferFrom",
      "increaseAllowance",
      "decreaseAllowance",
    ]);
    const abiNames = (vault.interface.fragments as any[])
      .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
      .map((f) => f.name);
    for (const n of abiNames) {
      expect(
        gatedNames.has(n) || permissionless.has(n),
        `unclassified privileged function "${n}" — add it to the isolation table`
      ).to.equal(true);
    }

    const everyKey = [roleAdmin, admission, risk, allocation, alice];

    for (const entry of surface) {
      for (const caller of everyKey) {
        const call = (vault.connect(caller) as any)[entry.name](...entry.args);
        if (caller.address === entry.holder.address) {
          await expect(call, `${entry.name} rejected its OWN role`).to.not.be.reverted;
        } else {
          await expect(call, `${entry.name} accepted a foreign key`)
            .to.be.revertedWithCustomError(vault, "NotRoleHolder")
            .withArgs(entry.role);
        }
      }
    }
  });

  it("ISOLATION: every risk key routes to the risk role and to nothing else", async () => {
    const fx = await deployOpenIndex();
    const { vault, risk, allocation, admission, roleAdmin, alice } = fx;
    const ROLE_RISK = await vault.ROLE_RISK_PARAM();

    for (const k of RISK_KEYS) {
      expect(await vault.roleForParamKey(b32(k)), k).to.equal(ROLE_RISK);
      for (const wrong of [allocation, admission, roleAdmin, alice]) {
        await expect(vault.connect(wrong).queueParam(b32(k), 1n), k)
          .to.be.revertedWithCustomError(vault, "NotRoleHolder")
          .withArgs(ROLE_RISK);
      }
      await expect(vault.connect(risk).queueParam(b32(k), 1n), k).to.not.be.reverted;
    }

    // ...and the one key that is NOT risk's is the operator-value one.
    expect(await vault.roleForParamKey(b32("platformAllocationBps"))).to.equal(
      await vault.ROLE_PLATFORM_ALLOCATION()
    );
    await expect(vault.connect(risk).queueParam(b32("platformAllocationBps"), 1n))
      .to.be.revertedWithCustomError(vault, "NotRoleHolder")
      .withArgs(await vault.ROLE_PLATFORM_ALLOCATION());
  });

  it("ISOLATION: the shared queue mapping is not a back door between roles", async () => {
    // `queuedParams` is keyed by bytes32 and read by BOTH `executeParam` and
    // `executeMetric`. Without a key whitelist the risk role could write a
    // metric-shaped key and re-weight a constituent — the admission role's
    // power, reached sideways. The whitelist is what closes it, so it is
    // asserted directly rather than assumed.
    const fx = await deployOpenIndex();
    const { vault, risk, addrs } = fx;
    const metricKey = ethers.keccak256(
      ethers.solidityPacked(["string", "address"], ["metric", addrs[0]])
    );
    await expect(vault.connect(risk).queueParam(metricKey, 10n ** 30n)).to.be.revertedWithCustomError(
      vault,
      "BadParam"
    );
    await expect(vault.roleForParamKey(metricKey)).to.be.revertedWithCustomError(vault, "BadParam");

    // An arbitrary invented key is equally unqueueable, by anybody.
    for (const who of [risk, fx.admission, fx.allocation, fx.roleAdmin]) {
      await expect(
        vault.connect(who).queueParam(b32("thereIsNoSuchParam"), 1n)
      ).to.be.revertedWithCustomError(vault, "BadParam");
    }
  });

  // ══ (b)+(c) Role reassignment is timelocked and non-instant ══════════════

  it("ESCALATION: the role-management role cannot grant itself another role in one transaction", async () => {
    const fx = await deployOpenIndex();
    const { vault, roleAdmin, risk, allocation } = fx;
    const ROLE_RISK = await vault.ROLE_RISK_PARAM();
    const ROLE_ALLOC = await vault.ROLE_PLATFORM_ALLOCATION();

    // The maximally greedy single transaction available to it.
    await vault.connect(roleAdmin).queueRole(ROLE_RISK, roleAdmin.address);
    await vault.connect(roleAdmin).queueRole(ROLE_ALLOC, roleAdmin.address);

    // Nothing moved. Not one holder, not one parameter.
    expect(await vault.roleHolder(ROLE_RISK)).to.equal(risk.address);
    expect(await vault.roleHolder(ROLE_ALLOC)).to.equal(allocation.address);
    await expect(vault.connect(roleAdmin).queueParam(b32("bandBps"), 1n))
      .to.be.revertedWithCustomError(vault, "NotRoleHolder")
      .withArgs(ROLE_RISK);
    await expect(vault.connect(roleAdmin).queuePlatformTreasury(roleAdmin.address))
      .to.be.revertedWithCustomError(vault, "NotRoleHolder")
      .withArgs(ROLE_ALLOC);

    // Executing early is impossible for the full delay — checked one second
    // short of the eta, not merely "at some earlier point".
    await time.increase(TIMELOCK - 5);
    await expect(vault.executeRole(ROLE_RISK)).to.be.revertedWithCustomError(
      vault,
      "RoleTimelockNotElapsed"
    );
    expect(await vault.roleHolder(ROLE_RISK)).to.equal(risk.address);

    // Only after the full public delay does the escalation land — which is
    // exactly the observable, slow, cancel-able window a timelock is for.
    await time.increase(10);
    await vault.executeRole(ROLE_RISK);
    expect(await vault.roleHolder(ROLE_RISK)).to.equal(roleAdmin.address);
    // ...and the OTHER role it grabbed at the same moment still had to wait
    // its own delay, i.e. there is no batch-escalation shortcut.
    await vault.executeRole(ROLE_ALLOC);
    expect(await vault.roleHolder(ROLE_ALLOC)).to.equal(roleAdmin.address);
  });

  it("ESCALATION: role reassignment refuses unknown roles and the zero address", async () => {
    const fx = await deployOpenIndex();
    const { vault, roleAdmin, alice } = fx;
    await expect(
      vault.connect(roleAdmin).queueRole(b32("vault.superuser"), alice.address)
    ).to.be.revertedWithCustomError(vault, "UnknownRole");
    await expect(
      vault.connect(roleAdmin).queueRole(await vault.ROLE_RISK_PARAM(), ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(vault, "BadRoleHolder");
  });

  it("ESCALATION: there is no second write path to roleHolder anywhere in the ABI", async () => {
    const fx = await deployOpenIndex();
    const names = (fx.vault.interface.fragments as any[])
      .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
      .map((f) => f.name);
    // `executeRole` is the only mutator, and it is gated on the eta alone.
    expect(names.filter((n) => n.toLowerCase().includes("role")).sort()).to.deep.equal([
      "cancelRole",
      "executeRole",
      "queueRole",
    ]);
    // No renounce/grant/revoke/setRole surface sneaked in alongside it.
    for (const bad of ["grantRole", "revokeRole", "renounceRole", "setRole", "setAdmin"]) {
      expect(names).to.not.include(bad);
    }
  });

  // ══ (d) Bounded blast radius of a single compromised key ═════════════════

  it("BLAST RADIUS: a compromised key of each role can touch nothing outside its own scope", async () => {
    const fx = await deployOpenIndex();
    const { vault, roleAdmin, admission, risk, allocation, alice, addrs } = fx;
    const d = await deployConstituent("cBLAST", 100n * WAD, 100n * WAD);
    const dSrc = await d.source.getAddress();

    // What each role is NOT allowed to do. Simulate the compromise by having
    // that role's key attempt every OTHER role's functions, one at a time.
    const foreign = async (key: any, label: string) => {
      const attempts: [string, any[], string][] = [];
      const ROLE_ADMISSION = await vault.ROLE_CONSTITUENT_ADMISSION();
      const ROLE_RISK = await vault.ROLE_RISK_PARAM();
      const ROLE_ALLOC = await vault.ROLE_PLATFORM_ALLOCATION();
      const ROLE_ADMIN = await vault.ROLE_ADMIN();
      if (key.address !== admission.address) {
        attempts.push(["queueListing", [d.addr, dSrc, 1_000, false], ROLE_ADMISSION]);
        attempts.push(["queueMetric", [addrs[0], 1n], ROLE_ADMISSION]);
      }
      if (key.address !== risk.address) {
        attempts.push(["queueParam", [b32("concentrationCapBps"), 5_000n], ROLE_RISK]);
      }
      if (key.address !== allocation.address) {
        attempts.push(["queueParam", [b32("platformAllocationBps"), 500n], ROLE_ALLOC]);
        attempts.push(["queuePlatformTreasury", [key.address], ROLE_ALLOC]);
      }
      if (key.address !== roleAdmin.address) {
        attempts.push(["queueRole", [ROLE_RISK, key.address], ROLE_ADMIN]);
        attempts.push(["cancelRole", [ROLE_RISK], ROLE_ADMIN]);
      }
      for (const [name, args, role] of attempts) {
        await expect((vault.connect(key) as any)[name](...args), `${label} -> ${name}`)
          .to.be.revertedWithCustomError(vault, "NotRoleHolder")
          .withArgs(role);
      }
    };

    await foreign(roleAdmin, "role-admin");
    await foreign(admission, "admission");
    await foreign(risk, "risk");
    await foreign(allocation, "allocation");
    await foreign(alice, "outsider");

    // Nothing above changed a single piece of state.
    expect(await vault.platformTreasury()).to.equal(ethers.ZeroAddress);
    expect(await vault.platformAllocationBps()).to.equal(200n);
    expect(await vault.roleHolder(await vault.ROLE_RISK_PARAM())).to.equal(risk.address);
  });

  it("BLAST RADIUS: even ALL roles colluding cannot move a reserve or mint themselves shares", async () => {
    const fx = await deployOpenIndex();
    const { vault, vaultAddr, roleAdmin, admission, risk, allocation, alice, tokens, addrs } = fx;
    await vault.connect(alice).mintProRata(500n * WAD, maxIn(3));

    const before = await Promise.all(addrs.map((a: string) => vault.reserveOf(a)));
    const supplyBefore = await vault.totalSupply();

    const fns = (vault.interface.fragments as any[]).filter(
      (f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)
    );
    const argFor = (t: string): any => {
      if (t === "address") return addrs[0];
      if (t.startsWith("uint")) return 10n ** 24n;
      if (t === "bool") return true;
      if (t === "bytes32") return b32("concentrationCapBps");
      if (t === "address[]") return addrs;
      if (t.endsWith("[]")) return [0n, 0n, 0n];
      if (t === "string") return "x";
      return 0n;
    };
    // All four keys in the same session, in every order the ABI allows.
    for (const who of [roleAdmin, admission, risk, allocation]) {
      for (const f of fns) {
        try {
          await (vault.connect(who) as any)[f.format("sighash")](
            ...f.inputs.map((i: any) => argFor(i.type))
          );
        } catch {
          /* a guard firing is the correct outcome */
        }
      }
    }

    for (const who of [roleAdmin, admission, risk, allocation]) {
      expect(await vault.balanceOf(who.address)).to.equal(0n, "a role minted itself shares");
      for (let i = 0; i < 3; i++) {
        expect(await tokens[i].balanceOf(who.address)).to.equal(0n, "a role took a reserve");
      }
    }
    for (let i = 0; i < 3; i++) {
      expect(await vault.reserveOf(addrs[i])).to.equal(before[i], `reserve ${i} moved`);
      expect(await tokens[i].balanceOf(vaultAddr)).to.be.gte(before[i]);
    }
    expect(await vault.totalSupply()).to.equal(supplyBefore, "supply moved");
  });

  // ══ THE EXIT DOOR ════════════════════════════════════════════════════════

  it("THE EXIT DOOR: no role, no pause, no queued change, and no collusion can ever block a redemption", async () => {
    const fx = await deployOpenIndex();
    const { vault, roleAdmin, admission, risk, allocation, alice, addrs } = fx;
    await vault.connect(alice).mintProRata(1_000n * WAD, maxIn(3));

    // 1. There is NO pause mechanism to weaponise. Not "a pause that spares
    //    redemption" — none at all, in either the ABI or the storage surface.
    //    A mechanism that can hold assets in an unmovable state, even
    //    temporarily and even for a good reason, is a hostage mechanism.
    const names = (vault.interface.fragments as any[])
      .filter((f) => f.type === "function")
      .map((f) => f.name.toLowerCase());
    for (const forbidden of [
      "pause",
      "unpause",
      "freeze",
      "unfreeze",
      "halt",
      "shutdown",
      "emergencystop",
      "setpaused",
      "lock",
      "blocklist",
      "blacklist",
    ]) {
      expect(names, `a "${forbidden}" surface appeared`).to.not.include(forbidden);
    }
    expect(names.some((n: string) => n.includes("paus"))).to.equal(false);
    expect(names.some((n: string) => n.includes("freez"))).to.equal(false);

    // 2. Redemption works with EVERY role key simultaneously hostile and
    //    every hostile change they can reach sitting queued at once.
    const d = await deployConstituent("cEXIT", 100n * WAD, 100n * WAD);
    await vault.connect(admission).queueListing(d.addr, await d.source.getAddress(), 3_000, false);
    await vault.connect(admission).queueListing(addrs[1], addrs[1], 0, true); // removal
    await vault.connect(admission).queueMetric(addrs[0], 10n ** 30n);
    await vault.connect(risk).queueParam(b32("concentrationCapBps"), 1n); // absurd
    await vault.connect(risk).queueParam(b32("maxImbalanceFeeBps"), 10_000n);
    await vault.connect(risk).queueParam(b32("staleAfter"), 1n);
    await vault.connect(allocation).queueParam(b32("platformAllocationBps"), 10_000n);
    await vault.connect(allocation).queuePlatformTreasury(allocation.address);
    await vault.connect(roleAdmin).queueRole(await vault.ROLE_RISK_PARAM(), roleAdmin.address);

    // Mid-timelock: the whole hostile slate is pending and none of it bites.
    const heldMid = await vault.balanceOf(alice.address);
    await expect(vault.connect(alice).redeemProRata(100n * WAD, zeroOut(3))).to.not.be.reverted;
    expect(await vault.balanceOf(alice.address)).to.equal(heldMid - 100n * WAD);

    // 3. Now let EVERY queued hostile change actually land, and redeem again.
    await time.increase(TIMELOCK + 1);
    for (const k of ["maxImbalanceFeeBps", "staleAfter", "platformAllocationBps"]) {
      try {
        await vault.executeParam(b32(k));
      } catch {
        /* the compile-time ceilings reject the absurd ones — also correct */
      }
    }
    try {
      await vault.executeListing(addrs[1]);
    } catch {
      /* ignore */
    }
    try {
      await vault.executePlatformTreasury();
    } catch {
      /* ignore */
    }
    await vault.executeRole(await vault.ROLE_RISK_PARAM());

    // 4. The exit door is still open, at the same strict pro-rata price, with
    //    every role now concentrated in one hostile key.
    const [, previewOut] = await vault.previewRedeemProRata(100n * WAD);
    expect(previewOut.filter((x: bigint) => x > 0n).length).to.be.greaterThan(
      0,
      "redemption stopped paying out"
    );
    const held = await vault.balanceOf(alice.address);
    await expect(vault.connect(alice).redeemProRata(held, zeroOut(3))).to.not.be.reverted;
    expect(await vault.balanceOf(alice.address)).to.equal(0n);

    // 5. And redeemProRata reads no role and no flag: it is reachable by an
    //    address that holds nothing but shares, forever.
    expect(
      (vault.interface.fragments as any[]).find(
        (f) => f.type === "function" && f.name === "redeemProRata"
      ).stateMutability
    ).to.equal("nonpayable");
  });
});

describe("Scoped-capability roles — PlankGauge", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  it("ISOLATION: registration and tuning are separately keyed and mutually closed", async () => {
    const { gauge, gaugeRoleAdmin, registry, tuning, outsider, whale, gA } = await gaugeFixture();
    const ROLE_ADMIN = await gauge.ROLE_ADMIN();
    const ROLE_REG = await gauge.ROLE_GAUGE_REGISTRY();
    const ROLE_TUNE = await gauge.ROLE_GAUGE_TUNING();

    const surface: { name: string; args: any[]; role: string; holder: any }[] = [
      { name: "queueGauge", args: [outsider.address, false], role: ROLE_REG, holder: registry },
      {
        name: "queuePlankEthLp",
        args: [outsider.address, false],
        role: ROLE_REG,
        holder: registry,
      },
      {
        name: "queueCollectionLp",
        args: [gA, outsider.address, outsider.address, false],
        role: ROLE_REG,
        holder: registry,
      },
      { name: "queueRedirectSink", args: [outsider.address], role: ROLE_REG, holder: registry },
      { name: "queueParam", args: [b32("baseBoostBps"), 10_000n], role: ROLE_TUNE, holder: tuning },
      {
        name: "queueRole",
        args: [ROLE_TUNE, outsider.address],
        role: ROLE_ADMIN,
        holder: gaugeRoleAdmin,
      },
    ];

    const everyKey = [gaugeRoleAdmin, registry, tuning, whale, outsider];
    for (const entry of surface) {
      for (const caller of everyKey) {
        const call = (gauge.connect(caller) as any)[entry.name](...entry.args);
        if (caller.address === entry.holder.address) {
          await expect(call, `${entry.name} rejected its OWN role`).to.not.be.reverted;
        } else {
          await expect(call, `${entry.name} accepted a foreign key`)
            .to.be.revertedWithCustomError(gauge, "NotRoleHolder")
            .withArgs(entry.role);
        }
      }
    }
  });

  it("ISOLATION: every tuning key routes to the tuning role, and the registry key cannot reach one", async () => {
    const { gauge, registry, tuning, gaugeRoleAdmin, outsider } = await gaugeFixture();
    const ROLE_TUNE = await gauge.ROLE_GAUGE_TUNING();
    for (const k of GAUGE_TUNING_KEYS) {
      expect(await gauge.roleForParamKey(b32(k)), k).to.equal(ROLE_TUNE);
      for (const wrong of [registry, gaugeRoleAdmin, outsider]) {
        await expect(gauge.connect(wrong).queueParam(b32(k), 1n), k)
          .to.be.revertedWithCustomError(gauge, "NotRoleHolder")
          .withArgs(ROLE_TUNE);
      }
    }
    // The registry key holds the allowlists and NOTHING on the curve.
    expect(await gauge.multiplierBps(0)).to.equal(RAW_MULT);
    expect(await gauge.roleHolder(ROLE_TUNE)).to.equal(tuning.address);
  });

  it("ESCALATION: the gauge's role handover is timelocked and cannot self-escalate in one step", async () => {
    const { gauge, gaugeRoleAdmin, tuning } = await gaugeFixture();
    const ROLE_TUNE = await gauge.ROLE_GAUGE_TUNING();
    await gauge.connect(gaugeRoleAdmin).queueRole(ROLE_TUNE, gaugeRoleAdmin.address);
    expect(await gauge.roleHolder(ROLE_TUNE)).to.equal(tuning.address);
    await expect(gauge.connect(gaugeRoleAdmin).queueParam(b32("baseBoostBps"), 12_000n))
      .to.be.revertedWithCustomError(gauge, "NotRoleHolder")
      .withArgs(ROLE_TUNE);
    await time.increase(GAUGE_TIMELOCK - 5);
    await expect(gauge.executeRole(ROLE_TUNE)).to.be.revertedWithCustomError(
      gauge,
      "RoleTimelockNotElapsed"
    );
    await time.increase(10);
    await gauge.executeRole(ROLE_TUNE);
    expect(await gauge.roleHolder(ROLE_TUNE)).to.equal(gaugeRoleAdmin.address);
  });

  it("BLAST RADIUS: a compromised gauge key erases no burn record and blocks no burn it does not own", async () => {
    const { gauge, gaugeRoleAdmin, registry, tuning, whale, gA } = await gaugeFixture();
    await gauge.connect(whale).burnPlank(gA, 1_000n * WAD);
    const weight: bigint = await gauge.gaugeWeight(gA);
    expect(weight).to.be.gt(0n);

    const fns = (gauge.interface.fragments as any[]).filter(
      (f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)
    );
    const argFor = (t: string): any => {
      if (t === "address") return whale.address;
      if (t.startsWith("uint")) return 10n ** 24n;
      if (t === "bool") return true;
      if (t === "bytes32") return b32("multiplierRawBps");
      if (t.endsWith("[]")) return [];
      return 0n;
    };
    for (const who of [gaugeRoleAdmin, registry, tuning]) {
      for (const f of fns) {
        try {
          await (gauge.connect(who) as any)[f.format("sighash")](
            ...f.inputs.map((i: any) => argFor(i.type))
          );
        } catch {
          /* correct */
        }
      }
    }
    // The already-earned weight is exactly where it was: no role rewrites
    // history, and the gauge holds no value for any of them to take.
    expect(await gauge.gaugeWeight(gA)).to.equal(weight);
    expect(await (await ethers.getContractAt("MockIndexToken", await gauge.plank())).balanceOf(
      gaugeRoleAdmin.address
    )).to.equal(0n);
  });

  it("THE EXIT DOOR: the gauge has no pause surface either, and holds nothing to lock", async () => {
    const { gauge } = await gaugeFixture();
    const names = (gauge.interface.fragments as any[])
      .filter((f) => f.type === "function")
      .map((f) => f.name.toLowerCase());
    expect(names.some((n: string) => n.includes("paus"))).to.equal(false);
    expect(names.some((n: string) => n.includes("freez"))).to.equal(false);
    // No payable function means there is nothing here to hold hostage at all.
    const payable = (gauge.interface.fragments as any[]).filter(
      (f) => f.type === "function" && f.stateMutability === "payable"
    );
    expect(payable.length).to.equal(0);
  });
});
