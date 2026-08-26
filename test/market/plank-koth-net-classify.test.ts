import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeErc20TransfersForTokens,
  computeNetBalances,
  classifyNetBuyCandidates,
  ERC20_TRANSFER_TOPIC,
  type RawReceiptLog,
} from "../../lib/market/plank-koth-net-classify.ts";

const PLANK = "0x69420eaf0ebf43e08f621b014f25cefdfa7e2ddc";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const V2_POOL = "0x01b1bef6fba02c846ea5c4ff59193988b5f86f73";
const ROUTER = "0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc";
const BUYER = "0xc4a50f35177839fb72cfc248f545b903524d2b40";

/** Real event log padded to a 32-byte topic, as returned by any real EVM RPC. */
function addrTopic(addr: string): string {
  return "0x" + "0".repeat(24) + addr.replace("0x", "");
}

function transferLog(token: string, from: string, to: string, value: bigint): RawReceiptLog {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, addrTopic(from), addrTopic(to)],
    data: "0x" + value.toString(16).padStart(64, "0"),
  };
}

test("real production tx 0x0716472e...4e74ab: native-ETH-funded buy nets correctly once the synthetic WETH leg is included", () => {
  // Real logs from this tx (confirmed live 2026-08-26): WETH minted to the
  // router, forwarded to the V2 pool, PLANK forwarded from the pool to the
  // real buyer. The buyer's own wallet never appears in any of these three
  // logs -- their real payment was native ETH (msg.value), which this test
  // injects as the same synthetic transfer evaluatePlankKothCandidate adds.
  const logs: RawReceiptLog[] = [
    transferLog(WETH, "0x0000000000000000000000000000000000000000", ROUTER, 990000000000000n),
    transferLog(WETH, ROUTER, V2_POOL, 990000000000000n),
    transferLog(PLANK, V2_POOL, BUYER, 2852763239272944515373175765n),
    // Synthetic native-value leg (buyer -> router), same shape
    // evaluatePlankKothCandidate injects from the real tx.value field.
    transferLog(WETH, BUYER, ROUTER, 990000000000000n),
  ];
  const decoded = decodeErc20TransfersForTokens(logs, new Set([PLANK, WETH]));
  const net = computeNetBalances(decoded);
  const candidates = classifyNetBuyCandidates(net, PLANK, [WETH], new Set([V2_POOL, PLANK, WETH]));

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].wallet, BUYER);
  assert.equal(candidates[0].plankAmount, 2852763239272944515373175765n);
  assert.equal(candidates[0].quoteSpent.get(WETH), 990000000000000n);
  assert.equal(candidates[0].hasRoundTripShape, false);
  // The router nets to ~0 on both tokens -- it must never appear as a candidate.
  assert.ok(!candidates.some((c) => c.wallet === ROUTER));
});

test("real production tx 0x42c96c03...02249a3: router-mediated, split-across-two-pools buy nets to one real recipient", () => {
  const V3_POOL = "0x3ce05efe2e7c9c136f12a1be695f75f807b6c69e";
  const RECIPIENT = "0xf09da807812c9d8ce19c5e2c12f1aac382eb84ec";
  const FORWARDER = "0xbdbae060cbab0e9cfe802a7513dd5ecb36cda6c3";
  const logs: RawReceiptLog[] = [
    transferLog(WETH, "0x0000000000000000000000000000000000000000", ROUTER, 49562500000000000n),
    transferLog(WETH, ROUTER, V2_POOL, 39650000000000000n),
    transferLog(PLANK, V2_POOL, FORWARDER, 113226452204409165055532511104n),
    transferLog(PLANK, V3_POOL, FORWARDER, 28292117139585560967924038085n),
    transferLog(WETH, ROUTER, V3_POOL, 9912500000000000n),
    transferLog(PLANK, FORWARDER, RECIPIENT, 141518569343994726023456549189n),
  ];
  const decoded = decodeErc20TransfersForTokens(logs, new Set([PLANK, WETH]));
  const net = computeNetBalances(decoded);
  const candidates = classifyNetBuyCandidates(net, PLANK, [WETH], new Set([V2_POOL, V3_POOL, PLANK, WETH]));

  // The forwarder receives PLANK from both pools and forwards all of it on
  // to the recipient in the same tx -- nets to 0 PLANK, so it must never
  // appear as a candidate (this is the exact real router/aggregator shape
  // that broke the old transfer-graph-matching approach).
  assert.ok(!candidates.some((c) => c.wallet === FORWARDER));
});

test("same-tx round trip: a wallet that both buys PLANK and receives WETH back is flagged, not confirmed", () => {
  const logs: RawReceiptLog[] = [
    transferLog(PLANK, V2_POOL, BUYER, 1_000n),
    transferLog(WETH, BUYER, V2_POOL, 500n),
    transferLog(WETH, V2_POOL, BUYER, 500n), // suspicious: value returned in the same tx
  ];
  const decoded = decodeErc20TransfersForTokens(logs, new Set([PLANK, WETH]));
  const net = computeNetBalances(decoded);
  const candidates = classifyNetBuyCandidates(net, PLANK, [WETH], new Set([V2_POOL, PLANK, WETH]));
  // Net WETH for the buyer is 0 (paid 500, got 500 back), so no real
  // negative quote leg exists -- this candidate is correctly excluded
  // entirely (not just flagged), since there is no real net payment at all.
  assert.equal(candidates.length, 0);
});

test("a normal slippage-refund leg (same token, still net-negative overall) is NOT flagged as a round trip", () => {
  // A real, ordinary swap outcome: the router refunds unused input in the
  // SAME quote token. Net WETH is still clearly negative (a real payment
  // happened) -- this must never be confused with a genuine round trip,
  // which requires ending up net POSITIVE in some quote asset, not merely
  // paying slightly less than the raw total of the two legs.
  const logs: RawReceiptLog[] = [
    transferLog(PLANK, V2_POOL, BUYER, 1_000n),
    transferLog(WETH, BUYER, V2_POOL, 1_000n),
    transferLog(WETH, V2_POOL, BUYER, 200n),
  ];
  const decoded = decodeErc20TransfersForTokens(logs, new Set([PLANK, WETH]));
  const net = computeNetBalances(decoded);
  const candidates = classifyNetBuyCandidates(net, PLANK, [WETH], new Set([V2_POOL, PLANK, WETH]));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].quoteSpent.get(WETH), 800n);
  assert.equal(candidates[0].hasRoundTripShape, false);
});

test("a real round trip (net positive in a DIFFERENT quote asset than the one paid) is flagged", () => {
  const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  const logs: RawReceiptLog[] = [
    transferLog(PLANK, V2_POOL, BUYER, 1_000n),
    transferLog(USDG, BUYER, V2_POOL, 500n),
    // Suspicious: the buyer also nets POSITIVE in a wholly separate quote
    // asset in the same tx -- real economic value flowing back out with no
    // legitimate "refund of what was just paid" explanation.
    transferLog(WETH, V2_POOL, BUYER, 10n),
  ];
  const decoded = decodeErc20TransfersForTokens(logs, new Set([PLANK, WETH, USDG]));
  const net = computeNetBalances(decoded);
  const candidates = classifyNetBuyCandidates(net, PLANK, [WETH, USDG], new Set([V2_POOL, PLANK, WETH, USDG]));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].hasRoundTripShape, true);
});

test("a pass-through router (receives and forwards equal PLANK) nets to 0 and is never a candidate", () => {
  const logs: RawReceiptLog[] = [
    transferLog(PLANK, V2_POOL, ROUTER, 1_000n),
    transferLog(PLANK, ROUTER, BUYER, 1_000n),
    transferLog(WETH, BUYER, V2_POOL, 500n),
  ];
  const decoded = decodeErc20TransfersForTokens(logs, new Set([PLANK, WETH]));
  const net = computeNetBalances(decoded);
  const candidates = classifyNetBuyCandidates(net, PLANK, [WETH], new Set([V2_POOL, PLANK, WETH]));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].wallet, BUYER);
});
