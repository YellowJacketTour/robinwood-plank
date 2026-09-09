import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Milady Maker, live 2026-09-09:
 *
 *   pagesWalked 2, ordersFetched 200, ordersAfterDedup 1,
 *   excludedCriteriaOrders 0, excludedNonNativeCurrency 0
 *
 * against a header reading "117 listed of 9,976". Two hundred real orders
 * arrived and one survived, and BOTH documented exclusions were zero -- so the
 * numbers that exist could not explain where 199 orders went.
 *
 * The route's own comment lists three cases these counters were built to
 * separate (page cap / upstream returned one / dedup collapse). None covered
 * "the token id was missing", because that exit incremented nothing. An
 * unexplained drop must never be silent.
 */

const ROUTE = readFileSync("app/api/market/multichain/listings/route.ts", "utf8").replace(/\r\n/g, "\n");

test("every exit from the dedup loop increments a counter", () => {
  // Extract the loop body and assert that no `continue` is unaccounted for.
  const start = ROUTE.indexOf("for (const order of rawOrders) {");
  assert.ok(start > 0, "the dedup loop must exist");
  const end = ROUTE.indexOf("const orders = [...cheapestByToken.values()]", start);
  assert.ok(end > start, "the loop must terminate");
  const body = ROUTE.slice(start, end);

  const continues = (body.match(/continue;/g) ?? []).length;
  const counters = (body.match(/excluded[A-Za-z]+ \+= 1;/g) ?? []).length;
  assert.ok(continues > 0, "sanity: the loop has early exits");
  assert.equal(
    counters,
    continues,
    `${continues} exits but only ${counters} counters -- a silent drop is exactly the bug this file already documents`,
  );
});

test("token id \"0\" is not treated as a missing token id", () => {
  // `!tokenId` is falsy for the string "0", so a listing of token #0 -- the
  // first mint of most collections -- was dropped as malformed.
  const start = ROUTE.indexOf("for (const order of rawOrders) {");
  const body = ROUTE.slice(start, ROUTE.indexOf("const orders = [...cheapestByToken", start));
  assert.ok(
    !/if \(!tokenId\) continue;/.test(body),
    "a falsy check drops token 0, which is a real NFT",
  );
  assert.match(body, /tokenId == null \|\| tokenId === ""/, "absence must be tested explicitly");
});

test("a multi-item bundle is not shown as a single-token ask", () => {
  // Reading offer[0] and ignoring offer.length prices ONE token at the whole
  // bundle's price -- a wrong number in front of a buyer, which is worse than
  // a missing row.
  const start = ROUTE.indexOf("for (const order of rawOrders) {");
  const body = ROUTE.slice(start, ROUTE.indexOf("const orders = [...cheapestByToken", start));
  assert.match(body, /offer\?\.length \?\? 0\) > 1/, "bundles must be detected");
  assert.match(body, /excludedMultiOffer \+= 1/, "and counted, not silently dropped");
});

test("the new counters actually reach the client", () => {
  // A counter that never leaves the server explains nothing. The whole point
  // is that a short grid arrives WITH the number that explains it.
  // Anchor on the RESPONSE's bookCoverage object, not the first textual
  // occurrence of the word: `bookCoverage` also appears in a type declaration
  // far above, so a greedy match spanned the wrong region entirely.
  // FOUR return paths now build a bookCoverage: Robinhood-native, Bitcoin,
  // Solana and OpenSea. Only the OpenSea one runs the per-token dedup.
  //
  // Anchoring on "the first bookCoverage after `ordersAfterDedup`" broke the
  // moment Solana gained a coverage object containing that same field: the
  // search found Solana's and reported the OpenSea counters missing while the
  // code was correct. Anchor on the field that is UNIQUE to this object
  // instead, then walk BACK to its opening brace -- structure, not order.
  const marker = ROUTE.indexOf("excludedNoTokenId,");
  assert.ok(marker > 0, "the OpenSea coverage object must carry excludedNoTokenId");
  const at = ROUTE.lastIndexOf("bookCoverage: {", marker);
  assert.ok(at > 0, "the OpenSea response must build a bookCoverage object");
  // Bound the object by BALANCING ITS BRACES, not by a character count. My
  // first attempt here used `at + 2000`, which is the same fixed-offset
  // mistake that has failed repeatedly in this codebase while the code under
  // test was correct. Real structure, never position.
  let depth = 0;
  let end = at;
  for (let i = ROUTE.indexOf("{", at); i < ROUTE.length; i += 1) {
    if (ROUTE[i] === "{") depth += 1;
    else if (ROUTE[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > at, "the bookCoverage object must close");
  const block = ROUTE.slice(at, end);
  for (const field of ["excludedNoTokenId", "excludedMultiOffer", "ordersFetched", "ordersAfterDedup"]) {
    assert.ok(block.includes(field), `${field} must be surfaced in bookCoverage`);
  }
});
