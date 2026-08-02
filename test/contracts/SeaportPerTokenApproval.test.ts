import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Contract, TypedDataEncoder } from "ethers";
import type { Signer } from "ethers";
import seaportFixture from "./fixtures/seaport-1.6-bytecode.json";

/**
 * THE CRITICAL PROOF for the per-token-approval spoof (lib/market/seaport.ts,
 * wrapProviderWithApprovalSpoof / computeApprovalSpoof).
 *
 * BACKGROUND: seaport-js's client-side pre-flight (lib/utils/approval.js)
 * only ever calls ERC-721 `isApprovedForAll(owner, operator)` — never
 * `getApproved(tokenId)`. This marketplace deliberately signs listings and
 * offers with `exactApproval = true`, i.e. a single-token `approve(Seaport,
 * tokenId)` instead of a blanket `setApprovalForAll`, so those orders read as
 * unapproved to seaport-js and it throws before the wallet ever opens.
 *
 * The fix bypasses ONLY that one incomplete client-side read, after
 * independently confirming `getApproved(tokenId) == Seaport` on-chain. This
 * suite proves the premise the whole fix rests on, against the REAL deployed
 * Seaport 1.6 runtime bytecode (not a mock, not a reimplementation — see
 * SeaportCriteriaFulfill.test.ts for how the fixture was obtained and why the
 * chainId/EIP-712 domain-separator recomputation makes signatures verify
 * under Hardhat):
 *
 *   A Seaport order whose offerer granted ONLY a per-token `approve(Seaport,
 *   tokenId)` — with NO `setApprovalForAll` — is genuinely fillable on-chain,
 *   because with a zero conduitKey Seaport itself calls ERC-721
 *   `transferFrom`, and ERC-721 permits that when `getApproved(tokenId)` is
 *   the caller.
 *
 * If any assertion here contradicts that premise, the fix must not ship.
 */

const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";
const ZERO_HASH = "0x" + "0".repeat(64);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Seaport 1.6 fragments needed here (canonical signatures). */
const SEAPORT_ABI = [
  "function information() view returns (string version, bytes32 domainSeparator, address conduitController)",
  "function getCounter(address offerer) view returns (uint256)",
  "function fulfillOrder(" +
    "(" +
    "(address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters," +
    "bytes signature" +
    ") order," +
    "bytes32 fulfillerConduitKey" +
    ") payable returns (bool fulfilled)",
];

const ERC721_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function approve(address to, uint256 tokenId)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
];

/** Same EIP-712 struct lib/market/signature.ts verifies against (copied — the
 * hardhat tsconfig has no "@/" path aliases). */
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

const PRICE_WEI = ethers.parseEther("1");

describe("Seaport 1.6 per-token approval fillability (REAL deployed bytecode)", () => {
  let seller: Signer;
  let buyer: Signer;
  let sellerAddr: string;
  let buyerAddr: string;
  let seaport: Contract;
  let nft: Contract;
  let weth: Contract;

  before(async () => {
    [buyer, seller] = await ethers.getSigners();
    sellerAddr = await seller.getAddress();
    buyerAddr = await buyer.getAddress();

    // Plant the REAL canonical Seaport 1.6 runtime bytecode — same fixture,
    // same setup discipline as SeaportCriteriaFulfill.test.ts.
    expect((seaportFixture.bytecode.length - 2) / 2).to.equal(23_981);
    await network.provider.send("hardhat_setCode", [
      SEAPORT_ADDRESS,
      seaportFixture.bytecode,
    ]);
    seaport = new Contract(SEAPORT_ADDRESS, SEAPORT_ABI, seller);

    const NftFactory = await ethers.getContractFactory("MockRobinWoodNft");
    nft = (await NftFactory.deploy()) as unknown as Contract;
    const WethFactory = await ethers.getContractFactory("MockWeth");
    weth = (await WethFactory.deploy()) as unknown as Contract;
  });

  it("planted bytecode IS Seaport 1.6 and recomputes the domain separator for chainId 31337", async () => {
    const [version, domainSeparator] = await seaport.information();
    expect(version).to.equal("1.6");
    const local = TypedDataEncoder.hashDomain({
      name: "Seaport",
      version: "1.6",
      chainId: 31337,
      verifyingContract: SEAPORT_ADDRESS,
    });
    expect(domainSeparator).to.equal(local);
  });

  /** Builds + signs a fixed-price listing exactly shaped like buildListing:
   * offer = one ERC721, consideration = native ETH, zero conduitKey. */
  async function signedListing(
    offerer: Signer,
    offererAddr: string,
    tokenId: bigint,
    salt: bigint
  ) {
    const counter: bigint = await seaport.getCounter(offererAddr);
    const now = Math.floor(Date.now() / 1000);
    const parameters = {
      offerer: offererAddr,
      zone: ZERO_ADDRESS,
      offer: [
        {
          itemType: 2, // ERC721
          token: await nft.getAddress(),
          identifierOrCriteria: tokenId,
          startAmount: BigInt(1),
          endAmount: BigInt(1),
        },
      ],
      consideration: [
        {
          itemType: 0, // NATIVE
          token: ZERO_ADDRESS,
          identifierOrCriteria: BigInt(0),
          startAmount: PRICE_WEI,
          endAmount: PRICE_WEI,
          recipient: offererAddr,
        },
      ],
      orderType: 0, // FULL_OPEN
      startTime: BigInt(0),
      endTime: BigInt(now + 86_400),
      zoneHash: ZERO_HASH,
      salt,
      conduitKey: ZERO_HASH, // zero conduit — Seaport itself calls transferFrom
      totalOriginalConsiderationItems: BigInt(1),
    };
    const domain = {
      name: "Seaport",
      version: "1.6",
      chainId: 31337,
      verifyingContract: SEAPORT_ADDRESS,
    };
    const signature = await offerer.signTypedData(domain, EIP_712_ORDER_TYPE, {
      ...parameters,
      counter,
    });
    return { parameters, signature };
  }

  /** Builds + signs an item-level WETH offer exactly shaped like buildOffer's
   * single-token variant: offer = WETH, consideration = one fixed ERC721. */
  async function signedOffer(
    offerer: Signer,
    offererAddr: string,
    tokenId: bigint,
    recipientAddr: string,
    salt: bigint
  ) {
    const counter: bigint = await seaport.getCounter(offererAddr);
    const now = Math.floor(Date.now() / 1000);
    const parameters = {
      offerer: offererAddr,
      zone: ZERO_ADDRESS,
      offer: [
        {
          itemType: 1, // ERC20
          token: await weth.getAddress(),
          identifierOrCriteria: BigInt(0),
          startAmount: PRICE_WEI,
          endAmount: PRICE_WEI,
        },
      ],
      consideration: [
        {
          itemType: 2, // ERC721 fixed
          token: await nft.getAddress(),
          identifierOrCriteria: tokenId,
          startAmount: BigInt(1),
          endAmount: BigInt(1),
          recipient: recipientAddr,
        },
      ],
      orderType: 0,
      startTime: BigInt(0),
      endTime: BigInt(now + 86_400),
      zoneHash: ZERO_HASH,
      salt,
      conduitKey: ZERO_HASH,
      totalOriginalConsiderationItems: BigInt(1),
    };
    const domain = {
      name: "Seaport",
      version: "1.6",
      chainId: 31337,
      verifyingContract: SEAPORT_ADDRESS,
    };
    const signature = await offerer.signTypedData(domain, EIP_712_ORDER_TYPE, {
      ...parameters,
      counter,
    });
    return { parameters, signature };
  }

  it("PROOF: a listing with ONLY a per-token approve (no setApprovalForAll) fills — NFT and ETH both move", async () => {
    const tokenId = BigInt(9001);
    await nft.mint(sellerAddr, tokenId);

    const nftAsSeller = new Contract(await nft.getAddress(), ERC721_ABI, seller);
    // Honestly exercise the per-token path: confirm the blanket approval is
    // NOT what's making this fillable.
    expect(await nftAsSeller.isApprovedForAll(sellerAddr, SEAPORT_ADDRESS)).to.equal(false);
    await nftAsSeller.approve(SEAPORT_ADDRESS, tokenId);
    expect(await nftAsSeller.getApproved(tokenId)).to.equal(SEAPORT_ADDRESS);

    const { parameters, signature } = await signedListing(seller, sellerAddr, tokenId, BigInt(1));

    const sellerEthBefore = await ethers.provider.getBalance(sellerAddr);

    const tx = await seaport
      .connect(buyer)
      .fulfillOrder({ parameters, signature }, ZERO_HASH, { value: PRICE_WEI });
    await tx.wait();

    expect(await nft.ownerOf(tokenId)).to.equal(buyerAddr);
    const sellerEthAfter = await ethers.provider.getBalance(sellerAddr);
    expect(sellerEthAfter - sellerEthBefore).to.equal(PRICE_WEI);
  });

  it("NEGATIVE: the same listing shape with NO approval of any kind reverts", async () => {
    const tokenId = BigInt(9002);
    await nft.mint(sellerAddr, tokenId);

    const nftAsSeller = new Contract(await nft.getAddress(), ERC721_ABI, seller);
    expect(await nftAsSeller.isApprovedForAll(sellerAddr, SEAPORT_ADDRESS)).to.equal(false);
    expect(await nftAsSeller.getApproved(tokenId)).to.equal(ZERO_ADDRESS);

    const { parameters, signature } = await signedListing(seller, sellerAddr, tokenId, BigInt(2));

    await expect(
      seaport.connect(buyer).fulfillOrder({ parameters, signature }, ZERO_HASH, { value: PRICE_WEI })
    ).to.be.reverted;

    // Confirms this is a real on-chain gate, not a library artifact: nothing moved.
    expect(await nft.ownerOf(tokenId)).to.equal(sellerAddr);
  });

  it("APPROVAL CONSUMED: after the successful fill, getApproved(tokenId) no longer points to Seaport", async () => {
    const tokenId = BigInt(9003);
    await nft.mint(sellerAddr, tokenId);
    const nftAsSeller = new Contract(await nft.getAddress(), ERC721_ABI, seller);
    await nftAsSeller.approve(SEAPORT_ADDRESS, tokenId);
    expect(await nftAsSeller.getApproved(tokenId)).to.equal(SEAPORT_ADDRESS);

    const { parameters, signature } = await signedListing(seller, sellerAddr, tokenId, BigInt(3));
    const tx = await seaport
      .connect(buyer)
      .fulfillOrder({ parameters, signature }, ZERO_HASH, { value: PRICE_WEI });
    await tx.wait();

    expect(await nft.ownerOf(tokenId)).to.equal(buyerAddr);
    // ERC-721 clears per-token approval on transfer — the spoof cannot be
    // reused against this token once its approval is gone.
    expect(await nftAsSeller.getApproved(tokenId)).to.not.equal(SEAPORT_ADDRESS);
  });

  it("PROOF: an offer/bid acceptance also fills with ONLY a per-token approve on the accepting seller's side", async () => {
    const tokenId = BigInt(9004);
    await nft.mint(sellerAddr, tokenId);

    await weth.mint(buyerAddr, PRICE_WEI);
    const wethAsBuyer = weth.connect(buyer) as Contract;
    await wethAsBuyer.approve(SEAPORT_ADDRESS, PRICE_WEI);

    const nftAsSeller = new Contract(await nft.getAddress(), ERC721_ABI, seller);
    expect(await nftAsSeller.isApprovedForAll(sellerAddr, SEAPORT_ADDRESS)).to.equal(false);
    await nftAsSeller.approve(SEAPORT_ADDRESS, tokenId);

    // Buyer signs the bid; seller (accepting) fulfils it.
    const { parameters, signature } = await signedOffer(
      buyer,
      buyerAddr,
      tokenId,
      buyerAddr,
      BigInt(4)
    );

    const seaportAsSeller = new Contract(SEAPORT_ADDRESS, SEAPORT_ABI, seller);
    const tx = await seaportAsSeller.fulfillOrder({ parameters, signature }, ZERO_HASH);
    await tx.wait();

    expect(await nft.ownerOf(tokenId)).to.equal(buyerAddr);
    expect(await weth.balanceOf(sellerAddr)).to.equal(PRICE_WEI);
  });
});
