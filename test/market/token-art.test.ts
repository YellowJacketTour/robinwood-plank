import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { templatedErc721Image } from "../../lib/market/multichain/token-art-templates";

describe("per-token art templates", () => {
  it("resolves proven Milady CDN for numeric ids", () => {
    const url = templatedErc721Image("0x5Af0D9827E0c53E31634944c487d43a2b04f8e38", "6770");
    assert.equal(url, "https://www.miladymaker.net/milady/6770.png");
  });

  it("does not invent a template for unknown contracts", () => {
    assert.equal(templatedErc721Image("0x0000000000000000000000000000000000000001", "1"), null);
  });
});
