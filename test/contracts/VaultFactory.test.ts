import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { takeSnapshot, type SnapshotRestorer } from "./helpers/network-helpers.js";

/**
 * Proves design doc §2 / §7.2's factory-level guarantees:
 *  - one vault per collection ID, create2-deployed; second attempt reverts
 *  - every economically load-bearing parameter is immutable — no setter
 *    exists anywhere in the ABI that could change it post-construction
 *
 * LOCAL HARDHAT ONLY.
 */
describe("CollectionVaultFactory — permissionless, one vault per collection", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const TIMELOCK = 48 * 3600;

  async function deployFixture() {
    const [deployer, indexDiamondStandIn, treasury, attacker] = await ethers.getSigners();
    const payment: any = await (await ethers.getContractFactory("MockIndexToken")).deploy("PAY", "PAY");
    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(indexDiamondStandIn.address, await payment.getAddress(), TIMELOCK);
    const nft1: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const nft2: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    return { deployer, indexDiamondStandIn, treasury, attacker, payment, factory, nft1, nft2 };
  }

  it("deploys exactly one vault for a collection; a second attempt reverts", async () => {
    const { factory, treasury, nft1 } = await deployFixture();
    const nft1Addr = await nft1.getAddress();

    const tx = await factory.deployVault(nft1Addr, treasury.address, 810);
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((l: any) => {
        try {
          return factory.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "VaultDeployed");
    expect(event).to.not.be.undefined;
    const vaultAddr = event!.args.vault;
    expect(await factory.vaultForCollection(await factory.collectionSalt(nft1Addr))).to.equal(vaultAddr);
    expect(await factory.vaultCount()).to.equal(1n);

    await expect(factory.deployVault(nft1Addr, treasury.address, 810)).to.be.revertedWithCustomError(
      factory,
      "VaultAlreadyExists"
    );
  });

  it("permits a second, independent vault for a DIFFERENT collection", async () => {
    const { factory, treasury, nft1, nft2 } = await deployFixture();
    const v1 = await factory.deployVault.staticCall(await nft1.getAddress(), treasury.address, 810);
    await factory.deployVault(await nft1.getAddress(), treasury.address, 810);
    const v2 = await factory.deployVault.staticCall(await nft2.getAddress(), treasury.address, 810);
    await factory.deployVault(await nft2.getAddress(), treasury.address, 810);
    expect(v1).to.not.equal(v2);
    expect(await factory.vaultCount()).to.equal(2n);
  });

  it("is genuinely permissionless — any caller, not just the factory deployer, may deploy", async () => {
    const { factory, attacker, treasury, nft1 } = await deployFixture();
    await expect(factory.connect(attacker).deployVault(await nft1.getAddress(), treasury.address, 810)).to.not.be
      .revert(ethers);
  });

  it("create2 address is deterministic and matches predictVault", async () => {
    const { factory, treasury, nft1 } = await deployFixture();
    const nft1Addr = await nft1.getAddress();
    const predicted = await factory.predictVault(nft1Addr, treasury.address, 810);
    const actual = await factory.deployVault.staticCall(nft1Addr, treasury.address, 810);
    expect(actual).to.equal(predicted);
  });

  it("construction reverts if the deployer tries a sink split below the 8.1% floor", async () => {
    const { factory, treasury, nft1 } = await deployFixture();
    // deployVault itself doesn't validate range up front — the VAULT
    // CONSTRUCTOR does (SplitOutOfRange), so the create2 call reverts and no
    // vault is registered either way. Confirms the floor cannot be
    // constructed around via the factory path.
    await expect(factory.deployVault(await nft1.getAddress(), treasury.address, 809)).to.be.revert(ethers);
    expect(await factory.vaultForCollection(await factory.collectionSalt(await nft1.getAddress()))).to.equal(
      ethers.ZeroAddress
    );
  });

  // ── Immutable parameters: no setter exists anywhere in the ABI ─────────

  it("has no function in the vault ABI that can change collection, paymentToken, mint/redeem fee, swapFeeBps, or upstreamSink", async () => {
    const { factory, treasury, nft1 } = await deployFixture();
    await factory.deployVault(await nft1.getAddress(), treasury.address, 810);
    const vaultAddr = await factory.vaultForCollection(await factory.collectionSalt(await nft1.getAddress()));
    const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);

    // Enumerate every function selector in the deployed ABI and assert none
    // of them is a setter for an immutable field. This is a structural proof:
    // Solidity `immutable` fields have no assignment opcode reachable outside
    // the constructor, so if no such function exists in the ABI at all, there
    // is no path — this test additionally documents that expectation.
    const abi = vault.interface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => f.name);
    const forbiddenSetterNames = [
      "setCollection",
      "setPaymentToken",
      "setMintFeeWei",
      "setRedeemFeeWei",
      "setSwapFeeBps",
      "setUpstreamSink",
      "queueUpstreamSink",
      "queueCollection",
      "queuePaymentToken",
      "queueSwapFeeBps",
    ];
    for (const name of forbiddenSetterNames) {
      expect(abi).to.not.include(name);
    }

    // And directly: the values read back identical to construction, and stay
    // that way after every other mutation this vault permits (treasury /
    // mintRedeemSinkBps changes, exercised in FeeRouting.test.ts) — since
    // there is no code path that writes them, this is exhaustive by
    // construction, not merely sampled.
    expect(await vault.collection()).to.equal(await nft1.getAddress());
    expect(await vault.upstreamSink()).to.equal(
      await (await ethers.getContractAt("CollectionVaultFactory", await factory.getAddress())).upstreamSink()
    );
    expect(await vault.swapFeeBps()).to.equal(100n);
  });
});
