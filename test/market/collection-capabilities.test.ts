import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sequentialMintCapability } from "@/lib/market/multichain/collection-capabilities";

describe("verified sequential collection capabilities", () => {
  it("recognizes MUGS case-insensitively with its first-party boundary selector", () => {
    assert.deepEqual(sequentialMintCapability(
      "robinhood",
      "0xAB75F3D72509CD3B3A386A03DE2B82854F0060E5"
    ), {
      supplySelector: "0xa2309ff8",
      firstTokenId: 1,
      provenance: "mugs-first-party-total-minted",
    });
  });

  it("does not infer sequential ids merely from an arbitrary EVM contract", () => {
    assert.equal(sequentialMintCapability("robinhood", "0x0000000000000000000000000000000000000001"), null);
  });
});
