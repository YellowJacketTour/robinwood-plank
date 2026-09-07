import assert from "node:assert/strict";
import test from "node:test";
import { handleFromTwitterUrl } from "../../lib/market/multichain/discovery/creator-identity";

test("creator identity: twitter handle parsing accepts twitter.com and x.com URLs and bare handles, rejects non-profile paths", () => {
  assert.equal(handleFromTwitterUrl("https://twitter.com/BoredApeYC"), "BoredApeYC");
  assert.equal(handleFromTwitterUrl("https://x.com/@pudgypenguins"), "pudgypenguins");
  assert.equal(handleFromTwitterUrl("https://twitter.com/#!/azuki"), "azuki");
  assert.equal(handleFromTwitterUrl("@degods"), "degods");
  assert.equal(handleFromTwitterUrl("degods"), "degods");
  assert.equal(handleFromTwitterUrl("https://twitter.com/home"), null);
  assert.equal(handleFromTwitterUrl("https://twitter.com/intent/tweet?text=x"), null);
  assert.equal(handleFromTwitterUrl(null), null);
  assert.equal(handleFromTwitterUrl("https://discord.gg/abc"), null);
});
