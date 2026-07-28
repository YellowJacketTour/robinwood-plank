import assert from "node:assert/strict";
import test from "node:test";
import { verifyOrderSignature, type Rpc } from "../../lib/market/signature";

/**
 * A background security review flagged that the DELETE /api/market/orders
 * route purged any order on `signatureFailsOffline(rawOrder)` alone — a
 * plain ecrecover check. A contract-wallet (EIP-1271, e.g. Safe) order
 * ALWAYS recovers to a random EOA under plain ecrecover, so this check would
 * misclassify every genuine smart-account order as "forged" — and since the
 * DELETE endpoint requires no proof of identity to call, anyone could delete
 * anyone's contract-wallet listing on demand. That is an unauthenticated
 * deletion bug, not a false positive.
 *
 * The fix: run the full on-chain-aware verifier (the same one POST uses) and
 * only purge on a genuine, non-transient failure.
 */

const EIP1271_MAGIC = "0x1626ba7e";

function baseParams(offerer: string) {
  return {
    offerer,
    zone: "0x0000000000000000000000000000000000000000",
    offer: [{ itemType: 2, token: "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156", identifierOrCriteria: "1", startAmount: "1", endAmount: "1" }],
    consideration: [{ itemType: 0, token: "0x0000000000000000000000000000000000000000", identifierOrCriteria: "0", startAmount: "1000000000000000000", endAmount: "1000000000000000000", recipient: offerer }],
    orderType: 0,
    startTime: "0",
    endTime: String(Math.floor(Date.now() / 1000) + 86400),
    zoneHash: "0x" + "0".repeat(64),
    salt: "0",
    conduitKey: "0x" + "0".repeat(64),
    counter: "0",
  };
}

test("a genuine EIP-1271 contract-wallet order is NOT flagged for deletion", async () => {
  const CONTRACT_WALLET = "0x1111111111111111111111111111111111111111";
  const order = { parameters: baseParams(CONTRACT_WALLET), signature: "0xaabbccdd" };

  // The mock RPC represents a real chain: this address has code (it's a
  // contract wallet), isValidSignature approves, and the counter matches.
  const rpc: Rpc = {
    getCode: async () => "0x6080604052",
    call: async (_to, data) => {
      if (data.startsWith("0x1626ba7e")) {
        // bytes4 return: left-aligned, right-padded to 32 bytes.
        return EIP1271_MAGIC + "0".repeat(56);
      }
      // getCounter(offerer) -> 0
      return "0x" + "0".repeat(64);
    },
  };

  const result = await verifyOrderSignature(order, rpc);
  assert.equal(result.ok, true, "a genuinely-approved contract-wallet order must verify, not be purgeable");
});

test("a genuinely forged order (garbage signature, real EOA offerer) IS flagged for deletion", async () => {
  const EOA = "0x2222222222222222222222222222222222222222";
  const order = { parameters: baseParams(EOA), signature: "0xdeadbeef" };
  const rpc: Rpc = {
    getCode: async () => "0x", // plain EOA, no code
    call: async () => "0x" + "0".repeat(64),
  };
  const result = await verifyOrderSignature(order, rpc);
  assert.equal(result.ok, false);
  if (!result.ok) assert.notEqual(result.transient, true, "a real forgery must not be reported as merely transient");
});

test("an RPC outage during verification is marked transient — must never justify a purge", async () => {
  const CONTRACT_WALLET = "0x3333333333333333333333333333333333333333";
  const order = { parameters: baseParams(CONTRACT_WALLET), signature: "0xaabbccdd" };
  const rpc: Rpc = {
    getCode: async () => {
      throw new Error("network down");
    },
    call: async () => {
      throw new Error("network down");
    },
  };
  const result = await verifyOrderSignature(order, rpc);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.transient, true, "an unreachable RPC must be distinguishable from a real defect");
});

test("a contract wallet that genuinely rejects the signature IS flagged for deletion (non-transient)", async () => {
  const CONTRACT_WALLET = "0x4444444444444444444444444444444444444444";
  const order = { parameters: baseParams(CONTRACT_WALLET), signature: "0xaabbccdd" };
  const rpc: Rpc = {
    getCode: async () => "0x6080604052",
    call: async (_to, data) => {
      if (data.startsWith("0x1626ba7e")) {
        // Wrong magic value == the wallet explicitly rejects it.
        return "0x" + "0".repeat(64);
      }
      return "0x" + "0".repeat(64);
    },
  };
  const result = await verifyOrderSignature(order, rpc);
  assert.equal(result.ok, false);
  if (!result.ok) assert.notEqual(result.transient, true, "a genuine on-chain rejection must be purgeable, not treated as transient");
});
