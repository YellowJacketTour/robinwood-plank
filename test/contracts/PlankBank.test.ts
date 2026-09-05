import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { assertConserved, bet, deployCasino, findRandomness, increaseToAtLeast, settleCurrent } from "./helpers/casino.js";
import { tick, type KeeperConfig } from "../../scripts/casino-keeper.js";

/**
 * PlankBank -- "deposit once, play instantly with a session key, withdraw"
 * against the REAL PlankCrash, plus every access-control boundary that keeps
 * a session key strictly weaker than the root key. Also drives the keeper's
 * tick() so the permissionless loop is proven end to end.
 */
describe("PlankBank -- session-key play against PlankCrash + keeper loop", () => {
  const E = (x: string) => ethers.parseEther(x);

  async function deploy() {
    const env = await deployCasino();
    await env.crash.fundVault({ value: E("1") });
    const [sessionKey, attacker] = env.signers.slice(10, 12);
    const cfg: KeeperConfig = {
      crash: env.crashAddr,
      lottery: await env.lottery.getAddress(),
      beacon: await env.beacon.getAddress(),
      router: await env.rakeRouter.getAddress(),
      burnEngine: await env.burnEngine.getAddress(),
      oracle: await env.oracle.getAddress(),
      mockBeacon: true,
    };
    return { env, sessionKey, attacker, cfg };
  }

  it("deposit -> grantSession -> betVia commits a seat FOR the player; winnings recycle via withdrawToBank", async () => {
    const { env, sessionKey } = await deploy();
    const { bank, crash, alice, bob } = env;
    await bank.connect(alice).deposit({ value: E("3") });
    const expiry = BigInt(await networkHelpers.time.latest()) + 3600n;
    await bank.connect(alice).grantSession(sessionKey.address, E("2"), expiry);
    const id: bigint = await crash.currentRoundId();
    const r0 = await crash.rounds(id);
    await bank.connect(sessionKey).betVia(env.crashAddr, E("1"), 15_000n);
    expect(await crash.stakeOf(id, alice.address)).to.equal(E("1"));
    expect(await crash.targetOf(id, alice.address)).to.equal(15_000n);
    expect(await bank.balanceOf(alice.address)).to.equal(E("2"));
    await bet(env, bob, "1", 20_000n);
    await settleCurrent(env, await findRandomness(env, id, BigInt(r0.targetDrandRound), (c) => c >= 20_000n));
    const won: bigint = await crash.owed(alice.address);
    expect(won).to.be.greaterThan(0n);
    await crash.connect(alice).withdrawToBank(await bank.getAddress());
    expect(await bank.balanceOf(alice.address)).to.equal(E("2") + won);
    expect(await crash.owed(alice.address)).to.equal(0n);
    await bank.connect(alice).withdrawAll();
    expect(await bank.balanceOf(alice.address)).to.equal(0n);
    await assertConserved(env, expect);
  });

  it("a session key is strictly weaker than the root key: cap, expiry, revoke, game allow-list, no withdraw", async () => {
    const { env, sessionKey, attacker } = await deploy();
    const { bank, alice } = env;
    await bank.connect(alice).deposit({ value: E("5") });
    const expiry = BigInt(await networkHelpers.time.latest()) + 100n;
    await bank.connect(alice).grantSession(sessionKey.address, E("1.5"), expiry);
    await expect(bank.connect(sessionKey).betVia(env.crashAddr, E("2"), 15_000n)).to.be.revertedWithCustomError(bank, "CapExceeded");
    await expect(bank.connect(sessionKey).betVia(attacker.address, E("1"), 15_000n)).to.be.revertedWithCustomError(bank, "NotAGame");
    await expect(bank.connect(attacker).betVia(env.crashAddr, E("1"), 15_000n)).to.be.revertedWithCustomError(bank, "SessionInvalid");
    await expect(bank.connect(attacker).grantSession(sessionKey.address, E("1"), expiry)).to.be.revertedWithCustomError(bank, "KeyInUse");
    // No withdraw surface for a session key, at all.
    const names = bank.interface.fragments.filter((f: any) => f.type === "function").map((f: any) => f.name as string);
    expect(names.some((n) => /withdrawVia|cashOut/i.test(n))).to.equal(false);
    await bank.connect(alice).revokeSession(sessionKey.address);
    await expect(bank.connect(sessionKey).betVia(env.crashAddr, E("1"), 15_000n)).to.be.revertedWithCustomError(bank, "SessionInvalid");
    await bank.connect(alice).grantSession(sessionKey.address, E("1.5"), expiry);
    await increaseToAtLeast(expiry + 1n);
    await expect(bank.connect(sessionKey).betVia(env.crashAddr, E("1"), 15_000n)).to.be.revertedWithCustomError(bank, "SessionExpired");
    await expect(bank.connect(attacker).creditFor(alice.address, { value: 1n })).to.be.revertedWithCustomError(bank, "NotAGame");
    await expect(bank.connect(alice).withdraw(E("6"))).to.be.revertedWithCustomError(bank, "InsufficientBalance");
  });

  it("the keeper's tick() drives lock -> relay -> settle -> flush -> router claims -> burn with a gas-only signer", async () => {
    const { env, cfg } = await deploy();
    const { crash, alice, bob, keeper } = env;
    await bet(env, alice, "2", 15_000n);
    await bet(env, bob, "2", 20_000n);
    const id: bigint = await crash.currentRoundId();
    const r0 = await crash.rounds(id);
    const steps = new Set<string>();
    const run = async () => { for (const a of await tick(ethers.provider, keeper, cfg)) steps.add(a.step); };
    await run(); // nothing actionable yet (betting open)
    expect(steps.has("lockRound")).to.equal(false);
    await increaseToAtLeast(BigInt(r0.bettingEndsAt));
    await run(); // lock
    expect((await crash.rounds(id)).phase).to.equal(1n);
    await increaseToAtLeast(BigInt(r0.revealNotBefore));
    await run(); // mock relay + settle (+ flush on the same tick)
    expect((await crash.rounds(id)).phase).to.equal(2n);
    await networkHelpers.time.increase(61);
    await run(); // router legs + oracle prime + burn
    await run();
    for (const s of ["lockRound", "mockBeacon.setRandomness", "settleRound", "flushRake", "router.claimBurn", "router.claimLottery", "router.claimVault", "router.claimFounders", "oracle.update", "executeBurn"]) {
      expect(steps.has(s), `keeper step ${s}`).to.equal(true);
    }
    expect(await env.burnEngine.totalPlankBurned()).to.be.greaterThan(0n);
    expect(await env.lottery.totalFunded()).to.be.greaterThan(0n);
    expect(await crash.protectedPrincipal()).to.be.greaterThan(0n);
    // Zero privilege: the keeper earned nothing (keeperRewardBps 0) and can redirect nothing.
    expect(await crash.owed(keeper.address)).to.equal(0n);
    await assertConserved(env, expect);
  });
});
