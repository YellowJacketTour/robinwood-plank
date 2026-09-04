import assert from "node:assert/strict";
import test from "node:test";
import {
  DevelopmentXProvider,
  LiveXProvider,
  formatPlankSpaceXPost,
  selectXProvider,
} from "../../integrations/plankspace-app/app/x/provider";

test("development X provider connects, imports, and publishes deterministically", async () => {
  const provider = new DevelopmentXProvider();
  const account = await provider.connect({ handle: "degenwaffle" });
  assert.equal(account.username, "Degen_Waffle");
  const first = await provider.listRecentPosts(account, "");
  assert.equal(first.posts.length, 2);
  assert.equal((await provider.listRecentPosts(account, first.cursor)).posts.length, 0);
  const published = await provider.createPost(account, "PLANK IS FOR THE PEOPLE", "post-42");
  assert.equal(published.id, "xdev-post-42");
  assert.match(published.url, /Degen_Waffle\/status\/xdev-post-42/);
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

test("PlankSpace X posts carry the required footer and stay within X's limit", () => {
  assert.equal(
    formatPlankSpaceXPost("Hello from the Lumberyard"),
    "Hello from the Lumberyard\n\nPosted from my PlankSpace on Plank.Love",
  );

  const result = formatPlankSpaceXPost(`${"board ".repeat(60)}🪵`);
  assert.ok(Array.from(result).length <= 280);
  assert.ok(result.endsWith("\n\nPosted from my PlankSpace on Plank.Love"));
  assert.doesNotMatch(result, /�/);
});

test("live X failures remain readable when X returns a non-JSON response", async () => {
  const provider = new LiveXProvider(async () =>
    new Response("<html>gateway failure</html>", { status: 502 }),
  );
  const account = { id: "123", username: "plank", accessToken: "token" };

  await assert.rejects(
    provider.listRecentPosts(account, ""),
    /X timeline request failed \(502\)/,
  );
});
