import assert from "node:assert/strict";
import test from "node:test";
import { classifyTransfer } from "../../lib/market/activity";

const SEAPORT = "0x0000000000000068F116a894984e2DB1123eB395";
const NFT = "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156";
const ZERO = "0x0000000000000000000000000000000000000000";
const OTHER_MARKETPLACE = "0x1234567890123456789012345678901234567890";
const VAULT = "0xb2019Fd4cA24502e812C0C73b751Fa49979BF708";

test("a mint (from the zero address) is always a mint, regardless of executor", () => {
  const r = classifyTransfer({ from: ZERO, txTo: SEAPORT, seaportAddress: SEAPORT, nftContractAddress: NFT });
  assert.equal(r.kind, "mint");
  assert.equal(r.venue, null);
});

test("a direct call to the NFT contract itself is a plain transfer, no venue", () => {
  const r = classifyTransfer({
    from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
    txTo: NFT,
    seaportAddress: SEAPORT,
    nftContractAddress: NFT,
  });
  assert.equal(r.kind, "transfer");
  assert.equal(r.venue, null);
});

test("a call executed via the Seaport contract is a sale, venue = seaport — NOT marketplank", () => {
  // This is the exact bug that was caught live: Seaport is shared protocol
  // infrastructure. Going through it is not evidence of who initiated the
  // order — attribution to us requires a positive orderHash match, applied
  // later by upgradeMarketplankAttribution, not inferred from the address.
  const r = classifyTransfer({
    from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
    txTo: SEAPORT,
    seaportAddress: SEAPORT,
    nftContractAddress: NFT,
  });
  assert.equal(r.kind, "sale");
  assert.deepEqual(r.venue, { kind: "seaport", contract: SEAPORT });
});

test("a call executed via ANY OTHER contract is still detected as a sale — venue = other", () => {
  const r = classifyTransfer({
    from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
    txTo: OTHER_MARKETPLACE,
    seaportAddress: SEAPORT,
    nftContractAddress: NFT,
  });
  assert.equal(r.kind, "sale");
  assert.deepEqual(r.venue, { kind: "other", contract: OTHER_MARKETPLACE });
});

test("classification is case-insensitive on addresses", () => {
  const r = classifyTransfer({
    from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
    txTo: SEAPORT.toUpperCase().replace("0X", "0x"),
    seaportAddress: SEAPORT.toLowerCase(),
    nftContractAddress: NFT,
  });
  assert.equal(r.kind, "sale");
  assert.equal(r.venue?.kind, "seaport");
});

test("a call executed via the vault is a transfer, not a sale — venue = vault", () => {
  // The exact bug reported live: deposit()/redeemTarget()/claimRandomRedeem()
  // all execute via the vault contract, which the generic "any other
  // contract = sale" branch above would otherwise misclassify as a sale
  // with no price to show ("price unavailable"). VaultTradeHistory already
  // shows these with their real numbers — this feed must not double-count
  // them as broken sales, and must check vault BEFORE the generic fallback.
  const r = classifyTransfer({
    from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
    txTo: VAULT,
    seaportAddress: SEAPORT,
    nftContractAddress: NFT,
    vaultAddress: VAULT,
  });
  assert.equal(r.kind, "transfer");
  assert.deepEqual(r.venue, { kind: "vault", contract: VAULT });
});

test("with no vault configured, a vault-shaped address still falls through to the generic sale path", () => {
  const r = classifyTransfer({
    from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
    txTo: VAULT,
    seaportAddress: SEAPORT,
    nftContractAddress: NFT,
    vaultAddress: null,
  });
  assert.equal(r.kind, "sale");
  assert.deepEqual(r.venue, { kind: "other", contract: VAULT });
});

test("an unreadable transaction (txTo null) falls back to plain transfer rather than crashing", () => {
  const r = classifyTransfer({
    from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
    txTo: null,
    seaportAddress: SEAPORT,
    nftContractAddress: NFT,
  });
  assert.equal(r.kind, "transfer");
  assert.equal(r.venue, null);
});
