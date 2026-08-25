import assert from "node:assert/strict";
import test from "node:test";
import { MARKET_VENUES, hasUnindexedNativeBook, isCompleteVenueCoverage, venuesForChain } from "../../lib/market/multichain/venue-registry";

test("venue ids are unique and every venue declares capabilities", () => {
  assert.equal(new Set(MARKET_VENUES.map((venue) => venue.id)).size, MARKET_VENUES.length);
  for (const venue of MARKET_VENUES) assert.ok(venue.capabilities.length > 0, venue.id);
});

test("CryptoPunks native coverage distinguishes indexed book state from pending history lanes", () => {
  const venue = venuesForChain("eth-mainnet").find((candidate) => candidate.id === "cryptopunks-native");
  assert.ok(venue);
  assert.equal(venue.coverage, "partial");
  assert.ok(venue.capabilities.includes("listings"));
});

test("Bitcoin and Solana do not inherit EVM venues", () => {
  assert.ok(venuesForChain("bitcoin-mainnet").every((venue) => venue.family === "bitcoin"));
  assert.ok(venuesForChain("solana-mainnet").every((venue) => venue.family === "solana"));
});

test("partial or planned venue coverage cannot claim complete market history", () => {
  assert.equal(isCompleteVenueCoverage(venuesForChain("eth-mainnet")), false);
  assert.equal(isCompleteVenueCoverage(venuesForChain("solana-mainnet")), false);
  assert.equal(isCompleteVenueCoverage(venuesForChain("bitcoin-mainnet")), false);
});

test("CryptoPunks native book is unknown until its contract adapter is indexed", () => {
  assert.equal(hasUnindexedNativeBook("eth-mainnet", "0xB47E3CD837dDF8e4c57F05d70Ab865de6e193BBB"), true);
  assert.equal(hasUnindexedNativeBook("eth-mainnet", "0x0000000000000000000000000000000000000000"), false);
});
