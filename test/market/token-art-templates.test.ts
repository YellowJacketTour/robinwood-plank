import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  templatedErc721Image,
  ERC721_IMAGE_TEMPLATE_KEYS,
} from "@/lib/market/multichain/token-art-templates";

/**
 * A template is a (contract -> url) PAIR, and this file's rule used to check
 * only the url: "add a line only after a real HEAD 200 on that host".
 *
 * The single entry keyed Milady as 0x5af0d9827e0c53e31634944c487d43a2b04f8e38,
 * which shares a prefix with the real contract and diverges after 16 hex
 * characters. Checked on-chain 2026-09-09 with eth_call name():
 *
 *   0x5af0d9827e0c53e31634944c487d43a2b04f8e38 -> NO CODE AT ALL
 *   0x5af0d9827e0c53e4799bb226655a1de152a425a5 -> "Milady"
 *
 * So the only template in the codebase could never match, and every Milady
 * tile fell through to a per-token OpenSea call. A wrong key fails exactly
 * like a missing entry: silently, and slower.
 */

const MILADY = "0x5af0d9827e0c53e4799bb226655a1de152a425a5";

test("the Milady template is keyed to the contract that actually exists", () => {
  const url = templatedErc721Image(MILADY, "7957");
  assert.equal(url, "https://www.miladymaker.net/milady/7957.png");
});

test("the dead address that was there before matches nothing", () => {
  // Pinned so a revert is loud. This address has no code on mainnet.
  assert.equal(templatedErc721Image("0x5af0d9827e0c53e31634944c487d43a2b04f8e38", "7957"), null);
});

test("every template key is a well-formed lowercase address", () => {
  // The shape a typo'd key fails. Checksum casing would also silently miss,
  // because the lookup lowercases the INPUT but not the stored key.
  for (const k of ERC721_IMAGE_TEMPLATE_KEYS) {
    assert.match(k, /^0x[0-9a-f]{40}$/, `template key is not a lowercase address: ${k}`);
  }
  assert.ok(ERC721_IMAGE_TEMPLATE_KEYS.length > 0, "sanity: there is at least one template");
});

test("a checksummed lookup still resolves", () => {
  const mixed = "0x5AF0D9827E0C53E4799BB226655A1DE152A425A5";
  assert.ok(templatedErc721Image(mixed, "1"), "callers pass checksummed addresses too");
});

test("non-numeric token ids are refused", () => {
  // The url template interpolates the id directly; an inscription id or a
  // mint address would build a nonsense URL.
  assert.equal(templatedErc721Image(MILADY, "abc"), null);
  assert.equal(templatedErc721Image(MILADY, ""), null);
});

/**
 * The general case: a collection with NO template.
 */
const ART = readFileSync("lib/market/multichain/token-art.ts", "utf8").replace(/\r\n/g, "\n");

test("remote image lookups are grouped, not awaited one at a time", () => {
  // A templated collection fills its page for free. Everything else reaches
  // this loop, and the caller's budget is 16 against a 400-tile grid -- so it
  // filled slowly, and it used to fill 16 SEQUENTIAL round-trips slowly.
  const at = ART.indexOf("FETCH IN BOUNDED GROUPS");
  assert.ok(at > 0, "the grouping must be documented where it happens");
  const body = ART.slice(at, ART.indexOf("return filled;", at));
  assert.match(body, /await Promise\.all\(/, "the group must be issued together");
  assert.match(body, /const GROUP = \d+/, "the group size must be an explicit constant");
  const n = Number(body.match(/const GROUP = (\d+)/)![1]);
  assert.ok(n > 1 && n <= 16, `group size ${n} is not a bounded fan-out`);
});

test("one failed image cannot lose the rest of its group", () => {
  const at = ART.indexOf("FETCH IN BOUNDED GROUPS");
  const body = ART.slice(at, ART.indexOf("return filled;", at));
  assert.match(body, /catch \{/, "each lookup must absorb its own failure");
});
