import { test } from "node:test";
import assert from "node:assert/strict";
import { canSpectate, parseSpectatorPolicy } from "../../lib/charmville/spectator-policy";
import { YardError } from "../../lib/charmville/errors";

test("spectator policy accepts exact modes and deduplicates explicit handles", () => {
  for (const mode of ["public", "private", "allowlist"]) {
    assert.deepEqual(parseSpectatorPolicy({ mode }), { mode, allowedHandles: [] });
    assert.deepEqual(parseSpectatorPolicy({ mode, allowedHandles: ["friend", "other_2", "friend"] }),
      { mode, allowedHandles: ["friend", "other_2"] });
  }
});

test("spectator updates reject malformed modes, handles, and oversized lists", () => {
  const invalid = [null, [], "public", {}, { mode: "PUBLIC" }, { mode: "friends" },
    ...[null, "friend", [""], ["Friend"], ["@friend"], [" friend"], ["friend\n"],
      ["a".repeat(41)], [123], [null], new Array(1), Array(101).fill("friend")]
      .map(allowedHandles => ({ mode: "allowlist", allowedHandles }))];
  for (const raw of invalid) {
    assert.throws(() => parseSpectatorPolicy(raw), (error: unknown) => error instanceof YardError && error.status === 400);
  }
  assert.equal(parseSpectatorPolicy({ mode: "allowlist", allowedHandles: Array.from({ length: 100 }, (_, i) => `friend${i}`) }).allowedHandles.length, 100);
});

test("only public policies admit anonymous viewers", () => {
  for (const viewerId of [undefined, null, ""]) {
    for (const mode of ["public", "private", "allowlist", "invalid", undefined, null]) {
      assert.equal(canSpectate({ ownerId: "1", viewerId, mode, allowedIds: ["", "2"] }), mode === "public");
    }
  }
});

test("owner always has access and unknown policies deny everyone else", () => {
  for (const mode of ["public", "private", "allowlist", "invalid", undefined, null]) {
    assert.equal(canSpectate({ ownerId: "1", viewerId: "1", mode }), true);
    assert.equal(canSpectate({ ownerId: "1", viewerId: "2", mode, allowedIds: ["2"] }), mode === "public" || mode === "allowlist");
  }
});

test("allowlist compares explicit profile IDs without coercion or implicit access", () => {
  assert.equal(canSpectate({ ownerId: "1", viewerId: "2", mode: "allowlist", allowedIds: ["2"] }), true);
  for (const allowedIds of [undefined, [], ["friend"], ["02"], ["3"]]) {
    assert.equal(canSpectate({ ownerId: "1", viewerId: "2", mode: "allowlist", allowedIds }), false);
  }
});
