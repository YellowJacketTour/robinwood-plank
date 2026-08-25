import assert from "node:assert/strict";
import test from "node:test";
import {
  parseOkxListingsResponse,
  parseOkxCollectionStatsResponse,
  fetchOkxOrdinalsListings,
  fetchOkxCollectionStats,
  verifyOkxCredentials,
} from "../../lib/market/multichain/adapters/okx-ordinals";

// OKX's real /api/v5/mktplace/nft/ordinals/collections and .../listings
// endpoints were live-verified this session via direct curl (no key):
// GET .../collections -> real HTTP 401
// {"msg":"Request header OK-ACCESS-KEY AND OK-ACCESS-TOKEN can not all
// empty ","code":"50116"} -- confirming the path is real and live and
// that there is NO public/keyless tier. No OKX_API_KEY/OKX_API_SECRET/
// OKX_API_PASSPHRASE is configured in this environment, so the actual
// response BODY shape (field names) has never been observed -- these
// tests cover the honest-empty fail-closed path (real, exercised now)
// and the defensive parsing logic against the field names OKX's own
// docs index states (unexercised against a real body until a key
// exists -- see this file's own header for that caveat).

test("fetchOkxOrdinalsListings returns [] (never throws, never fabricates) when no OKX credentials are configured", async () => {
  const key = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const pass = process.env.OKX_API_PASSPHRASE;
  delete process.env.OKX_API_KEY;
  delete process.env.OKX_API_SECRET;
  delete process.env.OKX_API_PASSPHRASE;
  try {
    const listings = await fetchOkxOrdinalsListings("bitcoin-puppets", 10);
    assert.deepEqual(listings, []);
  } finally {
    if (key !== undefined) process.env.OKX_API_KEY = key;
    if (secret !== undefined) process.env.OKX_API_SECRET = secret;
    if (pass !== undefined) process.env.OKX_API_PASSPHRASE = pass;
  }
});

test("fetchOkxCollectionStats returns null (never throws, never fabricates) when no OKX credentials are configured", async () => {
  const key = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const pass = process.env.OKX_API_PASSPHRASE;
  delete process.env.OKX_API_KEY;
  delete process.env.OKX_API_SECRET;
  delete process.env.OKX_API_PASSPHRASE;
  try {
    const stats = await fetchOkxCollectionStats("bitcoin-puppets");
    assert.equal(stats, null);
  } finally {
    if (key !== undefined) process.env.OKX_API_KEY = key;
    if (secret !== undefined) process.env.OKX_API_SECRET = secret;
    if (pass !== undefined) process.env.OKX_API_PASSPHRASE = pass;
  }
});

test("parseOkxListingsResponse: null body (no key / failed call) parses to []", () => {
  assert.deepEqual(parseOkxListingsResponse(null, 50), []);
});

test("parseOkxListingsResponse: primary field names (inscriptionId/price/ownerAddress) documented by OKX", () => {
  const body = {
    code: "0",
    data: [
      { inscriptionId: "abc123i0", price: "150000", ownerAddress: "bc1qseller" },
      { inscriptionId: "def456i0", price: "0", ownerAddress: "bc1qzero" }, // zero price excluded
      { inscriptionId: "", price: "1000", ownerAddress: "bc1qnoid" }, // missing id excluded
    ],
  };
  const out = parseOkxListingsResponse(body, 50);
  assert.deepEqual(out, [{ inscriptionId: "abc123i0", priceSats: 150000, sellerAddress: "bc1qseller" }]);
});

test("parseOkxListingsResponse: handles {data:{list:[...]}} and {data:{items:[...]}} envelope shapes", () => {
  const listShape = { data: { list: [{ inscriptionId: "x1", price: "5000", ownerAddress: "bc1qa" }] } };
  const itemsShape = { data: { items: [{ inscriptionId: "x2", price: "6000", ownerAddress: "bc1qb" }] } };
  assert.deepEqual(parseOkxListingsResponse(listShape, 50), [{ inscriptionId: "x1", priceSats: 5000, sellerAddress: "bc1qa" }]);
  assert.deepEqual(parseOkxListingsResponse(itemsShape, 50), [{ inscriptionId: "x2", priceSats: 6000, sellerAddress: "bc1qb" }]);
});

test("parseOkxListingsResponse: falls back to defensive field-name variants (snake_case / alternate keys)", () => {
  const body = { data: [{ inscription_id: "y1", unitPrice: "9000", sellerAddress: "bc1qc" }] };
  assert.deepEqual(parseOkxListingsResponse(body, 50), [{ inscriptionId: "y1", priceSats: 9000, sellerAddress: "bc1qc" }]);
});

test("parseOkxListingsResponse: respects the limit parameter", () => {
  const body = {
    data: Array.from({ length: 5 }, (_, i) => ({ inscriptionId: `id${i}`, price: "1000", ownerAddress: "bc1q" })),
  };
  assert.equal(parseOkxListingsResponse(body, 2).length, 2);
});

test("parseOkxCollectionStatsResponse: null body parses to null", () => {
  assert.equal(parseOkxCollectionStatsResponse(null, "bitcoin-puppets"), null);
});

test("parseOkxCollectionStatsResponse: matches by slug (case-insensitive) and extracts floor/listed/supply", () => {
  const body = {
    data: [
      { slug: "Bitcoin-Puppets", floorPrice: "250000", listedCount: "42", totalSupply: "10000" },
      { slug: "other-collection", floorPrice: "1", listedCount: "1", totalSupply: "1" },
    ],
  };
  assert.deepEqual(parseOkxCollectionStatsResponse(body, "bitcoin-puppets"), {
    floorPriceSats: 250000,
    listedCount: 42,
    totalSupply: 10000,
  });
});

test("parseOkxCollectionStatsResponse: no matching slug returns null rather than a wrong collection's stats", () => {
  const body = { data: [{ slug: "unrelated", floorPrice: "1" }] };
  assert.equal(parseOkxCollectionStatsResponse(body, "bitcoin-puppets"), null);
});

// Real, unmocked, LIVE network test against OKX's actual API -- skipped
// (not failed) when OKX_API_KEY/OKX_API_SECRET/OKX_API_PASSPHRASE aren't
// in this process's environment, matching unisat-ordinals-trade.test.ts's
// established pattern for the exact same situation. Confirms real auth
// succeeds and captures the real response shape once a key exists.
test(
  "verifyOkxCredentials reaches real OKX business logic with a configured key",
  { skip: !process.env.OKX_API_KEY || !process.env.OKX_API_SECRET || !process.env.OKX_API_PASSPHRASE },
  async () => {
    const result = await verifyOkxCredentials();
    assert.equal(result.ok, true);
  }
);
