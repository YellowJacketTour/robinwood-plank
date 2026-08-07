import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bpsFromRoyaltyAmount,
  decodeRoyaltyInfo,
  encodeRoyaltyInfo,
  ROBINWOOD_ROYALTY_BPS,
  ROBINWOOD_ROYALTY_RECEIVER,
  ROYALTY_PROBE_PRICE_WEI,
} from "../../lib/market/royalty";

test("EIP-2981 royalty calldata encodes and decodes the expected RobinWood result", () => {
  const data = encodeRoyaltyInfo("1106", ROYALTY_PROBE_PRICE_WEI);
  assert.equal(data.length, 138);
  const receiverWord = ROBINWOOD_ROYALTY_RECEIVER.slice(2).padStart(64, "0");
  const amountWord = BigInt("81000000000000000").toString(16).padStart(64, "0");
  const decoded = decodeRoyaltyInfo(`0x${receiverWord}${amountWord}`);
  assert.equal(decoded.receiver, ROBINWOOD_ROYALTY_RECEIVER);
  assert.equal(
    bpsFromRoyaltyAmount(decoded.amountWei, ROYALTY_PROBE_PRICE_WEI),
    ROBINWOOD_ROYALTY_BPS
  );
});

test("royalty decoder rejects a zero receiver", () => {
  assert.throws(
    () => decodeRoyaltyInfo(`0x${"0".repeat(128)}`),
    /no receiver/i
  );
});
