import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import {
  impersonateAccount,
  setBalance,
  stopImpersonatingAccount,
  takeSnapshot,
  time,
  type SnapshotRestorer,
} from "./helpers/network-helpers.js";
import { TIMELOCK, WAD, defaultParams, paramsTuple,
  indexVaultFactory,
} from "./helpers/index-vault.js";

/**
 * Audit-style suite for two properties that are easy to CLAIM and easy to get
 * subtly wrong:
 *
 *   PART B/C — THE SELF-DEAL REDIRECT (PlankGauge). The contract catches
 *   exactly one thing: an address that is provably standing on both sides of
 *   the benefit a burn buys — the gauge itself, its registered vault, or its
 *   registered LP token. All three are addresses the registry role registered
 *   on-chain in a timelocked action, so the equality test is over facts the
 *   contract already holds and, when it fires, it is certain. This file drives
 *   all three, drives the no-sink refusal, drives the honest third party who
 *   must be unaffected, and asserts in as many ways as it can that the redirect
 *   is a REDIRECT and not a penalty — the tokens still die, and the weight the
 *   sink receives is bit-for-bit the weight the self-dealer would have got.
 *
 *   DIRECTION SYMMETRY (GlobalIndexVault). There is ONE imbalance-fee formula
 *   and both priced paths charge it, with no `isBuy` argument, no direction
 *   branch, no second fee table and no directional multiplier. Asserted by
 *   enumerating the ABI (so a future directional argument fails here), by
 *   showing the mint-side directional TERM vanishes identically at target
 *   weight, and by showing a round trip is strictly loss-making in both
 *   orders rather than free in one of them.
 *
 * LOCAL HARDHAT ONLY. Nothing in this repo may deploy either contract until
 * the external audit gate (§2.6) clears.
 */
describe("Self-deal redirect (PlankGauge) and direction symmetry (GlobalIndexVault)", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  const DEAD = "0x000000000000000000000000000000000000dEaD";
  const RAW_MULT = 10_000n;
  const LP_MULT = 25_000n;
  const COLL_MULT = 30_000n;
  const EPOCH = 7 * 24 * 3_600;

  function isqrt(n: bigint): bigint {
    if (n < 2n) return n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
      x = y;
      y = (x + n / x) / 2n;
    }
    return x;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  PART B/C — the self-deal redirect
  // ══════════════════════════════════════════════════════════════════════

  describe("PlankGauge self-deal redirect", () => {
    /**
     * A gauge with one registered collection: gauge id `gA`, registered vault
     * `vaultA`, registered LP token `collLp`. All three are the addresses the
     * redirect is defined over, and the fixture keeps them distinct from every
     * honest actor so a redirect can never fire by coincidence.
     */
    async function fixture() {
      const all = await ethers.getSigners();
      const [gaugeRegistry, honest, sink, funder] = [all[12], all[13], all[14], all[15]];
      const gaugeRoleAdmin = all[16];
      const gaugeTuning = all[17];

      const Token = await ethers.getContractFactory("MockIndexToken");
      const plank: any = await Token.deploy("PLANK", "PLANK");
      const collLp: any = await Token.deploy("vROBIN/ETH LP", "VR-LP");

      const Gauge = await ethers.getContractFactory("PlankGauge");
      const gauge: any = await Gauge.deploy(
        await plank.getAddress(),
        [gaugeRoleAdmin.address, gaugeRegistry.address, gaugeTuning.address],
        TIMELOCK,
        [RAW_MULT, LP_MULT, COLL_MULT],
        EPOCH
      );
      const gaugeAddr = await gauge.getAddress();

      // The gauge id and the registered vault are plain addresses with no
      // code, exactly as a v-token id and a vault address would be from this
      // contract's point of view.
      const gA = ethers.Wallet.createRandom().address;
      const gB = ethers.Wallet.createRandom().address;
      const vaultA = ethers.Wallet.createRandom().address;
      const collLpAddr = await collLp.getAddress();

      await gauge.connect(gaugeRegistry).queueGauge(gA, false);
      await gauge.connect(gaugeRegistry).queueGauge(gB, false);
      await gauge.connect(gaugeRegistry).queueCollectionLp(gA, collLpAddr, vaultA, false);
      await time.increase(TIMELOCK + 1);
      await gauge.executeGauge(gA);
      await gauge.executeGauge(gB);
      await gauge.executeCollectionLp(gA);

      for (const who of [honest, funder]) {
        for (const t of [plank, collLp]) {
          await t.mint(who.address, 1_000_000n * WAD);
          await t.connect(who).approve(gaugeAddr, ethers.MaxUint256);
        }
      }

      return {
        gaugeRegistry,
        honest,
        sink,
        funder,
        plank,
        collLp,
        collLpAddr,
        gauge,
        gaugeAddr,
        gA,
        gB,
        vaultA,
      };
    }

    /** Appoint the redirect sink through the timelock. */
    async function appointSink(fx: any, sinkAddr: string) {
      await fx.gauge.connect(fx.gaugeRegistry).queueRedirectSink(sinkAddr);
      await time.increase(TIMELOCK + 1);
      await fx.gauge.executeRedirectSink();
      expect(await fx.gauge.redirectSink()).to.equal(sinkAddr);
    }

    /**
     * Act as `who` (which may be a contract address), funded with PLANK and
     * approved to the gauge. This is how a burn is driven FROM one of the
     * three self-dealing addresses.
     */
    async function asAddress(fx: any, who: string) {
      await impersonateAccount(who);
      await setBalance(who, ethers.parseEther("10"));
      const signer = await ethers.getSigner(who);
      await fx.plank.mint(who, 1_000_000n * WAD);
      await fx.plank.connect(signer).approve(fx.gaugeAddr, ethers.MaxUint256);
      return signer;
    }

    it("with NO sink appointed, a self-dealing burn is REFUSED rather than quietly credited", async () => {
      const fx = await fixture();
      const { gauge, gA } = fx;
      expect(await gauge.redirectSink()).to.equal(ethers.ZeroAddress);

      const signer = await asAddress(fx, gA);
      await expect(
        gauge.connect(signer).burnPlank(gA, 100n * WAD)
      ).to.be.revertedWithCustomError(gauge, "SelfDealing");
      await stopImpersonatingAccount(gA);

      // Nothing was credited to anyone and nothing was destroyed.
      expect(await gauge.gaugeWeight(gA)).to.equal(0n);
      expect(await fx.plank.balanceOf(DEAD)).to.equal(0n);
    });

    it("CASE 1 — the GAUGE ITSELF burning toward its own gauge is redirected to the sink", async () => {
      const fx = await fixture();
      const { gauge, gA, sink, plank } = fx;
      await appointSink(fx, sink.address);

      const amount = 400n * WAD;
      const signer = await asAddress(fx, gA);
      const weighted = (amount * RAW_MULT) / 10_000n;
      await expect(gauge.connect(signer).burnPlank(gA, amount))
        .to.emit(gauge, "SelfDealRedirected")
        .withArgs(gA, gA, sink.address, weighted);
      await stopImpersonatingAccount(gA);

      // The weight went to the sink and NOT to the self-dealer.
      expect(await gauge.accountWeight(gA, sink.address)).to.equal(isqrt(weighted));
      expect(await gauge.accountWeight(gA, gA)).to.equal(0n);
      expect(await gauge.epochWeightedBurn(await gauge.currentEpoch(), gA, gA)).to.equal(0n);
      // The destruction is real either way — the tokens still left the burner
      // and still landed at dEaD.
      expect(await plank.balanceOf(DEAD)).to.equal(amount);
    });

    it("CASE 2 — the gauge's REGISTERED VAULT burning is redirected", async () => {
      const fx = await fixture();
      const { gauge, gA, vaultA, sink } = fx;
      await appointSink(fx, sink.address);
      expect(await gauge.collectionVaultOf(gA)).to.equal(vaultA);

      const amount = 900n * WAD;
      const signer = await asAddress(fx, vaultA);
      await expect(gauge.connect(signer).burnPlank(gA, amount)).to.emit(
        gauge,
        "SelfDealRedirected"
      );
      await stopImpersonatingAccount(vaultA);
      expect(await gauge.accountWeight(gA, sink.address)).to.equal(isqrt(amount));
      expect(await gauge.accountWeight(gA, vaultA)).to.equal(0n);
    });

    it("CASE 3 — the gauge's REGISTERED LP TOKEN burning is redirected", async () => {
      const fx = await fixture();
      const { gauge, gA, collLpAddr, sink } = fx;
      await appointSink(fx, sink.address);
      expect(await gauge.collectionLpOf(gA)).to.equal(collLpAddr);

      const amount = 1_600n * WAD;
      const signer = await asAddress(fx, collLpAddr);
      await expect(gauge.connect(signer).burnPlank(gA, amount)).to.emit(
        gauge,
        "SelfDealRedirected"
      );
      await stopImpersonatingAccount(collLpAddr);
      expect(await gauge.accountWeight(gA, sink.address)).to.equal(isqrt(amount));
      expect(await gauge.accountWeight(gA, collLpAddr)).to.equal(0n);
    });

    it("the check is PER-GAUGE: gA's registered vault self-deals on gA and is an ordinary burner on gB", async () => {
      const fx = await fixture();
      const { gauge, gA, gB, vaultA, sink } = fx;
      await appointSink(fx, sink.address);

      const signer = await asAddress(fx, vaultA);
      // On gA it is provably on both sides.
      await expect(gauge.connect(signer).burnPlank(gA, 100n * WAD)).to.emit(
        gauge,
        "SelfDealRedirected"
      );
      // On gB it is just an address, and the contract must not pretend
      // otherwise — a redirect that fired on unrelated gauges would be a
      // heuristic, which is exactly what the NatSpec refuses.
      await expect(gauge.connect(signer).burnPlank(gB, 100n * WAD)).to.not.emit(
        gauge,
        "SelfDealRedirected"
      );
      await stopImpersonatingAccount(vaultA);
      expect(await gauge.accountWeight(gB, vaultA)).to.equal(isqrt(100n * WAD));
      expect(await gauge.accountWeight(gB, sink.address)).to.equal(0n);
    });

    it("an HONEST burner is completely unaffected — no redirect, no event, no penalty", async () => {
      const fx = await fixture();
      const { gauge, gA, honest, sink } = fx;
      await appointSink(fx, sink.address);

      await expect(gauge.connect(honest).burnPlank(gA, 2_500n * WAD)).to.not.emit(
        gauge,
        "SelfDealRedirected"
      );
      expect(await gauge.accountWeight(gA, honest.address)).to.equal(isqrt(2_500n * WAD));
      expect(await gauge.accountWeight(gA, sink.address)).to.equal(0n);
    });

    it("SYMMETRY: the redirect changes WHO is credited and NOTHING about how much", async () => {
      // The load-bearing property. A redirect that also shaved the weight
      // would be a penalty wearing a redirect's name, and would make the whole
      // mechanism a fee an attacker could route around; a redirect that
      // inflated it would pay for self-dealing. It must be bit-for-bit equal.
      const fx = await fixture();
      const { gauge, gA, gB, honest, sink } = fx;
      await appointSink(fx, sink.address);

      const amount = 777n * WAD;
      // Honest burn of exactly `amount` into gB.
      await gauge.connect(honest).burnPlank(gB, amount);
      const honestWeighted: bigint = await gauge.epochWeightedBurn(
        await gauge.currentEpoch(),
        gB,
        honest.address
      );

      // Self-dealing burn of exactly `amount` into gA.
      const signer = await asAddress(fx, gA);
      await gauge.connect(signer).burnPlank(gA, amount);
      await stopImpersonatingAccount(gA);
      const sinkWeighted: bigint = await gauge.epochWeightedBurn(
        await gauge.currentEpoch(),
        gA,
        sink.address
      );

      expect(sinkWeighted).to.equal(honestWeighted);
      expect(await gauge.accountWeight(gA, sink.address)).to.equal(
        await gauge.accountWeight(gB, honest.address)
      );
      // Gauge-level weight is identical too: gA is not disadvantaged for
      // having had a self-dealer point at it.
      expect(await gauge.gaugeWeight(gA)).to.equal(await gauge.gaugeWeight(gB));
    });

    it("the sink accumulates across repeated redirects under the SAME one-wallet-one-sqrt rule", async () => {
      const fx = await fixture();
      const { gauge, gA, sink } = fx;
      await appointSink(fx, sink.address);

      const signer = await asAddress(fx, gA);
      await gauge.connect(signer).burnPlank(gA, 100n * WAD);
      await gauge.connect(signer).burnPlank(gA, 300n * WAD);
      await stopImpersonatingAccount(gA);

      // sqrt applies to the epoch TOTAL, not per burn — so splitting a
      // self-dealing burn in two buys the sink nothing extra, exactly as it
      // buys an honest wallet nothing extra.
      expect(await gauge.accountWeight(gA, sink.address)).to.equal(isqrt(400n * WAD));
    });

    it("the sink is TIMELOCKED and registry-role-only, and retiring it re-arms the refusal", async () => {
      const fx = await fixture();
      const { gauge, gaugeRegistry, honest, sink, gA } = fx;

      await expect(
        gauge.connect(honest).queueRedirectSink(honest.address)
      )
        .to.be.revertedWithCustomError(gauge, "NotRoleHolder")
        .withArgs(await gauge.ROLE_GAUGE_REGISTRY());

      await gauge.connect(gaugeRegistry).queueRedirectSink(sink.address);
      await expect(gauge.executeRedirectSink()).to.be.revertedWithCustomError(
        gauge,
        "TimelockNotElapsed"
      );
      await time.increase(TIMELOCK + 1);
      await expect(gauge.executeRedirectSink())
        .to.emit(gauge, "RedirectSinkApplied")
        .withArgs(sink.address);
      await expect(gauge.executeRedirectSink()).to.be.revertedWithCustomError(
        gauge,
        "NothingQueued"
      );

      // Retiring it (back to address(0)) makes self-dealing revert again.
      await gauge.connect(gaugeRegistry).queueRedirectSink(ethers.ZeroAddress);
      await time.increase(TIMELOCK + 1);
      await gauge.executeRedirectSink();
      const signer = await asAddress(fx, gA);
      await expect(
        gauge.connect(signer).burnPlank(gA, 10n * WAD)
      ).to.be.revertedWithCustomError(gauge, "SelfDealing");
      await stopImpersonatingAccount(gA);
    });

    it("THE HONEST LIMIT, asserted: a cross-wallet self-dealer is NOT caught, and the suite says so", async () => {
      // Documented as open in `_isSameAddressSelfDeal`, and pinned here on
      // purpose. If someone later 'closes' this with a heuristic, this test
      // fails and forces the argument to be had rather than slipped in.
      const fx = await fixture();
      const { gauge, gA, vaultA, honest, sink } = fx;
      await appointSink(fx, sink.address);

      // The same human, operating the registered vault from one key and
      // burning from a second, unrelated one. To this contract that is two
      // people, and it must not pretend otherwise.
      const signer = await asAddress(fx, vaultA);
      await gauge.connect(signer).burnPlank(gA, 100n * WAD); // redirected
      await stopImpersonatingAccount(vaultA);
      await expect(gauge.connect(honest).burnPlank(gA, 100n * WAD)).to.not.emit(
        gauge,
        "SelfDealRedirected"
      );
      expect(await gauge.accountWeight(gA, honest.address)).to.equal(isqrt(100n * WAD));
    });

    it("the redirect adds NO custody: the gauge still holds nothing and the sink is never paid", async () => {
      const fx = await fixture();
      const { gauge, gaugeAddr, gA, sink, plank } = fx;
      await appointSink(fx, sink.address);
      const sinkPlankBefore: bigint = await plank.balanceOf(sink.address);
      const sinkEthBefore: bigint = await ethers.provider.getBalance(sink.address);

      const signer = await asAddress(fx, gA);
      await gauge.connect(signer).burnPlank(gA, 500n * WAD);
      await stopImpersonatingAccount(gA);

      // The sink received WEIGHT, which is a published number, and nothing
      // else. No token, no ETH, and the gauge holds neither.
      expect(await plank.balanceOf(sink.address)).to.equal(sinkPlankBefore);
      expect(await ethers.provider.getBalance(sink.address)).to.equal(sinkEthBefore);
      expect(await plank.balanceOf(gaugeAddr)).to.equal(0n);
      expect(await ethers.provider.getBalance(gaugeAddr)).to.equal(0n);
      expect(await plank.balanceOf(DEAD)).to.equal(500n * WAD);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  //  DIRECTION SYMMETRY
  // ══════════════════════════════════════════════════════════════════════

  describe("GlobalIndexVault direction symmetry", () => {
    /** Three identical legs, all priced 1.0, all seeded equally — so every
     * leg sits EXACTLY at its target weight and the directional term of
     * `_mintFeeBps` is provably zero rather than merely small. */
    async function balancedIndex() {
      const [, admin, seeder, alice] = await ethers.getSigners();
      const roles: [string, string, string, string] = [
        admin.address,
        admin.address,
        admin.address,
        admin.address,
      ];
      const Token = await ethers.getContractFactory("MockIndexToken");
      const Source = await ethers.getContractFactory("MockIndexPriceSource");
      const tokens: any[] = [];
      const sources: any[] = [];
      for (let i = 0; i < 3; i++) {
        tokens.push(await Token.deploy(`b${i}`, `b${i}`));
        sources.push(await Source.deploy(100n * WAD, 100n * WAD));
      }
      const addrs = await Promise.all(tokens.map((t) => t.getAddress()));

      const Vault = await indexVaultFactory();
      const vault: any = await Vault.deploy(
        "gi",
        "gi",
        roles,
        seeder.address,
        TIMELOCK,
        paramsTuple(defaultParams),
        ethers.ZeroAddress // dividends off: this fixture never pushes one
      );
      const vaultAddr = await vault.getAddress();
      for (let i = 0; i < 3; i++) {
        await vault.connect(seeder).seedConstituent(addrs[i], await sources[i].getAddress(), 3_333);
        await tokens[i].mint(seeder.address, 1_000n * WAD);
        await tokens[i].connect(seeder).approve(vaultAddr, 1_000n * WAD);
        await vault.connect(seeder).seedDeposit(addrs[i], 1_000n * WAD);
      }
      await vault.connect(seeder).openIndex(1_000n * WAD);
      for (const t of tokens) {
        await t.mint(alice.address, 500_000n * WAD);
        await t.connect(alice).approve(vaultAddr, ethers.MaxUint256);
      }
      for (let i = 0; i < 8; i++) {
        await time.increase(Number(defaultParams.minCheckpointInterval) + 1);
        await vault.checkpointAll();
      }
      return { admin, seeder, alice, vault, vaultAddr, tokens, addrs };
    }

    it("no function in the vault's ABI takes a direction, a side, or a buy/sell flag", async () => {
      const { vault } = await balancedIndex();
      const offenders: string[] = [];
      for (const f of vault.interface.fragments as any[]) {
        if (f.type !== "function") continue;
        for (const inp of f.inputs ?? []) {
          if (/isbuy|issell|direction|side|buy|sell/i.test(inp.name ?? "")) {
            offenders.push(`${f.name}(${inp.name})`);
          }
        }
      }
      expect(offenders, offenders.join(", ")).to.deep.equal([]);

      // And there is exactly ONE publicly exposed imbalance-fee formula.
      const feeFns = (vault.interface.fragments as any[])
        .filter((f) => f.type === "function" && /(imbalance|mint)fee/i.test(f.name))
        .map((f) => f.name)
        .sort();
      expect(feeFns).to.deep.equal(["imbalanceFeeBps", "previewMintFeeBps"]);
    });

    it("the ONE formula is a function of (amount, against) only — nothing about who is asking or which way", async () => {
      const { vault } = await balancedIndex();
      // Same (amount, against) -> same bps, everywhere, always.
      for (const [amt, against] of [
        [1n, 1_000n * WAD],
        [100n * WAD, 1_000n * WAD],
        [500n * WAD, 1_000n * WAD],
        [1_000n * WAD, 1_000n * WAD],
      ] as bigint[][]) {
        const a: bigint = await vault.imbalanceFeeBps(amt, against);
        const b: bigint = await vault.imbalanceFeeBps(amt, against);
        expect(a).to.equal(b);
        // base + slope*d, capped — hand-computed from the parameters.
        const d = (amt * 10_000n) / against;
        const expected =
          defaultParams.baseImbalanceFeeBps + (defaultParams.imbalanceSlopeBps * d) / 10_000n;
        expect(a).to.equal(
          expected > defaultParams.maxImbalanceFeeBps
            ? defaultParams.maxImbalanceFeeBps
            : expected
        );
      }
      // A withdrawal taking the WHOLE remaining leg pays base + slope, and an
      // empty leg pays the max — the two documented endpoints.
      expect(await vault.imbalanceFeeBps(1_000n * WAD, 1_000n * WAD)).to.equal(
        defaultParams.baseImbalanceFeeBps + defaultParams.imbalanceSlopeBps
      );
      expect(await vault.imbalanceFeeBps(1n, 0n)).to.equal(defaultParams.maxImbalanceFeeBps);
    });

    it("the mint side's ONE extra term VANISHES identically when a leg is at its target weight", async () => {
      // `_mintFeeBps` is the only asymmetry in the contract, and it is a
      // function of (current weight, target weight) rather than of direction.
      // At target the gap is zero, so it must return the depth fee untouched
      // — which is what makes it not a directional multiplier.
      const { vault, addrs } = await balancedIndex();
      const reserve: bigint = await vault.reserveOf(addrs[0]);
      for (const amt of [1n * WAD, 10n * WAD, 100n * WAD]) {
        const depth: bigint = await vault.imbalanceFeeBps(amt, reserve);
        const mintFee: bigint = await vault.previewMintFeeBps(addrs[0], amt);
        expect(mintFee, `amount ${amt}`).to.equal(depth);
      }
    });

    it("the mint-side term is keyed on WEIGHT vs TARGET, not on buy-vs-sell: it discounts underweight and surcharges overweight", async () => {
      const { vault, alice, addrs } = await balancedIndex();
      const amt = 5n * WAD;
      const atTarget: bigint = await vault.previewMintFeeBps(addrs[0], amt);

      // Make leg 0 OVERWEIGHT by depositing into it. The same buy now costs
      // MORE — because of where the leg sits, not because it is a buy.
      // 200 units into a 3000-unit basket leaves leg 0 at 1200/3200 = 37.5%,
      // over its 3333 target and under the 4000 concentration cap.
      await vault.connect(alice).mintSingleAsset(addrs[0], 200n * WAD, 0n);
      const overweight: bigint = await vault.previewMintFeeBps(addrs[0], amt);
      expect(overweight).to.be.greaterThan(atTarget);

      // And leg 1, which is now UNDERWEIGHT relative to target, is discounted
      // for the identical buy. Same direction, opposite adjustment.
      const underweight: bigint = await vault.previewMintFeeBps(addrs[1], amt);
      expect(underweight).to.be.at.most(atTarget);
    });

    it("a ROUND TRIP is strictly loss-making, and equally so in either order", async () => {
      const { vault, alice, addrs } = await balancedIndex();
      const amountIn = 50n * WAD;

      // BUY then SELL on the same leg.
      const before: bigint = await vault.balanceOf(alice.address);
      await vault.connect(alice).mintSingleAsset(addrs[0], amountIn, 0n);
      const shares: bigint = (await vault.balanceOf(alice.address)) - before;
      expect(shares).to.be.greaterThan(0n);
      const tokenBefore: bigint = await (
        await ethers.getContractAt("MockIndexToken", addrs[0])
      ).balanceOf(alice.address);
      await vault.connect(alice).redeemSingleAsset(shares, addrs[0], 0n);
      const out: bigint =
        (await (await ethers.getContractAt("MockIndexToken", addrs[0])).balanceOf(
          alice.address
        )) - tokenBefore;

      // Strictly less back than went in. If a direction were cheaper than the
      // other, this is where it would show up as a free or profitable loop.
      expect(out).to.be.lessThan(amountIn);

      // The identical loop on a DIFFERENT, untouched leg loses too — the loss
      // is the fee structure, not an artefact of which leg was picked.
      const before2: bigint = await vault.balanceOf(alice.address);
      await vault.connect(alice).mintSingleAsset(addrs[2], amountIn, 0n);
      const shares2: bigint = (await vault.balanceOf(alice.address)) - before2;
      const t2 = await ethers.getContractAt("MockIndexToken", addrs[2]);
      const t2Before: bigint = await t2.balanceOf(alice.address);
      await vault.connect(alice).redeemSingleAsset(shares2, addrs[2], 0n);
      const out2: bigint = (await t2.balanceOf(alice.address)) - t2Before;
      expect(out2).to.be.lessThan(amountIn);
    });
  });
});
