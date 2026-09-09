import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { templatedErc721Image } from "../../lib/market/multichain/token-art-templates";

/**
 * These tests pinned 0x5Af0D9827E0c53E31634944c487d43a2b04f8e38 as Milady.
 * That address has ZERO bytes of code on mainnet (confirmed 2026-09-09 on two
 * independent RPC providers); the real contract is
 * 0x5af0d9827e0c53e4799bb226655a1de152a425a5, which returns name() == "Milady"
 * and 11,410 bytes of code. The tests mirrored the template's typo instead of
 * verifying it, so the only image template in the codebase could never match
 * and every Milady tile fell through to a per-token OpenSea call -- green
 * tests, silent bug.
 */
describe("per-token art templates", () => {
  it("resolves proven Milady CDN for numeric ids", () => {
    const url = templatedErc721Image("0x5af0d9827e0c53e4799bb226655a1de152a425a5", "6770");
    assert.equal(url, "https://www.miladymaker.net/milady/6770.png");
  });

  it("does not invent a template for unknown contracts", () => {
    assert.equal(templatedErc721Image("0x0000000000000000000000000000000000000001", "1"), null);
  });
});
