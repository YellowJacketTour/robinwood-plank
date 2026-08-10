import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { time, takeSnapshot, mine, type SnapshotRestorer } from "./helpers/network-helpers.js";
import { deployOpenIndex, maxIn } from "./helpers/index-vault.js";

/**
 * ============================================================================
 * ROUND 9d — N-ASSET REWARD STREAMS ON THE WRAPPER
 *
 * `WrappedIndexShare` solved dividend-stranding for pooled index shares by
 * making value arrive as EXCHANGE-RATE APPRECIATION rather than as a
 * per-holder accrual an LP pool would never claim. Round 9d generalises that
 * from two backing assets to N, so an arbitrary third-party reward — a bribe,
 * an RWA airdrop, a partner incentive — reaches pooled holders the same way.
 *
 * This file is written to break it. The things that would each be a real bug:
 *
 *   1. A new stream NOT reaching a passive custodian, i.e. the whole point
 *      failing one level up.
 *   2. A hostile / broken / reverting stream token bricking ANYTHING: core
 *      wIDX withdrawals, `harvest`, `deposit`, or another healthy stream.
 *   3. An RWA transfer restriction on ONE asset trapping a user's raw shares
 *      and every other unrestricted asset — the unmovable-assets cardinal sin
 *      arrived at from a new direction.
 *   4. Delisting clawing back backing already promised to holders.
 *   5. Un-whitelisted or non-timelocked stream admission.
 *   6. Nominal-amount crediting on a fee-on-transfer stream push.
 *   7. Silent truncation instead of a clear revert at the stream cap.
 *   8. Total claims across every asset exceeding real backing, over a long
 *      randomised sequence.
 * ============================================================================
 */
describe("WrappedIndexShare — N-asset reward streams (round 9d)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const E = (n: string) => ethers.parseEther(n);
  const VIRTUAL_SHARES = 1000n;
  const DELAY = 48 * 3600;

  async function fixture() {
    const fx = await deployOpenIndex();
    const signers = await ethers.getSigners();
    const lister = signers[9];
    const stranger = signers[10];

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
      await fx.tokens[0].connect(who).approve(fx.vaultAddr, ethers.MaxUint256);
      await fx.tokens[0].connect(who).approve(wrapperAddr, ethers.MaxUint256);
      await fx.vault.connect(who).approve(wrapperAddr, ethers.MaxUint256);
    }
    return { ...fx, wrapper, wrapperAddr, lister, stranger, div: fx.tokens[0] };
  }

  const mint = (fx: any, who: any, shares: bigint) =>
    fx.vault.connect(who).mintProRata(shares, maxIn(3));

  const push = (fx: any, who: any, amount: bigint) =>
    fx.vault.connect(who).receiveDividendsWrapped(amount);

  /** Deploy a plain mintable ERC-20 to act as a bribe / reward stream. */
  async function newToken(name = "BRIBE") {
    const T = await ethers.getContractFactory("MockIndexToken");
    const t: any = await T.deploy(name, name);
    return t;
  }

  /** Walk a token all the way through the timelocked admission path. */
  async function listStream(fx: any, token: any) {
    const addr = await token.getAddress();
    await fx.wrapper.connect(fx.lister).queueStream(addr);
    await time.increase(DELAY + 1);
    await fx.wrapper.executeStream(addr); // permissionless after the eta
    return addr;
  }

  /** Fund a stream permissionlessly, as a briber would. */
  async function fundStream(fx: any, token: any, from: any, amount: bigint) {
    await token.mint(from.address, amount);
    await token.connect(from).approve(fx.wrapperAddr, amount);
    return fx.wrapper.connect(from).depositStream(await token.getAddress(), amount);
  }

  /** Everything an address could redeem right now, across EVERY backing leg. */
  async function claimOf(fx: any, who: string) {
    const bal = await fx.wrapper.balanceOf(who);
    const [tokens, amounts] = await fx.wrapper.previewWithdraw(bal);
    const out: Record<string, bigint> = {};
    for (let i = 0; i < tokens.length; i++) out[tokens[i].toLowerCase()] = amounts[i];
    return out;
  }

  // ══ 0. Admission: the ONLY administered surface ══════════════════════════

  it("exposes exactly one capability role, and it reaches no value path", async () => {
    const fx = await fixture();
    expect(await fx.wrapper.roleHolder(await fx.wrapper.ROLE_STREAM_LISTER())).to.equal(
      fx.lister.address
    );
    expect(await fx.wrapper.roleHolder(await fx.wrapper.ROLE_ADMIN())).to.equal(
      fx.roleAdmin.address
    );
    // No pause, no owner, no upgrade, no sweep, no rescue: there is no lever
    // over user assets, which is the property the whole wrapper rests on.
    const names = fx.wrapper.interface.fragments.map((f: any) => f.name);
    for (const banned of [
      "owner",
      "pause",
      "unpause",
      "setOwner",
      "upgradeTo",
      "sweep",
      "rescue",
      "recover",
      "skim",
      "setStreamBalance",
    ]) {
      expect(names).to.not.include(banned);
    }
    // Rejects a delay outside the vault's own bounds.
    const W = await ethers.getContractFactory("WrappedIndexShare");
    await expect(
      W.deploy(fx.vaultAddr, "w", "w", fx.roleAdmin.address, fx.lister.address, 3600)
    ).to.be.revertedWithCustomError(W, "BadTimelockDelay");
  });

  it("only the listing role can whitelist, and only after the full timelock", async () => {
    const fx = await fixture();
    const bribe = await newToken();
    const addr = await bribe.getAddress();

    // Every non-lister, including ROLE_ADMIN itself — the role-rotation key is
    // deliberately NOT a super-role over capabilities.
    for (const who of [fx.alice, fx.stranger, fx.roleAdmin]) {
      await expect(
        fx.wrapper.connect(who).queueStream(addr)
      ).to.be.revertedWithCustomError(fx.wrapper, "NotRoleHolder");
      await expect(
        fx.wrapper.connect(who).delistStream(addr)
      ).to.be.revertedWithCustomError(fx.wrapper, "NotRoleHolder");
    }

    // Nothing queued yet.
    await expect(fx.wrapper.executeStream(addr)).to.be.revertedWithCustomError(
      fx.wrapper,
      "NoStreamQueued"
    );

    await fx.wrapper.connect(fx.lister).queueStream(addr);
    const q = await fx.wrapper.queuedStreams(addr);
    expect(q.pending).to.equal(true);
    expect(q.eta).to.be.gte(BigInt(await time.latest()) + BigInt(DELAY) - 5n);

    // One second early is still early.
    await time.increaseTo(Number(q.eta) - 2);
    await expect(fx.wrapper.executeStream(addr)).to.be.revertedWithCustomError(
      fx.wrapper,
      "StreamTimelockNotElapsed"
    );

    // Queued is NOT listed: a push before execution is refused.
    await bribe.mint(fx.alice.address, E("10"));
    await bribe.connect(fx.alice).approve(fx.wrapperAddr, ethers.MaxUint256);
    await expect(
      fx.wrapper.connect(fx.alice).depositStream(addr, E("10"))
    ).to.be.revertedWithCustomError(fx.wrapper, "NotAStream");

    await time.increase(10);
    await fx.wrapper.executeStream(addr); // permissionless after the eta
    expect(await fx.wrapper.isStream(addr)).to.equal(true);
    expect(await fx.wrapper.streamCount()).to.equal(1n);

    // Now the push works, and it is permissionless.
    //
    // ROUND 9e: pushed with NO wrapped supply, the credit is held in the
    // zero-denominator `carry` instead of counting as backing — see
    // IndexZeroDenominatorCarry.test.ts. Assert BOTH halves here rather than
    // only the one this test originally saw: carried while empty, and backing
    // the instant there is somebody to divide it among.
    await fx.wrapper.connect(fx.alice).depositStream(addr, E("10"));
    expect(await fx.wrapper.totalSupply()).to.equal(0n);
    expect(await fx.wrapper.carry(addr)).to.equal(E("10"));
    expect(await fx.wrapper.streamHeld(addr)).to.equal(0n);

    await mint(fx, fx.alice, E("1000"));
    await fx.wrapper.connect(fx.alice).deposit(E("100"));
    await mine();
    await fx.wrapper.connect(fx.alice).withdraw(E("1")); // any interaction folds
    expect(await fx.wrapper.carry(addr)).to.equal(0n);

    // And a push with a live supply is backing in the very same call, exactly
    // as it always was.
    await bribe.mint(fx.alice.address, E("5"));
    await fx.wrapper.connect(fx.alice).depositStream(addr, E("5"));
    expect(await fx.wrapper.streamHeld(addr)).to.be.greaterThan(E("14"));
  });

  it("an un-whitelisted token can never be pushed, and cannot be listed twice or as a core leg", async () => {
    const fx = await fixture();
    const bribe = await newToken();
    const addr = await bribe.getAddress();

    await expect(
      fx.wrapper.connect(fx.alice).depositStream(addr, E("1"))
    ).to.be.revertedWithCustomError(fx.wrapper, "NotAStream");

    // The two core backing legs can never be double-counted as streams.
    for (const bad of [fx.vaultAddr, await fx.div.getAddress(), fx.wrapperAddr, ethers.ZeroAddress]) {
      await expect(
        fx.wrapper.connect(fx.lister).queueStream(bad)
      ).to.be.revertedWithCustomError(fx.wrapper, "InvalidStream");
    }
    // An EOA is not a token.
    await expect(
      fx.wrapper.connect(fx.lister).queueStream(fx.alice.address)
    ).to.be.revertedWithCustomError(fx.wrapper, "InvalidStream");

    await listStream(fx, bribe);
    await expect(
      fx.wrapper.connect(fx.lister).queueStream(addr)
    ).to.be.revertedWithCustomError(fx.wrapper, "StreamAlreadyListed");

    // Cancelling a queue is the lister's own undo, and grants nothing.
    const other = await newToken("B2");
    const oAddr = await other.getAddress();
    await fx.wrapper.connect(fx.lister).queueStream(oAddr);
    await expect(
      fx.wrapper.connect(fx.stranger).cancelStream(oAddr)
    ).to.be.revertedWithCustomError(fx.wrapper, "NotRoleHolder");
    await fx.wrapper.connect(fx.lister).cancelStream(oAddr);
    await time.increase(DELAY + 1);
    await expect(fx.wrapper.executeStream(oAddr)).to.be.revertedWithCustomError(
      fx.wrapper,
      "NoStreamQueued"
    );
  });

  // ══ 1. THE POINT: a new stream reaches a passive custodian ═══════════════

  it("a bribed-in stream reaches a passive third-party custodian (an LP pool) with zero action of its own", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("2000"));
    await fx.wrapper.connect(fx.alice).deposit(E("2000"));

    // The exact failure case: the wrapped share is handed to a dumb contract
    // that has never heard of any reward mechanism and never will.
    const pool = await fx.sources[1].getAddress();
    const all = await fx.wrapper.balanceOf(fx.alice.address);
    await fx.wrapper.connect(fx.alice).transfer(pool, all);

    const bribe = await newToken();
    const bAddr = await listStream(fx, bribe);

    const before = await claimOf(fx, pool);
    expect(before[bAddr.toLowerCase()] ?? 0n).to.equal(0n);

    // A total stranger bribes the index. No permission, no integration, and
    // the pool takes NO action whatsoever.
    await fundStream(fx, bribe, fx.stranger, E("500"));

    const after = await claimOf(fx, pool);
    expect(await fx.wrapper.balanceOf(pool)).to.equal(all); // balance unchanged
    expect(after[fx.vaultAddr.toLowerCase()]).to.equal(before[fx.vaultAddr.toLowerCase()]);
    // Value arrived anyway — as backing-pool appreciation, the ONLY channel a
    // passive custodian can receive on.
    expect(after[bAddr.toLowerCase()]).to.be.gt(0n);
    expect(after[bAddr.toLowerCase()]).to.be.gt((E("500") * 999n) / 1000n);

    // And it is really there: the pool's own operator can eventually redeem it.
    expect(await bribe.balanceOf(fx.wrapperAddr)).to.be.gte(after[bAddr.toLowerCase()]);
  });

  it("withdraw pays exact pro-rata across raw share, dividend AND every stream, in native units", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("3000"));
    await mint(fx, fx.bob, E("1000"));
    await mint(fx, fx.carol, E("1000"));

    const s1 = await newToken("S1");
    const s2 = await newToken("S2");
    const a1 = await listStream(fx, s1);
    const a2 = await listStream(fx, s2);

    await fx.wrapper.connect(fx.alice).deposit(E("3000"));
    await push(fx, fx.carol, E("200"));
    await fx.wrapper.connect(fx.carol).harvest();
    await fundStream(fx, s1, fx.stranger, E("77"));
    await fundStream(fx, s2, fx.stranger, E("13"));

    const supply = await fx.wrapper.totalSupply();
    const denom = supply + VIRTUAL_SHARES;
    const half = (await fx.wrapper.balanceOf(fx.alice.address)) / 2n;

    const exp1 = (half * (await fx.wrapper.streamHeld(a1))) / denom;
    const exp2 = (half * (await fx.wrapper.streamHeld(a2))) / denom;
    const expRaw = (half * (await fx.wrapper.rawSharesHeld())) / denom;
    const expDiv = (half * (await fx.wrapper.dividendAssetHeld())) / denom;

    const [ptoks, pamts] = await fx.wrapper.previewWithdraw(half);
    expect(ptoks.length).to.equal(4);
    expect(pamts[0]).to.equal(expRaw);
    expect(pamts[1]).to.equal(expDiv);

    const r0 = await fx.vault.balanceOf(fx.alice.address);
    const d0 = await fx.div.balanceOf(fx.alice.address);
    await fx.wrapper.connect(fx.alice).withdraw(half);

    expect((await fx.vault.balanceOf(fx.alice.address)) - r0).to.equal(expRaw);
    expect((await fx.div.balanceOf(fx.alice.address)) - d0).to.equal(expDiv);
    expect(await s1.balanceOf(fx.alice.address)).to.equal(exp1);
    expect(await s2.balanceOf(fx.alice.address)).to.equal(exp2);
    // Each redeemed in its OWN units — no conversion, no price, no oracle.
    expect(exp1).to.be.gt(0n);
    expect(exp2).to.be.gt(0n);
    expect(exp1).to.not.equal(exp2);
  });

  // ══ 2. Measured delta on the push ════════════════════════════════════════

  it("depositStream credits the MEASURED delta, not the nominal amount, on a fee-on-transfer stream", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("1000"));
    await fx.wrapper.connect(fx.alice).deposit(E("1000"));

    const fee = await newToken("FEE");
    const fAddr = await listStream(fx, fee);
    await fee.setFeeBps(1000); // burns 10% in flight

    await fee.mint(fx.stranger.address, E("100"));
    await fee.connect(fx.stranger).approve(fx.wrapperAddr, ethers.MaxUint256);
    const tx = await fx.wrapper.connect(fx.stranger).depositStream(fAddr, E("100"));
    const rc = await tx.wait();
    const ev = rc.logs
      .map((l: any) => {
        try {
          return fx.wrapper.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "StreamFunded");

    // Nominal was 100e18; only 90e18 arrived, and 90e18 is what was credited.
    expect(ev.args.credited).to.equal(E("90"));
    expect(ev.args.credited).to.not.equal(E("100"));
    expect(await fx.wrapper.streamHeld(fAddr)).to.equal(E("90"));

    // Backing is read live, so the claim can never exceed what landed.
    const c = await claimOf(fx, fx.alice.address);
    expect(c[fAddr.toLowerCase()]).to.be.lte(E("90"));

    await fee.setFeeBps(0);
    await expect(
      fx.wrapper.connect(fx.stranger).depositStream(fAddr, 0n)
    ).to.be.revertedWithCustomError(fx.wrapper, "ZeroAmount");

    // A push that reports success and delivers literally nothing is a clear
    // revert, not a no-op that emits a lie about credited backing.
    const H = await ethers.getContractFactory("MockHostileStream");
    const swallow: any = await H.deploy("SWAL", "SWAL");
    const sAddr = await listStream(fx, swallow);
    await swallow.mint(fx.stranger.address, E("100"));
    await swallow.connect(fx.stranger).approve(fx.wrapperAddr, ethers.MaxUint256);
    await swallow.setSwallowFrom(true);
    await expect(
      fx.wrapper.connect(fx.stranger).depositStream(sAddr, E("100"))
    ).to.be.revertedWithCustomError(fx.wrapper, "NothingCredited");
  });

  // ══ 3. THE RWA TRANSFER-RESTRICTION CASE ═════════════════════════════════

  it("a KYC-restricted RWA stream cannot trap a user's raw shares or any other asset", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("2000"));
    await mint(fx, fx.bob, E("2000"));
    await mint(fx, fx.carol, E("1000"));

    // Three streams: a healthy bribe, a restricted RWA, another healthy one.
    const good1 = await newToken("G1");
    const good2 = await newToken("G2");
    const R = await ethers.getContractFactory("MockRestrictedToken");
    const rwa: any = await R.deploy("RWA", "RWA");

    const g1 = await listStream(fx, good1);
    const rAddr = await listStream(fx, rwa);
    const g2 = await listStream(fx, good2);

    await fx.wrapper.connect(fx.alice).deposit(E("2000"));
    await push(fx, fx.carol, E("300"));
    await fx.wrapper.connect(fx.carol).harvest();

    await fundStream(fx, good1, fx.stranger, E("60"));
    await fundStream(fx, good2, fx.stranger, E("40"));
    await rwa.mint(fx.stranger.address, E("500"));
    await rwa.connect(fx.stranger).approve(fx.wrapperAddr, ethers.MaxUint256);
    await fx.wrapper.connect(fx.stranger).depositStream(rAddr, E("500"));

    // The issuer now revokes Alice's permission to hold the RWA. Nobody here
    // controls this and nobody here can appeal it.
    await rwa.setBlocked(fx.alice.address, true);

    const all = await fx.wrapper.balanceOf(fx.alice.address);
    const owed = await claimOf(fx, fx.alice.address);
    const expectedRwa = owed[rAddr.toLowerCase()];
    expect(expectedRwa).to.be.gt(0n);

    const rawBefore = await fx.vault.balanceOf(fx.alice.address);
    const divBefore = await fx.div.balanceOf(fx.alice.address);

    // THE TEST: the withdrawal must still succeed, and must still deliver
    // everything that is NOT restricted.
    await expect(fx.wrapper.connect(fx.alice).withdraw(all)).to.not.be.reverted;

    expect((await fx.vault.balanceOf(fx.alice.address)) - rawBefore).to.equal(
      owed[fx.vaultAddr.toLowerCase()]
    );
    expect((await fx.div.balanceOf(fx.alice.address)) - divBefore).to.equal(
      owed[(await fx.div.getAddress()).toLowerCase()]
    );
    expect(await good1.balanceOf(fx.alice.address)).to.equal(owed[g1.toLowerCase()]);
    expect(await good2.balanceOf(fx.alice.address)).to.equal(owed[g2.toLowerCase()]);
    expect(await good1.balanceOf(fx.alice.address)).to.be.gt(0n);

    // The restricted slice is NOT lost — credited, and reserved out of backing
    // so nobody else can redeem it out from under her.
    expect(await rwa.balanceOf(fx.alice.address)).to.equal(0n);
    expect(await fx.wrapper.pendingClaim(fx.alice.address, rAddr)).to.equal(expectedRwa);
    expect(await fx.wrapper.reserved(rAddr)).to.equal(expectedRwa);
    expect(await fx.wrapper.streamHeld(rAddr)).to.equal(E("500") - expectedRwa);

    // Retrying while still restricted fails loudly and changes nothing.
    await expect(fx.wrapper.connect(fx.alice).claimPending(rAddr)).to.be.reverted;
    expect(await fx.wrapper.pendingClaim(fx.alice.address, rAddr)).to.equal(expectedRwa);

    // The batch form is tolerant instead: it settles what it can and leaves
    // the rest credited.
    await fx.wrapper.connect(fx.alice).claimPendingMany([rAddr]);
    expect(await fx.wrapper.pendingClaim(fx.alice.address, rAddr)).to.equal(expectedRwa);
    expect(await fx.wrapper.reserved(rAddr)).to.equal(expectedRwa);

    // KYC clears. The credit was never touched by anyone and pays in full.
    await rwa.setBlocked(fx.alice.address, false);
    await fx.wrapper.connect(fx.alice).claimPending(rAddr);
    expect(await rwa.balanceOf(fx.alice.address)).to.equal(expectedRwa);
    expect(await fx.wrapper.pendingClaim(fx.alice.address, rAddr)).to.equal(0n);
    expect(await fx.wrapper.reserved(rAddr)).to.equal(0n);
    await expect(
      fx.wrapper.connect(fx.alice).claimPending(rAddr)
    ).to.be.revertedWithCustomError(fx.wrapper, "NothingToReturn");
  });

  it("a reserved slice is not redeemable a second time by the holders who stayed", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("1000"));
    await mint(fx, fx.bob, E("1000"));

    const R = await ethers.getContractFactory("MockRestrictedToken");
    const rwa: any = await R.deploy("RWA", "RWA");
    const rAddr = await listStream(fx, rwa);

    await fx.wrapper.connect(fx.alice).deposit(E("1000"));
    await fx.wrapper.connect(fx.bob).deposit(E("1000"));
    await rwa.mint(fx.stranger.address, E("400"));
    await rwa.connect(fx.stranger).approve(fx.wrapperAddr, ethers.MaxUint256);
    await fx.wrapper.connect(fx.stranger).depositStream(rAddr, E("400"));

    await rwa.setBlocked(fx.alice.address, true);
    const aliceOwed = (await claimOf(fx, fx.alice.address))[rAddr.toLowerCase()];
    await fx.wrapper.connect(fx.alice).withdraw(await fx.wrapper.balanceOf(fx.alice.address));

    // Bob is now essentially the whole supply. His claim must NOT include
    // Alice's reserved slice.
    const bobOwed = (await claimOf(fx, fx.bob.address))[rAddr.toLowerCase()];
    expect(bobOwed + aliceOwed).to.be.lte(await rwa.balanceOf(fx.wrapperAddr));

    await fx.wrapper.connect(fx.bob).withdraw(await fx.wrapper.balanceOf(fx.bob.address));
    // Whatever is left still covers Alice's credit in full.
    expect(await rwa.balanceOf(fx.wrapperAddr)).to.be.gte(
      await fx.wrapper.pendingClaim(fx.alice.address, rAddr)
    );
    await rwa.setBlocked(fx.alice.address, false);
    await expect(fx.wrapper.connect(fx.alice).claimPending(rAddr)).to.not.be.reverted;
    expect(await rwa.balanceOf(fx.alice.address)).to.equal(aliceOwed);
  });

  // ══ 4. PER-STREAM ISOLATION ══════════════════════════════════════════════

  it("a hostile stream cannot brick withdrawals of raw shares, the dividend, or another stream", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("2000"));
    await mint(fx, fx.bob, E("2500"));
    await mint(fx, fx.carol, E("1000"));

    const good = await newToken("GOOD");
    const H = await ethers.getContractFactory("MockHostileStream");
    const hostile: any = await H.deploy("EVIL", "EVIL");

    const gAddr = await listStream(fx, good);
    const hAddr = await listStream(fx, hostile);

    await fx.wrapper.connect(fx.alice).deposit(E("2000"));
    await fx.wrapper.connect(fx.bob).deposit(E("2000"));
    await push(fx, fx.carol, E("250"));
    await fx.wrapper.connect(fx.carol).harvest();
    await fundStream(fx, good, fx.stranger, E("90"));

    // It was a normal token when it was listed and funded. It turns hostile
    // afterwards, which is the realistic threat model.
    await hostile.mint(fx.stranger.address, E("200"));
    await hostile.connect(fx.stranger).approve(fx.wrapperAddr, ethers.MaxUint256);
    await fx.wrapper.connect(fx.stranger).depositStream(hAddr, E("200"));

    // Every hostile mode at once: reverting transfer, reverting balanceOf,
    // lying return value, and unbounded gas burn in both.
    await hostile.setModes(true, true, true, true);

    // (a) the core mechanism is untouched — deposit and harvest never read a
    //     stream at all.
    await push(fx, fx.carol, E("50"));
    await expect(fx.wrapper.connect(fx.stranger).harvest()).to.not.be.reverted;
    await expect(fx.wrapper.connect(fx.bob).deposit(E("1"))).to.not.be.reverted;

    // (b) pricing views do not revert; the broken stream reads as empty.
    expect(await fx.wrapper.streamHeld(hAddr)).to.equal(0n);
    const [, held] = await fx.wrapper.backingAssets();
    expect(held[0]).to.be.gt(0n);
    expect(held[1]).to.be.gt(0n);

    // (c) THE test: Alice still gets everything else out, in one call.
    const owed = await claimOf(fx, fx.alice.address);
    const rawBefore = await fx.vault.balanceOf(fx.alice.address);
    const divBefore = await fx.div.balanceOf(fx.alice.address);
    await expect(
      fx.wrapper.connect(fx.alice).withdraw(await fx.wrapper.balanceOf(fx.alice.address))
    ).to.not.be.reverted;

    expect((await fx.vault.balanceOf(fx.alice.address)) - rawBefore).to.equal(
      owed[fx.vaultAddr.toLowerCase()]
    );
    expect((await fx.div.balanceOf(fx.alice.address)) - divBefore).to.be.gt(0n);
    // Round 9f: Bob's `deposit` on line 537 displaced a slice of the GOOD
    // stream into a linear re-vest, so a stream leg — exactly like the
    // dividend leg the header already documents — quotes as a LOWER BOUND from
    // a view and pays at least that much one block later when the vest has
    // ticked. Assert both halves: never under-quoted, and the drift is one
    // block of a 300-block schedule, not a pricing error.
    const aliceGood = await good.balanceOf(fx.alice.address);
    expect(aliceGood).to.be.gte(owed[gAddr.toLowerCase()]);
    expect(aliceGood).to.be.lt((owed[gAddr.toLowerCase()] * 1001n) / 1000n);
    expect(aliceGood).to.be.gt(0n);

    // (d) and Bob, a completely different user, is equally unaffected.
    await expect(
      fx.wrapper.connect(fx.bob).withdraw(await fx.wrapper.balanceOf(fx.bob.address))
    ).to.not.be.reverted;
    expect(await good.balanceOf(fx.bob.address)).to.be.gt(0n);

    // (e) the stuck stream can be delisted and pruned, and everyone else's
    //     exits get cheaper. It probes as empty, so pruning orphans nothing.
    await fx.wrapper.connect(fx.lister).delistStream(hAddr);
    await fx.wrapper.connect(fx.stranger).pruneStream(hAddr);
    expect(await fx.wrapper.streamCount()).to.equal(1n);
  });

  it("a stream that merely LIES on transfer defers rather than silently vanishing the slice", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("1000"));
    const H = await ethers.getContractFactory("MockHostileStream");
    const liar: any = await H.deploy("LIAR", "LIAR");
    const lAddr = await listStream(fx, liar);

    await fx.wrapper.connect(fx.alice).deposit(E("1000"));
    await liar.mint(fx.stranger.address, E("100"));
    await liar.connect(fx.stranger).approve(fx.wrapperAddr, ethers.MaxUint256);
    await fx.wrapper.connect(fx.stranger).depositStream(lAddr, E("100"));

    const owed = (await claimOf(fx, fx.alice.address))[lAddr.toLowerCase()];
    expect(owed).to.be.gt(0n);
    await liar.setModes(false, false, true, false); // returns false, moves nothing

    await fx.wrapper.connect(fx.alice).withdraw(await fx.wrapper.balanceOf(fx.alice.address));
    // A `false` return is treated as failure, not success: the slice is
    // credited, never written off.
    expect(await liar.balanceOf(fx.alice.address)).to.equal(0n);
    expect(await fx.wrapper.pendingClaim(fx.alice.address, lAddr)).to.equal(owed);

    await liar.setModes(false, false, false, false);
    await fx.wrapper.connect(fx.alice).claimPending(lAddr);
    expect(await liar.balanceOf(fx.alice.address)).to.equal(owed);
  });

  // ══ 5. Delisting never claws back ════════════════════════════════════════

  it("delisting stops new pushes and NEVER claws back held backing", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("1000"));
    await mint(fx, fx.bob, E("1000"));

    const bribe = await newToken("BRIBE");
    const bAddr = await listStream(fx, bribe);
    await fx.wrapper.connect(fx.alice).deposit(E("1000"));
    await fx.wrapper.connect(fx.bob).deposit(E("1000"));
    await fundStream(fx, bribe, fx.stranger, E("300"));

    const beforeAlice = (await claimOf(fx, fx.alice.address))[bAddr.toLowerCase()];
    const beforeBob = (await claimOf(fx, fx.bob.address))[bAddr.toLowerCase()];
    expect(beforeAlice).to.be.gt(0n);

    await fx.wrapper.connect(fx.lister).delistStream(bAddr);
    expect(await fx.wrapper.isStream(bAddr)).to.equal(false);

    // NOT ONE WEI moved. Backing, and every holder's claim, are identical.
    expect(await fx.wrapper.streamHeld(bAddr)).to.equal(E("300"));
    expect((await claimOf(fx, fx.alice.address))[bAddr.toLowerCase()]).to.equal(beforeAlice);
    expect((await claimOf(fx, fx.bob.address))[bAddr.toLowerCase()]).to.equal(beforeBob);

    // The stream is still enumerated, flagged as no longer accepting.
    const [tokens, held, accepting] = await fx.wrapper.streams();
    expect(tokens[0]).to.equal(bAddr);
    expect(held[0]).to.equal(E("300"));
    expect(accepting[0]).to.equal(false);

    // Only NEW pushes are closed.
    await bribe.mint(fx.stranger.address, E("10"));
    await bribe.connect(fx.stranger).approve(fx.wrapperAddr, ethers.MaxUint256);
    await expect(
      fx.wrapper.connect(fx.stranger).depositStream(bAddr, E("10"))
    ).to.be.revertedWithCustomError(fx.wrapper, "NotAStream");
    await expect(
      fx.wrapper.connect(fx.lister).delistStream(bAddr)
    ).to.be.revertedWithCustomError(fx.wrapper, "NotAStream");

    // And it is still fully withdrawable, forever, by everyone.
    await fx.wrapper.connect(fx.alice).withdraw(await fx.wrapper.balanceOf(fx.alice.address));
    expect(await bribe.balanceOf(fx.alice.address)).to.equal(beforeAlice);
    await fx.wrapper.connect(fx.bob).withdraw(await fx.wrapper.balanceOf(fx.bob.address));
    expect(await bribe.balanceOf(fx.bob.address)).to.be.gt(0n);

    // A non-empty delisted stream cannot be pruned away either.
    const dust = await fx.wrapper.streamHeld(bAddr);
    if (dust > 0n) {
      await expect(fx.wrapper.pruneStream(bAddr)).to.be.revertedWithCustomError(
        fx.wrapper,
        "StreamNotEmpty"
      );
    }
    // A still-listed stream cannot be pruned at all.
    const other = await newToken("O");
    const oAddr = await listStream(fx, other);
    await expect(fx.wrapper.pruneStream(oAddr)).to.be.revertedWithCustomError(
      fx.wrapper,
      "StreamStillListed"
    );
    await expect(fx.wrapper.pruneStream(fx.vaultAddr)).to.be.revertedWithCustomError(
      fx.wrapper,
      "NotAStream"
    );
  });

  // ══ 6. The cap is enforced, loudly ═══════════════════════════════════════

  it("enforces MAX_STREAMS with a clear revert, never silent truncation, and a prune frees a slot", async () => {
    const fx = await fixture();
    const cap = Number(await fx.wrapper.MAX_STREAMS());
    expect(cap).to.equal(32); // same as GlobalIndexVault.MAX_CONSTITUENTS

    const toks: any[] = [];
    for (let i = 0; i < cap; i++) {
      const t = await newToken(`S${i}`);
      toks.push(t);
      await fx.wrapper.connect(fx.lister).queueStream(await t.getAddress());
    }
    await time.increase(DELAY + 1);
    for (const t of toks) await fx.wrapper.executeStream(await t.getAddress());
    expect(await fx.wrapper.streamCount()).to.equal(BigInt(cap));

    // Queuing past the cap reverts AT QUEUE TIME...
    const extra = await newToken("EXTRA");
    const xAddr = await extra.getAddress();
    await expect(
      fx.wrapper.connect(fx.lister).queueStream(xAddr)
    ).to.be.revertedWithCustomError(fx.wrapper, "StreamCapReached");

    // ...and a queue made while a slot was free cannot sneak past it either,
    // because execution re-validates from scratch.
    const last = toks[cap - 1];
    await fx.wrapper.connect(fx.lister).delistStream(await last.getAddress());
    await fx.wrapper.pruneStream(await last.getAddress());
    expect(await fx.wrapper.streamCount()).to.equal(BigInt(cap - 1));

    await fx.wrapper.connect(fx.lister).queueStream(xAddr);
    const readd = await newToken("READD");
    await fx.wrapper.connect(fx.lister).queueStream(await readd.getAddress());
    await time.increase(DELAY + 1);
    await fx.wrapper.executeStream(xAddr); // fills the freed slot
    expect(await fx.wrapper.streamCount()).to.equal(BigInt(cap));
    await expect(
      fx.wrapper.executeStream(await readd.getAddress())
    ).to.be.revertedWithCustomError(fx.wrapper, "StreamCapReached");

    // A full-cap withdrawal still works and still pays every leg — the whole
    // reason the bound exists.
    await mint(fx, fx.alice, E("1000"));
    await fx.wrapper.connect(fx.alice).deposit(E("1000"));
    for (let i = 0; i < 5; i++) await fundStream(fx, toks[i], fx.stranger, E("10"));
    const tx = await fx.wrapper
      .connect(fx.alice)
      .withdraw(await fx.wrapper.balanceOf(fx.alice.address));
    const rc = await tx.wait();
    expect(rc.gasUsed).to.be.lt(3_000_000n); // comfortably inside a block
    for (let i = 0; i < 5; i++) {
      expect(await toks[i].balanceOf(fx.alice.address)).to.be.gt(0n);
    }
  });

  // ══ 7. Discovery view ════════════════════════════════════════════════════

  it("stream discovery enumerates every stream and its held balance for a UI", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("1000"));
    await fx.wrapper.connect(fx.alice).deposit(E("1000"));

    const a = await newToken("A");
    const b = await newToken("B");
    const aA = await listStream(fx, a);
    const bA = await listStream(fx, b);
    await fundStream(fx, a, fx.stranger, E("11"));

    const [tokens, held, accepting] = await fx.wrapper.streams();
    expect(tokens).to.deep.equal([aA, bA]);
    expect(held[0]).to.equal(E("11"));
    expect(held[1]).to.equal(0n); // listed but unfunded, discoverable anyway
    expect(accepting[0]).to.equal(true);
    expect(accepting[1]).to.equal(true);

    const [bt, bh] = await fx.wrapper.backingAssets();
    expect(bt[0]).to.equal(fx.vaultAddr);
    expect(bt[1]).to.equal(await fx.div.getAddress());
    expect(bt.slice(2)).to.deep.equal([aA, bA]);
    expect(bh[0]).to.be.gt(0n);
    expect(bh[3]).to.equal(0n);

    // An untracked token reads as zero rather than reverting.
    expect(await fx.wrapper.streamHeld(await (await newToken("Z")).getAddress())).to.equal(0n);
  });

  // ══ 8. Randomised conservation across every asset ════════════════════════

  for (const seed of [3, 99, 424242]) {
    it(`claims across every asset never exceed real backing over 70 random ops (seed ${seed})`, async () => {
      const fx = await fixture();
      const actors = [fx.alice, fx.bob, fx.carol];
      for (const a of actors) await mint(fx, a, E("5000"));

      // A pool of candidate streams: plain, fee-on-transfer, restricted and
      // hostile, so the invariant is tested against the whole zoo.
      const H = await ethers.getContractFactory("MockHostileStream");
      const R = await ethers.getContractFactory("MockRestrictedToken");
      const candidates: any[] = [
        await newToken("P1"),
        await newToken("P2"),
        await newToken("P3"),
        await R.deploy("RW", "RW"),
        await H.deploy("HX", "HX"),
      ];
      const cAddrs: string[] = [];
      for (const c of candidates) cAddrs.push(await c.getAddress());
      for (const c of candidates) {
        await c.mint(fx.stranger.address, E("100000"));
        await c.connect(fx.stranger).approve(fx.wrapperAddr, ethers.MaxUint256);
      }

      let s = BigInt(seed);
      const rnd = (n: number) => {
        s = (s * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
        return Number((s >> 16n) % BigInt(n));
      };

      for (let i = 0; i < 70; i++) {
        const who = actors[rnd(3)];
        const op = rnd(8);
        const ci = rnd(candidates.length);
        try {
          if (op === 0) {
            await fx.wrapper.connect(who).deposit(E(String(1 + rnd(400))));
          } else if (op === 1) {
            const bal = await fx.wrapper.balanceOf(who.address);
            if (bal > 0n) await fx.wrapper.connect(who).withdraw(bal / BigInt(1 + rnd(3)));
          } else if (op === 2) {
            await fx.wrapper.connect(who).harvest();
          } else if (op === 3) {
            await push(fx, who, E(String(1 + rnd(50))));
          } else if (op === 4) {
            // Queue + (later) execute a listing. Time moves forward anyway
            // through the loop, so some of these land and some do not.
            await fx.wrapper.connect(fx.lister).queueStream(cAddrs[ci]);
          } else if (op === 5) {
            await time.increase(DELAY + 1);
            await fx.wrapper.connect(fx.stranger).executeStream(cAddrs[ci]);
          } else if (op === 6) {
            await fx.wrapper
              .connect(fx.stranger)
              .depositStream(cAddrs[ci], E(String(1 + rnd(200))));
          } else {
            // Chaos: delist, block a holder, or turn a stream hostile.
            const pick = rnd(3);
            if (pick === 0) await fx.wrapper.connect(fx.lister).delistStream(cAddrs[ci]);
            else if (pick === 1)
              await candidates[3].setBlocked(actors[rnd(3)].address, rnd(2) === 0);
            else await candidates[4].setModes(rnd(2) === 0, rnd(2) === 0, false, false);
          }
        } catch {
          /* a reverted op is a no-op; the invariant must still hold */
        }

        // THE invariant, per asset: everything everyone could take out, plus
        // everything already reserved for a bounced payout, is really there.
        const [tokens, backing] = await fx.wrapper.backingAssets();
        for (let t = 0; t < tokens.length; t++) {
          let sum = 0n;
          for (const a of actors) {
            const bal = await fx.wrapper.balanceOf(a.address);
            const [, amts] = await fx.wrapper.previewWithdraw(bal);
            sum += amts[t];
          }
          expect(sum).to.be.lte(backing[t]);
        }
        // And reservations are always fully covered by a real balance, so a
        // pending credit can never be a promise the contract cannot keep.
        for (const t of tokens) {
          const res = await fx.wrapper.reserved(t);
          if (res > 0n) {
            const tok = await ethers.getContractAt("MockIndexToken", t);
            let real = 0n;
            try {
              real = await tok.balanceOf(fx.wrapperAddr);
            } catch {
              continue; // a hostile balanceOf; nothing to compare against
            }
            expect(real).to.be.gte(res);
          }
        }
      }
    });
  }

  it("actually drove listing, funding, deferral and retry to non-trivial state", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("1000"));
    const R = await ethers.getContractFactory("MockRestrictedToken");
    const rwa: any = await R.deploy("RWA", "RWA");
    const rAddr = await listStream(fx, rwa);
    const good = await newToken("G");
    const gAddr = await listStream(fx, good);

    await fx.wrapper.connect(fx.alice).deposit(E("1000"));
    await fundStream(fx, good, fx.stranger, E("50"));
    await rwa.mint(fx.stranger.address, E("50"));
    await rwa.connect(fx.stranger).approve(fx.wrapperAddr, ethers.MaxUint256);
    await fx.wrapper.connect(fx.stranger).depositStream(rAddr, E("50"));

    expect(await fx.wrapper.streamCount()).to.equal(2n);
    expect(await fx.wrapper.streamHeld(gAddr)).to.be.gt(0n);
    await rwa.setBlocked(fx.alice.address, true);
    await fx.wrapper.connect(fx.alice).withdraw(await fx.wrapper.balanceOf(fx.alice.address));
    expect(await fx.wrapper.pendingClaim(fx.alice.address, rAddr)).to.be.gt(0n);
    await rwa.setBlocked(fx.alice.address, false);
    const settled = await fx.wrapper
      .connect(fx.alice)
      .claimPendingMany.staticCall([rAddr, rAddr]);
    expect(settled).to.equal(1n); // duplicates are harmless
    await fx.wrapper.connect(fx.alice).claimPendingMany([rAddr]);
    expect(await fx.wrapper.pendingClaim(fx.alice.address, rAddr)).to.equal(0n);
    expect(await fx.wrapper.totalSupply()).to.equal(0n);
  });
});
