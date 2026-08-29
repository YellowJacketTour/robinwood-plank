import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateXImportWindow,
  evaluateXPostCooldown,
  normalizeXCooldownMinutes,
  newestTwentyXPosts,
} from "../../integrations/plankspace-app/app/x/policy";

const now = Date.parse("2026-08-28T18:00:00.000Z");

test("ordinary profiles wait five minutes between X publications", () => {
  assert.deepEqual(
    evaluateXPostCooldown({
      now,
      lastPublishedAt: "2026-08-28T17:58:30.000Z",
      cooldownMinutes: 5,
      profileHandle: "somebody",
    }),
    { allowed: false, retryAfterSeconds: 210 },
  );
  assert.deepEqual(
    evaluateXPostCooldown({
      now,
      lastPublishedAt: "2026-08-28T17:55:00.000Z",
      cooldownMinutes: 5,
      profileHandle: "somebody",
    }),
    { allowed: true, retryAfterSeconds: 0 },
  );
});

test("Degen_Waffle is exempt from only the X publication cooldown", () => {
  assert.deepEqual(
    evaluateXPostCooldown({
      now,
      lastPublishedAt: "2026-08-28T17:59:59.000Z",
      cooldownMinutes: 5,
      profileHandle: "Degen_Waffle",
    }),
    { allowed: true, retryAfterSeconds: 0 },
  );
  assert.equal(
    evaluateXPostCooldown({
      now,
      lastPublishedAt: "2026-08-28T17:59:59.000Z",
      cooldownMinutes: 5,
      profileHandle: "degenwaffle",
    }).allowed,
    true,
  );
  assert.equal(
    evaluateXImportWindow({
      now,
      lastImportedAt: "2026-08-28T17:00:00.000Z",
    }).allowed,
    false,
  );
});

test("X imports are available only once per rolling 24 hours", () => {
  assert.deepEqual(
    evaluateXImportWindow({
      now,
      lastImportedAt: "2026-08-28T17:00:00.000Z",
    }),
    { allowed: false, retryAfterSeconds: 82_800 },
  );
  assert.deepEqual(
    evaluateXImportWindow({
      now,
      lastImportedAt: "2026-08-27T18:00:00.000Z",
    }),
    { allowed: true, retryAfterSeconds: 0 },
  );
});

test("an import keeps at most the newest twenty X posts", () => {
  const posts = Array.from({ length: 27 }, (_, index) => ({
    id: String(index + 1),
    text: `post ${index + 1}`,
    createdAt: new Date(now - index * 1_000).toISOString(),
    url: `https://x.com/example/status/${index + 1}`,
  }));
  assert.deepEqual(
    newestTwentyXPosts(posts).map((post) => post.id),
    Array.from({ length: 20 }, (_, index) => String(index + 1)),
  );
});

test("admin cooldown input is constrained to a safe range", () => {
  assert.equal(normalizeXCooldownMinutes(undefined), 5);
  assert.equal(normalizeXCooldownMinutes(-1), 0);
  assert.equal(normalizeXCooldownMinutes(8.7), 9);
  assert.equal(normalizeXCooldownMinutes(10_000), 1_440);
});
