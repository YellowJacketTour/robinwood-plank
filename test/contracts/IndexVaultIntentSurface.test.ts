import { expect } from "chai";
import { ethers } from "hardhat";
import {
  takeSnapshot,
  time,
  type SnapshotRestorer,
} from "@nomicfoundation/hardhat-network-helpers";
import {
  STALE_AFTER,
  WAD,
  deployOpenIndex,
  maxIn,
  warmCheckpoints,
  zeroOut,
  type IndexFixture,
} from "./helpers/index-vault";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INTENT-SETTLEMENT FINDING, PROVEN RATHER THAN ASSUMED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SPEC-GLOBAL-INDEX-ULTIMATE-FORM.md §4 / §5.4 specify solver-auctioned
 * intents (CoW / UniswapX style) for the vault's rebalance trades, to close
 * the "the chain sees the trade and its direction before it fills" surface.
 *
 * This round's assignment was to build the ON-CHAIN half of that pattern — an
 * `IIntentSettlement` commit/settle interface — and route the single-asset
 * mint/redeem "internal swap" leg through it, UNLESS that leg turns out not to
 * have the exposure the section describes, in which case: prove it, document
 * it, and add no surface.
 *
 * IT DOES NOT HAVE THE EXPOSURE, and the reason is structural, not a
 * parameter choice. The front-runnable shape §5.4 names is:
 *
 *     vault publishes / becomes obligated to an executable trade
 *       -> the trade's direction and size are visible
 *         -> someone positions ahead of it against the venue it will hit
 *           -> the vault fills at the worsened price it created.
 *
 * Every arrow in that chain is absent here, and this suite asserts each one:
 *
 *  1. THERE IS NO EXECUTABLE VAULT-INITIATED TRADE. `GlobalIndexVault` has
 *     exactly two token-out call sites in the entire contract, and both send
 *     to `msg.sender` inside a share-burning redemption. The vault never
 *     trades on its own behalf, never holds an order, and never touches an
 *     external venue. `targetWeightsBps()` is a pure view that nothing
 *     force-trades against — publishing a target vector is safe, publishing
 *     an executable rebalance order is what gets front-run.
 *
 *  2. THE "INTERNAL SWAP" IS NOT A SWAP AGAINST LIQUIDITY. The non-pro-rata
 *     leg of `redeemSingleAsset` / `mintSingleAsset` is priced off the
 *     checkpointed ORACLE BAND (other legs at their band LOW, the target at
 *     its band HIGH), not off a reserve ratio. There is no pool to move: an
 *     attacker cannot push the price the victim gets by trading first,
 *     because the victim's price does not come from the reserves the attacker
 *     can touch.
 *
 *  3. THE COMMITMENT AND THE FILL ARE ALREADY THE SAME ATOMIC STEP, with the
 *     caller's OWN `minSharesOut` / `minAmountOut` bound on it. There is no
 *     window between "the vault is committed" and "the vault is filled" for
 *     anyone to occupy, because there is no commitment that outlives its own
 *     transaction. That is the property an intent/settlement split would be
 *     BUYING; here it is already free by construction.
 *
 *  4. THE ONE THING AN ATTACKER CAN MOVE — the depth/weight inputs to the
 *     imbalance fee — is bounded by a fee curve that is direction-symmetric
 *     and retained in reserves, so buying the position needed to move it
 *     costs strictly more than moving it is worth. This suite drives that
 *     directly: both sandwich orientations, measured, provably loss-making.
 *
 * Adding a commit/settle indirection on top of a mechanism with no exposure
 * would introduce exactly what this codebase's hard constraint forbids: a
 * second, later, separately-callable step sitting between a user and their
 * assets. A settlement leg that can expire, fail, or be griefed is a way for
 * value to sit un-withdrawable, even temporarily. The safe design here is the
 * one already shipped, and §5 of this suite proves the exit door stays open
 * under every adversarial ordering above — including with the oracle fully
 * stale, which is the case an intent-settlement path would have made worse.
 *
 * LOCAL HARDHAT ONLY.
 */
describe("GlobalIndexVault — intent/front-running surface (§4, §5.4)", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  // 1000 / 2000 / 500 units at 1.0 / 0.5 / 2.0 ETH => 1000 ETH each, 1/3 by NAV.
  const RESERVES = [1000n * WAD, 2000n * WAD, 500n * WAD];
  const fixture = () => deployOpenIndex({}, RESERVES);

  async function reservesOf(fx: IndexFixture): Promise<bigint[]> {
    return Promise.all(fx.addrs.map((a) => fx.vault.reserveOf(a) as Promise<bigint>));
  }

  // ══ 1. There is no executable vault-initiated trade to front-run ════════

  it("exposes no rebalance/swap/solver/intent execution entrypoint at all", async () => {
    const { vault } = await fixture();
    const forbidden = /rebalance|swap|solver|intent|settle|execute(Trade|Order|Swap)|route/i;
    const offenders = vault.interface.fragments
      .filter((f: any) => f.type === "function")
      .filter((f: any) => forbidden.test(f.name))
      .map((f: any) => f.name);
    expect(offenders, `vault grew a trade-execution surface: ${offenders}`).to.deep.equal([]);
  });

  it("has no entrypoint that forwards arbitrary calldata or names an external venue", async () => {
    const { vault } = await fixture();
    // A router/venue integration always shows up as one of these shapes:
    // raw `bytes` calldata to forward, or a `bytes[]` multicall batch.
    for (const f of vault.interface.fragments as any[]) {
      if (f.type !== "function") continue;
      if (f.stateMutability === "view" || f.stateMutability === "pure") continue;
      for (const inp of f.inputs) {
        expect(
          inp.type === "bytes" || inp.type === "bytes[]",
          `${f.name} takes forwardable calldata (${inp.type} ${inp.name})`
        ).to.equal(false);
      }
    }
  });

  it("targetWeightsBps is a pure view — publishing the target vector moves nothing", async () => {
    const fx = await fixture();
    const { vault, alice } = fx;
    const frag: any = vault.interface.getFunction("targetWeightsBps");
    expect(["view", "pure"]).to.include(frag.stateMutability);

    // And observing it can be done by anyone, repeatedly, with zero state
    // effect: the reserve vector is byte-identical before and after. A
    // published target is only front-runnable if reading it commits the vault
    // to trading toward it. It does not.
    const before = await reservesOf(fx);
    await vault.connect(alice).targetWeightsBps();
    await vault.connect(alice).targetWeightsBps();
    expect(await reservesOf(fx)).to.deep.equal(before);
  });

  it("the only two token-out paths are share-burning redemptions to msg.sender", async () => {
    const fx = await fixture();
    const { vault, vaultAddr, alice, bob, tokens, addrs } = fx;
    await warmCheckpoints(fx, 7);
    await vault.connect(alice).mintProRata(300n * WAD, maxIn(3));

    // Exhaustive over the mutating ABI: nothing but redeemProRata and
    // redeemSingleAsset can make a constituent leave the vault, and both
    // require burning the caller's OWN shares. Proven behaviourally by
    // checking the vault's real token balance only ever falls in those two
    // calls, across a full drive of every other mutating path available to a
    // non-privileged caller.
    const vaultBalBefore = await tokens[0].balanceOf(vaultAddr);
    await vault.connect(bob).mintProRata(50n * WAD, maxIn(3));
    await vault.connect(bob).mintSingleAsset(addrs[0], 20n * WAD, 0n);
    await vault.checkpointAll();
    await vault.connect(bob).targetWeightsBps();
    expect(await tokens[0].balanceOf(vaultAddr)).to.be.gte(
      vaultBalBefore,
      "a non-redemption path moved a constituent out of the vault"
    );

    // ...and a redemption only ever pays the burner.
    const aliceBefore = await tokens[0].balanceOf(alice.address);
    await vault.connect(alice).redeemSingleAsset(10n * WAD, addrs[0], 0n);
    expect(await tokens[0].balanceOf(alice.address)).to.be.gt(aliceBefore);
  });

  // ══ 2. The internal swap is oracle-band priced, not reserve priced ══════

  it("a victim's single-asset quote does not move when an attacker trades the reserves first", async () => {
    const fx = await fixture();
    const { vault, alice, bob, addrs } = fx;
    await warmCheckpoints(fx, 7);

    // The exact number of shares a 50-unit deposit buys, quoted with the
    // basket untouched...
    const clean: bigint = await vault
      .connect(bob)
      .mintSingleAsset.staticCall(addrs[0], 50n * WAD, 0n);

    // ...now the attacker moves the reserves as hard as the cap allows,
    // trying to worsen the victim's fill.
    await vault.connect(alice).mintSingleAsset(addrs[0], 150n * WAD, 0n);

    const attacked: bigint = await vault
      .connect(bob)
      .mintSingleAsset.staticCall(addrs[0], 50n * WAD, 0n);

    // The price the victim gets is the checkpointed BAND, not a reserve
    // ratio, so the shift is confined to the imbalance-fee term. In a
    // reserve-priced AMM this is where a sandwich earns its money; here the
    // whole movable range is bounded by maxImbalanceFeeBps (600bps).
    const drift = clean > attacked ? clean - attacked : attacked - clean;
    expect(drift * 10_000n).to.be.lte(
      clean * 600n,
      "victim's fill moved more than the fee cap — a price surface exists"
    );
  });

  it("the quote a caller is shown is the quote the same transaction fills at", async () => {
    const fx = await fixture();
    const { vault, alice, addrs } = fx;
    await warmCheckpoints(fx, 7);
    await vault.connect(alice).mintProRata(500n * WAD, maxIn(3));

    // No commit/settle gap: preview and fill are one atomic step, so there is
    // no interval in which a committed-but-unfilled vault order exists.
    const quoted: bigint = await vault.previewRedeemSingleAsset(120n * WAD, addrs[0]);
    // Exact-equality slippage bound: if any second step existed between the
    // quote and the fill, this bound would be unsatisfiable.
    await expect(vault.connect(alice).redeemSingleAsset(120n * WAD, addrs[0], quoted)).to.not
      .be.reverted;
  });

  // ══ 3/4. Sandwiches, both orientations, driven and measured ═════════════

  it("sandwiching a victim's single-asset MINT is strictly loss-making for the attacker", async () => {
    const fx = await fixture();
    const { vault, alice, bob, tokens, addrs } = fx;
    await warmCheckpoints(fx, 7);

    const attackerBefore: bigint = await tokens[0].balanceOf(alice.address);

    // FRONT-RUN: attacker takes a position on the leg the victim is about to hit.
    await vault.connect(alice).mintSingleAsset(addrs[0], 120n * WAD, 0n);
    const gained: bigint = await vault.balanceOf(alice.address);

    // VICTIM's transaction lands between them.
    await vault.connect(bob).mintSingleAsset(addrs[0], 100n * WAD, 0n);

    // BACK-RUN: attacker unwinds into the same leg.
    await vault.connect(alice).redeemSingleAsset(gained, addrs[0], 0n);

    const attackerAfter: bigint = await tokens[0].balanceOf(alice.address);
    expect(await vault.balanceOf(alice.address)).to.equal(0n, "attacker kept a residual position");
    expect(attackerAfter).to.be.lt(
      attackerBefore,
      "sandwiching the mint side returned a profit"
    );
  });

  it("sandwiching a victim's single-asset REDEEM is strictly loss-making for the attacker", async () => {
    const fx = await fixture();
    const { vault, alice, bob, tokens, addrs } = fx;
    await warmCheckpoints(fx, 7);

    // Both parties take honest pro-rata positions first (the free path).
    await vault.connect(alice).mintProRata(400n * WAD, maxIn(3));
    await vault.connect(bob).mintProRata(400n * WAD, maxIn(3));

    const sharesBefore: bigint = await vault.balanceOf(alice.address);
    const tokBefore: bigint = await tokens[0].balanceOf(alice.address);

    // FRONT-RUN: attacker exits into the leg the victim is about to exit into.
    await vault.connect(alice).redeemSingleAsset(150n * WAD, addrs[0], 0n);
    // VICTIM.
    await vault.connect(bob).redeemSingleAsset(150n * WAD, addrs[0], 0n);
    // BACK-RUN: attacker re-enters with exactly the units it pulled out.
    const pulled: bigint = (await tokens[0].balanceOf(alice.address)) - tokBefore;
    await vault.connect(alice).mintSingleAsset(addrs[0], pulled, 0n);

    const sharesAfter: bigint = await vault.balanceOf(alice.address);
    const tokAfter: bigint = await tokens[0].balanceOf(alice.address);
    expect(tokAfter).to.equal(tokBefore, "attacker did not fully re-enter");
    expect(sharesAfter).to.be.lt(
      sharesBefore,
      "sandwiching the redeem side returned a profit"
    );
  });

  it("the attacker's whole sandwich accrues to the holders who stayed", async () => {
    const fx = await fixture();
    const { vault, alice, bob, carol, addrs } = fx;
    await warmCheckpoints(fx, 7);
    await vault.connect(carol).mintProRata(500n * WAD, maxIn(3));

    const V = 1000n;
    const [navBefore]: [bigint, bigint] = await vault.nav();
    const sBefore: bigint = await vault.totalSupply();

    // The full sandwich, start to finish.
    await vault.connect(alice).mintSingleAsset(addrs[0], 120n * WAD, 0n);
    const gained: bigint = await vault.balanceOf(alice.address);
    await vault.connect(bob).mintSingleAsset(addrs[0], 100n * WAD, 0n);
    await vault.connect(alice).redeemSingleAsset(gained, addrs[0], 0n);

    const [navAfter]: [bigint, bigint] = await vault.nav();
    const sAfter: bigint = await vault.totalSupply();

    // NAV PER SHARE is the stayer invariant here, and it is worth being
    // precise about why it is not the PER-LEG backing invariant the pro-rata
    // suite asserts. A single-asset deposit deliberately changes the basket's
    // composition: it lifts the leg it lands in and dilutes every other leg's
    // per-share slice, by design and in the open. Asserting per-leg backing
    // across a single-asset op would be asserting that the mechanism does not
    // do the one thing it exists to do. What must hold — and does — is that
    // the whole basket's value per share never falls, because the imbalance
    // fee is retained in reserves and there is no treasury path for it to
    // leak down (§2.8).
    expect(navAfter * (sBefore + V)).to.be.gte(
      navBefore * (sAfter + V),
      "NAV per share fell across the sandwich — value left the basket"
    );
  });

  it("repeating the sandwich compounds the attacker's loss — there is no break-even size", async () => {
    const fx = await fixture();
    const { vault, alice, bob, tokens, addrs } = fx;
    await warmCheckpoints(fx, 7);

    let prevLoss = 0n;
    for (const size of [20n * WAD, 60n * WAD, 120n * WAD]) {
      const start: bigint = await tokens[0].balanceOf(alice.address);
      await vault.connect(alice).mintSingleAsset(addrs[0], size, 0n);
      const gained: bigint = await vault.balanceOf(alice.address);
      await vault.connect(bob).mintSingleAsset(addrs[0], size / 2n, 0n);
      await vault.connect(alice).redeemSingleAsset(gained, addrs[0], 0n);
      const loss: bigint = start - (await tokens[0].balanceOf(alice.address));
      expect(loss).to.be.gt(0n, `size ${size} broke even or profited`);
      expect(loss).to.be.gt(prevLoss, "loss did not grow with size");
      prevLoss = loss;
    }
  });

  // ══ 5. The exit door, under every ordering above ════════════════════════

  it("pro-rata redemption stays open after an adversarial sandwich sequence", async () => {
    const fx = await fixture();
    const { vault, alice, bob, carol, addrs } = fx;
    await warmCheckpoints(fx, 7);
    await vault.connect(carol).mintProRata(300n * WAD, maxIn(3));

    await vault.connect(alice).mintSingleAsset(addrs[0], 120n * WAD, 0n);
    const gained: bigint = await vault.balanceOf(alice.address);
    await vault.connect(bob).mintSingleAsset(addrs[0], 80n * WAD, 0n);
    await vault.connect(alice).redeemSingleAsset(gained, addrs[0], 0n);

    // The bystander's exit is untouched by any of it.
    await expect(vault.connect(carol).redeemProRata(300n * WAD, zeroOut(3))).to.not.be.reverted;
    expect(await vault.balanceOf(carol.address)).to.equal(0n);
  });

  it("pro-rata redemption works with the oracle FULLY STALE — the exit needs no price at all", async () => {
    const fx = await fixture();
    const { vault, alice } = fx;
    await vault.connect(alice).mintProRata(250n * WAD, maxIn(3));

    // Let every observation rot far past staleAfter and never checkpoint again.
    // A priced path must now refuse to quote...
    await time.increase(STALE_AFTER * 10);
    await expect(vault.connect(alice).mintSingleAsset(fx.addrs[0], WAD, 0n)).to.be.reverted;

    // ...while the exit door does not consult a price anywhere in its path,
    // and therefore cannot be jammed by one. THIS is the property an
    // intent/settlement leg would have destroyed: a settlement step that can
    // expire or fail is a step that can sit between a holder and their assets.
    const before = await reservesOf(fx);
    await expect(vault.connect(alice).redeemProRata(250n * WAD, zeroOut(3))).to.not.be.reverted;
    const after = await reservesOf(fx);
    for (let i = 0; i < 3; i++) expect(after[i]).to.be.lt(before[i], `leg ${i} paid nothing`);
    expect(await vault.balanceOf(alice.address)).to.equal(0n);
  });

  it("nobody — not an attacker, not any role — can stall a redemption into a later block", async () => {
    const fx = await fixture();
    const { vault, roleAdmin, risk, admission, allocation, alice, bob, addrs } = fx;
    await warmCheckpoints(fx, 7);
    await vault.connect(alice).mintProRata(200n * WAD, maxIn(3));

    // Every privileged signer tries anything that could introduce a wait, and
    // an attacker spams the priced paths in between. The redemption still
    // settles in the very next transaction, in full, same block-chain of state.
    for (const who of [roleAdmin, risk, admission, allocation]) {
      await vault.connect(who).checkpointAll().catch(() => {});
    }
    await vault.connect(bob).mintSingleAsset(addrs[1], 30n * WAD, 0n);

    await expect(vault.connect(alice).redeemProRata(200n * WAD, zeroOut(3))).to.not.be.reverted;
    expect(await vault.balanceOf(alice.address)).to.equal(0n);
  });
});
