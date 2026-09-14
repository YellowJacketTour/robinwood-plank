import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { openSeaFloorCurrency, openSeaVolumeWei } from "../../lib/market/multichain/opensea-stats-units";

const toWei = (v: number | undefined) => (typeof v === "number" && v > 0 ? BigInt(Math.round(v * 1e18)).toString() : null);

test("the floor's currency is the symbol OpenSea names; the native symbol only when OpenSea omits it", () => {
  // Measured 2026-09-14, slug beezie-base: floor_price 25.0, floor_price_symbol "USDC".
  assert.equal(openSeaFloorCurrency("USDC", "ETH"), "USDC");
  assert.equal(openSeaFloorCurrency("usdc", "ETH"), "USDC");
  assert.equal(openSeaFloorCurrency("ETH", "ETH"), "ETH");
  assert.equal(openSeaFloorCurrency("POL", "POL"), "POL");
  assert.equal(openSeaFloorCurrency(undefined, "BNB"), "BNB");
  assert.equal(openSeaFloorCurrency("", "AVAX"), "AVAX");
  assert.equal(openSeaFloorCurrency("  ", "ETH"), "ETH");
  assert.equal(openSeaFloorCurrency("not a symbol!", "ETH"), "ETH");
});

test("a volume is native wei only when OpenSea says it is native (or wrapped, or unlabelled)", () => {
  // Measured 2026-09-14, beezie-base one_day: volume 5.93, volume_symbol "ETH" (floor is USDC).
  assert.equal(openSeaVolumeWei({ volume: 5.93, volume_symbol: "ETH" }, "ETH", toWei), "5930000000000000000");
  assert.equal(openSeaVolumeWei({ volume: 1, volume_symbol: "WETH" }, "ETH", toWei), "1000000000000000000");
  assert.equal(openSeaVolumeWei({ volume: 1 }, "ETH", toWei), "1000000000000000000");
  assert.equal(openSeaVolumeWei({ volume: 112200, volume_symbol: "USDC" }, "ETH", toWei), null, "a USDC volume is a hole, never 112200 ETH");
  assert.equal(openSeaVolumeWei({ volume: 3, volume_symbol: "ETH" }, "POL", toWei), null, "ETH on Polygon is not POL");
  assert.equal(openSeaVolumeWei({ volume: 0, volume_symbol: "ETH" }, "ETH", toWei), null);
  assert.equal(openSeaVolumeWei(undefined, "ETH", toWei), null);
});

test("the stats hydrator actually reads the symbols (the helpers are not decoration)", () => {
  const route = readFileSync("app/api/market/multichain/hydrate-stats/route.ts", "utf8");
  assert.match(route, /floorPriceCurrency:\s*openSeaFloorCurrency\(stats\.total\?\.floor_price_symbol,\s*nativeSymbol\)/);
  assert.equal((route.match(/openSeaVolumeWei\((oneDay|sevenDay|thirtyDay), nativeSymbol, nativeToWei\)/g) ?? []).length, 3);
  assert.doesNotMatch(route, /floorPriceCurrency:\s*(currency|nativeSymbol)\s*,/, "no path labels an OpenSea floor with the native symbol unconditionally");
  assert.match(route, /floor_price_symbol\?: string/);
  assert.match(route, /volume_symbol\?: string/);
});
