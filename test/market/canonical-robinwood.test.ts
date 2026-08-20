import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalRobinwoodOrigin,
  isCanonicalRobinwoodHost,
} from "@/lib/market/canonical-robinwood";

test("canonical origin defaults to plank.love", () => {
  const prev = process.env.ROBINWOOD_CANONICAL_ORIGIN;
  delete process.env.ROBINWOOD_CANONICAL_ORIGIN;
  assert.equal(canonicalRobinwoodOrigin(), "https://plank.love");
  if (prev != null) process.env.ROBINWOOD_CANONICAL_ORIGIN = prev;
});

test("does not treat localhost as the live book", () => {
  assert.equal(isCanonicalRobinwoodHost("localhost:3800"), false);
  assert.equal(isCanonicalRobinwoodHost("127.0.0.1"), false);
});

test("treats plank.love host as canonical (no self-fetch)", () => {
  assert.equal(isCanonicalRobinwoodHost("plank.love"), true);
});
