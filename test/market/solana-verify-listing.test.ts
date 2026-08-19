import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { verifySolanaListingOnChain } from "../../app/api/market/multichain/solana-verify-listing/route";

// Reuses the same real, live-verified fixture magiceden-m2-onchain.test.ts
// pins (see that file's header for the full "checked against the real
// me-foundation/m2 source, then matched Magic Eden's own live API" trail) --
// these tests exercise verifySolanaListingOnChain's own glue: turning a
// Magic Eden per-token API response into a real fetchM2Listing call, and its
// three fail-closed shapes, with the network calls stubbed rather than live.
const REAL_LISTING = {
  pdaAddress: "D1KhqL6y9txRCuHb2Q7V99McYUse6RHoJB8j4Q56fLZ1",
  auctionHouse: "E8cU1WiRWjanGxmn96ewBgk9vPTcL6AEZ1t6F6fkgUWe",
  tokenAccount: "G5TTWeAxhSnPGyRZP1yQsdVXFaPcXjtwT2eobFKLDt3w",
  tokenMint: "BDt2nwbxEcWcufSQi8FUs3PiWRgqwyrwLHdGG1tJzkuc",
  seller: "2ZCQ18QjibZZCPfcCesdZ1y2WMmZKd5rKZLyc2sjYGir",
  priceSol: 5.6915,
  priceLamports: "5691500000",
};

/** Builds a synthetic Anchor-shaped SellerTradeState buffer, same layout magiceden-m2-onchain.test.ts's own builder uses. */
function buildSellerTradeStateBuffer(priceLamports: bigint): Buffer {
  const parts: Buffer[] = [Buffer.alloc(8, 0)];
  parts.push(new PublicKey(REAL_LISTING.auctionHouse).toBuffer());
  parts.push(new PublicKey(REAL_LISTING.seller).toBuffer());
  parts.push(new PublicKey("autMW8SgBkVYeBgqYiTuJZnkvDZMVU2MHJh9Jh7CSQ2").toBuffer());
  const price = Buffer.alloc(8);
  price.writeBigUInt64LE(priceLamports);
  parts.push(price);
  parts.push(new PublicKey(REAL_LISTING.tokenMint).toBuffer());
  parts.push(new PublicKey(REAL_LISTING.tokenAccount).toBuffer());
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(1n);
  parts.push(size);
  parts.push(Buffer.from([254]));
  const expiry = Buffer.alloc(8);
  expiry.writeBigInt64LE(-1n);
  parts.push(expiry);
  return Buffer.concat(parts);
}

function fakeConnectionReturning(data: Buffer | null): Connection {
  return {
    getAccountInfo: async () => (data ? { owner: new PublicKey("M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K"), data } : null),
  } as unknown as Connection;
}

function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

test("verifySolanaListingOnChain reports a real, matching listing as verified with priceMatches true", async () => {
  const connection = fakeConnectionReturning(buildSellerTradeStateBuffer(BigInt(REAL_LISTING.priceLamports)));
  const fetchImpl = fetchReturning(200, [
    {
      pdaAddress: REAL_LISTING.pdaAddress,
      auctionHouse: REAL_LISTING.auctionHouse,
      tokenAddress: REAL_LISTING.tokenAccount,
      seller: REAL_LISTING.seller,
      tokenMint: REAL_LISTING.tokenMint,
      price: REAL_LISTING.priceSol,
    },
  ]);
  const result = await verifySolanaListingOnChain({ tokenMint: REAL_LISTING.tokenMint, connection, fetchImpl });
  assert.equal(result.verified, true);
  if (result.verified) {
    assert.equal(result.priceMatches, true);
    assert.equal(result.onchain.pda, REAL_LISTING.pdaAddress);
    assert.equal(result.onchain.priceLamports, REAL_LISTING.priceLamports);
  }
});

test("verifySolanaListingOnChain reports priceMatches false when the API price and the decoded on-chain price disagree", async () => {
  // On-chain buffer says 5.6915 SOL, but the API claims a different price --
  // a real, honest mismatch signal, not a silently-passed check.
  const connection = fakeConnectionReturning(buildSellerTradeStateBuffer(BigInt(REAL_LISTING.priceLamports)));
  const fetchImpl = fetchReturning(200, [
    {
      pdaAddress: REAL_LISTING.pdaAddress,
      auctionHouse: REAL_LISTING.auctionHouse,
      tokenAddress: REAL_LISTING.tokenAccount,
      seller: REAL_LISTING.seller,
      tokenMint: REAL_LISTING.tokenMint,
      price: 1.0,
    },
  ]);
  const result = await verifySolanaListingOnChain({ tokenMint: REAL_LISTING.tokenMint, connection, fetchImpl });
  assert.equal(result.verified, true);
  if (result.verified) assert.equal(result.priceMatches, false);
});

test("verifySolanaListingOnChain fails closed (verified:false, not a throw) when Magic Eden returns no listing for this token", async () => {
  const connection = fakeConnectionReturning(null);
  const fetchImpl = fetchReturning(200, []);
  const result = await verifySolanaListingOnChain({ tokenMint: REAL_LISTING.tokenMint, connection, fetchImpl });
  assert.equal(result.verified, false);
  if (!result.verified) assert.match(result.reason, /No active Magic Eden listing/);
});

test("verifySolanaListingOnChain fails closed when Magic Eden's API itself errors", async () => {
  const connection = fakeConnectionReturning(null);
  const fetchImpl = fetchReturning(502, {});
  const result = await verifySolanaListingOnChain({ tokenMint: REAL_LISTING.tokenMint, connection, fetchImpl });
  assert.equal(result.verified, false);
  if (!result.verified) assert.match(result.reason, /Magic Eden 502/);
});

test("verifySolanaListingOnChain fails closed when the API lead resolves but no on-chain account exists at the derived PDA (listing was cancelled/filled)", async () => {
  // Real lead, but the PDA the app derives from it doesn't exist on-chain --
  // fetchM2Listing returns null (see magiceden-m2-onchain.ts's own
  // not-found-is-null contract) rather than the app fabricating a match.
  const connection = fakeConnectionReturning(null);
  const fetchImpl = fetchReturning(200, [
    {
      pdaAddress: REAL_LISTING.pdaAddress,
      auctionHouse: REAL_LISTING.auctionHouse,
      tokenAddress: REAL_LISTING.tokenAccount,
      seller: REAL_LISTING.seller,
      tokenMint: REAL_LISTING.tokenMint,
      price: REAL_LISTING.priceSol,
    },
  ]);
  const result = await verifySolanaListingOnChain({ tokenMint: REAL_LISTING.tokenMint, connection, fetchImpl });
  assert.equal(result.verified, false);
  if (!result.verified) assert.match(result.reason, /no matching on-chain account/);
});
