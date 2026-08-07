import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, mine, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { deployOpenIndex, maxIn } from "./helpers/index-vault";

/**
 * ============================================================================
 * ROUND 9e — THE ZERO / NEAR-ZERO ELIGIBLE-DENOMINATOR CARRY
 *
 * Derived from an audited CRITICAL in a sister design's MasterChef-style
 * accumulator (`index += donation * SCALE / W_global`), filed there as
 * "lone-staker vault drain". When value arrives while the eligible
 * denominator is ZERO, a naive implementation does one of three bad things:
 *
 *   (a) reverts, so the funder's transaction fails and the stream stalls;
 *   (b) divides by zero / rounds to nothing, stranding the value forever;
 *   (c) — the actual audited bug — lets the FIRST party to become eligible
 *       after the zero-denominator window capture the ENTIRE pot that
 *       accumulated while nobody was eligible, having contributed nothing
 *       during that window.
 *
 * This codebase has THREE independent denominators that can be zero, and they
 * are checked here one at a time because they are genuinely independent:
 *
 *   1. `GlobalIndexVault.magnifiedDividendPerShare` — divisor is
 *      `totalSupply() - balanceOf(SEED_LOCK)`, i.e. eligible supply.
 *   2. `WrappedIndexShare`'s dividend-harvest leg — divisor is
 *      `totalSupply()` of wIDX.
 *   3. EACH of the N whitelisted reward streams on `WrappedIndexShare` — the
 *      sharpest case, because N independent funding paths multiply the
 *      surface.
 *
 * ============================================================================
 */
describe("Zero-denominator carry (round 9e)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const E = (n: string) => ethers.parseEther(n);
  const DELAY = 48 * 3600;
  const MAXU = (1n << 256n) - 1n;

  async function base() {
    const fx = await deployOpenIndex();
    const signers = await ethers.getSigners();
    const lister = signers[9];
    const W = await ethers.getContractFactory("WrappedIndexShare");
    const wrapper: any = await W.deploy(
      fx.vaultAddr,
      "Wrapped Global Index",
      "wIDX",
      fx.roleAdmin.address,
      lister.address,
      DELAY
    );
    const wrapperAddr = await wrapper.getAddress();
    for (const who of [fx.alice, fx.bob, fx.carol]) {
      await fx.tokens[0].connect(who).approve(wrapperAddr, ethers.MaxUint256);
      await fx.vault.connect(who).approve(wrapperAddr, ethers.MaxUint256);
    }
    return { ...fx, wrapper, wrapperAddr, lister, div: fx.tokens[0] };
  }

  const mint = (fx: any, who: any, shares: bigint) =>
    fx.vault.connect(who).mintProRata(shares, maxIn(3));

  async function newToken(name = "BRIBE") {
    const T = await ethers.getContractFactory("MockIndexToken");
    return (await T.deploy(name, name)) as any;
  }

  async function listStream(fx: any, token: any) {
    const addr = await token.getAddress();
    await fx.wrapper.connect(fx.lister).queueStream(addr);
    await time.increase(DELAY + 1);
    await fx.wrapper.executeStream(addr);
    return addr;
  }

  async function fundStream(fx: any, token: any, from: any, amount: bigint) {
    await token.mint(from.address, amount);
    await token.connect(from).approve(fx.wrapperAddr, amount);
    return fx.wrapper.connect(from).depositStream(await token.getAddress(), amount);
  }

  // ══ DENOMINATOR 1: the vault's own magnified-dividend accumulator ═══════

  /**
   * ALREADY SAFE, and safe by the exact mechanism the sister design adopted:
   * `undistributedDividends` is a carry term written by `_creditDividends` —
   * the ONE accumulator entrypoint shared by the permissionless push and by
   * `harvestEcosystemFees`'s self-sink branch — and folded back through that
   * same entrypoint. This test is the adversarial statement of that property,
   * including the case the audited bug was actually about: it must be shared
   * pro rata with everyone present at the fold, NOT captured by the first
   * holder to reappear.
   */
  it("DENOM 1 (vault dividend): a push at zero eligible supply neither reverts nor strands", async () => {
    const fx = await base();
    // Only the permanently-locked seed exists: eligible supply is exactly 0.
    const seedLock: string = await fx.vault.SEED_LOCK();
    expect(await fx.vault.totalSupply()).to.equal(await fx.vault.balanceOf(seedLock));

    // (a) It does NOT revert on the funder.
    await expect(fx.vault.connect(fx.carol).receiveDividendsWrapped(E("9"))).to.not.be.reverted;
    // (b) It is NOT stranded: it is queryable, in a named public carry.
    expect(await fx.vault.undistributedDividends()).to.equal(E("9"));
    expect(await fx.vault.magnifiedDividendPerShare()).to.equal(0n);
    expect(await fx.vault.totalDividendsReceived()).to.equal(E("9"));
  });

  it("DENOM 1 (vault dividend): the carried pot is shared PRO RATA with everyone present at the fold, not captured by the first re-entrant", async () => {
    const fx = await base();
    await fx.vault.connect(fx.carol).receiveDividendsWrapped(E("9"));
    expect(await fx.vault.undistributedDividends()).to.equal(E("9"));

    // THE AUDITED BUG, stated exactly: Alice is the FIRST holder to appear
    // after the zero-eligible window. If the carry folded on her arrival she
    // would own all 9. It does not — the carry only folds through the shared
    // `_creditDividends` entrypoint, i.e. on the next push, by which time Bob
    // and Carol have joined too.
    await mint(fx, fx.alice, E("100"));
    expect(await fx.vault.withdrawableDividendOf(fx.alice.address)).to.equal(0n);
    expect(await fx.vault.undistributedDividends()).to.equal(E("9"));

    await mint(fx, fx.bob, E("100"));
    await mint(fx, fx.carol, E("300"));

    // A one-wei push is enough to fold the whole carry: the flush is
    // permissionlessly reachable by anybody, for dust.
    await fx.vault.connect(fx.carol).receiveDividendsWrapped(1n);
    expect(await fx.vault.undistributedDividends()).to.equal(0n);

    const a: bigint = await fx.vault.withdrawableDividendOf(fx.alice.address);
    const b: bigint = await fx.vault.withdrawableDividendOf(fx.bob.address);
    const c: bigint = await fx.vault.withdrawableDividendOf(fx.carol.address);

    // Alice captured NOT the whole pot but her 100/500 share of it.
    expect(a).to.be.lessThan(E("9") / 4n);
    expect(a).to.be.greaterThan(0n);
    expect(b).to.equal(a); // equal stakes, equal slice
    expect(c).to.be.greaterThan(a * 2n); // 3x the stake, ~3x the slice
    // And the seed, which can never claim, accrued none of it.
    expect(await fx.vault.accumulativeDividendOf(await fx.vault.SEED_LOCK())).to.equal(0n);
    // Conservation: nothing minted out of thin air.
    expect(a + b + c).to.be.lessThanOrEqual(await fx.vault.totalDividendsReceived());
  });

  // ══ DENOMINATOR 3: the N reward streams — the sharpest case ═════════════

  /**
   * THE REGRESSION TEST FOR THE ACTUAL BUG, in the place it actually existed.
   *
   * Before round 9e this failed: 100 units of a bribe pushed into a wrapper
   * with `totalSupply() == 0` were extractable IN A SINGLE TRANSACTION by any
   * address willing to `deposit` one wei of raw share and `withdraw` again,
   * for a measured 99.999999999999999999 of the 100 units. Zero capital, zero
   * duration, zero risk.
   */
  it("DENOM 3 (streams): a bribe pushed at zero wIDX supply CANNOT be flash-captured by the first depositor", async () => {
    const fx = await base();
    await mint(fx, fx.alice, E("1000"));
    await mint(fx, fx.bob, E("1000"));
    const t = await newToken();
    const ta = await listStream(fx, t);

    // Funded while the wrapper has NO holders at all.
    expect(await fx.wrapper.totalSupply()).to.equal(0n);
    await fundStream(fx, t, fx.carol, E("100"));

    // Carried: physically held, but NOT counted as backing, so there is
    // nothing for an arriving depositor's shares to be a claim on.
    expect(await fx.wrapper.carry(ta)).to.equal(E("100"));
    expect(await t.balanceOf(fx.wrapperAddr)).to.equal(E("100"));
    expect(await fx.wrapper.streamHeld(ta)).to.equal(0n);
    expect(await fx.wrapper.carryUnlockBlock()).to.equal(MAXU);

    // THE ATTACK, in its strongest form: a contract that wraps and unwraps
    // inside ONE transaction. Nothing can be interleaved, no other holder can
    // join, and before round 9e this returned 99.999999999999999999 of the
    // 100 units for one wei of net cost.
    const A = await ethers.getContractFactory("MockFlashWrapAttacker");
    const atk: any = await A.deploy();
    const atkAddr = await atk.getAddress();
    await fx.vault.connect(fx.bob).approve(atkAddr, ethers.MaxUint256);
    const rawBefore: bigint = await fx.vault.balanceOf(fx.bob.address);

    await expect(atk.connect(fx.bob).attack(fx.wrapperAddr, fx.vaultAddr, E("500"))).to.not.be
      .reverted;

    // The bribe did not move. Not to the attacker, not to its caller.
    expect(await t.balanceOf(atkAddr)).to.equal(0n, "the bribe was flash-captured");
    expect(await t.balanceOf(fx.bob.address)).to.equal(0n);
    // ...and nothing was TRAPPED either: the raw shares came straight back out
    // to the attacker, minus at most the ordinary rounding dust.
    expect(await fx.vault.balanceOf(atkAddr)).to.be.greaterThanOrEqual(E("500") - 10n);
    expect(await fx.vault.balanceOf(fx.bob.address)).to.equal(rawBefore - E("500"));
    // The pot is still there, still carried, still owed to nobody yet.
    expect(await t.balanceOf(fx.wrapperAddr)).to.equal(E("100"));
    expect(await fx.wrapper.carry(ta)).to.equal(E("100"));
    expect(await fx.wrapper.totalSupply()).to.equal(0n);
  });

  it("DENOM 3 (streams): the carried pot rejoins backing pro rata to EVERYONE present, not to whoever arrived first", async () => {
    const fx = await base();
    await mint(fx, fx.alice, E("1000"));
    await mint(fx, fx.bob, E("1000"));
    const t = await newToken();
    const ta = await listStream(fx, t);
    await fundStream(fx, t, fx.carol, E("100"));

    // Alice is FIRST in. Bob joins in the very same block, before the release.
    await ethers.provider.send("evm_setAutomine", [false]);
    await fx.wrapper.connect(fx.alice).deposit(E("500"));
    await fx.wrapper.connect(fx.bob).deposit(E("500"));
    await mine();
    await ethers.provider.send("evm_setAutomine", [true]);

    // Still carried in the arming block.
    expect(await fx.wrapper.streamHeld(ta)).to.equal(0n);

    // One block later it is backing, and it is SHARED.
    await mine();
    const aW: bigint = await fx.wrapper.balanceOf(fx.alice.address);
    const bW: bigint = await fx.wrapper.balanceOf(fx.bob.address);
    await fx.wrapper.connect(fx.alice).withdraw(aW);
    await fx.wrapper.connect(fx.bob).withdraw(bW);

    const aGot: bigint = await t.balanceOf(fx.alice.address);
    const bGot: bigint = await t.balanceOf(fx.bob.address);
    expect(aGot).to.be.greaterThan(0n);
    expect(bGot).to.be.greaterThan(0n);
    // Alice, the first arrival, did NOT take it all. Bob's slice is within a
    // hair of hers — they staked the same, one block apart, inside the window.
    expect(aGot).to.be.lessThan((E("100") * 60n) / 100n);
    const diff = aGot > bGot ? aGot - bGot : bGot - aGot;
    expect(diff * 100n).to.be.lessThan(aGot); // <1% apart
    // Conservation: the pot went out, nothing was minted, dust stayed home.
    expect(aGot + bGot).to.be.lessThanOrEqual(E("100"));
    expect(aGot + bGot).to.be.greaterThan((E("100") * 99n) / 100n);
    expect(await fx.wrapper.carry(ta)).to.equal(0n);
    expect(await fx.wrapper.carryUnlockBlock()).to.equal(0n);
  });

  /**
   * THE DESIGN CHOICE, STATED AND PROVEN RATHER THAN FALLEN INTO.
   *
   * The carry makes capture require REAL CAPITAL HELD ACROSS A BLOCK. It does
   * NOT, and deliberately does not, guarantee company: if exactly one holder
   * wraps and nobody else joins before the release block, that holder does get
   * the whole carried pot. That is the correct outcome, not a residual bug —
   * eligibility is defined by capital at risk over time, which they supplied
   * and everyone else declined to, and the window is public and joinable. What
   * the carry removes is the FREE, RISKLESS, ORDERING-ONLY capture, which is
   * what the sister design's audit was actually about.
   */
  it("DESIGN CHOICE: a lone holder who actually carries the position across a block DOES receive the pot, and that is intended", async () => {
    const fx = await base();
    await mint(fx, fx.alice, E("1000"));
    const t = await newToken();
    const ta = await listStream(fx, t);
    await fundStream(fx, t, fx.carol, E("100"));

    await fx.wrapper.connect(fx.alice).deposit(E("500"));
    // Nobody else joins. One block of real exposure later:
    await mine();
    const w: bigint = await fx.wrapper.balanceOf(fx.alice.address);
    await fx.wrapper.connect(fx.alice).withdraw(w);
    expect(await t.balanceOf(fx.alice.address)).to.be.greaterThan((E("100") * 99n) / 100n);
    expect(await fx.wrapper.carry(ta)).to.equal(0n);
  });

  it("DENOM 3 (streams): the carry is INERT in the normal case — with any supply, a push is backing in the same transaction", async () => {
    const fx = await base();
    await mint(fx, fx.alice, E("1000"));
    const t = await newToken();
    const ta = await listStream(fx, t);
    await fx.wrapper.connect(fx.alice).deposit(E("500"));
    expect(await fx.wrapper.totalSupply()).to.be.greaterThan(0n);

    await fundStream(fx, t, fx.carol, E("40"));
    // No carry, no clock, and it is backing immediately — round-9d behaviour
    // is byte-for-byte unchanged whenever there is somebody to pay.
    expect(await fx.wrapper.carry(ta)).to.equal(0n);
    expect(await fx.wrapper.carryUnlockBlock()).to.equal(0n);
    expect(await fx.wrapper.streamHeld(ta)).to.equal(E("40"));
  });

  it("DENOM 3 (streams): N independent streams each carry independently, and all fold together", async () => {
    const fx = await base();
    await mint(fx, fx.alice, E("1000"));
    const toks = [];
    const addrs: string[] = [];
    for (let i = 0; i < 4; i++) {
      const t = await newToken(`B${i}`);
      addrs.push(await listStream(fx, t));
      toks.push(t);
    }
    // Fund every one of them while the denominator is zero.
    for (let i = 0; i < 4; i++) await fundStream(fx, toks[i], fx.carol, E(String(10 * (i + 1))));
    for (let i = 0; i < 4; i++) {
      expect(await fx.wrapper.carry(addrs[i])).to.equal(E(String(10 * (i + 1))));
      expect(await fx.wrapper.streamHeld(addrs[i])).to.equal(0n);
    }

    await fx.wrapper.connect(fx.alice).deposit(E("500"));
    await mine();
    // One interaction folds every stream at once — one code path, not N.
    await fx.wrapper.connect(fx.alice).withdraw(E("1"));
    for (let i = 0; i < 4; i++) {
      expect(await fx.wrapper.carry(addrs[i])).to.equal(0n);
      expect(await fx.wrapper.streamHeld(addrs[i])).to.be.greaterThan(0n);
    }
  });

  it("DENOM 3 (streams): a second push into a STILL-empty wrapper re-locks rather than inheriting a stale unlock height", async () => {
    const fx = await base();
    await mint(fx, fx.alice, E("1000"));
    await mint(fx, fx.bob, E("1000"));
    const t = await newToken();
    const ta = await listStream(fx, t);

    await fundStream(fx, t, fx.carol, E("10"));
    // Arm the clock, then empty the wrapper again in the SAME block, before
    // the clock fires, so the carry is still outstanding with supply back at 0
    // and `_carryUnlockBlock` holding a now-past height.
    const A = await ethers.getContractFactory("MockFlashWrapAttacker");
    const atk: any = await A.deploy();
    const atkAddr = await atk.getAddress();
    await fx.vault.connect(fx.alice).approve(atkAddr, ethers.MaxUint256);
    await atk.connect(fx.alice).attack(fx.wrapperAddr, fx.vaultAddr, E("100"));
    expect(await fx.wrapper.totalSupply()).to.equal(0n);
    expect(await fx.wrapper.carry(ta)).to.equal(E("10"));
    await mine(5); // the armed height is now firmly in the past

    // A fresh push while empty must RE-LOCK, or that stale height would make
    // the next depositor's flash-capture work again.
    await fundStream(fx, t, fx.carol, E("10"));
    expect(await fx.wrapper.carryUnlockBlock()).to.equal(MAXU);

    const atk2: any = await A.deploy();
    const atk2Addr = await atk2.getAddress();
    await fx.vault.connect(fx.bob).approve(atk2Addr, ethers.MaxUint256);
    await atk2.connect(fx.bob).attack(fx.wrapperAddr, fx.vaultAddr, E("100"));
    expect(await t.balanceOf(atk2Addr)).to.equal(0n, "stale clock allowed a re-capture");
    expect(await fx.wrapper.carry(ta)).to.equal(E("20"));
  });

  it("DENOM 3 (streams): a carried balance can NEVER be pruned off the iteration list and orphaned", async () => {
    const fx = await base();
    await mint(fx, fx.alice, E("1000"));
    const t = await newToken();
    const ta = await listStream(fx, t);
    await fundStream(fx, t, fx.carol, E("25"));
    await fx.wrapper.connect(fx.lister).delistStream(ta);

    // `_probeBalance` nets the carry out, so without the explicit guard this
    // token would probe as EMPTY and be prunable — after which `_foldCarry`
    // could never reach it and the 25 units would be trapped forever.
    expect(await fx.wrapper.streamHeld(ta)).to.equal(0n);
    await expect(fx.wrapper.pruneStream(ta)).to.be.revertedWithCustomError(
      fx.wrapper,
      "StreamNotEmpty"
    );

    // And it is still fully recoverable by holders once the carry folds.
    await fx.wrapper.connect(fx.alice).deposit(E("500"));
    await mine();
    const w: bigint = await fx.wrapper.balanceOf(fx.alice.address);
    await fx.wrapper.connect(fx.alice).withdraw(w);
    expect(await t.balanceOf(fx.alice.address)).to.be.greaterThan((E("25") * 99n) / 100n);
  });

  // ══ DENOMINATOR 2: the wrapper's own dividend-harvest leg ═══════════════

  it("DENOM 2 (wrapper harvest): a dividend harvested at zero wIDX supply is carried, not flash-captured", async () => {
    const fx = await base();
    await mint(fx, fx.alice, E("1000"));
    await mint(fx, fx.bob, E("1000"));

    // Give the WRAPPER a raw-share position directly, so it is a holder of
    // record at the vault — and therefore accrues a dividend under the vault's
    // per-holder accumulator — while its OWN wIDX supply is exactly zero. That
    // is the zero-denominator state for this leg.
    await fx.vault.connect(fx.alice).transfer(fx.wrapperAddr, E("500"));
    expect(await fx.wrapper.totalSupply()).to.equal(0n);
    await fx.vault.connect(fx.carol).receiveDividendsWrapped(E("50"));
    expect(await fx.vault.withdrawableDividendOf(fx.wrapperAddr)).to.be.greaterThan(0n);

    // The harvest lands, and is CARRIED rather than left lying in backing for
    // whoever wraps next.
    const divAddr = await fx.div.getAddress();
    await fx.wrapper.harvest();
    const carried: bigint = await fx.wrapper.carry(divAddr);
    expect(carried).to.be.greaterThan(0n);
    expect(await fx.wrapper.dividendAssetHeld()).to.equal(0n);
    expect(await fx.wrapper.carryUnlockBlock()).to.equal(MAXU);
    // Same entrypoint as every stream — one code path, not a second one.
    expect(divAddr.toLowerCase()).to.equal((await fx.wrapper.dividendAsset()).toLowerCase());

    // The atomic flash-capture gets none of it.
    const A = await ethers.getContractFactory("MockFlashWrapAttacker");
    const atk: any = await A.deploy();
    const atkAddr = await atk.getAddress();
    await fx.vault.connect(fx.bob).approve(atkAddr, ethers.MaxUint256);
    await atk.connect(fx.bob).attack(fx.wrapperAddr, fx.vaultAddr, E("500"));
    expect(await fx.div.balanceOf(atkAddr)).to.equal(0n, "the harvest was flash-captured");
    expect(await fx.wrapper.carry(divAddr)).to.equal(carried);

    // ...and it is not lost: a real holder, one block on, redeems it.
    await fx.wrapper.connect(fx.bob).deposit(E("500"));
    await mine();
    const bw: bigint = await fx.wrapper.balanceOf(fx.bob.address);
    const before: bigint = await fx.div.balanceOf(fx.bob.address);
    await fx.wrapper.connect(fx.bob).withdraw(bw);
    expect((await fx.div.balanceOf(fx.bob.address)) - before).to.be.greaterThan(0n);
    expect(await fx.wrapper.carry(divAddr)).to.equal(0n);
  });

  // ══ THE ANCHOR RULE, under every carry state ════════════════════════════

  it("CARRY NEVER TRAPS: withdraw succeeds and pays every uncarried leg while a carry is outstanding", async () => {
    const fx = await base();
    await mint(fx, fx.alice, E("1000"));
    const t = await newToken();
    const ta = await listStream(fx, t);
    await fundStream(fx, t, fx.carol, E("30"));

    await fx.wrapper.connect(fx.alice).deposit(E("400"));
    const w: bigint = await fx.wrapper.balanceOf(fx.alice.address);
    const rawBefore: bigint = await fx.vault.balanceOf(fx.alice.address);

    // Mid-carry — the clock is armed but has not fired.
    expect(await fx.wrapper.carry(ta)).to.equal(E("30"));
    await expect(fx.wrapper.connect(fx.alice).withdraw(w)).to.not.be.reverted;
    // The raw leg paid in full. The carried leg simply was not hers yet.
    expect(await fx.vault.balanceOf(fx.alice.address)).to.be.greaterThan(rawBefore);
    expect(await fx.wrapper.balanceOf(fx.alice.address)).to.equal(0n);
  });

  it("CARRY IS NOT A LEVER: no role can read, write, extend or release it", async () => {
    const fx = await base();
    const names = (fx.wrapper.interface.fragments as any[])
      .filter((f) => f.type === "function")
      .map((f) => f.name);
    // There is no setter, no releaser, no admin path of any kind.
    for (const n of names) {
      const lower = n.toLowerCase();
      if (lower.includes("carry")) {
        const frag = (fx.wrapper.interface.fragments as any[]).find(
          (f) => f.type === "function" && f.name === n
        );
        expect(frag.stateMutability, `${n} is not a view`).to.equal("view");
      }
    }
    // The listing role — the only role with any capability at all — has
    // gained nothing.
    expect(names.filter((n: string) => n.toLowerCase().includes("carry")).sort()).to.deep.equal([
      "carry",
      "carryUnlockBlock",
    ]);
  });
});
