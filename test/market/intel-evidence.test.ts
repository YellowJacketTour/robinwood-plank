import assert from "node:assert/strict";
import test from "node:test";
import { askEvidence, evidenceCsvCell, saleCurrencies, saleObservations } from "../../lib/market/multichain/intel-evidence";

test("native sale evidence survives missing USD valuation and never mixes currencies or future dates", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  const sales = [
    { timestamp: "2026-09-09T11:00:00Z", priceWei: "28160000000000000000", priceSymbol: "ETH" },
    { timestamp: "2026-09-09T11:30:00Z", priceAmount: "30", priceSymbol: "SOL" },
    { timestamp: "2026-09-10T11:00:00Z", priceAmount: "99", priceSymbol: "ETH" },
    { timestamp: "2026-09-09T11:40:00Z", priceWei: "0", priceSymbol: "ETH" },
  ];
  assert.deepEqual(saleCurrencies(sales), ["ETH", "SOL"]);
  const points = saleObservations(sales, "ETH", now, 86_400_000);
  assert.equal(points.length, 1);
  assert.equal(points[0].value, 28.16);
  assert.equal(points[0].exact, "28.160000000000000000");
  assert.equal(saleObservations(sales, "USD", now).length, 0);
});

test("ask depth counts distinct NFTs and preserves exact atomic ordering and non-EVM wallets", () => {
  const floor = 100000000000000000000n;
  const traits = [{ traitType: "Hat", value: "Blue" }];
  const result = askEvidence([
    { tokenId: "1", priceWei: (floor + 5n).toString(), maker: "AbCd", traits },
    { tokenId: "1", priceWei: floor.toString(), maker: "AbCd", traits },
    { tokenId: "2", priceWei: (floor * 110n / 100n).toString(), maker: "abcd", traits: [...traits, ...traits] },
    { tokenId: "3", priceWei: (floor * 110n / 100n + 1n).toString() },
  ]);
  assert.equal(result.rows.length, 3);
  assert.equal(result.floorWei, floor.toString());
  assert.equal(result.depth10, 2);
  assert.equal(result.makers.length, 2);
  assert.equal(result.traitPremiums[0].listed, 2);
  assert.equal(result.traitPremiums[0].premiumPct, 5);
  assert.equal(askEvidence([]).depth10, null);
});

test("CSV preserves quoted collection names and prevents formula interpretation", () => {
  assert.equal(evidenceCsvCell('A "quoted", collection'), '"A ""quoted"", collection"');
  assert.equal(evidenceCsvCell('=SUM(A1:A9)'), '"\'=SUM(A1:A9)"');
  assert.equal(evidenceCsvCell(null), '""');
});


test("cumulative depth includes every distinct piece at the same exact ask price", () => {
  const result = askEvidence([
    { tokenId: "a", priceWei: "100" },
    { tokenId: "b", priceWei: "100" },
    { tokenId: "c", priceWei: "101" },
    { tokenId: "a", priceWei: "102" },
  ]);
  assert.deepEqual(result.cumulativeDepth, [2, 2, 3]);
});


test("asking-price evidence isolates payment currencies before deduplicating NFTs", () => {
  const rows = [{tokenId:"a",priceWei:"100",currencySymbol:"ETH"},{tokenId:"a",priceWei:"1",currencySymbol:"USDC"},{tokenId:"b",priceWei:"110"}];
  const result = askEvidence(rows,{currency:"ETH",defaultCurrency:"ETH"});
  assert.equal(result.rows.length,2);
  assert.equal(result.floorWei,"100");
  assert.equal(result.depth10,2);
});
