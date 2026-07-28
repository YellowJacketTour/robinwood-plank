import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Contract, TypedDataEncoder } from "ethers";
import type { Signer } from "ethers";
import seaportFixture from "./fixtures/seaport-1.6-bytecode.json";
import {
  computeCriteriaProof,
  computeCriteriaRoot,
  verifyCriteriaProof,
} from "../../lib/market/criteria";

/**
 * THE CRITICAL PROOF for trait-scoped criteria bids (2026-07-28).
 *
 * The prior audit disabled "Offer any" because the criteria fulfil path was
 * never wired: orders carried an ERC721_WITH_CRITERIA item but no
 * CriteriaResolver was ever supplied, making every such bid unfillable. This
 * suite proves the NEW trait-bid path end to end against the REAL Seaport:
 *
 *  - the bytecode under test is the canonical Seaport 1.6 RUNTIME BYTECODE
 *    fetched from Robinhood Chain itself (fixtures/seaport-1.6-bytecode.json,
 *    fetched twice, identical, 23,981 bytes — the same figure the 2026-07-27
 *    audit independently verified), planted at the canonical address with
 *    hardhat_setCode. This is not a mock and not a reimplementation.
 *  - Seaport caches its deployment chainId (1237) and recomputes the EIP-712
 *    domain separator whenever block.chainid differs, so signatures over
 *    chainId 31337 verify against this exact bytecode under Hardhat. That
 *    behaviour is asserted below (information() vs a locally computed
 *    domain separator), not assumed.
 *  - the Merkle root comes from lib/market/criteria.ts, which uses
 *    seaport-js's OWN MerkleTree — the identical code path buildOffer uses
 *    when signing a trait bid in production.
 *
 * If these tests pass, a trait bid built by the app is fillable by a seller
 * holding any token in the snapshot, and NOT fillable with a token outside it.
 */

const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";
const ZERO_HASH = "0x" + "0".repeat(64);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Seaport 1.6 fragments needed here (canonical signatures). */
const SEAPORT_ABI = [
  "function information() view returns (string version, bytes32 domainSeparator, address conduitController)",
  "function getCounter(address offerer) view returns (uint256)",
  "function fulfillAdvancedOrder(" +
    "(" +
    "(address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters," +
    "uint120 numerator,uint120 denominator,bytes signature,bytes extraData" +
    ") advancedOrder," +
    "(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers," +
    "bytes32 fulfillerConduitKey,address recipient" +
    ") payable returns (bool fulfilled)",
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

/** The trait snapshot for these tests. Token 7 is deliberately OUTSIDE it. */
const TRAIT_SET = ["3", "17", "42", "99", "256"];
const IN_SET_TOKEN = "42";
const OUT_OF_SET_TOKEN = "7";
const BID_WEI = ethers.parseEther("1");

describe("Seaport 1.6 criteria fulfillment (REAL deployed bytecode)", () => {
  let bidder: Signer;
  let seller: Signer;
  let bidderAddr: string;
  let sellerAddr: string;
  let seaport: Contract;
  let nft: Contract;
  let weth: Contract;
  let root: string;

  before(async () => {
    [bidder, seller] = await ethers.getSigners();
    bidderAddr = await bidder.getAddress();
    sellerAddr = await seller.getAddress();

    // Plant the REAL canonical Seaport 1.6 runtime bytecode.
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

    // Seller owns one token inside the trait set and one outside it.
    for (const id of [...TRAIT_SET, OUT_OF_SET_TOKEN]) {
      await nft.mint(sellerAddr, BigInt(id));
    }
    await nft.connect(seller).setApprovalForAll(SEAPORT_ADDRESS, true);

    // Bidder funds + approval (mirrors the app's WETH bid flow, bounded amount).
    await weth.mint(bidderAddr, BID_WEI * BigInt(10));
    await weth.connect(bidder).approve(SEAPORT_ADDRESS, BID_WEI * BigInt(10));

    root = computeCriteriaRoot(TRAIT_SET);
  });

  /** Builds + signs a trait bid exactly shaped like buildOffer's criteria
   * variant: offer = WETH, consideration = one ERC721_WITH_CRITERIA item
   * whose identifierOrCriteria is the trait snapshot's Merkle root. */
  async function signedTraitBid(salt: bigint) {
    const counter: bigint = await seaport.getCounter(bidderAddr);
    const now = Math.floor(Date.now() / 1000);
    const parameters = {
      offerer: bidderAddr,
      zone: ZERO_ADDRESS,
      offer: [
        {
          itemType: 1, // ERC20
          token: await weth.getAddress(),
          identifierOrCriteria: BigInt(0),
          startAmount: BID_WEI,
          endAmount: BID_WEI,
        },
      ],
      consideration: [
        {
          itemType: 4, // ERC721_WITH_CRITERIA
          token: await nft.getAddress(),
          identifierOrCriteria: BigInt(root),
          startAmount: BigInt(1),
          endAmount: BigInt(1),
          recipient: bidderAddr,
        },
      ],
      orderType: 0, // FULL_OPEN
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
    const signature = await bidder.signTypedData(domain, EIP_712_ORDER_TYPE, {
      ...parameters,
      counter,
    });
    return { parameters, signature };
  }

  it("planted bytecode IS Seaport 1.6 and recomputes the domain separator for chainId 31337", async () => {
    const [version, domainSeparator] = await seaport.information();
    expect(version).to.equal("1.6");
    const local = TypedDataEncoder.hashDomain({
      name: "Seaport",
      version: "1.6",
      chainId: 31337,
      verifyingContract: SEAPORT_ADDRESS,
    });
    // If Seaport served its CACHED (chain 1237) separator instead of
    // recomputing, this would differ and every signature below would revert.
    expect(domainSeparator).to.equal(local);
  });

  it("app-computed root and proof agree with the independent on-chain-algorithm verifier", () => {
    const proof = computeCriteriaProof(TRAIT_SET, IN_SET_TOKEN);
    expect(verifyCriteriaProof(root, IN_SET_TOKEN, proof)).to.equal(true);
    // A non-member never verifies, under any proof from the honest tree.
    for (const member of TRAIT_SET) {
      const p = computeCriteriaProof(TRAIT_SET, member);
      expect(verifyCriteriaProof(root, OUT_OF_SET_TOKEN, p)).to.equal(false);
    }
  });

  it("PROOF: a trait-criteria bid is fulfilled end-to-end for a token IN the snapshot", async () => {
    const { parameters, signature } = await signedTraitBid(BigInt(1));
    const proof = computeCriteriaProof(TRAIT_SET, IN_SET_TOKEN);

    const sellerWethBefore: bigint = await weth.balanceOf(sellerAddr);
    expect(await nft.ownerOf(BigInt(IN_SET_TOKEN))).to.equal(sellerAddr);

    const tx = await seaport.connect(seller).fulfillAdvancedOrder(
      {
        parameters,
        numerator: 1,
        denominator: 1,
        signature,
        extraData: "0x",
      },
      [
        {
          orderIndex: 0,
          side: 1, // CONSIDERATION
          index: 0,
          identifier: BigInt(IN_SET_TOKEN),
          criteriaProof: proof,
        },
      ],
      ZERO_HASH,
      sellerAddr
    );
    await tx.wait();

    // The NFT moved to the bidder; the bid's WETH moved to the seller.
    expect(await nft.ownerOf(BigInt(IN_SET_TOKEN))).to.equal(bidderAddr);
    expect(await weth.balanceOf(sellerAddr)).to.equal(sellerWethBefore + BID_WEI);
  });

  it("REJECTED: a token OUTSIDE the snapshot cannot fill, even with a proof from a tree that includes it", async () => {
    const { parameters, signature } = await signedTraitBid(BigInt(2));
    // Attacker-style attempt: build a DIFFERENT tree that does contain the
    // out-of-set token and proffer its proof against the signed root.
    const forgedSet = [...TRAIT_SET, OUT_OF_SET_TOKEN];
    const forgedProof = computeCriteriaProof(forgedSet, OUT_OF_SET_TOKEN);

    await expect(
      seaport.connect(seller).fulfillAdvancedOrder(
        { parameters, numerator: 1, denominator: 1, signature, extraData: "0x" },
        [
          {
            orderIndex: 0,
            side: 1,
            index: 0,
            identifier: BigInt(OUT_OF_SET_TOKEN),
            criteriaProof: forgedProof,
          },
        ],
        ZERO_HASH,
        sellerAddr
      )
    ).to.be.reverted; // Seaport InvalidProof()
  });

  it("REJECTED: an in-set token with a tampered proof cannot fill", async () => {
    const { parameters, signature } = await signedTraitBid(BigInt(3));
    const proof = computeCriteriaProof(TRAIT_SET, "17");
    const tampered = [...proof];
    tampered[0] = ZERO_HASH.replace(/0$/, "1"); // flip a byte

    await expect(
      seaport.connect(seller).fulfillAdvancedOrder(
        { parameters, numerator: 1, denominator: 1, signature, extraData: "0x" },
        [
          {
            orderIndex: 0,
            side: 1,
            index: 0,
            identifier: BigInt("17"),
            criteriaProof: tampered,
          },
        ],
        ZERO_HASH,
        sellerAddr
      )
    ).to.be.reverted;
  });

  it("REJECTED: omitting the criteria resolver entirely (the exact pre-audit failure mode) reverts", async () => {
    const { parameters, signature } = await signedTraitBid(BigInt(4));
    await expect(
      seaport.connect(seller).fulfillAdvancedOrder(
        { parameters, numerator: 1, denominator: 1, signature, extraData: "0x" },
        [], // no resolver — how "Offer any" used to try to fill
        ZERO_HASH,
        sellerAddr
      )
    ).to.be.reverted; // UnresolvedConsiderationCriteria()
  });

  it("a single-token criteria set also round-trips (edge: proof is empty, root = leaf hash)", async () => {
    const single = ["1106"];
    const singleRoot = computeCriteriaRoot(single);
    const singleProof = computeCriteriaProof(single, "1106");
    expect(verifyCriteriaProof(singleRoot, "1106", singleProof)).to.equal(true);
    expect(verifyCriteriaProof(singleRoot, "1107", singleProof)).to.equal(false);
  });
});
