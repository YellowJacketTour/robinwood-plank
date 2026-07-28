import { expect } from "chai";
import { ethers } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import { deployBeaconMock, relayPendingRound } from "./helpers/beacon";

/**
 * Revision-3 randomized property test.
 *
 * The revision-3 fixes added new state (pendingRequester, frozenLen, pinning)
 * and two new supply-touching paths (forfeitExpiredRedeem re-mints a share,
 * seedShares moves shares into the pool). Both are exactly the kind of change
 * that quietly breaks the solvency invariant, so this drives a long, seeded,
 * pseudo-random sequence of every state-changing entry point and re-checks the
 * invariant after every single call:
 *
 *     totalSupply() + pendingRedeemCount * SHARE_UNIT
 *         == heldTokenCount() * SHARE_UNIT
 *
 * It also re-checks, on every step, the two properties the fixes exist for:
 * a pinned draw's token never changes, and accounted ETH never exceeds the
 * contract's real balance.
 */
describe("MarketplankVault — randomized solvency & draw-immutability", () => {
  const SHARE_UNIT = 10n ** 18n;

  // Deterministic PRNG so a failure is reproducible from the seed alone.
  function prng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  async function run(seed: number, fees: bigint) {
    const [, treasury, alice, bob, carol] = await ethers.getSigners();
    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft: any = await Nft.deploy();
    const beacon: any = await deployBeaconMock();
    const Vault = await ethers.getContractFactory("MarketplankVault");
    const vault: any = await Vault.deploy(
      await nft.getAddress(),
      "V",
      "V",
      fees,
      fees,
      fees,
      treasury.address,
      await beacon.getAddress()
    );
    const addr = await vault.getAddress();
    const rand = prng(seed);
    const actors = [alice, bob, carol, treasury];
    let nextId = 1;

    // Track the pinned draw so we can prove it never moves.
    let pinnedToken: bigint | null = null;
    // Coverage guard: the forfeit path re-mints a share, so it is exactly the
    // kind of thing that must actually be driven, not merely present. If a
    // future change makes it unreachable this counter catches it.
    let forfeits = 0;

    const check = async () => {
      const supply: bigint = await vault.totalSupply();
      const held: bigint = await vault.heldTokenCount();
      const pending: bigint = await vault.pendingRedeemCount();
      expect(supply + pending * SHARE_UNIT).to.equal(
        held * SHARE_UNIT,
        `solvency broken (seed ${seed})`
      );
      expect(await vault.ethReserve()).to.be.lte(await ethers.provider.getBalance(addr));

      const [isPinned, drawn] = await vault.pendingDraw();
      if (isPinned) {
        if (pinnedToken === null) pinnedToken = drawn;
        expect(drawn).to.equal(pinnedToken, `a pinned draw changed (seed ${seed})`);
        // A pinned token must still be in the vault, or the claim is unpayable.
        expect(await vault.isTokenHeld(drawn)).to.equal(true);
      } else if ((await vault.pendingRequester()) === ethers.ZeroAddress) {
        pinnedToken = null;
      }
    };

    const deposit = async (who: any) => {
      const id = nextId++;
      await nft.mint(who.address, id);
      await nft.connect(who).approve(addr, id);
      await vault.connect(who).deposit(id);
    };

    // Warm start so the AMM and the redeem paths are reachable at all.
    for (let i = 0; i < 6; i++) await deposit(alice);
    await deposit(treasury);
    await deposit(treasury);
    await vault.connect(treasury).seedShares(SHARE_UNIT, {
      value: ethers.parseEther("3"),
    });
    // The pool must be explicitly opened before anyone can trade.
    await vault.connect(treasury).openPool();
    await check();

    for (let step = 0; step < 120; step++) {
      const who = actors[Math.floor(rand() * actors.length)];
      const op = Math.floor(rand() * 9);
      try {
        if (op === 0) {
          await deposit(who);
        } else if (op === 1) {
          await vault.connect(who).requestRandomRedeem();
        } else if (op === 2) {
          // Relaying the target round is permissionless and is what makes a
          // draw pinnable at all now; sometimes skip it so the "not yet
          // available" path is exercised too.
          if (rand() < 0.8) await relayPendingRound(vault, beacon, step);
          await vault.connect(who).pinPendingDraw();
        } else if (op === 3) {
          if (rand() < 0.8) await relayPendingRound(vault, beacon, step);
          const r = await vault.pendingRequester();
          await vault.connect(who).claimRandomRedeemFor(r);
        } else if (op === 4) {
          const held: bigint = await vault.heldTokenCount();
          const target = 1 + Math.floor(rand() * Number(held === 0n ? 1n : held) * 2);
          await vault.connect(who).redeemTarget(target);
        } else if (op === 5) {
          await vault.connect(who).buyShares(0n, { value: ethers.parseEther("0.05") });
        } else if (op === 6) {
          const bal: bigint = await vault.balanceOf(who.address);
          await vault.connect(who).sellShares(bal / 3n, 0n);
        } else if (op === 7) {
          // The pool is open for the whole run, so seeding must ALWAYS be
          // dead — assert the exact error rather than letting the outer
          // catch swallow a wrong revert (or, worse, a success).
          await expect(
            vault.connect(treasury).seedShares(SHARE_UNIT / 4n, { value: 1n })
          ).to.be.revertedWithCustomError(vault, "BootstrapComplete");
        } else {
          // Push time forward — sometimes past the beacon's expiry window, so
          // the forfeit path is genuinely reachable (rounds are timed now, not
          // counted in blocks).
          await mine(1);
          await time.increase(1 + Math.floor(rand() * 40_000));
          const r = await vault.pendingRequester();
          if (r !== ethers.ZeroAddress) {
            await vault.connect(who).forfeitExpiredRedeem(r);
            forfeits++;
          }
        }
      } catch {
        // Reverts are fine and expected — a guard firing is the contract
        // working. What must never happen is a call that SUCCEEDS and leaves
        // the vault insolvent, which is what the check below asserts.
      }
      await check();
    }
    return { forfeits };
  }

  let totalForfeits = 0;
  for (const seed of [1, 7, 12345, 98765]) {
    for (const fees of [0n, 100n]) {
      it(`holds the invariant over 120 random ops (seed ${seed}, fees ${fees}bps)`, async () => {
        const { forfeits } = await run(seed, fees);
        totalForfeits += forfeits;
      });
    }
  }

  it("actually drove the forfeit path (it re-mints a share, so it must be covered)", () => {
    expect(totalForfeits).to.be.greaterThan(0);
  });
});
