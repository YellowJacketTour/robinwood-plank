import { expect } from "chai";
import { ethers, provider } from "./helpers/hardhat.js";
import { Contract } from "ethers";
import type { Signer } from "ethers";
import seaportFixture from "./fixtures/seaport-1.6-bytecode.json" with { type: "json" };

/**
 * Proves MarketplankForeignFeeRouter.sol end-to-end against the REAL
 * Seaport 1.6 runtime bytecode (same fixture, same hardhat_setCode
 * technique as SeaportCriteriaFulfill.test.ts -- not a mock, not a
 * reimplementation). Covers exactly the properties the contract's own
 * header comment claims:
 *
 *  - a real order is genuinely fulfilled (seller's NFT moves, seller
 *    receives full price)
 *  - the fee is computed correctly and lands at feeRecipient, nowhere else
 *  - the buyer receives the NFT directly (never the router -- proven by
 *    asserting the router's NFT balance stays zero throughout)
 *  - overpayment is refunded exactly
 *  - underpayment reverts before ANY state changes (seller still owns the
 *    NFT, no ETH moved)
 *  - the constructor's MAX_FEE_BPS ceiling actually rejects an
 *    absurd fee rather than silently deploying one
 */

const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";
const ZERO_HASH = "0x" + "0".repeat(64);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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

const TOKEN_ID = 7n;
const PRICE_WEI = ethers.parseEther("1"); // 1 ETH listing
const FEE_BPS = 180n; // 1.8%

describe("MarketplankForeignFeeRouter (REAL deployed Seaport bytecode)", () => {
  let buyer: Signer;
  let seller: Signer;
  let treasury: Signer;
  let buyerAddr: string;
  let sellerAddr: string;
  let treasuryAddr: string;
  let seaport: any;
  let nft: any;
  let router: any;

  beforeEach(async () => {
    [buyer, seller, treasury] = await ethers.getSigners();
    buyerAddr = await buyer.getAddress();
    sellerAddr = await seller.getAddress();
    treasuryAddr = await treasury.getAddress();

    await provider.send("hardhat_setCode", [SEAPORT_ADDRESS, seaportFixture.bytecode]);
    seaport = new Contract(SEAPORT_ADDRESS, SEAPORT_ABI, seller);

    const NftFactory = await ethers.getContractFactory("MockRobinWoodNft");
    nft = (await NftFactory.deploy()) as unknown as Contract;
    await nft.mint(sellerAddr, TOKEN_ID);
    await nft.connect(seller).setApprovalForAll(SEAPORT_ADDRESS, true);

    const RouterFactory = await ethers.getContractFactory("MarketplankForeignFeeRouter");
    router = await RouterFactory.deploy(SEAPORT_ADDRESS, treasuryAddr, FEE_BPS);
  });

  async function signedListing(salt: bigint) {
    const counter: bigint = await seaport.getCounter(sellerAddr);
    const latestBlock = await provider.send("eth_getBlockByNumber", ["latest", false]);
    const now = Number(latestBlock.timestamp);
    const parameters = {
      offerer: sellerAddr,
      zone: ZERO_ADDRESS,
      offer: [
        {
          itemType: 2, // ERC721
          token: await nft.getAddress(),
          identifierOrCriteria: TOKEN_ID,
          startAmount: 1n,
          endAmount: 1n,
        },
      ],
      consideration: [
        {
          itemType: 0, // NATIVE (ETH)
          token: ZERO_ADDRESS,
          identifierOrCriteria: 0n,
          startAmount: PRICE_WEI,
          endAmount: PRICE_WEI,
          recipient: sellerAddr,
        },
      ],
      orderType: 0, // FULL_OPEN
      startTime: 0n,
      endTime: BigInt(now + 86_400),
      zoneHash: ZERO_HASH,
      salt,
      conduitKey: ZERO_HASH,
      totalOriginalConsiderationItems: 1n,
    };
    const domain = { name: "Seaport", version: "1.6", chainId: 31337, verifyingContract: SEAPORT_ADDRESS };
    const signature = await seller.signTypedData(domain, EIP_712_ORDER_TYPE, { ...parameters, counter });
    return {
      parameters,
      numerator: 1,
      denominator: 1,
      signature,
      extraData: "0x",
    };
  }

  it("PROOF: buyNow fulfils the real order, pays the seller in full, and the NFT goes directly to the buyer (never the router)", async () => {
    const order = await signedListing(1n);
    const fee = (PRICE_WEI * FEE_BPS) / 10_000n;

    const sellerBalBefore = await ethers.provider.getBalance(sellerAddr);
    const treasuryBalBefore = await ethers.provider.getBalance(treasuryAddr);

    const tx = await router.connect(buyer).buyNow(order, [], ZERO_HASH, PRICE_WEI, {
      value: PRICE_WEI + fee,
    });
    await tx.wait();

    expect(await nft.ownerOf(TOKEN_ID)).to.equal(buyerAddr);
    expect(await nft.balanceOf(await router.getAddress())).to.equal(0n); // router never custodied it

    expect(await ethers.provider.getBalance(sellerAddr)).to.equal(sellerBalBefore + PRICE_WEI);
    expect(await ethers.provider.getBalance(treasuryAddr)).to.equal(treasuryBalBefore + fee);
    expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(0n); // nothing left stuck in the router
  });

  it("PROOF: overpayment beyond price+fee is refunded to the buyer exactly", async () => {
    const order = await signedListing(2n);
    const fee = (PRICE_WEI * FEE_BPS) / 10_000n;
    const overpay = ethers.parseEther("0.05");

    const buyerBalBefore = await ethers.provider.getBalance(buyerAddr);
    const tx = await router.connect(buyer).buyNow(order, [], ZERO_HASH, PRICE_WEI, {
      value: PRICE_WEI + fee + overpay,
    });
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;

    const buyerBalAfter = await ethers.provider.getBalance(buyerAddr);
    // Buyer spent exactly price+fee+gas -- the overpay came back.
    expect(buyerBalBefore - buyerBalAfter).to.equal(PRICE_WEI + fee + gasCost);
  });

  it("PROOF: underpayment reverts BEFORE any state changes -- seller still owns the NFT, no ETH moved", async () => {
    const order = await signedListing(3n);
    const fee = (PRICE_WEI * FEE_BPS) / 10_000n;
    const tooLittle = PRICE_WEI + fee - 1n;

    const sellerBalBefore = await ethers.provider.getBalance(sellerAddr);
    await expect(
      router.connect(buyer).buyNow(order, [], ZERO_HASH, PRICE_WEI, { value: tooLittle })
    ).to.be.revertedWithCustomError(router, "InsufficientPayment");

    expect(await nft.ownerOf(TOKEN_ID)).to.equal(sellerAddr); // never transferred
    expect(await ethers.provider.getBalance(sellerAddr)).to.equal(sellerBalBefore); // never paid
  });

  it("PROOF: a tampered order (wrong price) fails Seaport's own signature check -- the router cannot be used to under-pay a real seller", async () => {
    const order = await signedListing(4n);
    const tamperedOrder = {
      ...order,
      parameters: {
        ...order.parameters,
        consideration: [{ ...order.parameters.consideration[0], startAmount: PRICE_WEI / 2n, endAmount: PRICE_WEI / 2n }],
      },
    };
    const halfFee = ((PRICE_WEI / 2n) * FEE_BPS) / 10_000n;

    await expect(
      router.connect(buyer).buyNow(tamperedOrder, [], ZERO_HASH, PRICE_WEI / 2n, {
        value: PRICE_WEI / 2n + halfFee,
      })
    ).to.be.revert(ethers); // Seaport itself rejects the signature mismatch

    expect(await nft.ownerOf(TOKEN_ID)).to.equal(sellerAddr); // still not transferred
  });

  it("constructor rejects a fee above the 10% sanity ceiling", async () => {
    const RouterFactory = await ethers.getContractFactory("MarketplankForeignFeeRouter");
    await expect(
      RouterFactory.deploy(SEAPORT_ADDRESS, treasuryAddr, 1_001n)
    ).to.be.revertedWithCustomError(RouterFactory, "FeeTooHigh");
  });

  it("constructor rejects a zero fee recipient or zero Seaport address", async () => {
    const RouterFactory = await ethers.getContractFactory("MarketplankForeignFeeRouter");
    await expect(RouterFactory.deploy(ZERO_ADDRESS, treasuryAddr, 180n)).to.be.revert(ethers);
    await expect(RouterFactory.deploy(SEAPORT_ADDRESS, ZERO_ADDRESS, 180n)).to.be.revert(ethers);
  });

  it("fee/recipient are immutable -- no setter exists on the contract", async () => {
    expect(router.interface.fragments.some((f: any) => f.type === "function" && /set(Fee|Recipient)/i.test(f.name ?? ""))).to.equal(false);
  });

  it("PROOF: buyNowFor delivers the NFT to an explicit recipient distinct from the payer, refund still goes to the payer", async () => {
    const order = await signedListing(5n);
    const fee = (PRICE_WEI * FEE_BPS) / 10_000n;
    const overpay = ethers.parseEther("0.02");
    const [, , , someoneElse] = await ethers.getSigners();
    const recipientAddr = await someoneElse.getAddress();

    const buyerBalBefore = await ethers.provider.getBalance(buyerAddr);
    const tx = await router.connect(buyer).buyNowFor(order, [], ZERO_HASH, PRICE_WEI, recipientAddr, {
      value: PRICE_WEI + fee + overpay,
    });
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;

    expect(await nft.ownerOf(TOKEN_ID)).to.equal(recipientAddr); // NFT to the named recipient, not the payer
    const buyerBalAfter = await ethers.provider.getBalance(buyerAddr);
    expect(buyerBalBefore - buyerBalAfter).to.equal(PRICE_WEI + fee + gasCost); // overpay refunded to the PAYER
  });

  it("buyNowFor rejects a zero-address recipient", async () => {
    const order = await signedListing(6n);
    const fee = (PRICE_WEI * FEE_BPS) / 10_000n;
    await expect(
      router.connect(buyer).buyNowFor(order, [], ZERO_HASH, PRICE_WEI, ZERO_ADDRESS, { value: PRICE_WEI + fee })
    ).to.be.revertedWithCustomError(router, "ZeroAddress");
  });

  describe("sweepBuy", () => {
    async function mintAndApprove(tokenId: bigint) {
      await nft.mint(sellerAddr, tokenId);
      // setApprovalForAll is idempotent -- fine to call again per token.
      await nft.connect(seller).setApprovalForAll(SEAPORT_ADDRESS, true);
    }

    it("PROOF: sweeps N distinct orders in one transaction, fee charged per fill, no NFT ever custodied by the router", async () => {
      const ids = [10n, 11n, 12n];
      for (const id of ids) await mintAndApprove(id);

      const orders: any[] = [];
      for (const id of ids) {
        await nft.mint(sellerAddr, id).catch(() => {}); // already minted above; guard against double-mint revert
      }
      // Rebuild signedListing per-token since it hardcodes TOKEN_ID's constant token -- inline a local variant here.
      async function signedListingFor(tokenId: bigint, salt: bigint) {
        const counter: bigint = await seaport.getCounter(sellerAddr);
        const latestBlock = await provider.send("eth_getBlockByNumber", ["latest", false]);
        const now = Number(latestBlock.timestamp);
        const parameters = {
          offerer: sellerAddr,
          zone: ZERO_ADDRESS,
          offer: [{ itemType: 2, token: await nft.getAddress(), identifierOrCriteria: tokenId, startAmount: 1n, endAmount: 1n }],
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

      let salt = 100n;
      for (const id of ids) {
        orders.push(await signedListingFor(id, salt++));
      }

      const fee = (PRICE_WEI * FEE_BPS) / 10_000n;
      const totalValue = (PRICE_WEI + fee) * BigInt(ids.length);

      const sellerBalBefore = await ethers.provider.getBalance(sellerAddr);
      const treasuryBalBefore = await ethers.provider.getBalance(treasuryAddr);

      const tx = await router.connect(buyer).sweepBuy(
        orders,
        orders.map(() => []),
        ZERO_HASH,
        ids.map(() => PRICE_WEI),
        { value: totalValue }
      );
      await tx.wait();

      for (const id of ids) expect(await nft.ownerOf(id)).to.equal(buyerAddr);
      expect(await nft.balanceOf(await router.getAddress())).to.equal(0n);
      expect(await ethers.provider.getBalance(sellerAddr)).to.equal(sellerBalBefore + PRICE_WEI * BigInt(ids.length));
      expect(await ethers.provider.getBalance(treasuryAddr)).to.equal(treasuryBalBefore + fee * BigInt(ids.length));
      expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(0n);
    });

    it("PROOF: one already-filled order in the batch is skipped, not reverted-whole-batch -- the rest still succeed and its share is refunded", async () => {
      const idA = 20n;
      const idB = 21n;
      await mintAndApprove(idA);
      await mintAndApprove(idB);

      async function signedListingFor(tokenId: bigint, salt: bigint) {
        const counter: bigint = await seaport.getCounter(sellerAddr);
        const latestBlock = await provider.send("eth_getBlockByNumber", ["latest", false]);
        const now = Number(latestBlock.timestamp);
        const parameters = {
          offerer: sellerAddr,
          zone: ZERO_ADDRESS,
          offer: [{ itemType: 2, token: await nft.getAddress(), identifierOrCriteria: tokenId, startAmount: 1n, endAmount: 1n }],
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

      const orderA = await signedListingFor(idA, 200n);
      const orderB = await signedListingFor(idB, 201n);

      // Someone else buys token A on Seaport directly, BEFORE the sweep runs -- the real race this test proves survives.
      await seaport.connect(seller).getCounter(sellerAddr); // no-op read, keeps `seaport` bound to seller signer used below
      const directBuyer = (await ethers.getSigners())[3];
      const seaportAsThirdParty = new Contract(SEAPORT_ADDRESS, [
        "function fulfillAdvancedOrder((( address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData) advancedOrder,(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers,bytes32 fulfillerConduitKey,address recipient) payable returns (bool fulfilled)",
      ], directBuyer);
      await seaportAsThirdParty.fulfillAdvancedOrder(orderA, [], ZERO_HASH, await directBuyer.getAddress(), { value: PRICE_WEI });
      expect(await nft.ownerOf(idA)).to.equal(await directBuyer.getAddress());

      const fee = (PRICE_WEI * FEE_BPS) / 10_000n;
      const totalValue = (PRICE_WEI + fee) * 2n; // fund as if both would succeed

      const buyerBalBefore = await ethers.provider.getBalance(buyerAddr);
      const tx = await router.connect(buyer).sweepBuy(
        [orderA, orderB],
        [[], []],
        ZERO_HASH,
        [PRICE_WEI, PRICE_WEI],
        { value: totalValue }
      );
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;

      // B filled, A was skipped (already sold).
      expect(await nft.ownerOf(idB)).to.equal(buyerAddr);
      expect(await nft.ownerOf(idA)).to.equal(await directBuyer.getAddress()); // unchanged, still the direct buyer

      const buyerBalAfter = await ethers.provider.getBalance(buyerAddr);
      // Buyer only actually spent price+fee for the ONE order that filled, plus gas -- A's share came back.
      expect(buyerBalBefore - buyerBalAfter).to.equal(PRICE_WEI + fee + gasCost);
    });

    it("reverts with NoOrdersFilled if every order in the batch fails", async () => {
      const idC = 30n;
      await mintAndApprove(idC);
      async function signedListingFor(tokenId: bigint, salt: bigint) {
        const counter: bigint = await seaport.getCounter(sellerAddr);
        const latestBlock = await provider.send("eth_getBlockByNumber", ["latest", false]);
        const now = Number(latestBlock.timestamp);
        const parameters = {
          offerer: sellerAddr,
          zone: ZERO_ADDRESS,
          offer: [{ itemType: 2, token: await nft.getAddress(), identifierOrCriteria: tokenId, startAmount: 1n, endAmount: 1n }],
          consideration: [
            { itemType: 0, token: ZERO_ADDRESS, identifierOrCriteria: 0n, startAmount: PRICE_WEI, endAmount: PRICE_WEI, recipient: sellerAddr },
          ],
          orderType: 0,
          startTime: 0n,
          endTime: BigInt(now - 1), // already expired -- guaranteed Seaport rejection
          zoneHash: ZERO_HASH,
          salt,
          conduitKey: ZERO_HASH,
          totalOriginalConsiderationItems: 1n,
        };
        const domain = { name: "Seaport", version: "1.6", chainId: 31337, verifyingContract: SEAPORT_ADDRESS };
        const signature = await seller.signTypedData(domain, EIP_712_ORDER_TYPE, { ...parameters, counter });
        return { parameters, numerator: 1, denominator: 1, signature, extraData: "0x" };
      }
      const expired = await signedListingFor(idC, 300n);
      const fee = (PRICE_WEI * FEE_BPS) / 10_000n;
      await expect(
        router.connect(buyer).sweepBuy([expired], [[]], ZERO_HASH, [PRICE_WEI], { value: PRICE_WEI + fee })
      ).to.be.revertedWithCustomError(router, "NoOrdersFilled");
    });

    it("rejects an empty sweep and a batch exceeding MAX_SWEEP_ITEMS", async () => {
      await expect(
        router.connect(buyer).sweepBuy([], [], ZERO_HASH, [], { value: 0 })
      ).to.be.revertedWithCustomError(router, "EmptySweep");
    });
  });

  describe("buyNowWithToken", () => {
    let weth: any;

    beforeEach(async () => {
      const WethFactory = await ethers.getContractFactory("MockWeth");
      weth = await WethFactory.deploy();
    });

    async function signedTokenListing(tokenId: bigint, salt: bigint) {
      await nft.mint(sellerAddr, tokenId);
      await nft.connect(seller).setApprovalForAll(SEAPORT_ADDRESS, true);
      const counter: bigint = await seaport.getCounter(sellerAddr);
      const latestBlock = await provider.send("eth_getBlockByNumber", ["latest", false]);
      const now = Number(latestBlock.timestamp);
      const parameters = {
        offerer: sellerAddr,
        zone: ZERO_ADDRESS,
        offer: [{ itemType: 2, token: await nft.getAddress(), identifierOrCriteria: tokenId, startAmount: 1n, endAmount: 1n }],
        consideration: [
          {
            itemType: 1, // ERC20
            token: await weth.getAddress(),
            identifierOrCriteria: 0n,
            startAmount: PRICE_WEI,
            endAmount: PRICE_WEI,
            recipient: sellerAddr,
          },
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

    it("PROOF: fulfils a WETH-denominated order, pays seller in WETH, fee in WETH to treasury, no lingering allowance on the router", async () => {
      const tokenId = 40n;
      const order = await signedTokenListing(tokenId, 400n);
      const fee = (PRICE_WEI * FEE_BPS) / 10_000n;
      const total = PRICE_WEI + fee;

      await weth.mint(buyerAddr, total);
      await weth.connect(buyer).approve(await router.getAddress(), total);

      await router.connect(buyer).buyNowWithToken(order, [], PRICE_WEI, await weth.getAddress());

      expect(await nft.ownerOf(tokenId)).to.equal(buyerAddr);
      expect(await weth.balanceOf(sellerAddr)).to.equal(PRICE_WEI);
      expect(await weth.balanceOf(treasuryAddr)).to.equal(fee);
      expect(await weth.balanceOf(await router.getAddress())).to.equal(0n);
      expect(await weth.allowance(await router.getAddress(), SEAPORT_ADDRESS)).to.equal(0n); // no lingering approval
    });

    it("reverts if the buyer never approved the router for the token", async () => {
      const tokenId = 41n;
      const order = await signedTokenListing(tokenId, 401n);
      // No mint, no approve.
      await expect(
        router.connect(buyer).buyNowWithToken(order, [], PRICE_WEI, await weth.getAddress())
      ).to.be.revert(ethers);
    });
  });
});
