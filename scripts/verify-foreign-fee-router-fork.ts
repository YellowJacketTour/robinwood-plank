/**
 * ONE-OFF verification script, not part of the regular test suite: proves
 * MarketplankForeignFeeRouter end-to-end against a LIVE FORK of a real
 * chain (Base mainnet) -- real deployed Seaport, real current chain state,
 * a REAL live order fetched from OpenSea right now -- with zero real money
 * or real deployment risk, since the fork is a throwaway local copy.
 */
import hre from "hardhat";
import { fetchBestForeignListing, fetchListingFulfillmentData } from "../lib/market/multichain/trading/foreign-orders";

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
if (!ALCHEMY_KEY) throw new Error("Set ALCHEMY_API_KEY");

const TREASURY = "0xcdb7ca36d35fa16d15fda859a46f1d72d979e9d8"; // MARKET_FEE_RECIPIENT
const FEE_BPS = BigInt(180);
const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";

async function main() {
  console.log("[1/7] Fetching a REAL live order from OpenSea for GRiBBiTS on Base...");
  const summary = await fetchBestForeignListing({ chainSlug: "base-mainnet", collectionSlug: "gribbits" });
  if (!summary) throw new Error("No live listing found right now -- try a different collection/time.");
  console.log(`      order hash ${summary.orderHash}`);

  console.log("[2/7] Fetching the REAL fulfillable (signed) order via OpenSea's fulfillment_data endpoint...");
  // A throwaway address -- OpenSea's fulfillment_data needs a real-shaped
  // fulfiller address to compute the order, but this script controls its
  // OWN buyer signer for actually executing the transaction below.
  const FULFILLER_PLACEHOLDER = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0";
  const order = await fetchListingFulfillmentData({
    chainSlug: "base-mainnet",
    orderHash: summary.orderHash,
    fulfillerAddress: FULFILLER_PLACEHOLDER,
  });
  if (!order.signature || order.signature === "0x") {
    throw new Error("fulfillment_data returned no real signature -- cannot proceed with this order.");
  }
  const item = order.parameters.offer[0];
  const considerationTotal = order.parameters.consideration.reduce(
    (sum, c) => sum + BigInt(c.startAmount),
    BigInt(0)
  );
  console.log(`      token ${item.identifierOrCriteria}, price ${considerationTotal} wei, signature ${order.signature.length} chars (real)`);

  console.log("[3/7] Forking Base mainnet at the current block...");
  // chainId MUST match the real chain (Base = 8453), not Hardhat's default
  // 31337 -- confirmed live: Seaport recomputes its EIP-712 domain
  // separator from block.chainid whenever it differs from its cached
  // deployment chainId (proven behavior, see
  // SeaportCriteriaFulfill.test.ts), so a mismatched fork chainId makes
  // every real signature fail InvalidSigner() even though the order and
  // signature are both genuinely valid on the real chain.
  const { ethers, provider } = await hre.network.create({
    override: { forking: { url: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` }, chainId: 8453 },
  });
  const head = await provider.send("eth_blockNumber", []);
  console.log(`      forked at block ${Number.parseInt(head, 16)}`);

  console.log("[4/7] Deploying MarketplankForeignFeeRouter to the fork...");
  const RouterFactory = await ethers.getContractFactory("MarketplankForeignFeeRouter");
  const router = await RouterFactory.deploy(SEAPORT_ADDRESS, TREASURY, FEE_BPS);
  await router.waitForDeployment();
  console.log(`      deployed at ${await router.getAddress()} (fork-only, never touches real Base)`);

  console.log("[5/7] Funding a throwaway buyer account (fork-only, hardhat_setBalance)...");
  const [buyer] = await ethers.getSigners();
  await provider.send("hardhat_setBalance", [await buyer.getAddress(), "0x56BC75E2D63100000"]); // 100 ETH
  const treasuryBalBefore: bigint = await ethers.provider.getBalance(TREASURY);

  console.log("[6/7] Executing buyNow against the REAL, REALLY-SIGNED order on the REAL forked Seaport...");
  const fee = (considerationTotal * FEE_BPS) / BigInt(10_000);
  const value = considerationTotal + fee;
  const nft = new ethers.Contract(item.token, ["function ownerOf(uint256) view returns (address)"], ethers.provider);
  const ownerBefore = await nft.ownerOf(item.identifierOrCriteria);
  console.log(`      seller (current owner) on real chain state: ${ownerBefore}`);

  // The forked chain's own block timestamp continues from the FORKED
  // block's timestamp, not real wall-clock time -- confirmed live: a real
  // order's startTime had already passed on the real chain by the time
  // this ran, but Seaport's own InvalidTime() reverted because our local
  // mined block hadn't caught up. Explicitly advance to real now.
  await provider.send("evm_setNextBlockTimestamp", ["0x" + Math.floor(Date.now() / 1000).toString(16)]);

  const tx = await router.connect(buyer).buyNow(
    {
      parameters: order.parameters,
      numerator: 1,
      denominator: 1,
      signature: order.signature,
      extraData: "0x",
    },
    [],
    "0x" + "0".repeat(64),
    considerationTotal,
    { value }
  );
  const receipt = await tx.wait();
  console.log(`      tx mined, status ${receipt?.status}`);

  console.log("[7/7] Verifying real state changes on the fork...");
  const ownerAfter = await nft.ownerOf(item.identifierOrCriteria);
  const treasuryBalAfter: bigint = await ethers.provider.getBalance(TREASURY);
  const buyerAddr = await buyer.getAddress();

  console.log(`      NFT owner after: ${ownerAfter} (buyer: ${buyerAddr}) -- ${ownerAfter.toLowerCase() === buyerAddr.toLowerCase() ? "MATCH" : "MISMATCH"}`);
  console.log(`      treasury balance delta: ${treasuryBalAfter - treasuryBalBefore} wei (expected fee: ${fee} wei) -- ${treasuryBalAfter - treasuryBalBefore === fee ? "MATCH" : "MISMATCH"}`);
  console.log(`      router balance after: ${await ethers.provider.getBalance(await router.getAddress())} wei (expected 0)`);

  if (ownerAfter.toLowerCase() !== buyerAddr.toLowerCase()) throw new Error("FAIL: NFT did not transfer to buyer");
  if (treasuryBalAfter - treasuryBalBefore !== fee) throw new Error("FAIL: treasury did not receive the exact fee");

  console.log("\nEND-TO-END PROOF PASSED: a real live OpenSea order for a real Base collection was genuinely fulfilled through the fee router against a fork of real chain state.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FORK PROOF FAILED:", e);
    process.exit(1);
  });
