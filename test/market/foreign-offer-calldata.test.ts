import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import {
  assertOfferFulfillmentCalldata,
  encodeOpenSeaFulfillmentCalldata,
} from "../../lib/market/multichain/trading/foreign-offer";
import { FOREIGN_SEAPORT_ADDRESS } from "../../lib/market/multichain/trading/foreign-chain-registry";

/**
 * AUDIT lens 3 #5 / D4 (2026-09-06): the seller sends OpenSea's
 * `fulfillment_data.transaction` verbatim, so the only client-side defence
 * is the pure assertion under test here: target == Seaport, value == 0,
 * signed bid == displayed price.
 */

const BID = "1000000000000000000"; // 1 WETH

test("calldata assertion: passes for Seaport target, zero value, matching price (case-insensitive `to`)", () => {
  const out = assertOfferFulfillmentCalldata({
    to: FOREIGN_SEAPORT_ADDRESS.toLowerCase(),
    value: 0,
    orderBidWei: BID,
    expectedPriceWei: BigInt(BID),
  });
  assert.equal(out.valueWei, BigInt(0));
  assert.equal(out.to.toLowerCase(), FOREIGN_SEAPORT_ADDRESS.toLowerCase());
  // "0", "", null, undefined are all zero value
  for (const v of ["0", "", null, undefined]) {
    assert.doesNotThrow(() => assertOfferFulfillmentCalldata({ to: FOREIGN_SEAPORT_ADDRESS, value: v, orderBidWei: BID, expectedPriceWei: BID }));
  }
});

test("calldata assertion: rejects a non-Seaport target (conduit, collection, attacker)", () => {
  for (const to of [
    "0x1E0049783F008A0085193E00003D00cd54003c71", // OpenSea conduit -- never a fulfillment target
    "0x0000000000000000000000000000000000000001",
    "",
  ]) {
    assert.throws(
      () => assertOfferFulfillmentCalldata({ to, value: 0, orderBidWei: BID, expectedPriceWei: BID }),
      /does not target Seaport/
    );
  }
});

test("calldata assertion: rejects any native value leaving the seller", () => {
  assert.throws(
    () => assertOfferFulfillmentCalldata({ to: FOREIGN_SEAPORT_ADDRESS, value: "1", orderBidWei: BID, expectedPriceWei: BID }),
    /must not send native value/
  );
  assert.throws(
    () => assertOfferFulfillmentCalldata({ to: FOREIGN_SEAPORT_ADDRESS, value: 5, orderBidWei: BID, expectedPriceWei: BID }),
    /must not send native value/
  );
  assert.throws(
    () => assertOfferFulfillmentCalldata({ to: FOREIGN_SEAPORT_ADDRESS, value: "not-a-number", orderBidWei: BID, expectedPriceWei: BID }),
    /unreadable value/
  );
});

test("calldata assertion: rejects a signed bid that differs from the displayed price", () => {
  assert.throws(
    () => assertOfferFulfillmentCalldata({ to: FOREIGN_SEAPORT_ADDRESS, value: 0, orderBidWei: "999999999999999999", expectedPriceWei: BID }),
    /no longer matches/
  );
});

test("encode: hex input_data is used verbatim; malformed hex is refused", () => {
  const hex = "0xe7acab24" + "00".repeat(32);
  assert.equal(encodeOpenSeaFulfillmentCalldata({ function: "fulfillAdvancedOrder(...)", input_data: hex }), hex);
  assert.throws(() => encodeOpenSeaFulfillmentCalldata({ function: "f()", input_data: "0x12" }), /not hex/);
  assert.throws(() => encodeOpenSeaFulfillmentCalldata({ function: "f()", input_data: "zz" }), /not hex/);
});

test("encode: decoded input_data object is ABI-encoded from OpenSea's function signature (tuple + array + bytes32 + address)", () => {
  const signature = "fulfillTest((address,uint256),(uint256,bytes32[])[],bytes32,address)";
  const input_data = {
    order: { offerer: "0x0000000000000000000000000000000000000001", amount: "42" },
    resolvers: [{ index: "0", proof: ["0x" + "11".repeat(32)] }],
    conduitKey: "0x" + "00".repeat(32),
    recipient: "0x0000000000000000000000000000000000000002",
  };
  const encoded = encodeOpenSeaFulfillmentCalldata({ function: signature, input_data });
  const iface = new Interface([`function ${signature}`]);
  const decoded = iface.decodeFunctionData("fulfillTest", encoded);
  assert.equal(decoded[0][0].toLowerCase(), input_data.order.offerer);
  assert.equal(decoded[0][1], BigInt(42));
  assert.equal(decoded[1][0][1][0], input_data.resolvers[0].proof[0]);
  assert.equal(decoded[3].toLowerCase(), input_data.recipient);
});
