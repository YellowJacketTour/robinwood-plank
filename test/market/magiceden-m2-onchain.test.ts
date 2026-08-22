import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  M2_PROGRAM_ID,
  getBuyerTradeStatePda,
  getSellerTradeStatePda,
  decodeM2TradeState,
  fetchM2TradeState,
} from "../../lib/market/multichain/adapters/magiceden-m2-onchain";

// Real, live-verified fixture (fetched 2026-08-18 from Magic Eden's own
// public API and independently re-derived against the actual me-foundation/m2
// source's seed formula -- see magiceden-m2-onchain.ts's header comment for
// the full trail). This is not a synthetic example: pdaAddress below is the
// REAL M2 SellerTradeState PDA for a real DeGods #338 listing.
const REAL_LISTING = {
  pdaAddress: "D1KhqL6y9txRCuHb2Q7V99McYUse6RHoJB8j4Q56fLZ1",
  auctionHouse: "E8cU1WiRWjanGxmn96ewBgk9vPTcL6AEZ1t6F6fkgUWe",
  tokenAccount: "G5TTWeAxhSnPGyRZP1yQsdVXFaPcXjtwT2eobFKLDt3w",
  tokenMint: "BDt2nwbxEcWcufSQi8FUs3PiWRgqwyrwLHdGG1tJzkuc",
  seller: "2ZCQ18QjibZZCPfcCesdZ1y2WMmZKd5rKZLyc2sjYGir",
  priceLamports: "5691500000",
};

test("getSellerTradeStatePda derives the exact real PDA Magic Eden's own API returned for a live listing", () => {
  const pda = getSellerTradeStatePda({
    seller: REAL_LISTING.seller,
    auctionHouse: REAL_LISTING.auctionHouse,
    tokenAccount: REAL_LISTING.tokenAccount,
    tokenMint: REAL_LISTING.tokenMint,
  });
  assert.equal(pda.toBase58(), REAL_LISTING.pdaAddress);
});

test("getBuyerTradeStatePda uses the 4-seed (no token account) formula and differs from the seller PDA", () => {
  const buyerPda = getBuyerTradeStatePda({
    buyer: REAL_LISTING.seller,
    auctionHouse: REAL_LISTING.auctionHouse,
    tokenMint: REAL_LISTING.tokenMint,
  });
  assert.notEqual(buyerPda.toBase58(), REAL_LISTING.pdaAddress);
  // Deterministic: re-deriving with the same inputs must give the same PDA.
  const again = getBuyerTradeStatePda({
    buyer: REAL_LISTING.seller,
    auctionHouse: REAL_LISTING.auctionHouse,
    tokenMint: REAL_LISTING.tokenMint,
  });
  assert.equal(buyerPda.toBase58(), again.toBase58());
});

/** Builds a synthetic Anchor-shaped SellerTradeState buffer matching the real field layout, for decode-path unit testing without a network call. */
function buildSellerTradeStateBuffer(fields: {
  auctionHouse: string;
  seller: string;
  referral: string;
  priceLamports: bigint;
  tokenMint: string;
  tokenAccount: string;
  tokenSize: bigint;
  bump: number;
  expiry: bigint;
}): Buffer {
  const parts: Buffer[] = [Buffer.alloc(8, 0)]; // discriminator, unused by decode
  parts.push(new PublicKey(fields.auctionHouse).toBuffer());
  parts.push(new PublicKey(fields.seller).toBuffer());
  parts.push(new PublicKey(fields.referral).toBuffer());
  const price = Buffer.alloc(8);
  price.writeBigUInt64LE(fields.priceLamports);
  parts.push(price);
  parts.push(new PublicKey(fields.tokenMint).toBuffer());
  parts.push(new PublicKey(fields.tokenAccount).toBuffer());
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(fields.tokenSize);
  parts.push(size);
  parts.push(Buffer.from([fields.bump]));
  const expiry = Buffer.alloc(8);
  expiry.writeBigInt64LE(fields.expiry);
  parts.push(expiry);
  return Buffer.concat(parts);
}

test("decodeM2TradeState decodes a SellerTradeState buffer matching the real listing's known price/expiry", () => {
  const buf = buildSellerTradeStateBuffer({
    auctionHouse: REAL_LISTING.auctionHouse,
    seller: REAL_LISTING.seller,
    referral: "autMW8SgBkVYeBgqYiTuJZnkvDZMVU2MHJh9Jh7CSQ2",
    priceLamports: BigInt(REAL_LISTING.priceLamports),
    tokenMint: REAL_LISTING.tokenMint,
    tokenAccount: REAL_LISTING.tokenAccount,
    tokenSize: 1n,
    bump: 254,
    expiry: -1n,
  });
  const decoded = decodeM2TradeState(REAL_LISTING.pdaAddress, buf, true);
  assert.equal(decoded.priceLamports, REAL_LISTING.priceLamports);
  assert.equal(decoded.wallet, REAL_LISTING.seller);
  assert.equal(decoded.tokenMint, REAL_LISTING.tokenMint);
  assert.equal(decoded.tokenAccount, REAL_LISTING.tokenAccount);
  assert.equal(decoded.expiry, -1);
  assert.equal(decoded.tokenSize, 1);
  assert.equal(decoded.bump, 254);
});

test("decodeM2TradeState decodes a BuyerTradeState buffer (no token account field) correctly", () => {
  // BuyerTradeState has no tokenAccount field -- one fewer 32-byte pubkey.
  const parts: Buffer[] = [Buffer.alloc(8, 0)];
  parts.push(new PublicKey(REAL_LISTING.auctionHouse).toBuffer());
  parts.push(new PublicKey(REAL_LISTING.seller).toBuffer()); // reused as buyer for the fixture
  parts.push(new PublicKey("autMW8SgBkVYeBgqYiTuJZnkvDZMVU2MHJh9Jh7CSQ2").toBuffer());
  const price = Buffer.alloc(8);
  price.writeBigUInt64LE(1_000_000_000n);
  parts.push(price);
  parts.push(new PublicKey(REAL_LISTING.tokenMint).toBuffer());
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(1n);
  parts.push(size);
  parts.push(Buffer.from([255]));
  const expiry = Buffer.alloc(8);
  expiry.writeBigInt64LE(1800000000n);
  parts.push(expiry);
  const buf = Buffer.concat(parts);

  const decoded = decodeM2TradeState("SomePda11111111111111111111111111111111111", buf, false);
  assert.equal(decoded.tokenAccount, null);
  assert.equal(decoded.priceLamports, "1000000000");
  assert.equal(decoded.expiry, 1800000000);
});

test("fetchM2TradeState returns null when the account does not exist (fail-closed, no throw)", async () => {
  const fakeConnection = {
    getAccountInfo: async () => null,
  } as unknown as import("@solana/web3.js").Connection;
  const pda = getBuyerTradeStatePda({
    buyer: REAL_LISTING.seller,
    auctionHouse: REAL_LISTING.auctionHouse,
    tokenMint: REAL_LISTING.tokenMint,
  });
  const result = await fetchM2TradeState({ connection: fakeConnection, pda, hasTokenAccount: false });
  assert.equal(result, null);
});

test("fetchM2TradeState throws when the account exists but isn't owned by the M2 program", async () => {
  const wrongOwner = PublicKey.default;
  const fakeConnection = {
    getAccountInfo: async () => ({ owner: wrongOwner, data: Buffer.alloc(200) }),
  } as unknown as import("@solana/web3.js").Connection;
  const pda = getBuyerTradeStatePda({
    buyer: REAL_LISTING.seller,
    auctionHouse: REAL_LISTING.auctionHouse,
    tokenMint: REAL_LISTING.tokenMint,
  });
  await assert.rejects(() => fetchM2TradeState({ connection: fakeConnection, pda, hasTokenAccount: false }));
});

test("M2_PROGRAM_ID matches the real, live me-foundation/m2 program address", () => {
  assert.equal(M2_PROGRAM_ID.toBase58(), "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K");
});
