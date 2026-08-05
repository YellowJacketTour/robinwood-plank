import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployBeaconMock } from "./helpers/beacon";

/**
 * TBAValueSweeper — universal stranded-value sweep.
 *
 * The vault holds NFTs; those NFTs own ERC-6551 token-bound accounts; those
 * accounts keep accruing value after mint (the StonkBrokers shape). These
 * tests are adversarial, not demonstrative: every one of them is a thing an
 * attacker, a griefer, or a compromised allowlist key would try.
 *
 * The two load-bearing invariants, proved by name at the bottom:
 *   - UNMOVABLE-ASSETS (a): no sweep state can gate, delay or block a user's
 *     own redemption, in any configuration.
 *   - UNMOVABLE-ASSETS (b): once value is swept and credited, no role has a
 *     claw-back path to it.
 */
describe("TBAValueSweeper — stranded-value capture", () => {
  const SHARE_UNIT = 10n ** 18n;
  const MINT_FEE = ethers.parseEther("0.001");
  const REDEEM_FEE = ethers.parseEther("0.001");
  const PREMIUM = ethers.parseEther("0.002");
  const TARGET_COST = REDEEM_FEE + PREMIUM;
  const DELAY = 2 * 24 * 60 * 60; // 2 days, inside [1, 30] days

  const KIND_NONE = 0;
  const KIND_ERC20 = 1;
  const KIND_ERC721 = 2;
  const KIND_PM = 3;

  /**
   * A vault holding 4 NFTs, each with its own TBA, plus a deployed sweeper
   * that the TBAs recognise as a permitted executor (the documented
   * deployment prerequisite — a real ERC-6551 account only executes for its
   * owner or an owner-permitted caller).
   */
  async function fixture() {
    const [deployer, treasury, alice, bob, roleAdmin, allowAdmin, outsider] =
      await ethers.getSigners();

    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft: any = await Nft.deploy();
    const beacon: any = await deployBeaconMock();
    const Vault = await ethers.getContractFactory("MarketplankVaultV3");
    const vault: any = await Vault.deploy(
      await nft.getAddress(),
      "vROBIN3",
      "vROBIN3",
      MINT_FEE,
      REDEEM_FEE,
      PREMIUM,
      30n,
      treasury.address,
      await beacon.getAddress()
    );
    const vaultAddr = await vault.getAddress();
    const nftAddr = await nft.getAddress();

    for (let id = 1; id <= 4; id++) {
      await nft.mint(alice.address, id);
      await nft.connect(alice).approve(vaultAddr, id);
      await vault.connect(alice).deposit(id, { value: MINT_FEE });
    }

    // The sinks. `reserveSink` stands in for the accounted-reserve / dividend
    // machinery; `miscellanySink` is the deliberately-separate swept-NFT
    // holding, which construction forbids from being the vault.
    const Sink = await ethers.getContractFactory("MockMiscellanySink");
    const reserveSink: any = await Sink.deploy();
    const miscSink: any = await Sink.deploy();
    const reserveAddr = await reserveSink.getAddress();
    const miscAddr = await miscSink.getAddress();

    const chainId = (await ethers.provider.getNetwork()).chainId;

    const Sweeper = await ethers.getContractFactory("TBAValueSweeper");
    const sweeper: any = await Sweeper.deploy(
      nftAddr,
      vaultAddr,
      reserveAddr,
      miscAddr,
      DELAY,
      [roleAdmin.address, allowAdmin.address]
    );
    const sweeperAddr = await sweeper.getAddress();

    // One TBA per held NFT, each bound to its own token id.
    const TBA = await ethers.getContractFactory("MockTBA");
    const tbas: any[] = [];
    for (let id = 1; id <= 4; id++) {
      const tba: any = await TBA.deploy(chainId, nftAddr, id);
      await tba.setOperator(sweeperAddr, true);
      tbas.push(tba);
    }

    return {
      deployer,
      treasury,
      alice,
      bob,
      roleAdmin,
      allowAdmin,
      outsider,
      nft,
      nftAddr,
      vault,
      vaultAddr,
      sweeper,
      sweeperAddr,
      reserveSink,
      reserveAddr,
      miscSink,
      miscAddr,
      tbas,
      chainId,
    };
  }

  /** Push an asset through the full timelocked allowlist path. */
  async function allowlist(sweeper: any, allowAdmin: any, kind: number, asset: string) {
    await sweeper.connect(allowAdmin).queueAsset(kind, asset, true);
    await time.increase(DELAY + 1);
    await sweeper.executeAsset(kind, asset);
  }

  async function deployToken(name = "Airdrop", sym = "AIR") {
    const T = await ethers.getContractFactory("MockIndexToken");
    return (await T.deploy(name, sym)) as any;
  }

  // ── Construction: the structural guarantees ─────────────────────────────

  it("refuses a construction that would commingle swept NFTs with the basket", async () => {
    const { nftAddr, vaultAddr, reserveAddr, roleAdmin, allowAdmin } = await fixture();
    const Sweeper = await ethers.getContractFactory("TBAValueSweeper");
    // miscellanySink == vault is exactly the commingling this forbids.
    await expect(
      Sweeper.deploy(nftAddr, vaultAddr, reserveAddr, vaultAddr, DELAY, [
        roleAdmin.address,
        allowAdmin.address,
      ])
    ).to.be.revertedWithCustomError(Sweeper, "BadParam");
  });

  it("publishes its structural facts: push-only, no custody, no redemption reach, no calldata forwarding", async () => {
    const { sweeper } = await fixture();
    const [pushOnly, holdsCustody, canBlock, forwards] = await sweeper.capabilities();
    expect(pushOnly).to.equal(true);
    expect(holdsCustody).to.equal(false);
    expect(canBlock).to.equal(false);
    expect(forwards).to.equal(false);
  });

  it("exposes NO function that takes raw calldata or a recipient — the drain is absent, not guarded", async () => {
    const sweeper = await ethers.getContractFactory("TBAValueSweeper");
    const frag = sweeper.interface.fragments.filter((f: any) => f.type === "function");
    for (const f of frag as any[]) {
      for (const input of f.inputs) {
        expect(input.type, `${f.name} takes raw bytes`).to.not.equal("bytes");
      }
      expect(
        f.name.toLowerCase(),
        "a forwarder/rescue/withdraw surface exists"
      ).to.not.match(/forward|rescue|withdraw|sweepto|call|delegate/);
    }
  });

  // ── Primitive 1: ERC-20 ─────────────────────────────────────────────────

  it("sweeps a stranded ERC-20 out of a held NFT's TBA into the reserve sink", async () => {
    const { sweeper, allowAdmin, tbas, reserveAddr, outsider } = await fixture();
    const tok = await deployToken();
    const tokAddr = await tok.getAddress();
    await tok.mint(await tbas[0].getAddress(), 500n);
    await allowlist(sweeper, allowAdmin, KIND_ERC20, tokAddr);

    // Permissionless: an outsider with no stake triggers it.
    await sweeper.connect(outsider).sweepTBAERC20(1, await tbas[0].getAddress(), tokAddr);

    expect(await tok.balanceOf(reserveAddr)).to.equal(500n);
    expect(await tok.balanceOf(await tbas[0].getAddress())).to.equal(0n);
  });

  it("a non-allowlisted ERC-20 cannot be swept, no matter how much sits there", async () => {
    const { sweeper, tbas } = await fixture();
    const tok = await deployToken("Junk", "JNK");
    await tok.mint(await tbas[0].getAddress(), 10n ** 24n);
    await expect(
      sweeper.sweepTBAERC20(1, await tbas[0].getAddress(), await tok.getAddress())
    ).to.be.revertedWithCustomError(sweeper, "NotAllowlisted");
  });

  it("a queued-but-not-yet-executed allowlist entry grants nothing", async () => {
    const { sweeper, allowAdmin, tbas } = await fixture();
    const tok = await deployToken();
    const tokAddr = await tok.getAddress();
    await tok.mint(await tbas[0].getAddress(), 100n);
    await sweeper.connect(allowAdmin).queueAsset(KIND_ERC20, tokAddr, true);
    await expect(
      sweeper.sweepTBAERC20(1, await tbas[0].getAddress(), tokAddr)
    ).to.be.revertedWithCustomError(sweeper, "NotAllowlisted");
    // And executing early is refused too.
    await expect(sweeper.executeAsset(KIND_ERC20, tokAddr)).to.be.revertedWithCustomError(
      sweeper,
      "TimelockNotElapsed"
    );
  });

  it("double-sweep is idempotent: the second call reverts and credits nothing twice", async () => {
    const { sweeper, allowAdmin, tbas, reserveAddr } = await fixture();
    const tok = await deployToken();
    const tokAddr = await tok.getAddress();
    await tok.mint(await tbas[0].getAddress(), 777n);
    await allowlist(sweeper, allowAdmin, KIND_ERC20, tokAddr);

    await sweeper.sweepTBAERC20(1, await tbas[0].getAddress(), tokAddr);
    const after = await tok.balanceOf(reserveAddr);
    await expect(
      sweeper.sweepTBAERC20(1, await tbas[0].getAddress(), tokAddr)
    ).to.be.revertedWithCustomError(sweeper, "NothingToSweep");
    expect(await tok.balanceOf(reserveAddr)).to.equal(after);
  });

  it("a fee-on-transfer token credits the ACTUAL delta, never the nominal amount", async () => {
    const { sweeper, allowAdmin, tbas, reserveAddr } = await fixture();
    const tok = await deployToken("Fee", "FEE");
    const tokAddr = await tok.getAddress();
    await tok.mint(await tbas[0].getAddress(), 1000n);
    await tok.setFeeBps(2500); // burns 25% in flight
    await allowlist(sweeper, allowAdmin, KIND_ERC20, tokAddr);

    await expect(sweeper.sweepTBAERC20(1, await tbas[0].getAddress(), tokAddr))
      .to.emit(sweeper, "SweptERC20")
      .withArgs(1, await tbas[0].getAddress(), tokAddr, 750n);
    expect(await tok.balanceOf(reserveAddr)).to.equal(750n);
  });

  it("a token that lies about transferring reverts instead of emitting a fictional credit", async () => {
    const { sweeper, allowAdmin, tbas } = await fixture();
    const Lie = await ethers.getContractFactory("MockLyingERC20");
    const lie: any = await Lie.deploy();
    const lieAddr = await lie.getAddress();
    await lie.mint(await tbas[0].getAddress(), 900n);
    await allowlist(sweeper, allowAdmin, KIND_ERC20, lieAddr);
    await expect(
      sweeper.sweepTBAERC20(1, await tbas[0].getAddress(), lieAddr)
    ).to.be.revertedWithCustomError(sweeper, "SweepDidNotLand");
  });

  it("a reentrant token cannot double-credit, and cannot brick a DIFFERENT asset's sweep", async () => {
    const { sweeper, sweeperAddr, allowAdmin, tbas, reserveAddr } = await fixture();
    const tbaAddr = await tbas[0].getAddress();

    const Re = await ethers.getContractFactory("MockReentrantSweepERC20");
    const re: any = await Re.deploy();
    const reAddr = await re.getAddress();
    await re.mint(tbaAddr, 400n);
    await allowlist(sweeper, allowAdmin, KIND_ERC20, reAddr);

    const good = await deployToken("Good", "GOOD");
    const goodAddr = await good.getAddress();
    await good.mint(tbaAddr, 250n);
    await allowlist(sweeper, allowAdmin, KIND_ERC20, goodAddr);

    // Arm it to re-enter the sweeper mid-transfer, trying for a second credit.
    const payload = sweeper.interface.encodeFunctionData("sweepTBAERC20", [
      1,
      tbaAddr,
      reAddr,
    ]);
    await re.arm(sweeperAddr, payload);

    await sweeper.sweepTBAERC20(1, tbaAddr, reAddr);

    // Exactly one credit, not two.
    expect(await re.balanceOf(reserveAddr)).to.equal(400n);
    expect(await re.reentered()).to.equal(true);
    expect((await re.lastRevert()).length).to.be.greaterThan(2, "re-entry was rejected");

    // And the hostile asset did not poison the legitimate one.
    await sweeper.sweepTBAERC20(1, tbaAddr, goodAddr);
    expect(await good.balanceOf(reserveAddr)).to.equal(250n);
  });

  // ── TBA / held-NFT binding ──────────────────────────────────────────────

  it("a TBA bound to an NFT the vault does not hold cannot be swept from", async () => {
    const { sweeper, allowAdmin, nft, nftAddr, chainId, bob, sweeperAddr } = await fixture();
    // Bob's own NFT, never deposited, with its own TBA holding real value.
    await nft.mint(bob.address, 99);
    const TBA = await ethers.getContractFactory("MockTBA");
    const rogue: any = await TBA.deploy(chainId, nftAddr, 99);
    await rogue.setOperator(sweeperAddr, true);
    const tok = await deployToken();
    await tok.mint(await rogue.getAddress(), 1000n);
    await allowlist(sweeper, allowAdmin, KIND_ERC20, await tok.getAddress());

    await expect(
      sweeper.sweepTBAERC20(99, await rogue.getAddress(), await tok.getAddress())
    ).to.be.revertedWithCustomError(sweeper, "TokenNotHeldByVault");
  });

  it("a TBA whose token() names a DIFFERENT held id than the one passed is rejected", async () => {
    const { sweeper, allowAdmin, tbas } = await fixture();
    const tok = await deployToken();
    await tok.mint(await tbas[1].getAddress(), 100n);
    await allowlist(sweeper, allowAdmin, KIND_ERC20, await tok.getAddress());
    // tbas[1] is bound to id 2; claim it is id 1's account.
    await expect(
      sweeper.sweepTBAERC20(1, await tbas[1].getAddress(), await tok.getAddress())
    ).to.be.revertedWithCustomError(sweeper, "TbaNotBoundToHeldToken");
  });

  it("a cross-chain-bound TBA is rejected on the chainId, not merely on the collection", async () => {
    const { sweeper, allowAdmin, nftAddr, sweeperAddr, chainId } = await fixture();
    const TBA = await ethers.getContractFactory("MockTBA");
    const foreign: any = await TBA.deploy(chainId + 1n, nftAddr, 1);
    await foreign.setOperator(sweeperAddr, true);
    const tok = await deployToken();
    await tok.mint(await foreign.getAddress(), 100n);
    await allowlist(sweeper, allowAdmin, KIND_ERC20, await tok.getAddress());
    await expect(
      sweeper.sweepTBAERC20(1, await foreign.getAddress(), await tok.getAddress())
    ).to.be.revertedWithCustomError(sweeper, "WrongChain");
  });

  it("a TBA whose owner() disagrees with the collection is rejected (defence in depth)", async () => {
    const { sweeper, allowAdmin, tbas, outsider } = await fixture();
    const tok = await deployToken();
    await tok.mint(await tbas[0].getAddress(), 100n);
    await allowlist(sweeper, allowAdmin, KIND_ERC20, await tok.getAddress());
    await tbas[0].setOwnerOverride(outsider.address);
    await expect(
      sweeper.sweepTBAERC20(1, await tbas[0].getAddress(), await tok.getAddress())
    ).to.be.revertedWithCustomError(sweeper, "TbaOwnerMismatch");
  });

  it("once the NFT leaves the vault by redemption, its TBA stops being sweepable", async () => {
    const { sweeper, allowAdmin, tbas, vault, alice } = await fixture();
    const tok = await deployToken();
    const tokAddr = await tok.getAddress();
    await tok.mint(await tbas[0].getAddress(), 100n);
    await allowlist(sweeper, allowAdmin, KIND_ERC20, tokAddr);

    await vault.connect(alice).redeemTarget(1, { value: TARGET_COST });
    await tok.mint(await tbas[0].getAddress(), 500n); // more value arrives after

    await expect(
      sweeper.sweepTBAERC20(1, await tbas[0].getAddress(), tokAddr)
    ).to.be.revertedWithCustomError(sweeper, "TokenNotHeldByVault");
  });

  // ── Primitive 2: ERC-721 ────────────────────────────────────────────────

  it("sweeps a stranded sub-NFT into the SEPARATE miscellany holding, never the vault", async () => {
    const { sweeper, allowAdmin, tbas, miscAddr, vaultAddr } = await fixture();
    const Sub = await ethers.getContractFactory("MockSubNft");
    const sub: any = await Sub.deploy("Sub", "SUB");
    const subAddr = await sub.getAddress();
    await sub.mint(await tbas[0].getAddress(), 42);
    await allowlist(sweeper, allowAdmin, KIND_ERC721, subAddr);

    await sweeper.sweepTBAERC721(1, await tbas[0].getAddress(), subAddr, 42);
    expect(await sub.ownerOf(42)).to.equal(miscAddr);
    expect(await sub.ownerOf(42)).to.not.equal(vaultAddr);
  });

  it("a non-allowlisted 721 cannot be swept — junk-collection dilution is refused at the door", async () => {
    const { sweeper, tbas } = await fixture();
    const Sub = await ethers.getContractFactory("MockSubNft");
    const junk: any = await Sub.deploy("Junk", "JNK");
    await junk.mint(await tbas[0].getAddress(), 7);
    await expect(
      sweeper.sweepTBAERC721(1, await tbas[0].getAddress(), await junk.getAddress(), 7)
    ).to.be.revertedWithCustomError(sweeper, "NotAllowlisted");
  });

  it("an ERC-721 not actually inside the TBA cannot be swept", async () => {
    const { sweeper, allowAdmin, tbas, bob } = await fixture();
    const Sub = await ethers.getContractFactory("MockSubNft");
    const sub: any = await Sub.deploy("Sub", "SUB");
    const subAddr = await sub.getAddress();
    await sub.mint(bob.address, 5);
    await allowlist(sweeper, allowAdmin, KIND_ERC721, subAddr);
    await expect(
      sweeper.sweepTBAERC721(1, await tbas[0].getAddress(), subAddr, 5)
    ).to.be.revertedWithCustomError(sweeper, "NothingToSweep");
  });

  it("a hostile onERC721Received blocks only its OWN sweep and cannot brick a legitimate one", async () => {
    // A sweeper whose miscellany sink reverts on receipt: every 721 sweep
    // through it fails, and NOTHING else does — ERC-20 sweeps and the LP
    // collect path are untouched, because no state is shared between them.
    const { nftAddr, vaultAddr, reserveAddr, roleAdmin, allowAdmin, tbas } = await fixture();
    const Rev = await ethers.getContractFactory("MockRevertingReceiver");
    const rev: any = await Rev.deploy();
    const Sweeper = await ethers.getContractFactory("TBAValueSweeper");
    const hostile: any = await Sweeper.deploy(
      nftAddr,
      vaultAddr,
      reserveAddr,
      await rev.getAddress(),
      DELAY,
      [roleAdmin.address, allowAdmin.address]
    );
    await tbas[0].setOperator(await hostile.getAddress(), true);

    const Sub = await ethers.getContractFactory("MockSubNft");
    const sub: any = await Sub.deploy("Sub", "SUB");
    await sub.mint(await tbas[0].getAddress(), 9);
    await allowlist(hostile, allowAdmin, KIND_ERC721, await sub.getAddress());

    await expect(
      hostile.sweepTBAERC721(1, await tbas[0].getAddress(), await sub.getAddress(), 9)
    ).to.be.reverted;

    // The ERC-20 path on the SAME sweeper still works perfectly.
    const tok = await deployToken();
    await tok.mint(await tbas[0].getAddress(), 300n);
    await allowlist(hostile, allowAdmin, KIND_ERC20, await tok.getAddress());
    await hostile.sweepTBAERC20(1, await tbas[0].getAddress(), await tok.getAddress());
    expect(await tok.balanceOf(reserveAddr)).to.equal(300n);
  });

  // ── Primitive 3: concentrated-liquidity positions ───────────────────────

  async function lpFixture() {
    const base = await fixture();
    const t0 = await deployToken("T0", "T0");
    const t1 = await deployToken("T1", "T1");
    const PM = await ethers.getContractFactory("MockPositionManager");
    const pm: any = await PM.deploy(await t0.getAddress(), await t1.getAddress());
    const pmAddr = await pm.getAddress();
    // The manager custodies the fees it owes.
    await t0.mint(pmAddr, 10_000n);
    await t1.mint(pmAddr, 10_000n);
    await pm.mintPosition(await base.tbas[0].getAddress(), 1001, 600n, 400n);
    return { ...base, t0, t1, pm, pmAddr };
  }

  it("collects uncollected position fees straight to the reserve sink", async () => {
    const { sweeper, allowAdmin, tbas, pm, pmAddr, t0, t1, reserveAddr, outsider } =
      await lpFixture();
    await allowlist(sweeper, allowAdmin, KIND_PM, pmAddr);

    await sweeper
      .connect(outsider)
      .sweepLpPositionFees(1, await tbas[0].getAddress(), pmAddr, 1001);

    expect(await t0.balanceOf(reserveAddr)).to.equal(600n);
    expect(await t1.balanceOf(reserveAddr)).to.equal(400n);
    // And the outsider who paid the gas got nothing.
    expect(await t0.balanceOf(outsider.address)).to.equal(0n);
    expect(await t1.balanceOf(outsider.address)).to.equal(0n);
    expect(await pm.owed0(1001)).to.equal(0n);
  });

  it("the collect path cannot be pointed at an unallowlisted or fake position manager", async () => {
    const { sweeper, tbas, pmAddr, t0, t1 } = await lpFixture();
    // Unallowlisted: the real manager, before the timelock ran.
    await expect(
      sweeper.sweepLpPositionFees(1, await tbas[0].getAddress(), pmAddr, 1001)
    ).to.be.revertedWithCustomError(sweeper, "NotAllowlisted");

    // A fake manager with the same ABI is equally refused.
    const PM = await ethers.getContractFactory("MockPositionManager");
    const fake: any = await PM.deploy(await t0.getAddress(), await t1.getAddress());
    await expect(
      sweeper.sweepLpPositionFees(1, await tbas[0].getAddress(), await fake.getAddress(), 1)
    ).to.be.revertedWithCustomError(sweeper, "NotAllowlisted");
  });

  it("a position the TBA does not own cannot be collected, even on an allowlisted manager", async () => {
    const { sweeper, allowAdmin, tbas, pm, pmAddr, bob } = await lpFixture();
    await allowlist(sweeper, allowAdmin, KIND_PM, pmAddr);
    await pm.mintPosition(bob.address, 2002, 999n, 999n);
    await expect(
      sweeper.sweepLpPositionFees(1, await tbas[0].getAddress(), pmAddr, 2002)
    ).to.be.revertedWithCustomError(sweeper, "PositionNotOwnedByTba");
  });

  it("collecting twice is safe: the second call has nothing owed and reverts", async () => {
    const { sweeper, allowAdmin, tbas, pmAddr, t0, reserveAddr } = await lpFixture();
    await allowlist(sweeper, allowAdmin, KIND_PM, pmAddr);
    await sweeper.sweepLpPositionFees(1, await tbas[0].getAddress(), pmAddr, 1001);
    await expect(
      sweeper.sweepLpPositionFees(1, await tbas[0].getAddress(), pmAddr, 1001)
    ).to.be.revertedWithCustomError(sweeper, "NothingToSweep");
    expect(await t0.balanceOf(reserveAddr)).to.equal(600n);
  });

  it("fees first, then the position NFT itself — the wrapper never moves before its value", async () => {
    const { sweeper, allowAdmin, tbas, pm, pmAddr, t0, t1, reserveAddr, miscAddr } =
      await lpFixture();
    await allowlist(sweeper, allowAdmin, KIND_PM, pmAddr);
    await allowlist(sweeper, allowAdmin, KIND_ERC721, pmAddr);

    await sweeper.sweepLpPositionFees(1, await tbas[0].getAddress(), pmAddr, 1001);
    await sweeper.sweepTBAERC721(1, await tbas[0].getAddress(), pmAddr, 1001);

    expect(await t0.balanceOf(reserveAddr)).to.equal(600n);
    expect(await t1.balanceOf(reserveAddr)).to.equal(400n);
    expect(await pm.ownerOf(1001)).to.equal(miscAddr);
  });

  it("a v2-style fungible LP token needs no new code — primitive 1 already covers it", async () => {
    const { sweeper, allowAdmin, tbas, reserveAddr } = await fixture();
    const pair = await deployToken("UNI-V2", "UNI-V2");
    const pairAddr = await pair.getAddress();
    await pair.mint(await tbas[0].getAddress(), 12_345n);
    await allowlist(sweeper, allowAdmin, KIND_ERC20, pairAddr);
    await sweeper.sweepTBAERC20(1, await tbas[0].getAddress(), pairAddr);
    expect(await pair.balanceOf(reserveAddr)).to.equal(12_345n);
  });

  // ── The allowlist role ──────────────────────────────────────────────────

  it("only ROLE_SWEEP_ALLOWLIST may queue, and ROLE_ADMIN specifically may not", async () => {
    const { sweeper, roleAdmin, outsider } = await fixture();
    const tok = await deployToken();
    for (const who of [roleAdmin, outsider]) {
      await expect(
        sweeper.connect(who).queueAsset(KIND_ERC20, await tok.getAddress(), true)
      ).to.be.revertedWithCustomError(sweeper, "NotRoleHolder");
    }
  });

  it("role reassignment is timelocked, and the sweep role is a known role", async () => {
    const { sweeper, roleAdmin, outsider } = await fixture();
    const ROLE = await sweeper.ROLE_SWEEP_ALLOWLIST();
    await sweeper.connect(roleAdmin).queueRole(ROLE, outsider.address);
    await expect(sweeper.executeRole(ROLE)).to.be.revertedWithCustomError(
      sweeper,
      "RoleTimelockNotElapsed"
    );
    await time.increase(DELAY + 1);
    await sweeper.executeRole(ROLE);
    expect(await sweeper.hasRole(ROLE, outsider.address)).to.equal(true);
  });

  it("a rogue role key cannot invent a kind or a zero asset", async () => {
    const { sweeper, allowAdmin } = await fixture();
    await expect(
      sweeper.connect(allowAdmin).queueAsset(KIND_NONE, ethers.ZeroAddress, true)
    ).to.be.revertedWithCustomError(sweeper, "BadParam");
    const tok = await deployToken();
    await expect(
      sweeper.connect(allowAdmin).queueAsset(KIND_NONE, await tok.getAddress(), true)
    ).to.be.revertedWithCustomError(sweeper, "BadParam");
  });

  it("de-allowlisting stops future sweeps and has zero retroactive effect", async () => {
    const { sweeper, allowAdmin, tbas, reserveAddr } = await fixture();
    const tok = await deployToken();
    const tokAddr = await tok.getAddress();
    await tok.mint(await tbas[0].getAddress(), 100n);
    await allowlist(sweeper, allowAdmin, KIND_ERC20, tokAddr);
    await sweeper.sweepTBAERC20(1, await tbas[0].getAddress(), tokAddr);
    expect(await tok.balanceOf(reserveAddr)).to.equal(100n);

    await sweeper.connect(allowAdmin).queueAsset(KIND_ERC20, tokAddr, false);
    await time.increase(DELAY + 1);
    await sweeper.executeAsset(KIND_ERC20, tokAddr);

    await tok.mint(await tbas[0].getAddress(), 50n);
    await expect(
      sweeper.sweepTBAERC20(1, await tbas[0].getAddress(), tokAddr)
    ).to.be.revertedWithCustomError(sweeper, "NotAllowlisted");
    // The already-swept 100 is exactly where it was.
    expect(await tok.balanceOf(reserveAddr)).to.equal(100n);
  });

  // ── Caller gets nothing ─────────────────────────────────────────────────

  it("a permissionless caller gains nothing from any of the three primitives", async () => {
    const { sweeper, allowAdmin, tbas, outsider, reserveAddr, miscAddr, pm, pmAddr, t0, t1 } =
      await lpFixture();
    const tok = await deployToken();
    const tokAddr = await tok.getAddress();
    await tok.mint(await tbas[0].getAddress(), 1000n);
    const Sub = await ethers.getContractFactory("MockSubNft");
    const sub: any = await Sub.deploy("Sub", "SUB");
    await sub.mint(await tbas[0].getAddress(), 3);

    await allowlist(sweeper, allowAdmin, KIND_ERC20, tokAddr);
    await allowlist(sweeper, allowAdmin, KIND_ERC721, await sub.getAddress());
    await allowlist(sweeper, allowAdmin, KIND_PM, pmAddr);

    await sweeper.connect(outsider).sweepTBAERC20(1, await tbas[0].getAddress(), tokAddr);
    await sweeper
      .connect(outsider)
      .sweepTBAERC721(1, await tbas[0].getAddress(), await sub.getAddress(), 3);
    await sweeper
      .connect(outsider)
      .sweepLpPositionFees(1, await tbas[0].getAddress(), pmAddr, 1001);

    expect(await tok.balanceOf(outsider.address)).to.equal(0n);
    expect(await sub.ownerOf(3)).to.equal(miscAddr);
    expect(await t0.balanceOf(outsider.address)).to.equal(0n);
    expect(await t1.balanceOf(outsider.address)).to.equal(0n);
    // Nothing was retained by the sweeper either — no custody, ever.
    const sweeperAddr = await sweeper.getAddress();
    expect(await tok.balanceOf(sweeperAddr)).to.equal(0n);
    expect(await t0.balanceOf(sweeperAddr)).to.equal(0n);
    expect(await t0.balanceOf(reserveAddr)).to.equal(600n);
    expect(await pm.owed1(1001)).to.equal(0n);
  });

  // ══ UNMOVABLE-ASSETS PROOFS ═════════════════════════════════════════════

  it("UNMOVABLE-ASSETS (a): redemption is identical with sweeps mid-flight, pending, disabled, or a hostile allowlist queued", async () => {
    const { sweeper, allowAdmin, tbas, vault, alice, nft, vaultAddr } = await fixture();
    const tok = await deployToken();
    const tokAddr = await tok.getAddress();
    for (let i = 0; i < 4; i++) await tok.mint(await tbas[i].getAddress(), 100n);

    // 1. SWEEPS DISABLED (nothing allowlisted at all) — redeem works.
    await vault.connect(alice).redeemTarget(1, { value: TARGET_COST });
    expect(await nft.ownerOf(1)).to.equal(alice.address);

    // 2. A HOSTILE ALLOWLIST QUEUED (never executed) — redeem works.
    await sweeper.connect(allowAdmin).queueAsset(KIND_ERC20, tokAddr, true);
    await sweeper.connect(allowAdmin).queueAsset(KIND_ERC721, tokAddr, true);
    await sweeper.connect(allowAdmin).queueAsset(KIND_PM, tokAddr, true);
    await vault.connect(alice).redeemTarget(2, { value: TARGET_COST });
    expect(await nft.ownerOf(2)).to.equal(alice.address);

    // 3. SWEEPS LIVE AND MID-FLIGHT — sweep id 3's TBA, then redeem id 3 in
    //    the very next call. No queue, no cooldown, no reservation.
    await time.increase(DELAY + 1);
    await sweeper.executeAsset(KIND_ERC20, tokAddr);
    await sweeper.sweepTBAERC20(3, await tbas[2].getAddress(), tokAddr);
    await vault.connect(alice).redeemTarget(3, { value: TARGET_COST });
    expect(await nft.ownerOf(3)).to.equal(alice.address);

    // 4. A ROLE ROTATION PENDING — still works.
    const ROLE = await sweeper.ROLE_SWEEP_ALLOWLIST();
    const { roleAdmin, bob } = await (async () => {
      const s = await ethers.getSigners();
      return { roleAdmin: s[4], bob: s[3] };
    })();
    await sweeper.connect(roleAdmin).queueRole(ROLE, bob.address);
    await vault.connect(alice).redeemTarget(4, { value: TARGET_COST });
    expect(await nft.ownerOf(4)).to.equal(alice.address);

    // The vault is empty and every NFT went to its owner. The exit door never
    // narrowed by one wei of gas or one block of delay.
    expect(await vault.heldTokenCount()).to.equal(0n);
    expect(await nft.balanceOf(vaultAddr)).to.equal(0n);
  });

  it("UNMOVABLE-ASSETS (b): no role — not ROLE_ADMIN, not ROLE_SWEEP_ALLOWLIST — can claw back already-swept value", async () => {
    const { sweeper, roleAdmin, allowAdmin, outsider, tbas, reserveAddr, miscAddr } =
      await fixture();
    const tok = await deployToken();
    const tokAddr = await tok.getAddress();
    await tok.mint(await tbas[0].getAddress(), 1_000n);
    await allowlist(sweeper, allowAdmin, KIND_ERC20, tokAddr);
    await sweeper.sweepTBAERC20(1, await tbas[0].getAddress(), tokAddr);
    expect(await tok.balanceOf(reserveAddr)).to.equal(1_000n);

    // 1. THE LEVER IS ABSENT. There is no function on this contract that can
    //    move a token, redirect a sink, or reach the credited balance.
    const iface = (await ethers.getContractFactory("TBAValueSweeper")).interface;
    const names = (iface.fragments.filter((f: any) => f.type === "function") as any[]).map(
      (f) => f.name
    );
    for (const bad of [
      "setReserveSink",
      "setMiscellanySink",
      "rescue",
      "withdraw",
      "sweepTo",
      "recover",
      "transferOut",
      "emergencyExit",
    ]) {
      expect(names, `${bad} exists`).to.not.include(bad);
    }

    // 2. THE SINKS ARE IMMUTABLE. Reading them after every role action still
    //    gives the constructor's answers.
    const ROLE = await sweeper.ROLE_SWEEP_ALLOWLIST();
    await sweeper.connect(roleAdmin).queueRole(ROLE, outsider.address);
    await time.increase(DELAY + 1);
    await sweeper.executeRole(ROLE);
    // The attacker now holds the allowlist role outright.
    await sweeper.connect(outsider).queueAsset(KIND_ERC20, tokAddr, false);
    await time.increase(DELAY + 1);
    await sweeper.executeAsset(KIND_ERC20, tokAddr);

    const [reserve, misc] = await sweeper.sinks();
    expect(reserve).to.equal(reserveAddr);
    expect(misc).to.equal(miscAddr);

    // 3. AND THE VALUE IS STILL EXACTLY WHERE IT WAS CREDITED, untouched by
    //    the whole role takeover. It is an ordinary reserve balance now —
    //    redeemable pro rata by the vault's own path, with no privileged
    //    detour past it.
    expect(await tok.balanceOf(reserveAddr)).to.equal(1_000n);
    expect(await tok.balanceOf(outsider.address)).to.equal(0n);
    expect(await tok.balanceOf(await sweeper.getAddress())).to.equal(0n);
  });

  it("a fully-compromised allowlist key buys the attacker nothing: hostile assets still land in the immutable sink", async () => {
    const { sweeper, allowAdmin, tbas, reserveAddr, outsider } = await fixture();
    // The worst case: the key allowlists an asset of the attacker's choosing.
    const evil = await deployToken("Evil", "EVIL");
    const evilAddr = await evil.getAddress();
    await evil.mint(await tbas[0].getAddress(), 5_000n);
    await allowlist(sweeper, allowAdmin, KIND_ERC20, evilAddr);
    await sweeper.connect(allowAdmin).sweepTBAERC20(1, await tbas[0].getAddress(), evilAddr);
    // ...and it goes to the sink, not to them.
    expect(await evil.balanceOf(reserveAddr)).to.equal(5_000n);
    expect(await evil.balanceOf(allowAdmin.address)).to.equal(0n);
    expect(await evil.balanceOf(outsider.address)).to.equal(0n);
  });
});
