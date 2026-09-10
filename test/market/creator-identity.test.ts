import assert from "node:assert/strict";
import test from "node:test";
import { handleFromTwitterUrl, identityAttemptComplete } from "../../lib/market/multichain/discovery/creator-identity";

test("identity attempts do not impose seven-day cooldowns on skipped or failed vendor reads", () => {
  assert.equal(identityAttemptComplete(null, null, false), false);
  assert.equal(identityAttemptComplete(null, null, true), true);
  assert.equal(identityAttemptComplete("pudgypenguins", null, false), true);
  assert.equal(identityAttemptComplete(null, "creator.eth", false), true);
});

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
