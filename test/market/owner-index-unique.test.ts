import assert from "node:assert/strict";
import test from "node:test";
import { uniqueWalletCount } from "@/lib/market/owner-index";

test("unique wallets ignore zero address and count distinct owners", () => {
  assert.equal(
    uniqueWalletCount({
      "1": "0xAAA",
      "2": "0xaaa",
      "3": "0xBBB",
      "4": "0x0000000000000000000000000000000000000000",
    }),
    2
  );
});
