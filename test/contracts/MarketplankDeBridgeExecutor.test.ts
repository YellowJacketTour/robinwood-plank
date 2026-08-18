import { expect } from "chai";
import { ethers, provider } from "./helpers/hardhat.js";
import { Contract } from "ethers";
import type { Signer } from "ethers";
import seaportFixture from "./fixtures/seaport-1.6-bytecode.json" with { type: "json" };

/**
 * Proves MarketplankDeBridgeExecutor.sol's own logic in isolation, against
 * the REAL Seaport 1.6 runtime bytecode plus a real WETH9-shaped mock for
 * the unwrap path. The "external call adapter" here is a plain test signer
 * standing in for deBridge's real, live-verified
 * DlnExternalCallAdapter (0x61eF2E...) -- this suite proves THIS
 * contract's access control and forwarding logic, not deBridge's own
 * behaviour.
 *
 * Covers exactly the properties the contract's own header claims:
 *  - only the configured externalCallAdapter address can call onERC20Received
 *  - a wrong token (not wrappedNativeToken) is rejected before any spend
 *  - a real cross-chain purchase completes: WETH delivered -> unwrapped ->
 *    forwarded to the router -> NFT lands on the RECIPIENT
 *  - insufficient delivered funds reverts cleanly, before ever calling the router
 *  - a failing purchase (bad price) reverts the whole call
 *  - constructor zero-address guards
 */

const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";
const ZERO_HASH = "0x" + "0".repeat(64);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_ORDER_ID = ZERO_HASH;

const SEAPORT_ABI = [
  "function information() view returns (string version, bytes32 domainSeparator, address conduitController)",
  "function getCounter(address offerer) view returns (uint256)",
];

const EIP_712_ORDER_TYPE = {
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
};

const TOKEN_ID = 11n;
const PRICE_WEI = ethers.parseEther("1");
const FEE_BPS = BigInt(180);

const PAYLOAD_ABI_TYPES = [
  "tuple(address offerer,address zone,tuple(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,tuple(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters",
  "bytes signature",
  "tuple(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers",
  "bytes32 fulfillerConduitKey",
  "uint256 orderPriceWei",
  "address recipient",
];

describe("MarketplankDeBridgeExecutor (REAL deployed Seaport bytecode + real WETH9-shaped mock)", () => {
  let adapterStandIn: Signer;
  let attacker: Signer;
  let seller: Signer;
  let endUser: Signer;
  let sellerAddr: string;
  let endUserAddr: string;
  let seaport: any;
  let nft: any;
  let weth9: any;
  let router: any;
  let executor: any;

  beforeEach(async () => {
    [adapterStandIn, attacker, seller, endUser] = await ethers.getSigners();
    sellerAddr = await seller.getAddress();
    endUserAddr = await endUser.getAddress();

    await provider.send("hardhat_setCode", [SEAPORT_ADDRESS, seaportFixture.bytecode]);
    seaport = new Contract(SEAPORT_ADDRESS, SEAPORT_ABI, seller);

    const NftFactory = await ethers.getContractFactory("MockRobinWoodNft");
    nft = await NftFactory.deploy();
    await nft.mint(sellerAddr, TOKEN_ID);
    await nft.connect(seller).setApprovalForAll(SEAPORT_ADDRESS, true);

    const Weth9Factory = await ethers.getContractFactory("MockWeth9");
    weth9 = await Weth9Factory.deploy();

    const RouterFactory = await ethers.getContractFactory("MarketplankForeignFeeRouter");
    router = await RouterFactory.deploy(SEAPORT_ADDRESS, await attacker.getAddress(), FEE_BPS);

    const ExecutorFactory = await ethers.getContractFactory("MarketplankDeBridgeExecutor");
    executor = await ExecutorFactory.deploy(
      await adapterStandIn.getAddress(),
      await router.getAddress(),
      await weth9.getAddress()
    );
  });

  async function signedListing(salt: bigint) {
    const counter: bigint = await seaport.getCounter(sellerAddr);
    const latestBlock = await provider.send("eth_getBlockByNumber", ["latest", false]);
    const now = Number(latestBlock.timestamp);
    const parameters = {
      offerer: sellerAddr,
      zone: ZERO_ADDRESS,
      offer: [{ itemType: 2, token: await nft.getAddress(), identifierOrCriteria: TOKEN_ID, startAmount: 1n, endAmount: 1n }],
      consideration: [
        { itemType: 0, token: ZERO_ADDRESS, identifierOrCriteria: 0n, startAmount: PRICE_WEI, endAmount: PRICE_WEI, recipient: sellerAddr },
      ],
      orderType: 0,
      startTime: 0n,
      endTime: BigInt(now + 86_400),
      zoneHash: ZERO_HASH,
      salt,
      conduitKey: ZERO_HASH,
      totalOriginalConsiderationItems: 1n,
    };
    const domain = { name: "Seaport", version: "1.6", chainId: 31337, verifyingContract: SEAPORT_ADDRESS };
    const signature = await seller.signTypedData(domain, EIP_712_ORDER_TYPE, { ...parameters, counter });
    return { parameters, numerator: 1, denominator: 1, signature, extraData: "0x" };
  }

  function encodePayload(order: any, priceWei: bigint, recipient: string): string {
    const abi = ethers.AbiCoder.defaultAbiCoder();
    return abi.encode(PAYLOAD_ABI_TYPES, [order.parameters, order.signature, [], ZERO_HASH, priceWei, recipient]);
  }

  /** Mints WETH9 to `to` -- stands in for "the deBridge adapter delivered WETH to the executor." */
  async function deliverWeth(to: string, amount: bigint) {
    await weth9.connect(adapterStandIn).deposit({ value: amount });
    await weth9.connect(adapterStandIn).transfer(to, amount);
  }

  it("PROOF: rejects any caller that isn't the configured externalCallAdapter -- the primary defense", async () => {
    const order = await signedListing(1n);
    const fee = (PRICE_WEI * FEE_BPS) / 10_000n;
    const total = PRICE_WEI + fee;
    await deliverWeth(await executor.getAddress(), total);
    const payload = encodePayload(order, PRICE_WEI, endUserAddr);

    await expect(
      executor.connect(attacker).onERC20Received(ZERO_ORDER_ID, await weth9.getAddress(), total, ZERO_ADDRESS, payload)
    ).to.be.revertedWithCustomError(executor, "NotExternalCallAdapter");
  });

  it("PROOF: rejects a token that isn't wrappedNativeToken, before spending anything", async () => {
    const order = await signedListing(15n); // distinct salt
    const fee = (PRICE_WEI * FEE_BPS) / 10_000n;
    const total = PRICE_WEI + fee;
    const payload = encodePayload(order, PRICE_WEI, endUserAddr);

    await expect(
      executor.connect(adapterStandIn).onERC20Received(ZERO_ORDER_ID, await nft.getAddress(), total, ZERO_ADDRESS, payload)
    ).to.be.revertedWithCustomError(executor, "WrongToken");
  });

  it("PROOF: real cross-chain purchase -- WETH delivered, unwrapped, forwarded to the router, NFT lands on the named end user (never the executor, never the adapter)", async () => {
    const order = await signedListing(2n);
    const fee = (PRICE_WEI * FEE_BPS) / 10_000n;
    const total = PRICE_WEI + fee;
    await deliverWeth(await executor.getAddress(), total);
    const payload = encodePayload(order, PRICE_WEI, endUserAddr);

    const sellerBalBefore = await ethers.provider.getBalance(sellerAddr);

    await executor
      .connect(adapterStandIn)
      .onERC20Received(ZERO_ORDER_ID, await weth9.getAddress(), total, ZERO_ADDRESS, payload);

    expect(await nft.ownerOf(TOKEN_ID)).to.equal(endUserAddr);
    expect(await nft.balanceOf(await executor.getAddress())).to.equal(0n);
    expect(await nft.balanceOf(await router.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(sellerAddr)).to.equal(sellerBalBefore + PRICE_WEI);
    expect(await ethers.provider.getBalance(await executor.getAddress())).to.equal(0n); // nothing left stranded
  });

  it("REGRESSION (audit finding): over-delivery -- the NORMAL bridge case -- returns the unused headroom to the buyer, never strands it", async () => {
    // Same audit finding as MarketplankAcrossReceiver's equivalent test --
    // see that one's comment for the full rationale. A real deBridge order
    // over-delivers to absorb the solver's fee, so unused headroom
    // returning to the buyer (rather than locking in this contract) is the
    // normal path, not an edge case.
    const order = await signedListing(9n);
    const fee = (PRICE_WEI * FEE_BPS) / 10_000n;
    const headroom = ethers.parseEther("0.05");
    const generous = PRICE_WEI + fee + headroom;
    await deliverWeth(await executor.getAddress(), generous);
    const payload = encodePayload(order, PRICE_WEI, endUserAddr);

    const endUserBalBefore = await ethers.provider.getBalance(endUserAddr);

    await executor
      .connect(adapterStandIn)
      .onERC20Received(ZERO_ORDER_ID, await weth9.getAddress(), generous, ZERO_ADDRESS, payload);

    expect(await nft.ownerOf(TOKEN_ID)).to.equal(endUserAddr);
    expect(await ethers.provider.getBalance(endUserAddr)).to.equal(endUserBalBefore + headroom);
    expect(await ethers.provider.getBalance(await executor.getAddress())).to.equal(0n);
  });

  it("PROOF: insufficient delivered amount reverts BEFORE calling the router -- NFT stays with the seller", async () => {
    const order = await signedListing(3n);
    const fee = (PRICE_WEI * FEE_BPS) / 10_000n;
    const tooLittle = PRICE_WEI + fee - ethers.parseEther("0.5");
    await deliverWeth(await executor.getAddress(), tooLittle);
    const payload = encodePayload(order, PRICE_WEI, endUserAddr);

    await expect(
      executor
        .connect(adapterStandIn)
        .onERC20Received(ZERO_ORDER_ID, await weth9.getAddress(), tooLittle, ZERO_ADDRESS, payload)
    ).to.be.revertedWithCustomError(executor, "InsufficientDeliveredAmount");

    expect(await nft.ownerOf(TOKEN_ID)).to.equal(sellerAddr);
  });

  it("PROOF: a failing purchase (tampered price) reverts the whole call cleanly", async () => {
    const order = await signedListing(4n);
    const fee = (PRICE_WEI * FEE_BPS) / 10_000n;
    const total = PRICE_WEI + fee;
    await deliverWeth(await executor.getAddress(), total);
    const payload = encodePayload(order, PRICE_WEI / 2n, endUserAddr);

    await expect(
      executor
        .connect(adapterStandIn)
        .onERC20Received(ZERO_ORDER_ID, await weth9.getAddress(), total, ZERO_ADDRESS, payload)
    ).to.be.revert(ethers);

    expect(await nft.ownerOf(TOKEN_ID)).to.equal(sellerAddr);
  });

  it("constructor rejects any zero address", async () => {
    const ExecutorFactory = await ethers.getContractFactory("MarketplankDeBridgeExecutor");
    await expect(
      ExecutorFactory.deploy(ZERO_ADDRESS, await router.getAddress(), await weth9.getAddress())
    ).to.be.revert(ethers);
    await expect(
      ExecutorFactory.deploy(await adapterStandIn.getAddress(), ZERO_ADDRESS, await weth9.getAddress())
    ).to.be.revert(ethers);
    await expect(
      ExecutorFactory.deploy(await adapterStandIn.getAddress(), await router.getAddress(), ZERO_ADDRESS)
    ).to.be.revert(ethers);
  });
});
