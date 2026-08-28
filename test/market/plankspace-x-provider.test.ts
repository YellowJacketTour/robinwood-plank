import assert from "node:assert/strict";
import test from "node:test";
import { DevelopmentXProvider, selectXProvider } from "../../integrations/plankspace-app/app/x/provider";

test("development X provider connects, imports, and publishes deterministically", async () => {
  const provider = new DevelopmentXProvider();
  const account = await provider.connect({ handle: "degenwaffle" });
  assert.equal(account.username, "degenwaffle");
  const first = await provider.listRecentPosts(account, "");
  assert.equal(first.posts.length, 2);
  assert.equal((await provider.listRecentPosts(account, first.cursor)).posts.length, 0);
  const published = await provider.createPost(account, "PLANK IS FOR THE PEOPLE", "post-42");
  assert.equal(published.id, "xdev-post-42");
  assert.match(published.url, /degenwaffle\/status\/xdev-post-42/);
});

test("development provider is impossible to select in production", () => {
  assert.throws(() => selectXProvider({ mode: "development", nodeEnv: "production" }), /disabled in production/i);
});

test("X publication remains explicitly opt-in", async () => {
  const provider = new DevelopmentXProvider();
  const account = await provider.connect({ handle: "plank" });
  assert.equal(await provider.createPostIfRequested(account, "local", "key", false), null);
  assert.equal((await provider.createPostIfRequested(account, "shared", "key", true))?.id, "xdev-key");
});
