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

/**
 * Found while backfilling the permanent event ledger against the real chain
 * (2026-08-04): 130 of 375 rows classified as "sale" were actually deposits
 * into or redeems from a LEGACY pool. Only the PRIMARY vault address was ever
 * passed here, so a legacy vault's `txTo` matched nothing and fell straight
 * through to the generic "some other contract executed it, therefore a sale"
 * branch — surfacing pool mechanics as unpriced sales in the Activity feed and,
 * once a ledger exists, writing that mistake down permanently.
 *
 * AGENTS.md is explicit that vaults are an N-vault registry and must never be
 * resolved as a single "the vault". This is that rule with a test behind it.
 */
test("a LEGACY vault's deposit/redeem is a vault transfer, not a sale", () => {
  const LEGACY_A = "0xb2019Fd4cA24502e812C0C73b751Fa49979BF708";
  const LEGACY_B = "0xc4B29D7a01603D2A5937b1FC86ea85E488d72e04";
  for (const legacy of [LEGACY_A, LEGACY_B]) {
    const r = classifyTransfer({
      from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
      txTo: legacy,
      seaportAddress: SEAPORT,
      nftContractAddress: NFT,
      vaultAddress: VAULT,
      vaultAddresses: [VAULT, LEGACY_A, LEGACY_B],
    });
    assert.equal(r.kind, "transfer", `${legacy} must not be a sale`);
    assert.equal(r.venue?.kind, "vault");
  }
});

/**
 * Second classification bug found the same way (2026-08-04): after the legacy
 * vaults were accounted for, 131 "sales" still carried no price. Pulling every
 * one of their receipts off the real chain showed 121 had no payment leg of any
 * kind — they were not sales at all:
 *   0x0000000000c2d145a2526bd8c716263bfebe1a72  83  Seaport's TransferHelper,
 *                                                   method bulkTransfer
 *   0xd5c0fc17959314b212db7de6a195586be18d5c97  26  0xb58adcb2 =
 *                                                   safeBatchTransferToSingleWallet
 *   0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789   9  ERC-4337 EntryPoint,
 *                                                   0x1fad948c = handleOps
 * while RelayApprovalProxyV3 (0xccc8…15be) turned out to be the opposite case:
 * an unrecognised address whose receipts DO carry a real Seaport fill.
 * The address a transaction was sent to therefore decides nothing on its own.
 */
const TRANSFER_HELPER = "0x0000000000c2d145a2526bd8c716263bfebe1a72";
const RELAY_PROXY = "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be";

test("a contract call with a receipt proving no payment is a transfer, not an unpriced sale", () => {
  for (const executor of [TRANSFER_HELPER, "0xd5c0fc17959314b212db7de6a195586be18d5c97"]) {
    const r = classifyTransfer({
      from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
      txTo: executor,
      seaportAddress: SEAPORT,
      nftContractAddress: NFT,
      saleEvidence: "none",
    });
    assert.equal(r.kind, "transfer", `${executor} moved no money`);
    assert.equal(r.venue, null);
  }
});

test("a fill routed through an unknown proxy is a SALE, with Seaport as the venue", () => {
  const r = classifyTransfer({
    from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
    txTo: RELAY_PROXY,
    seaportAddress: SEAPORT,
    nftContractAddress: NFT,
    saleEvidence: "seaport-fill",
  });
  assert.equal(r.kind, "sale");
  assert.deepEqual(
    r.venue,
    { kind: "seaport", contract: SEAPORT },
    "the order cleared on Seaport — the router is not the venue"
  );
});

test("an unknown contract that moved ETH is still a sale at an unnamed venue", () => {
  const r = classifyTransfer({
    from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
    txTo: OTHER_MARKETPLACE,
    seaportAddress: SEAPORT,
    nftContractAddress: NFT,
    saleEvidence: "native-value",
  });
  assert.equal(r.kind, "sale");
  assert.deepEqual(r.venue, { kind: "other", contract: OTHER_MARKETPLACE });
});

test("evidence can never demote a transaction Seaport itself executed", () => {
  // The safety rail on the rule above: a receipt this run failed to decode must
  // not be able to turn a real Seaport fill into a plain transfer.
  const r = classifyTransfer({
    from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
    txTo: SEAPORT,
    seaportAddress: SEAPORT,
    nftContractAddress: NFT,
    saleEvidence: "none",
  });
  assert.equal(r.kind, "sale");
  assert.equal(r.venue?.kind, "seaport");
});

test("a vault mechanic stays a vault transfer even when a receipt shows payment", () => {
  const r = classifyTransfer({
    from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
    txTo: VAULT,
    seaportAddress: SEAPORT,
    nftContractAddress: NFT,
    vaultAddresses: [VAULT],
    saleEvidence: "native-value",
  });
  assert.equal(r.kind, "transfer");
  assert.equal(r.venue?.kind, "vault");
});

/**
 * The production regression this branch exists for (live feed, 2026-08-06):
 * the V3 pool 0xacE28f72… dropped out of the indexer's env vault list, so
 * `depositMany` was written to the permanent ledger as a "sale" priced at the
 * 0.0001 ETH deposit fee, and `redeemTargetMany` as an unpriced "sale". The env
 * list can drift; the vault's own event log cannot.
 */
test("a vault the env list has never heard of is still a vault transfer, from its own event", () => {
  const r = classifyTransfer({
    from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
    txTo: VAULT,
    seaportAddress: SEAPORT,
    nftContractAddress: NFT,
    // Deliberately empty — this is exactly the misconfigured deployment.
    vaultAddresses: [],
    saleEvidence: "native-value",
    vaultEventContract: VAULT.toLowerCase(),
  });
  assert.equal(r.kind, "transfer");
  assert.deepEqual(r.venue, { kind: "vault", contract: VAULT.toLowerCase() });
});

test("no vault event in the receipt leaves a genuine sale a sale", () => {
  const r = classifyTransfer({
    from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
    txTo: OTHER_MARKETPLACE,
    seaportAddress: SEAPORT,
    nftContractAddress: NFT,
    saleEvidence: "native-value",
    vaultEventContract: null,
  });
  assert.equal(r.kind, "sale");
  assert.deepEqual(r.venue, { kind: "other", contract: OTHER_MARKETPLACE });
});

test("with NO evidence supplied, classification is byte-for-byte what it always was", () => {
  // An unreadable receipt must leave behaviour unchanged rather than guess in
  // the other direction — silently demoting real sales would be a worse bug.
  const r = classifyTransfer({
    from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
    txTo: OTHER_MARKETPLACE,
    seaportAddress: SEAPORT,
    nftContractAddress: NFT,
  });
  assert.equal(r.kind, "sale");
  assert.deepEqual(r.venue, { kind: "other", contract: OTHER_MARKETPLACE });
});

test("vault matching is case-insensitive, so a checksummed registry entry still matches", () => {
  const r = classifyTransfer({
    from: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
    txTo: VAULT.toLowerCase(),
    seaportAddress: SEAPORT,
    nftContractAddress: NFT,
    vaultAddresses: [VAULT.toUpperCase().replace("0X", "0x")],
  });
  assert.equal(r.kind, "transfer");
  assert.equal(r.venue?.kind, "vault");
});
