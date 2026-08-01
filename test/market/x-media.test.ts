import assert from "node:assert/strict";
import test from "node:test";
import { syndicationToken, xPostId } from "../../lib/x-media";
import { titleFromPost } from "../../lib/woodamp-playlist";

/**
 * X posts carry their audio inside a video. These lock in the two pure pieces
 * of that import path — which URLs are posts, and the token X's own embed
 * endpoint requires — so a refactor can't silently start resolving the wrong
 * post or stop resolving at all.
 */

const POST = "https://x.com/Bullish0xCrypto/status/1934323597184508410";

test("post ids are extracted from every X URL shape", () => {
  assert.equal(xPostId(POST), "1934323597184508410");
  assert.equal(xPostId(`${POST}?s=20&t=abc`), "1934323597184508410");
  assert.equal(xPostId(`${POST}/video/1`), "1934323597184508410");
  assert.equal(
    xPostId("https://twitter.com/someone/status/1934323597184508410"),
    "1934323597184508410"
  );
  assert.equal(
    xPostId("https://mobile.twitter.com/a/statuses/1934323597184508410"),
    "1934323597184508410"
  );
});

test("non-posts and lookalike hosts resolve to nothing", () => {
  // The route feeds this straight into an outbound fetch, so a host that only
  // looks like X must never produce an id.
  for (const url of [
    "https://x.com/Bullish0xCrypto",
    "https://x.com.evil.example/status/123456789",
    "https://notx.com/a/status/1934323597184508410",
    "http://x.com/a/status/1934323597184508410",
    "https://suno.com/song/ec323f42-46f9-4d44-8f58-de00275fb36a",
    "garbage",
  ]) {
    assert.equal(xPostId(url), null, `${url} must not resolve`);
  }
});

test("the syndication token matches what X's embed script derives", () => {
  // Verified against the live endpoint: this exact token returns the post.
  // If the derivation drifts, imports 404 with no other symptom.
  assert.equal(syndicationToken("1934323597184508410"), "4osuuezbm3a");
  assert.match(syndicationToken("1"), /^[a-z0-9]+$/);
});

test("a title is borrowed from the post so none has to be typed", () => {
  // Real post text: prose across lines, emoji, trailing link.
  assert.equal(
    titleFromPost(
      "My timeline for the next... The pyops is real by these 2\n\nDon't lose sight",
      "@Bullish0xCrypto"
    ),
    "My timeline for the next... The pyops is real by these 2"
  );
  // A post that is only media still yields something usable.
  assert.equal(titleFromPost("", "@someone"), "Post by @someone");
  assert.equal(titleFromPost("https://t.co/abc", "@someone"), "Post by @someone");
  assert.ok(Array.from(titleFromPost("x".repeat(200), "@a")).length <= 60);
});

test("truncation never cuts an emoji in half", () => {
  // Emoji are surrogate pairs. Slicing by UTF-16 unit leaves a lone surrogate,
  // which renders as a replacement glyph in the playlist row — exactly what a
  // live X post produced before this.
  const title = titleFromPost("a".repeat(59) + "\u{1F602}\u{1F602}", "@a");
  assert.equal(Array.from(title).length, 60, "60 code points, not 60 units");
  assert.ok(
    !/[\uD800-\uDFFF]/.test(title.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")),
    "no orphaned surrogate survives truncation"
  );
});
