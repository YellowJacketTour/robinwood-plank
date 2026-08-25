import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { deployBeaconMock, relayPendingRound } from "./helpers/beacon.js";

/**
 * Randomized property test for V3, the counterpart of VaultSolvency.fuzz.test.ts.
 *
 * V3 adds proportional LP, ETH fees, a swap fee, and batch ops. This drives a
 * long pseudo-random sequence of every state-changing entry point and, after
 * every single call, re-checks the properties a value-extraction bug would show
 * up in. Unlike the V2 fuzz — whose LP reporters could only *report* because V2
 * is broken — these are HARD assertions: on a correct V3 they must always hold.
 *
 *   1. Solvency:  totalSupply + pendingRedeemCount*1e18 == held*1e18
 *   2. ETH backing:  balance >= ethReserve + accruedFees
 *   3. k monotonicity:  ethReserve*shareReserve never falls across a pure trade
 *      (it may only fall on an LP removal, which is legitimate)
 *   4. No stranded LP claim:  a wound-down pool (every non-locked LP removed)
 *      still has both reserves strictly positive — the seed lock cannot brick
 *   5. A pinned draw's token never changes
 */
describe("MarketplankVaultV3 — randomized invariants", () => {
  const SHARE_UNIT = 10n ** 18n;
  const MINT_FEE = ethers.parseEther("0.001");
  const REDEEM_FEE = ethers.parseEther("0.001");
  const PREMIUM = ethers.parseEther("0.002");
  const SWAP_BPS = 30n;

  function prng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  async function run(seed: number) {
    const [, treasury, alice, bob, carol] = await ethers.getSigners();
    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft: any = await Nft.deploy();
    const beacon: any = await deployBeaconMock();
    const Vault = await ethers.getContractFactory("MarketplankVaultV3");
    const vault: any = await Vault.deploy(
      await nft.getAddress(),
      "v",
      "v",
      MINT_FEE,
      REDEEM_FEE,
      PREMIUM,
      SWAP_BPS,
      treasury.address,
      await beacon.getAddress()
    );
    const addr = await vault.getAddress();
    const rand = prng(seed);
    const actors = [alice, bob, carol];

    let nextId = 1;
    let pinnedToken: bigint | null = null;
    let lastOpWasLpRemove = false;
    let k: bigint | null = null;
    let counts = {
      lpAdd: 0,
      lpRemove: 0,
      buy: 0,
      sell: 0,
      redeem: 0,
      forfeit: 0,
      depositMany: 0,
      redeemMany: 0,
    };
    // Best-effort off-chain mirror of what's currently held, so depositMany /
    // redeemTargetMany can build real batches instead of pure blind guesses.
    // It's allowed to drift (e.g. we don't always know which token a random
    // claim resolved to) — chain state via check() is the actual ground truth.
    let heldTokens: number[] = [];

    const mintTo = async (who: any) => {
      const id = nextId++;
      await nft.mint(who.address, id);
      await nft.connect(who).approve(addr, id);
      return id;
    };

    const check = async () => {
      const supply: bigint = await vault.totalSupply();
      const held: bigint = await vault.heldTokenCount();
      const pending: bigint = await vault.pendingRedeemCount();
      expect(supply + pending * SHARE_UNIT).to.equal(held * SHARE_UNIT, `solvency (seed ${seed})`);

      const eth: bigint = await vault.ethReserve();
      const fees: bigint = await vault.accruedFees();
      const bal = await ethers.provider.getBalance(addr);
      expect(bal).to.be.gte(eth + fees, `eth backing (seed ${seed})`);

      const share: bigint = await vault.shareReserve();
      // Reserves are both positive or both zero — never one-sided, and (given
      // the locked seed) never fully zero once open.
      if (await vault.poolOpen()) {
        expect(eth).to.be.gt(0n, `eth reserve alive (seed ${seed})`);
        expect(share).to.be.gt(0n, `share reserve alive (seed ${seed})`);
      }

      const kNow = eth * share;
      if (k !== null && !lastOpWasLpRemove && eth > 0n && share > 0n) {
        expect(kNow).to.be.gte(k, `k must not fall on a trade (seed ${seed})`);
      }
      k = kNow;

      const [isPinned, drawn] = await vault.pendingDraw();
      if (isPinned) {
        if (pinnedToken === null) pinnedToken = drawn;
        expect(drawn).to.equal(pinnedToken, `pinned draw changed (seed ${seed})`);
        expect(await vault.isTokenHeld(drawn)).to.equal(true);
      } else if ((await vault.pendingRequester()) === ethers.ZeroAddress) {
        pinnedToken = null;
      }
    };

    // Warm start: 6 deposits, seed 3 shares + 4 ETH, open.
    for (let i = 0; i < 6; i++) {
      const id = await mintTo(alice);
      await vault.connect(alice).deposit(id, { value: MINT_FEE });
      heldTokens.push(id);
    }
    await vault.connect(alice).transfer(treasury.address, SHARE_UNIT * 3n);
    await vault.connect(treasury).seedShares(SHARE_UNIT * 3n, { value: ethers.parseEther("4") });
    await vault.connect(treasury).openPool();
    await check();

    for (let step = 0; step < 140; step++) {
      const who = actors[Math.floor(rand() * actors.length)];
      const op = Math.floor(rand() * 12);
      lastOpWasLpRemove = false;
      try {
        if (op === 0) {
          const id = await mintTo(who);
          await vault.connect(who).deposit(id, { value: MINT_FEE });
          heldTokens.push(id);
        } else if (op === 1) {
          await vault.connect(who).requestRandomRedeem({ value: REDEEM_FEE });
        } else if (op === 2) {
          if (rand() < 0.8) await relayPendingRound(vault, beacon, step);
          const r = await vault.pendingRequester();
          const [isPinned, drawnTok] = await vault.pendingDraw();
          await vault.connect(who).claimRandomRedeemFor(r);
          counts.redeem++;
          if (isPinned) {
            const i = heldTokens.indexOf(Number(drawnTok));
            if (i >= 0) heldTokens.splice(i, 1);
          }
        } else if (op === 3) {
          await vault.connect(who).buyShares(0n, { value: ethers.parseEther("0.05") });
          counts.buy++;
        } else if (op === 4) {
          const bal: bigint = await vault.balanceOf(who.address);
          if (bal > 0n) {
            await vault.connect(who).sellShares(bal / 3n === 0n ? bal : bal / 3n, 0n);
            counts.sell++;
          } else throw new Error("skip");
        } else if (op === 5) {
          // Add liquidity — needs shares to pull, so top the actor up first.
          const need = SHARE_UNIT * 2n;
          if ((await vault.balanceOf(who.address)) < need) {
            const bal: bigint = await vault.balanceOf(alice.address);
            if (bal >= need) await vault.connect(alice).transfer(who.address, need);
          }
          await vault.connect(who).addLiquidity(SHARE_UNIT * 3n, 0n, {
            value: ethers.parseEther("0.1"),
          });
          counts.lpAdd++;
        } else if (op === 6) {
          const lp: bigint = await vault.lpBalance(who.address);
          if (lp > 0n) {
            const take = rand() < 0.5 ? lp : lp / 2n === 0n ? lp : lp / 2n;
            await vault.connect(who).removeLiquidity(take, 0n, 0n);
            lastOpWasLpRemove = true;
            counts.lpRemove++;
          } else throw new Error("skip");
        } else if (op === 7) {
          // Targeted redeem of an arbitrary held token.
          const held: bigint = await vault.heldTokenCount();
          const target = 1 + Math.floor(rand() * Number(held === 0n ? 1n : held) * 2);
          await vault.connect(who).redeemTarget(target, { value: REDEEM_FEE + PREMIUM });
          const ti = heldTokens.indexOf(target);
          if (ti >= 0) heldTokens.splice(ti, 1);
        } else if (op === 8) {
          await vault.connect(who).withdrawFees();
        } else if (op === 9) {
          // depositMany — batch size varies across the full legal range,
          // deliberately including sizes right at/near MAX_BATCH (50) and a
          // few just over it (expected BadBatch revert).
          const roll = rand();
          let n: number;
          if (roll < 0.15) n = 1 + Math.floor(rand() * 3); // 1-3
          else if (roll < 0.7) n = 4 + Math.floor(rand() * 12); // 4-15
          else if (roll < 0.92) n = 45 + Math.floor(rand() * 6); // 45-50
          else n = 51 + Math.floor(rand() * 5); // 51-55, over MAX_BATCH
          const ids: number[] = [];
          for (let i = 0; i < n; i++) ids.push(await mintTo(who));
          await vault.connect(who).depositMany(ids, { value: MINT_FEE * BigInt(n) });
          heldTokens.push(...ids);
          counts.depositMany++;
        } else if (op === 10) {
          // redeemTargetMany — batch-redeem N specific held tokens. Sometimes
          // first put a pending pinned redeem in flight so the batch lands
          // concurrently with (or right after) it, per the review's flagged
          // untested interaction.
          if (rand() < 0.35 && (await vault.pendingRequester()) === ethers.ZeroAddress) {
            try {
              const setupWho = actors[Math.floor(rand() * actors.length)];
              await vault.connect(setupWho).requestRandomRedeem({ value: REDEEM_FEE });
              if (rand() < 0.6) await relayPendingRound(vault, beacon, step);
            } catch {
              // Setup revert is fine — we still attempt the batch below.
            }
          }
          const roll = rand();
          let n: number;
          if (roll < 0.2) n = 1 + Math.floor(rand() * 3); // 1-3
          else if (roll < 0.75) n = 4 + Math.floor(rand() * 12); // 4-15
          else if (roll < 0.94) n = 45 + Math.floor(rand() * 6); // 45-50
          else n = 51 + Math.floor(rand() * 5); // 51-55, over MAX_BATCH
          // Pull from what we believe is actually held; pad with guesses
          // (same spirit as op 7) once the tracked pool runs dry — those
          // guesses are expected to legitimately revert the whole batch.
          const pool = [...heldTokens];
          const ids: number[] = [];
          for (let i = 0; i < n; i++) {
            if (pool.length > 0) {
              const idx = Math.floor(rand() * pool.length);
              ids.push(pool.splice(idx, 1)[0]);
            } else {
              ids.push(1 + Math.floor(rand() * nextId));
            }
          }
          await vault
            .connect(who)
            .redeemTargetMany(ids, { value: (REDEEM_FEE + PREMIUM) * BigInt(n) });
          for (const id of ids) {
            const i = heldTokens.indexOf(id);
            if (i >= 0) heldTokens.splice(i, 1);
          }
          counts.redeemMany++;
        } else {
          await networkHelpers.mine(1);
          await networkHelpers.time.increase(1 + Math.floor(rand() * 40_000));
          const r = await vault.pendingRequester();
          if (r !== ethers.ZeroAddress) {
            await vault.connect(who).forfeitExpiredRedeem(r);
            counts.forfeit++;
          }
        }
      } catch {
        // Reverts are expected (a guard firing is correct behaviour). What must
        // never happen is a SUCCEEDING call that violates an invariant — that
        // is what check() asserts after every iteration.
      }
      await check();
    }

    return counts;
  }

  const totals = {
    lpAdd: 0,
    lpRemove: 0,
    buy: 0,
    sell: 0,
    redeem: 0,
    forfeit: 0,
    depositMany: 0,
    redeemMany: 0,
  };
  for (const seed of [1, 7, 12345, 98765]) {
    it(`holds every invariant over 140 random ops (seed ${seed})`, async () => {
      const c = await run(seed);
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += c[key];
    });
  }

  it("actually drove the LP, trade, and redeem paths", () => {
    expect(totals.lpAdd, "add liquidity").to.be.greaterThan(0);
    expect(totals.lpRemove, "remove liquidity").to.be.greaterThan(0);
    expect(totals.buy + totals.sell, "trades").to.be.greaterThan(0);
    expect(totals.redeem, "random redeems").to.be.greaterThan(0);
    expect(totals.depositMany, "depositMany").to.be.greaterThan(0);
    expect(totals.redeemMany, "redeemTargetMany").to.be.greaterThan(0);
  });
});
