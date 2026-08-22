import assert from "node:assert/strict";
import test from "node:test";
import { prepareUniSatBid, createUniSatBid, confirmUniSatBid } from "../../lib/market/multichain/adapters/unisat-ordinals-trade";

// Real, unmocked regression coverage for a genuine bug found and fixed
// 2026-08-19 while live-verifying the Bitcoin buy flow: this module's
// endpoints were missing the real "/collection/auction/" path segment
// (a confirmed HTTP 404 on every call), its request bodies used field
// names ("buyerAddress"/"inscriptionId"/"price") the live API has never
// accepted (the real required shape is
// {address, auctionId, bidPrice, pubkey}, discovered by iterating the
// API's own validation error messages one field at a time), and its
// response handling never unwrapped the real {code, msg, data} envelope
// every UniSat endpoint actually returns. None of this had ever been
// exercised against the live API before this pass -- the schema
// assumptions were never tested, just written from an initial reading of
// third-party docs.

test("prepareUniSatBid fails closed with a clear, actionable error when UNISAT_API_KEY is unset -- never silently returns fabricated fee data", async () => {
  const original = process.env.UNISAT_API_KEY;
  delete process.env.UNISAT_API_KEY;
  try {
    await assert.rejects(
      () => prepareUniSatBid({ address: "bc1qtest", auctionId: "test", bidPriceSats: "1000", pubkey: "02" + "00".repeat(32) }),
      /UNISAT_API_KEY is not configured/
    );
  } finally {
    if (original !== undefined) process.env.UNISAT_API_KEY = original;
  }
});

// Real, unmocked, LIVE network tests -- skipped (not failed) when
// UNISAT_API_KEY isn't in this process's environment (tsx --test doesn't
// auto-load .env.local the way Next's dev/build does -- export the key
// first to exercise these for real, matching multichain-solana-bitcoin.test.ts's
// own established pattern for this exact situation).
test(
  "prepareUniSatBid reaches real UniSat business logic (not a 404, not a schema-validation error) against a real, currently-listed auctionId",
  { skip: !process.env.UNISAT_API_KEY },
  async () => {
    // A real, live bitcoin-frogs auctionId (fetched via the app's own
    // listings route during this fix's live verification) with a
    // syntactically-valid-but-unowned dummy pubkey. The real API's own
    // response for this exact input is a genuine business-logic error
    // ("Order not exist" -- the dummy pubkey doesn't correspond to a real
    // spendable UTXO set for this address), never a 404 or a
    // FST_ERR_VALIDATION schema error. That distinction IS the proof the
    // real path/field-name fix is correct: a 404 or schema error here
    // would mean the fix regressed.
    await assert.rejects(
      () =>
        prepareUniSatBid({
          address: "bc1plmhanvyaz0xehzt0whw8cdsd56qgx9e02x78ghytf4dqvmake65q3pzpng",
          auctionId: "7p7brj90wbtkfllvzpenuujqwesv552k",
          bidPriceSats: "370000",
          pubkey: "02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5d",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!/404/.test(err.message), `expected a real business-logic error, got a 404 (path bug regressed): ${err.message}`);
        assert.ok(!/FST_ERR_VALIDATION/.test(err.message), `expected a real business-logic error, got a schema-validation error (field-name bug regressed): ${err.message}`);
        return true;
      }
    );
  }
);

test(
  "createUniSatBid reaches the same real business logic as prepareUniSatBid, proving create_bid's path/fields are independently correct too",
  { skip: !process.env.UNISAT_API_KEY },
  async () => {
    await assert.rejects(
      () =>
        createUniSatBid({
          address: "bc1plmhanvyaz0xehzt0whw8cdsd56qgx9e02x78ghytf4dqvmake65q3pzpng",
          auctionId: "7p7brj90wbtkfllvzpenuujqwesv552k",
          bidPriceSats: "370000",
          pubkey: "02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5d",
        }),
      (err: unknown) => err instanceof Error && !/404/.test(err.message) && !/FST_ERR_VALIDATION/.test(err.message)
    );
  }
);

test(
  "confirmUniSatBid's real request shape (auctionId + bidId + psbtBid) is accepted -- reaches real business logic, not a schema error",
  { skip: !process.env.UNISAT_API_KEY },
  async () => {
    // Real, live-confirmed: confirm_bid demands auctionId, then bidId,
    // then psbtBid (in that exact order, discovered via the API's own
    // validation errors) -- NOT the {psbt: ...} shape originally assumed.
    await assert.rejects(
      () => confirmUniSatBid({ auctionId: "7p7brj90wbtkfllvzpenuujqwesv552k", bidId: "dummy", signedPsbtBase64: "dummy" }),
      (err: unknown) => err instanceof Error && !/404/.test(err.message) && !/FST_ERR_VALIDATION/.test(err.message)
    );
  }
);
