import test from "node:test";
import assert from "node:assert/strict";
import { MARKET_TABS } from "../../lib/market/navigation";

test("Marketplank keeps every public tab id and label", () => {
  assert.deepEqual(MARKET_TABS, [
    { id: "buy-sell", label: "Buy & Sell" },
    { id: "swap", label: "Instant Swap" },
    { id: "offers", label: "Offers" },
    { id: "activity", label: "Activity" },
    { id: "my-nfts", label: "My NFTs" },
    { id: "positions", label: "My Listings" },
  ]);
});
