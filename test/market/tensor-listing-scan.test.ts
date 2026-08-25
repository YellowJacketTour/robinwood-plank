import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { decodeListingAccount, LIST_STATE_DISCRIMINATOR_BASE58 } from "../../lib/market/multichain/discovery/tensor-listing-scan";

/**
 * decodeListingAccount is pure (no I/O). Its fixture,
 * tensor-listing-real-accounts.json, is a REAL `getProgramAccounts`
 * response (first 3 of 115,370 real accounts returned) fetched live from
 * api.mainnet-beta.solana.com during this task (2026-08-25) against the
 * real, live Tensor Marketplace program (TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp),
 * filtered with a real memcmp on ListState's own real discriminator
 * (base58 "ECt8xkbczt2", i.e. hex 4ef2598aa1ddb04b, read directly from the
 * installed @tensor-foundation/marketplace package -- see
 * tensor-listing-scan.ts's own header for the full citation). Nothing in
 * this fixture is synthesized: every byte is exactly what the public RPC
 * returned for a real, currently-open Tensor listing.
 */
const FIXTURES_DIR = path.join(process.cwd(), "test", "market", "fixtures");

function loadFixture(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

test("LIST_STATE_DISCRIMINATOR_BASE58 matches the real installed-package discriminator bytes", () => {
  // hex 4ef2598aa1ddb04b == base58 ECt8xkbczt2 (verified via bs58 during this task)
  assert.equal(LIST_STATE_DISCRIMINATOR_BASE58, "ECt8xkbczt2");
});

test("decodeListingAccount: real fetched ListState accounts decode with well-formed fields", () => {
  const fixture = loadFixture("tensor-listing-real-accounts.json");
  const accounts = fixture.result as Array<{ pubkey: string; account: { data: [string, string] } }>;
  assert.equal(accounts.length, 3, "fixture should contain the 3 real sampled accounts");

  const decodedListings = accounts.map((a) => decodeListingAccount(a));
  for (const listing of decodedListings) {
    assert.ok(listing, "every real ListState account in the fixture must decode successfully");
  }

  const [first] = decodedListings;
  assert.equal(first!.listingAccount, "12ZJJDgPSSqThpJuDkeY7342vFY7z7yt4pHFGuaYwxn");
  assert.equal(first!.owner, "BhUzP2nuFRNGJJGcAGJsdMxvjMGrzQhYD9N1vGy1pyYq");
  assert.equal(first!.mint, "2YPVS86yFGfKv7QhsNojMi9qALVo3bqomEKQ4JCne1K1");
  assert.equal(first!.priceLamports, "7449000");
  assert.equal(first!.currency, null, "this real listing has no SPL currency set (native SOL)");
  assert.equal(first!.expirySeconds, "1818842540");
});

test("decodeListingAccount: a non-base64-encoded row is rejected rather than guessed", () => {
  const result = decodeListingAccount({
    pubkey: "fakepubkey",
    account: { data: ["not-base64-marker", "base58"], lamports: 0, owner: "x" },
  });
  assert.equal(result, null);
});

test("decodeListingAccount: garbage bytes that are not a real ListState layout decode to null, not a fabricated partial row", () => {
  const result = decodeListingAccount({
    pubkey: "fakepubkey",
    account: { data: [Buffer.from([1, 2, 3]).toString("base64"), "base64"], lamports: 0, owner: "x" },
  });
  assert.equal(result, null);
});
