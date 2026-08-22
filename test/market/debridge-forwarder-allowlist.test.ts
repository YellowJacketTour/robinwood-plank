import assert from "node:assert/strict";
import test from "node:test";
import { assertKnownDeBridgeForwarder, KNOWN_DEBRIDGE_FORWARDER } from "../../lib/market/multichain/trading/debridge-quote";

// Real, fund-safety regression test. Found via an adversarial review
// 2026-08-19: quoteDeBridgeCrossChainPurchase used to trust `tx.to` from
// dln.debridge.finance's own unauthenticated, keyless HTTP response with
// NO runtime check -- the real forwarder address was only ever documented
// in a comment, never compared against anything. foreign-fulfill.ts's
// buyCrossChainViaDeBridge approves that exact address to spend the
// buyer's stablecoin AND sends real value to it in the same call, so a
// compromised/DNS-hijacked/MITM'd response could have redirected a real
// fund transfer to an attacker's contract. This is the exact same
// vulnerability class across-quote.ts's own header already documents
// fixing for `spokePoolAddress` (ACROSS_SPOKE_POOL) -- same fix pattern
// applied here.

test("assertKnownDeBridgeForwarder accepts the real, verified Crosschain Forwarder Proxy address", () => {
  assert.doesNotThrow(() => assertKnownDeBridgeForwarder(KNOWN_DEBRIDGE_FORWARDER));
});

test("assertKnownDeBridgeForwarder accepts a differently-cased version of the same real address", () => {
  assert.doesNotThrow(() => assertKnownDeBridgeForwarder(KNOWN_DEBRIDGE_FORWARDER.toUpperCase()));
  assert.doesNotThrow(() => assertKnownDeBridgeForwarder(KNOWN_DEBRIDGE_FORWARDER.toLowerCase()));
});

test("assertKnownDeBridgeForwarder REJECTS any other address -- the real fund-safety invariant this file exists to enforce", () => {
  assert.throws(
    () => assertKnownDeBridgeForwarder("0x000000000000000000000000000000000000dead"),
    /unexpected tx\.to/
  );
});

test("assertKnownDeBridgeForwarder rejects an empty or malformed value rather than treating it as a pass", () => {
  assert.throws(() => assertKnownDeBridgeForwarder(""), /unexpected tx\.to/);
});
