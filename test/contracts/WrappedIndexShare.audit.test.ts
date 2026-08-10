import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { takeSnapshot, type SnapshotRestorer } from "./helpers/network-helpers.js";
import { deployOpenIndex, maxIn } from "./helpers/index-vault.js";

/**
 * ============================================================================
 * ROUND 9c — THE OPT-IN COMPOSABILITY WRAPPER (wIDX)
 *
 * GlobalIndexVault's dividend accumulator is computed live off `balanceOf`,
 * which is exactly right for a wallet holder and exactly wrong for a share
 * sitting inside an LP pool or a lending market: the CUSTODIAN becomes the
 * holder of record, accrues the dividend, and never calls `claimDividend()`.
 *
 * `WrappedIndexShare` is the wstETH-shaped answer — a fixed-balance token
 * whose exchange rate appreciates — and this file is written to BREAK it.
 *
 * The things that would each be a real bug, each with a test built so that a
 * broken implementation produces a visibly wrong number, not a rounding
 * difference:
 *
 *   1. First-depositor inflation. A griefer donating either backing asset
 *      into an empty wrapper must not be able to steal from the next
 *      depositor.
 *   2. A late depositor retroactively capturing yield that predates them —
 *      the Alice-vs-Bob disjoint-accrual proof, same shape as the vault's own
 *      dividend suite.
 *   3. The exchange rate NOT appreciating on harvest, which would mean a
 *      passive LP pool gains nothing and the whole contract is pointless.
 *   4. A round trip through deposit+withdraw being PROFITABLE, which would be
 *      a risk-free drain of everyone who stayed.
 *   5. Crediting nominal instead of measured amounts on the pull, the
 *      Balancer-STA class of bug this codebase tests for everywhere else.
 *   6. Claims exceeding backing, over a long randomised op sequence.
 * ============================================================================
 */
describe("WrappedIndexShare — opt-in composability wrapper (wIDX)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const E = (n: string) => ethers.parseEther(n);
  const VIRTUAL_SHARES = 1000n;

  async function fixture() {
    const fx = await deployOpenIndex();
    const W = await ethers.getContractFactory("WrappedIndexShare");
    // ROUND 9d MECHANICAL UPDATE: the wrapper gained the stream-admission
    // role pair and its timelock. Nothing about the two core backing legs
    // these tests exercise changed — no assertion below was touched.
    const lister = (await ethers.getSigners())[9];
    const wrapper: any = await W.deploy(
      fx.vaultAddr,
      "Wrapped Global Index",
      "wIDX",
      fx.roleAdmin.address,
      lister.address,
      48 * 3600
    );
    const wrapperAddr = await wrapper.getAddress();

    for (const who of [fx.alice, fx.bob, fx.carol]) {
      // dividend pushes go to the vault; wrapping goes to the wrapper
      await fx.tokens[0].connect(who).approve(fx.vaultAddr, ethers.MaxUint256);
      await fx.tokens[0].connect(who).approve(wrapperAddr, ethers.MaxUint256);
      await fx.vault.connect(who).approve(wrapperAddr, ethers.MaxUint256);
    }
    return { ...fx, wrapper, wrapperAddr, lister, div: fx.tokens[0] };
  }

  const mint = (fx: any, who: any, shares: bigint) =>
    fx.vault.connect(who).mintProRata(shares, maxIn(3));

  const push = (fx: any, who: any, amount: bigint) =>
    fx.vault.connect(who).receiveDividendsWrapped(amount);

  /** Everything a wrapped balance would redeem for right now, both legs. */
  async function claimOf(fx: any, who: string) {
    const supply = await fx.wrapper.totalSupply();
    if (supply === 0n) return { raw: 0n, div: 0n };
    const bal = await fx.wrapper.balanceOf(who);
    const denom = supply + VIRTUAL_SHARES;
    return {
      raw: (bal * (await fx.wrapper.rawSharesHeld())) / denom,
      div: (bal * (await fx.wrapper.dividendAssetHeld())) / denom,
    };
  }

  // ══ 0. Wiring — the names came from the vault, not from a guess ══════════

  it("reads its dividend denomination from the vault's own getter", async () => {
    const fx = await fixture();
    expect(await fx.wrapper.dividendAsset()).to.equal(await fx.div.getAddress());
    expect(await fx.wrapper.indexShare()).to.equal(fx.vaultAddr);
    // No admin surface of any kind exists to be abused.
    for (const fn of ["owner", "pause", "setOwner", "upgradeTo"]) {
      expect(fx.wrapper.interface.fragments.some((f: any) => f.name === fn)).to.equal(false);
    }
  });

  it("refuses to exist against a vault with dividends switched off", async () => {
    const fx = await deployOpenIndex();
    const Vault = await (await import("./helpers/index-vault")).indexVaultFactory();
    // A second vault, identical but with dividendAsset == address(0).
    const inert: any = await Vault.deploy(
      "inert",
      "inert",
      [fx.roleAdmin.address, fx.admission.address, fx.risk.address, fx.allocation.address],
      fx.seeder.address,
      48 * 3600,
      (await import("./helpers/index-vault")).paramsTuple(
        (await import("./helpers/index-vault")).defaultParams
      ),
      ethers.ZeroAddress
    );
    const W = await ethers.getContractFactory("WrappedIndexShare");
    await expect(
      W.deploy(
        await inert.getAddress(),
        "w",
        "w",
        fx.roleAdmin.address,
        fx.risk.address,
        48 * 3600
      )
    ).to.be.revertedWithCustomError(W, "NoDividendAsset");
  });

  // ══ 1. First-depositor inflation ═════════════════════════════════════════

  it("a griefer donating BOTH backing assets into an empty wrapper cannot rob the next depositor", async () => {
    const fx = await fixture();
    await mint(fx, fx.carol, E("2000"));
    await mint(fx, fx.alice, E("1000"));

    // Classic setup: attacker opens the wrapper with dust, then donates a
    // large amount of BOTH backing assets directly, trying to inflate the
    // per-share price so the victim's mint rounds to zero (or near it).
    await fx.wrapper.connect(fx.carol).deposit(1n);
    await fx.vault.connect(fx.carol).transfer(fx.wrapperAddr, E("1000"));
    await fx.div.connect(fx.carol).transfer(fx.wrapperAddr, E("500"));

    const victimIn = E("1000");
    await fx.wrapper.connect(fx.alice).deposit(victimIn);
    const minted = await fx.wrapper.balanceOf(fx.alice.address);
    expect(minted).to.be.gt(0n); // did NOT round to zero

    const before = await fx.vault.balanceOf(fx.alice.address);
    await fx.wrapper.connect(fx.alice).withdraw(minted);
    const rawBack = (await fx.vault.balanceOf(fx.alice.address)) - before;

    // The victim gets essentially all of their raw shares back — the donation
    // was a gift to the pool, never a lever on the victim's mint price. Slack
    // is bounded far below any exploitable amount.
    expect(rawBack).to.be.gt((victimIn * 999n) / 1000n);
    // And the attacker cannot have profited: their dust share cannot claim
    // the victim's principal.
    const attacker = await claimOf(fx, fx.carol.address);
    expect(attacker.raw).to.be.lt(E("1001"));
  });

  it("an empty-wrapper dividend-asset donation is a gift, not a price lever", async () => {
    const fx = await fixture();
    await mint(fx, fx.carol, E("500"));
    await mint(fx, fx.alice, E("1000"));

    await fx.div.connect(fx.carol).transfer(fx.wrapperAddr, E("777"));
    // supply == 0, so no proportional side is demanded; the opener gets it.
    expect(await fx.wrapper.quoteDividendAssetIn(E("100"))).to.equal(0n);

    await fx.wrapper.connect(fx.alice).deposit(E("1000"));
    const c = await claimOf(fx, fx.alice.address);
    expect(c.div).to.be.gt(E("776"));
  });

  it("opens at the virtual-offset ratio and the SECOND depositor is priced fairly", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("1000"));
    await mint(fx, fx.bob, E("1000"));

    await fx.wrapper.connect(fx.alice).deposit(E("1000"));
    // VIRTUAL_SHARES : VIRTUAL_ASSETS == 1000 : 1 — documented, not accidental.
    expect(await fx.wrapper.balanceOf(fx.alice.address)).to.equal(E("1000") * 1000n);

    // The whole point of the offset: the second depositor's mint is
    // proportional and cannot be rounded away by whatever the first did.
    await fx.wrapper.connect(fx.bob).deposit(E("1000"));
    const a = await claimOf(fx, fx.alice.address);
    const b = await claimOf(fx, fx.bob.address);
    expect(b.raw).to.be.gt((a.raw * 999n) / 1000n);
    expect(b.raw).to.be.lte(a.raw);
  });

  // ══ 2/3. Harvest appreciates the rate, for everyone, retroactively-free ══

  it("harvest() turns real vault dividends into exchange-rate appreciation", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("1000"));
    await fx.wrapper.connect(fx.alice).deposit(E("1000"));

    const [, divRate0] = await fx.wrapper.exchangeRate();
    expect(divRate0).to.equal(0n);

    // The wrapper is now a direct raw-share holder, so it accrues with no
    // special support whatsoever.
    await mint(fx, fx.carol, E("1000"));
    await push(fx, fx.carol, E("100"));
    expect(await fx.wrapper.pendingDividend()).to.be.gt(0n);
    expect(await fx.wrapper.dividendAssetHeld()).to.equal(0n);

    // ANYONE may trigger it — here a party with no position at all.
    await fx.wrapper.connect(fx.bob).harvest();
    const held = await fx.wrapper.dividendAssetHeld();
    expect(held).to.be.gt(0n);
    const [, divRate1] = await fx.wrapper.exchangeRate();
    expect(divRate1).to.be.gt(divRate0);
    expect(await fx.wrapper.pendingDividend()).to.equal(0n);
  });

  it("a passive third-party custodian (an LP pool) gains with zero action of its own", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("2000"));
    await fx.wrapper.connect(fx.alice).deposit(E("2000"));

    // Simulate the exact failure case: the wrapped share is handed to a dumb
    // contract that has never heard of any dividend mechanism.
    const pool = await fx.sources[1].getAddress();
    const all = await fx.wrapper.balanceOf(fx.alice.address);
    await fx.wrapper.connect(fx.alice).transfer(pool, all);

    const before = await claimOf(fx, pool);
    expect(before.div).to.equal(0n);

    await mint(fx, fx.carol, E("1000"));
    await push(fx, fx.carol, E("250"));
    await fx.wrapper.connect(fx.bob).harvest(); // a stranger's public good

    const after = await claimOf(fx, pool);
    expect(await fx.wrapper.balanceOf(pool)).to.equal(all); // balance unchanged
    expect(after.raw).to.equal(before.raw); // raw leg unchanged
    expect(after.div).to.be.gt(0n); // value arrived anyway
  });

  it("Alice vs Bob: a post-harvest depositor does NOT capture yield that predates them", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("1000"));
    await mint(fx, fx.bob, E("1000"));
    await mint(fx, fx.carol, E("1000"));

    await fx.wrapper.connect(fx.alice).deposit(E("1000"));
    await push(fx, fx.carol, E("300"));
    await fx.wrapper.connect(fx.bob).harvest();

    const aliceDiv = (await claimOf(fx, fx.alice.address)).div;
    expect(aliceDiv).to.be.gt(0n);

    // Bob now joins. The proportional join makes him PAY the dividend side he
    // is buying a claim on, so he cannot reach back for Alice's accrual.
    const owed = await fx.wrapper.quoteDividendAssetIn(E("1000"));
    expect(owed).to.be.gt(0n);
    const bobDivBefore = await fx.div.balanceOf(fx.bob.address);
    await fx.wrapper.connect(fx.bob).deposit(E("1000"));
    const bobPaid = bobDivBefore - (await fx.div.balanceOf(fx.bob.address));
    expect(bobPaid).to.be.gte(owed);

    const aliceAfter = (await claimOf(fx, fx.alice.address)).div;
    const bobAfter = (await claimOf(fx, fx.bob.address)).div;

    // Alice's earned dividend was not diluted by Bob's arrival...
    expect(aliceAfter).to.be.gte((aliceDiv * 9999n) / 10000n);
    // ...and Bob's dividend claim is only what he himself paid in, never a
    // slice of the distribution that happened before he existed.
    expect(bobAfter).to.be.lte(bobPaid);
  });

  it("deposit → dividend → harvest → withdraw returns MORE value than went in", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("1000"));
    await mint(fx, fx.carol, E("1000"));

    const rawIn = E("1000");
    const rawBefore = await fx.vault.balanceOf(fx.alice.address);
    const divBefore = await fx.div.balanceOf(fx.alice.address);
    await fx.wrapper.connect(fx.alice).deposit(rawIn);

    await push(fx, fx.carol, E("400"));
    await fx.wrapper.connect(fx.carol).harvest();

    await fx.wrapper.connect(fx.alice).withdraw(await fx.wrapper.balanceOf(fx.alice.address));

    const rawDelta = (await fx.vault.balanceOf(fx.alice.address)) - rawBefore;
    const divDelta = (await fx.div.balanceOf(fx.alice.address)) - divBefore;

    // Raw side comes back essentially whole (dust to the pool, never to her)...
    expect(rawDelta).to.be.lte(0n);
    expect(rawDelta).to.be.gt(-3n);
    // ...and the dividend side is pure gain she took no action to earn.
    expect(divDelta).to.be.gt(0n);
  });

  // ══ 4. Round trips are never profitable ═════════════════════════════════

  it("a bare deposit→withdraw round trip is strictly non-profitable in BOTH assets", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("5000"));
    await mint(fx, fx.bob, E("2000"));

    await fx.wrapper.connect(fx.alice).deposit(E("3000"));
    await push(fx, fx.bob, E("120"));
    await fx.wrapper.connect(fx.bob).harvest();

    const rawB = await fx.vault.balanceOf(fx.bob.address);
    const divB = await fx.div.balanceOf(fx.bob.address);
    await fx.wrapper.connect(fx.bob).deposit(E("1000"));
    await fx.wrapper.connect(fx.bob).withdraw(await fx.wrapper.balanceOf(fx.bob.address));
    const rawA = await fx.vault.balanceOf(fx.bob.address);
    const divA = await fx.div.balanceOf(fx.bob.address);

    expect(rawA).to.be.lte(rawB);
    expect(divA).to.be.lte(divB);
    // The loss is dust, not a fee — the wrapper is not extracting either.
    expect(rawB - rawA).to.be.lt(E("0.000001"));
    expect(divB - divA).to.be.lt(E("0.000001"));
  });

  it("withdraw pays exact pro-rata in BOTH assets and cannot over-extract", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("3000"));
    await mint(fx, fx.bob, E("1000"));
    await mint(fx, fx.carol, E("1000"));

    await fx.wrapper.connect(fx.alice).deposit(E("3000"));
    await push(fx, fx.carol, E("200"));
    await fx.wrapper.connect(fx.carol).harvest();
    await fx.wrapper.connect(fx.bob).deposit(E("1000"));

    const supply = await fx.wrapper.totalSupply();
    const R = await fx.wrapper.rawSharesHeld();
    const D = await fx.wrapper.dividendAssetHeld();
    const half = (await fx.wrapper.balanceOf(fx.alice.address)) / 2n;

    const expRaw = (half * R) / (supply + VIRTUAL_SHARES);
    const expDiv = (half * D) / (supply + VIRTUAL_SHARES);

    const r0 = await fx.vault.balanceOf(fx.alice.address);
    const d0 = await fx.div.balanceOf(fx.alice.address);
    await fx.wrapper.connect(fx.alice).withdraw(half);
    expect((await fx.vault.balanceOf(fx.alice.address)) - r0).to.equal(expRaw);
    expect((await fx.div.balanceOf(fx.alice.address)) - d0).to.equal(expDiv);

    // Cannot burn more than you hold.
    await expect(fx.wrapper.connect(fx.alice).withdraw(supply)).to.be.revert(ethers);
    await expect(fx.wrapper.connect(fx.alice).withdraw(0n)).to.be.revertedWithCustomError(
      fx.wrapper,
      "ZeroAmount"
    );
  });

  // ══ 5. harvest() is ungriefable ══════════════════════════════════════════

  it("harvest() is a clean no-op when there is nothing to claim, however often it is called", async () => {
    const fx = await fixture();
    // Empty wrapper, no position at all.
    await expect(fx.wrapper.connect(fx.bob).harvest()).to.not.be.revert(ethers);

    await mint(fx, fx.alice, E("1000"));
    await mint(fx, fx.carol, E("1000"));
    await fx.wrapper.connect(fx.alice).deposit(E("1000"));

    await expect(fx.wrapper.connect(fx.bob).harvest()).to.not.be.revert(ethers);
    expect(await fx.wrapper.dividendAssetHeld()).to.equal(0n);

    await push(fx, fx.carol, E("50"));
    await fx.wrapper.connect(fx.bob).harvest();
    const held = await fx.wrapper.dividendAssetHeld();

    // Back-to-back re-harvests move nothing and cannot be used to grief the
    // rate or the accounting.
    for (let i = 0; i < 5; i++) await fx.wrapper.connect(fx.carol).harvest();
    expect(await fx.wrapper.dividendAssetHeld()).to.equal(held);
  });

  // ══ 6. Measured-delta pull ═══════════════════════════════════════════════

  it("credits the MEASURED delta, not the nominal amount, on a fee-on-transfer dividend leg", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("2000"));
    await mint(fx, fx.bob, E("2000"));
    await mint(fx, fx.carol, E("1000"));

    await fx.wrapper.connect(fx.alice).deposit(E("2000"));
    await push(fx, fx.carol, E("300"));
    await fx.wrapper.connect(fx.carol).harvest();

    const heldBefore = await fx.wrapper.dividendAssetHeld();
    const supplyBefore = await fx.wrapper.totalSupply();

    // The dividend asset now burns 10% of every transfer.
    await fx.tokens[0].setFeeBps(1000);
    await fx.wrapper.connect(fx.bob).deposit(E("2000"));
    const minted = await fx.wrapper.balanceOf(fx.bob.address);

    const arrived = (await fx.wrapper.dividendAssetHeld()) - heldBefore;
    // What Bob actually delivered on the dividend leg is what he was minted
    // against: his claim can never exceed it.
    const claim = (minted * (await fx.wrapper.dividendAssetHeld())) /
      ((await fx.wrapper.totalSupply()) + VIRTUAL_SHARES);
    expect(claim).to.be.lte(arrived);
    // 10% of the dividend leg was burned in flight, so Bob is minted ~90% of
    // what an equal fee-free deposit would have earned him — the nominal
    // amount is nowhere in the mint. A contract crediting nominal would have
    // minted the full `supplyBefore`-equivalent here.
    const feeFree = supplyBefore; // an identical raw deposit against equal backing
    expect(minted).to.be.lt((feeFree * 95n) / 100n);
    expect(minted).to.be.gt((feeFree * 85n) / 100n);
    // Only ~90% of the quoted dividend side actually landed, and the wrapper
    // priced against what landed.
    expect(arrived).to.be.lt((heldBefore * 95n) / 100n);
    expect(arrived).to.be.gt((heldBefore * 85n) / 100n);

    // And Alice, who was already in, was not diluted by the shortfall.
    const aliceClaim = await claimOf(fx, fx.alice.address);
    expect(aliceClaim.div).to.be.gte((heldBefore * 9999n) / 10000n);
    await fx.tokens[0].setFeeBps(0);
  });

  // ══ 7. Conservation under a randomised sequence ══════════════════════════

  for (const seed of [1, 7, 12345]) {
    it(`claims never exceed backing over 60 random ops (seed ${seed})`, async () => {
      const fx = await fixture();
      const actors = [fx.alice, fx.bob, fx.carol];
      for (const a of actors) await mint(fx, a, E("5000"));

      let s = BigInt(seed);
      const rnd = (n: number) => {
        s = (s * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
        return Number((s >> 16n) % BigInt(n));
      };

      for (let i = 0; i < 60; i++) {
        const who = actors[rnd(3)];
        const op = rnd(4);
        try {
          if (op === 0) {
            await fx.wrapper.connect(who).deposit(E(String(1 + rnd(400))));
          } else if (op === 1) {
            const bal = await fx.wrapper.balanceOf(who.address);
            if (bal > 0n) await fx.wrapper.connect(who).withdraw(bal / BigInt(1 + rnd(3)));
          } else if (op === 2) {
            await fx.wrapper.connect(who).harvest();
          } else {
            await push(fx, who, E(String(1 + rnd(50))));
          }
        } catch {
          /* a reverted op is a no-op; the invariant must still hold */
        }

        const supply = await fx.wrapper.totalSupply();
        const R = await fx.wrapper.rawSharesHeld();
        const D = await fx.wrapper.dividendAssetHeld();
        let sumRaw = 0n;
        let sumDiv = 0n;
        for (const a of actors) {
          const c = await claimOf(fx, a.address);
          sumRaw += c.raw;
          sumDiv += c.div;
        }
        // THE invariant: everything everyone could take out is really there.
        expect(sumRaw).to.be.lte(R);
        expect(sumDiv).to.be.lte(D);
        // Supply and backing move together — supply can only be zero when no
        // claim exists against the backing.
        if (supply === 0n) {
          expect(sumRaw).to.equal(0n);
          expect(sumDiv).to.equal(0n);
        }
      }
    });
  }

  it("actually drove deposit, withdraw and harvest to non-trivial state", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("1000"));
    await mint(fx, fx.carol, E("1000"));
    await fx.wrapper.connect(fx.alice).deposit(E("500"));
    await push(fx, fx.carol, E("30"));
    await fx.wrapper.connect(fx.carol).harvest();
    expect(await fx.wrapper.rawSharesHeld()).to.be.gt(0n);
    expect(await fx.wrapper.dividendAssetHeld()).to.be.gt(0n);
    await fx.wrapper.connect(fx.alice).withdraw(await fx.wrapper.balanceOf(fx.alice.address));
    expect(await fx.wrapper.totalSupply()).to.equal(0n);
  });
});
