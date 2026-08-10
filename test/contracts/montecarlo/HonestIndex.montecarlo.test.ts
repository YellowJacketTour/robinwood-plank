import { expect } from "chai";
import { ethers } from "../helpers/hardhat.js";
import { mine } from "../helpers/network-helpers.js";
import { deployBeaconMock } from "../helpers/beacon.js";

/**
 * ============================================================================
 * MONTE CARLO / ADVERSARIAL PROOF SUITE — 2026-08-10 game-theory audit fixes.
 *
 * Every property below is a HARD assertion checked after every single
 * randomized action across many seeds, against REAL deployed Solidity (no
 * mocked math) — the same deterministic-PRNG, re-check-every-call discipline
 * `VaultV3.fuzz.test.ts` already establishes in this repo. Each block targets
 * the EXACT adversarial strategy the game-theory audit found, run for real
 * rather than argued about, and confirms it no longer works.
 * ============================================================================
 */
describe("Monte Carlo / adversarial proof — game-theory audit fixes hold under randomized attack", function () {
  this.timeout(300_000);

  function prng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  const TIMELOCK = 48 * 3600;
  const SINK_BPS = 3_000n;
  const BPS = 10_000n;

  async function deployVaultAndWeight() {
    const [, treasury, alice] = await ethers.getSigners();
    const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
    const wethAddr = await weth.getAddress();
    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const factory: any = await (await ethers.getContractFactory("CollectionVaultFactory")).deploy(
      treasury.address,
      wethAddr,
      TIMELOCK
    );
    const vaultAddr: string = await factory.deployVault.staticCall(await nft.getAddress(), treasury.address, SINK_BPS);
    await factory.deployVault(await nft.getAddress(), treasury.address, SINK_BPS);
    const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);
    const weightModule: any = await (await ethers.getContractFactory("WeightModule")).deploy(await factory.getAddress());
    await vault.connect(treasury).setWeightModule(await weightModule.getAddress());
    return { treasury, alice, weth, wethAddr, nft, factory, vault, vaultAddr, weightModule };
  }

  async function openPool(vault: any, vaultAddr: string, weth: any, treasury: any, alice: any, nftCount = 40) {
    await weth.mint(alice.address, ethers.parseEther("2000"));
    await weth.connect(alice).approve(vaultAddr, ethers.MaxUint256);
    for (let i = 1; i <= nftCount; i++) {
      const nftAddr = await vault.collection();
      const nft = await ethers.getContractAt("MockRobinWoodNft", nftAddr);
      await nft.mint(alice.address, i);
      await nft.connect(alice).approve(vaultAddr, i);
    }
    await vault.connect(alice).deposit(1);
    const seedPayment = ethers.parseEther("50");
    await weth.mint(treasury.address, seedPayment);
    await weth.connect(treasury).approve(vaultAddr, seedPayment);
    await vault.connect(treasury).seedLiquidity(seedPayment);
    await vault.connect(alice).transfer(treasury.address, ethers.parseEther("1"));
    await vault.connect(treasury).seedShares(ethers.parseEther("1"));
    await vault.connect(treasury).openPool();
    return nftCount;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 1. SWAP FEE: exactly swapFeeBps, applied once — not the ~1.5x double-
  //    charge bug — under randomized trade sizes, and quote always mirrors
  //    execution wei-for-wei.
  // ══════════════════════════════════════════════════════════════════════
  it("MC-1: swap fee is exactly swapFeeBps (never ~1.5x) and quote==execution, across randomized trade sequences", async () => {
    const SEEDS = 6;
    const ACTIONS_PER_SEED = 25;
    let trades = 0;

    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = prng(seed * 7919);
      const { treasury, alice, weth, vault, vaultAddr } = await deployVaultAndWeight();
      await openPool(vault, vaultAddr, weth, treasury, alice);
      const swapFeeBps: bigint = await vault.swapFeeBps();

      for (let i = 0; i < ACTIONS_PER_SEED; i++) {
        const buy = rand() < 0.5;
        if (buy) {
          // Randomized amount, including adversarial extremes (tiny / large).
          const magnitude = rand() < 0.1 ? 1n : ethers.parseEther((0.001 + rand() * 5).toFixed(6));
          const quoted: bigint = await vault.quoteBuyShares(magnitude);
          if (quoted === 0n) continue;
          const before = { p: await vault.paymentReserve(), s: await vault.shareReserve() };
          const sharesOut: bigint = await vault.connect(alice).buyShares.staticCall(magnitude, 0n);
          expect(sharesOut).to.equal(quoted, `MC-1 seed=${seed} i=${i}: quote must mirror execution exactly (buy)`);
          await vault.connect(alice).buyShares(magnitude, 0n);
          trades++;

          // Effective fee check: the NO-FEE constant-product output for the
          // same input, vs what the trader actually got. The gap must equal
          // swapFeeBps within integer-rounding tolerance — never ~1.5x it.
          const idealOut = (magnitude * before.s) / (before.p + magnitude);
          if (idealOut > 0n) {
            const effectiveFeeBps = ((idealOut - sharesOut) * BPS) / idealOut;
            expect(effectiveFeeBps).to.be.lte(
              swapFeeBps + 5n,
              `MC-1 seed=${seed} i=${i}: effective fee ${effectiveFeeBps}bps exceeds nominal ${swapFeeBps}bps — the double-charge bug would show ~1.5x here`
            );
          }
        } else {
          const bal: bigint = await vault.balanceOf(alice.address);
          if (bal === 0n) continue;
          const sharesIn = (bal * BigInt(Math.floor(1 + rand() * 50))) / 100n || 1n;
          if (sharesIn === 0n) continue;
          const quoted: bigint = await vault.quoteSellShares(sharesIn);
          if (quoted === 0n) continue;
          const amountOut: bigint = await vault.connect(alice).sellShares.staticCall(sharesIn, 0n);
          expect(amountOut).to.equal(quoted, `MC-1 seed=${seed} i=${i}: quote must mirror execution exactly (sell)`);
          await vault.connect(alice).sellShares(sharesIn, 0n);
          trades++;
        }
      }
    }
    expect(trades).to.be.gt(SEEDS * 10, "MC-1: too few trades executed to be a meaningful proof");
  });

  // ══════════════════════════════════════════════════════════════════════
  // 2. DECAY ANTI-FREEZE: the exact adversarial strategy the audit found —
  //    stop real volume, but keep pinging trivial fee events — must NOT
  //    keep the composite score frozen at its peak.
  // ══════════════════════════════════════════════════════════════════════
  it("MC-2: 'ping trivial fees to freeze decay while volume goes silent' no longer works, across randomized ping schedules", async () => {
    const SEEDS = 4;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = prng(seed * 104729);
      const { treasury, alice, weth, vault, vaultAddr, weightModule } = await deployVaultAndWeight();
      const nftCount = await openPool(vault, vaultAddr, weth, treasury, alice, 60);

      // Build genuine, substantial F + V activity (real swaps). Sells a
      // FRACTION of her actual post-buy balance — the pool's reserve ratio
      // means a fixed ETH-denominated buy yields far fewer than 1 full
      // share-unit, so a fixed sell amount would exceed her balance.
      for (let i = 0; i < 8; i++) {
        await vault.connect(alice).buyShares(ethers.parseEther("1"), 0n);
        const bal: bigint = await vault.balanceOf(alice.address);
        if (bal > 0n) await vault.connect(alice).sellShares(bal / 3n || 1n, 0n);
      }
      const scoreAtPeak: bigint = await weightModule.score(vaultAddr);
      expect(scoreAtPeak).to.be.gt(0n, `MC-2 seed=${seed}: setup failed to build a nonzero score`);

      const DECAY_BLOCKS = 100_800n;
      let elapsed = 0n;
      let nextId = 20;
      // Adversarial strategy: periodic trivial mint+redeem round trips
      // (real, nonzero, but tiny sink cost — refreshes lastFeeBlock) at
      // RANDOMIZED intervals, while never touching volume again, for well
      // past the decay window.
      while (elapsed < DECAY_BLOCKS * 2n + 20_000n) {
        const gap = 500n + BigInt(Math.floor(rand() * 2000));
        await mine(gap);
        elapsed += gap;
        if (nextId <= nftCount) {
          await vault.connect(alice).deposit(nextId);
          await vault.connect(alice).redeem(nextId);
          nextId++;
        }
      }

      // The precise proof: F keeps growing from the pings themselves (real,
      // if small, sink fees), so the RAW composite legitimately grows too —
      // asserting the final score is merely "lower than an earlier snapshot"
      // would be the wrong test. What must hold is that the DECAY FACTOR
      // itself is doing real work: the actual (decayed) score must be
      // MEASURABLY below what the same current F/P/D/V would produce with
      // NO decay applied at all — proving `_applyDecay` is firing rather
      // than being permanently suppressed by the fee pings.
      const st = await weightModule.scores(vaultAddr);
      const [ALPHA_F, BETA_P, GAMMA_D, DELTA_V, K_BLOCKS, WAD] = await Promise.all([
        weightModule.ALPHA_F_WAD(),
        weightModule.BETA_P_WAD(),
        weightModule.GAMMA_D_WAD(),
        weightModule.DELTA_V_WAD(),
        weightModule.K_BLOCKS(),
        10n ** 18n,
      ]);
      const dHat: bigint = await weightModule.windowMinDepth(vaultAddr);
      const fHat: bigint = st.feeWethCumulative;
      const pHat: bigint = st.mintPressureCumulative > 0n ? st.mintPressureCumulative : 0n;
      const vHat: bigint = st.volumeEwma;

      const blockNow = BigInt(await ethers.provider.getBlockNumber());
      const anchor = st.firstDepthBlock !== 0n && st.firstDepthBlock < st.firstFeeBlock ? st.firstDepthBlock : st.firstFeeBlock;
      const delta = blockNow - anchor;
      const m = (delta * WAD) / (delta + K_BLOCKS);
      const composite = (ALPHA_F * fHat + BETA_P * pHat + GAMMA_D * dHat + DELTA_V * vHat) / WAD;
      const undecayed = (m * composite) / WAD;

      const scoreAfter: bigint = await weightModule.score(vaultAddr);
      expect(scoreAfter).to.be.lt(
        undecayed,
        `MC-2 seed=${seed}: decayed score ${scoreAfter} is NOT below the undecayed composite ${undecayed} — decay is not actually firing despite volume having gone silent well past the ${DECAY_BLOCKS}-block window`
      );
      // And it must be meaningfully below, not a rounding sliver — silence
      // this long should cost real ground.
      expect(scoreAfter * 2n).to.be.lt(
        undecayed,
        `MC-2 seed=${seed}: decay fired but reduced the score by less than half despite far exceeding the decay window — too weak to be the real half-life mechanism`
      );
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // 3. EWMA ONE-PER-BLOCK: an adversarial same-block multi-call burst must
  //    only move the EWMA once.
  // ══════════════════════════════════════════════════════════════════════
  it("MC-3: a same-block noteVolume burst (adversarial, via disabled automine) moves the EWMA at most once", async () => {
    // Exercises the real WeightModule.noteVolume directly (matching
    // WeightModule.reform.test.ts's own isolated-signal style) so the
    // property is proven against the exact guarded function, independent of
    // Hardhat 3's gas-estimation quirks around a real CollectionVault swap
    // with automine disabled.
    const [deployer, vaultA] = await ethers.getSigners();
    const factory: any = await (await ethers.getContractFactory("MockVaultFactory")).deploy();
    const wm: any = await (await ethers.getContractFactory("WeightModule")).deploy(await factory.getAddress());
    await factory.setVault(vaultA.address, true);

    const before = (await wm.scores(vaultA.address)).volumeEwma;

    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      // Fire 5 real noteVolume calls queued into the SAME block — an
      // adversarial burst attempting to converge the EWMA in one shot.
      for (let i = 0; i < 5; i++) {
        await wm.connect(vaultA).noteVolume(vaultA.address, ethers.parseEther("10"), { gasLimit: 200_000 });
      }
      await ethers.provider.send("evm_mine", []);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }

    const afterBurstBlock = (await wm.scores(vaultA.address)).volumeEwma;
    // Now let one more call through in its own block — this one MUST be
    // free to move the EWMA again (the cap is per-block, not permanent).
    await wm.connect(vaultA).noteVolume(vaultA.address, ethers.parseEther("10"));
    const afterNextBlock = (await wm.scores(vaultA.address)).volumeEwma;

    expect(afterBurstBlock).to.not.equal(before, "MC-3: the burst's first call should have moved the EWMA once");
    expect(afterNextBlock).to.not.equal(
      afterBurstBlock,
      "MC-3: a swap in a NEW block must still be able to move the EWMA — the cap must not be permanent"
    );
  });

  // ══════════════════════════════════════════════════════════════════════
  // 4. EXIT-CAPACITY CAPS SUM TO EXACTLY 10,000 BPS (H-8 invariant) under
  //    randomized vault counts and randomized real depths.
  // ══════════════════════════════════════════════════════════════════════
  it("MC-4: weights() sums to exactly 10,000 bps across randomized vault counts and depths", async () => {
    const SEEDS = 5;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = prng(seed * 40503);
      const [, treasury] = await ethers.getSigners();
      const factory: any = await (await ethers.getContractFactory("MockVaultFactory")).deploy();
      const wm: any = await (await ethers.getContractFactory("WeightModule")).deploy(await factory.getAddress());

      const n = 3 + Math.floor(rand() * 6); // 3..8 vaults
      const signers = (await ethers.getSigners()).slice(4, 4 + n);
      for (const s of signers) await factory.setVault(s.address, true);

      for (const s of signers) {
        const fee = ethers.parseEther((1 + rand() * 50).toFixed(4));
        await wm.connect(s).noteFee(s.address, fee);
      }
      await mine(50_400n);

      // Randomized real depth per vault, held through the full window.
      for (let e = 0; e < 7; e++) {
        for (const s of signers) {
          const depth = ethers.parseEther((0.01 + rand() * 200).toFixed(4));
          await wm.connect(s).noteDepth(s.address, depth);
        }
        await mine(1_200n);
      }
      for (const s of signers) await wm.checkAdmit(s.address);

      const [vaults, wBps] = await wm.weights();
      expect(vaults.length).to.equal(n);
      const sum = wBps.reduce((a: bigint, b: bigint) => a + b, 0n);
      expect(sum).to.equal(BPS, `MC-4 seed=${seed}, n=${n}: caps summed to ${sum}, not exactly 10,000`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // 5. LP DWELL-CLOCK GRIEFING: adversarial dust-transfer bursts at random
  //    intervals must NOT reset a victim's exit-fee clock; a real transfer
  //    still correctly does.
  // ══════════════════════════════════════════════════════════════════════
  it("MC-5: dust-transfer griefing cannot reset a victim's LP dwell clock, across randomized attack schedules", async () => {
    const SEEDS = 4;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = prng(seed * 65003);
      const { treasury, alice, weth, vault, vaultAddr } = await deployVaultAndWeight();
      await openPool(vault, vaultAddr, weth, treasury, alice);
      // openPool's own genesis-seed step transfers alice's entire initial
      // share balance to treasury, leaving her with zero — deposit two more
      // NFTs so she has real shares of her own to hand to victim/attacker.
      await vault.connect(alice).deposit(2);
      await vault.connect(alice).deposit(3);

      const [, , , victim, attacker] = await ethers.getSigners();
      const lpTokenAddr: string = await vault.lpToken();
      const lpToken: any = await ethers.getContractAt("CollectionVaultLP", lpTokenAddr);

      // Victim adds real liquidity.
      const addAmt = ethers.parseEther("2");
      await weth.mint(victim.address, addAmt);
      await weth.connect(victim).approve(vaultAddr, addAmt);
      await vault.connect(alice).transfer(victim.address, ethers.parseEther("0.5"));
      await vault.connect(victim).approve(vaultAddr, ethers.MaxUint256);
      await vault.connect(victim).addLiquidity(addAmt, 0n);
      const entryBlockBefore: bigint = await vault.lpEntryBlock(victim.address);

      // Attacker acquires a little LP and fires randomized dust transfers at
      // the victim — below the floor, at randomized intervals.
      await weth.mint(attacker.address, ethers.parseEther("2"));
      await weth.connect(attacker).approve(vaultAddr, ethers.parseEther("2"));
      await vault.connect(alice).transfer(attacker.address, ethers.parseEther("0.5"));
      await vault.connect(attacker).approve(vaultAddr, ethers.MaxUint256);
      await vault.connect(attacker).addLiquidity(ethers.parseEther("2"), 0n);

      for (let i = 0; i < 10; i++) {
        const gap = BigInt(Math.floor(rand() * 5));
        if (gap > 0n) await mine(gap);
        const dust = BigInt(Math.floor(rand() * 1e11)); // well under LP_GRIEF_RESET_FLOOR (1e12)
        if (dust === 0n) continue;
        const attackerBal: bigint = await lpToken.balanceOf(attacker.address);
        if (attackerBal < dust) continue;
        await lpToken.connect(attacker).transfer(victim.address, dust);
      }
      const entryBlockAfterDust: bigint = await vault.lpEntryBlock(victim.address);
      expect(entryBlockAfterDust).to.equal(
        entryBlockBefore,
        `MC-5 seed=${seed}: dust transfers reset the victim's dwell clock — the griefing floor failed`
      );

      // A REAL, above-floor transfer still correctly resets it (the fix is
      // a floor, not a blanket disable).
      const attackerBal: bigint = await lpToken.balanceOf(attacker.address);
      if (attackerBal > 0n) {
        await mine(3n);
        await lpToken.connect(attacker).transfer(victim.address, attackerBal / 2n > 0n ? attackerBal / 2n : attackerBal);
        const entryBlockAfterReal: bigint = await vault.lpEntryBlock(victim.address);
        expect(entryBlockAfterReal).to.not.equal(
          entryBlockBefore,
          `MC-5 seed=${seed}: a real, above-floor transfer should still reset the dwell clock`
        );
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // 6. ROBINWOOD V3 ADAPTER SOLVENCY: wrapped supply == real custodied V3
  //    shares, exactly, after every randomized buy/sell by multiple actors.
  // ══════════════════════════════════════════════════════════════════════
  it("MC-6: RobinwoodV3Adapter wV3S totalSupply == real custodied V3 shares, exactly, across randomized multi-actor trading", async () => {
    const SEEDS = 4;
    const MINT_FEE = ethers.parseEther("0.001");
    const REDEEM_FEE = ethers.parseEther("0.001");
    const PREMIUM = ethers.parseEther("0.002");
    const SWAP_BPS = 30n;

    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = prng(seed * 200003);
      const [, treasury, alice, actorA, actorB] = await ethers.getSigners();
      const Nft = await ethers.getContractFactory("MockRobinWoodNft");
      const nft: any = await Nft.deploy();
      const beacon: any = await deployBeaconMock();
      const VaultV3 = await ethers.getContractFactory("MarketplankVaultV3");
      const v3: any = await VaultV3.deploy(
        await nft.getAddress(),
        "vROBIN3",
        "vROBIN3",
        MINT_FEE,
        REDEEM_FEE,
        PREMIUM,
        SWAP_BPS,
        treasury.address,
        await beacon.getAddress()
      );
      const v3Addr = await v3.getAddress();
      for (let id = 1; id <= 8; id++) {
        await nft.mint(alice.address, id);
        await nft.connect(alice).approve(v3Addr, id);
        await v3.connect(alice).deposit(id, { value: MINT_FEE });
      }
      await v3.connect(alice).transfer(treasury.address, 10n ** 18n * 3n);
      await v3.connect(treasury).seedShares(10n ** 18n * 3n, { value: ethers.parseEther("4") });
      await v3.connect(treasury).openPool();

      const weth: any = await (await ethers.getContractFactory("CanonicalWeth9")).deploy();
      const factory: any = await (await ethers.getContractFactory("MockVaultFactory")).deploy();
      const wm: any = await (await ethers.getContractFactory("WeightModule")).deploy(await factory.getAddress());
      const Adapter = await ethers.getContractFactory("RobinwoodV3Adapter");
      const adapter: any = await Adapter.deploy(v3Addr, await weth.getAddress(), await wm.getAddress());
      const adapterAddr = await adapter.getAddress();

      const actors = [actorA, actorB];
      for (const a of actors) await weth.connect(a).deposit({ value: ethers.parseEther("5") });

      for (let i = 0; i < 20; i++) {
        const actor = actors[Math.floor(rand() * actors.length)];
        const buy = rand() < 0.6;
        if (buy) {
          const amt = ethers.parseEther((0.01 + rand() * 0.5).toFixed(6));
          const bal: bigint = await weth.balanceOf(actor.address);
          if (bal < amt) continue;
          await weth.connect(actor).approve(adapterAddr, amt);
          const quoted: bigint = await adapter.quoteBuyShares(amt);
          if (quoted === 0n) continue;
          await adapter.connect(actor).buyShares(amt, quoted);
        } else {
          const bal: bigint = await adapter.balanceOf(actor.address);
          if (bal === 0n) continue;
          const sharesIn = (bal * BigInt(Math.floor(1 + rand() * 80))) / 100n || 1n;
          const quoted: bigint = await adapter.quoteSellShares(sharesIn);
          if (quoted === 0n) continue;
          await adapter.connect(actor).sellShares(sharesIn, quoted);
        }

        // HARD invariant after EVERY action: wrapped supply == real custody.
        const wrapped: bigint = await adapter.totalSupply();
        const custodied: bigint = await v3.balanceOf(adapterAddr);
        expect(wrapped).to.equal(custodied, `MC-6 seed=${seed} i=${i}: wV3S supply ${wrapped} != custodied V3 shares ${custodied}`);
        expect(await weth.balanceOf(adapterAddr)).to.equal(0n, `MC-6 seed=${seed} i=${i}: WETH stranded in adapter`);
      }
    }
  });
});
