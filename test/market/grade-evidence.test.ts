import assert from "node:assert/strict";
import test from "node:test";
import { buildGradeContext } from "../../components/market/GlobalMarketHub";

/**
 * Grade eligibility must not be gated on listings alone (2026-09-07).
 *
 * Live on the Bitcoin tab: Taproot Wizards (1,297 holders, real 24h volume,
 * real sales) and PepeNals (1,812 holders) rendered "--" for grade while a
 * sibling with a single readable listing graded B. Bitcoin listings are
 * venue-held PSBTs with no keyless order book, so `listedCount > 0` denied a
 * letter to an entire chain regardless of how much real market evidence
 * existed.
 */
type Row = Parameters<typeof buildGradeContext>[0][number];

const row = (over: Partial<Row>): Row =>
  ({
    chainSlug: "bitcoin-mainnet",
    contractAddress: "abc",
    name: "test",
    imageUrl: "https://example.test/a.png",
    floorPriceWei: "1000000000000000",
    floorPriceCurrency: "BTC",
    volume24hWei: "0",
    sales24h: 0,
    listedCount: null,
    holderCount: null,
    isVaultBacked: false,
    ...over,
  }) as unknown as Row;

const usd = (wei: string | null) => (wei == null ? null : Number(BigInt(wei)) / 1e18);

test("a collection with holders, sales or volume but no readable listings is still gradeable", () => {
  // eligibleCount counts exactly the rows hasGradeEvidence() accepts.
  const holdersOnly = buildGradeContext([row({ holderCount: 1_297 })], usd);
  assert.equal(holdersOnly.eligibleCount, 1, "holders alone are real market evidence");

  const salesOnly = buildGradeContext([row({ sales24h: 8 })], usd);
  assert.equal(salesOnly.eligibleCount, 1, "real sales in the window are real market evidence");

  const volumeOnly = buildGradeContext([row({ volume24hWei: "1540000000000000" })], usd);
  assert.equal(volumeOnly.eligibleCount, 1, "real 24h volume is real market evidence");

  const listedOnly = buildGradeContext([row({ listedCount: 71 })], usd);
  assert.equal(listedOnly.eligibleCount, 1, "listings remain evidence, as before");

  const vault = buildGradeContext([row({ isVaultBacked: true })], usd);
  assert.equal(vault.eligibleCount, 1, "vault-backed stays always-eligible");
});

test("a row with no market evidence at all is still ungraded -- the bar was lowered, not removed", () => {
  const shell = buildGradeContext([row({})], usd);
  assert.equal(shell.eligibleCount, 0, "no listings, no sales, no volume, no holders = no grade");

  const zeroed = buildGradeContext([row({ listedCount: 0, sales24h: 0, holderCount: 0, volume24hWei: "0" })], usd);
  assert.equal(zeroed.eligibleCount, 0, "explicit zeros are not evidence");
});
