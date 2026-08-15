import assert from "node:assert/strict";
import test from "node:test";

import {
  DISMISSED_KEY,
  REFRESH_GUARD_KEY,
  REFRESH_GUARD_MS,
  isNewerBuild,
  manifestMarkers,
  shouldSuppressVersionPrompt,
  writeRecord,
} from "../../lib/version-update";

/**
 * The update prompt interrupts someone mid-session, so the expensive mistake
 * is a FALSE POSITIVE — prompting when there is no new build, on every poll,
 * forever. Most of these pin the cases that must stay silent.
 */

/** Minimal in-memory Storage, since this logic must run without a browser. */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(seed));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, v),
  } as Storage;
}

/** Storage that throws on every operation — private mode, quota, blocked. */
function hostileStorage(): Storage {
  const boom = () => {
    throw new Error("storage unavailable");
  };
  return {
    get length(): number {
      return boom();
    },
    clear: boom,
    getItem: boom,
    key: boom,
    removeItem: boom,
    setItem: boom,
  } as unknown as Storage;
}

test("a different server build prompts", () => {
  assert.equal(isNewerBuild("aaa111", { version: "bbb222" }), true);
});

test("the same build never prompts", () => {
  assert.equal(isNewerBuild("aaa111", { version: "aaa111" }), false);
  // Matching on ANY offered field counts as a match — /api/health and
  // /version.json name the same value differently.
  assert.equal(isNewerBuild("aaa111", { version: "bbb222", buildId: "aaa111" }), false);
});

test("no current marker never prompts — this is local dev", () => {
  // DEPLOYMENT_VERSION is unset outside production. Without this the feature
  // would prompt on every poll against a marker that never matches.
  for (const current of [null, undefined, "", "   ", "unknown"]) {
    assert.equal(isNewerBuild(current, { version: "bbb222" }), false, `current=${current}`);
  }
});

test("an unreadable or empty manifest never prompts", () => {
  // Offline, a proxy error page, a half-deployed server. Silence is right:
  // a false negative costs a stale tab, a false positive is a modal that is
  // simply wrong and repeats every poll.
  for (const manifest of [null, undefined, {}, { version: "" }, { version: "unknown" }, { version: 42 }]) {
    assert.equal(isNewerBuild("aaa111", manifest as never), false, JSON.stringify(manifest));
  }
});

test("markers are trimmed and junk is dropped", () => {
  assert.deepEqual(manifestMarkers({ version: "  aaa111  ", buildId: "", commit: null }), ["aaa111"]);
  assert.deepEqual(manifestMarkers({ version: "unknown" }), []);
  assert.deepEqual(manifestMarkers(null), []);
});

test("'Not now' silences that build permanently, but not the next one", () => {
  // No timed re-nag: someone who declined has answered. Asking again in an
  // hour is nagging. The next release carries a different marker.
  const local = fakeStorage();
  writeRecord(local, DISMISSED_KEY, "bbb222");

  assert.equal(shouldSuppressVersionPrompt("bbb222", { local }), true);
  assert.equal(
    shouldSuppressVersionPrompt("bbb222", { local, now: Date.now() + 30 * 24 * 3600_000 }),
    true,
    "a month later it is still dismissed"
  );
  assert.equal(shouldSuppressVersionPrompt("ccc333", { local }), false, "a new build asks again");
});

test("the refresh guard stops a reload loop, then expires", () => {
  // A Passenger restart can briefly serve the OLD process, so a reload can
  // land back on the old bundle. Without the guard the user is trapped in a
  // loop they cannot escape by doing what we asked.
  const session = fakeStorage();
  const t0 = 1_000_000;
  session.setItem(REFRESH_GUARD_KEY, JSON.stringify({ marker: "bbb222", timestamp: t0 }));

  assert.equal(shouldSuppressVersionPrompt("bbb222", { session, now: t0 + 1_000 }), true);
  assert.equal(
    shouldSuppressVersionPrompt("bbb222", { session, now: t0 + REFRESH_GUARD_MS + 1 }),
    false,
    "expires, so a genuinely stuck deploy can prompt again"
  );
  assert.equal(
    shouldSuppressVersionPrompt("ccc333", { session, now: t0 + 1_000 }),
    false,
    "guards only the build that was refreshed to"
  );
});

test("hostile storage degrades to prompting, never to throwing", () => {
  // Private mode / quota / blocked cookies must not break the page. Losing
  // the dismissal is acceptable; an exception in a root-layout component is
  // not.
  const hostile = hostileStorage();
  assert.doesNotThrow(() => shouldSuppressVersionPrompt("bbb222", { local: hostile, session: hostile }));
  assert.equal(shouldSuppressVersionPrompt("bbb222", { local: hostile, session: hostile }), false);
  assert.doesNotThrow(() => writeRecord(hostile, DISMISSED_KEY, "bbb222"));
});

test("corrupt stored records are ignored rather than trusted", () => {
  for (const bad of ["not json", "{}", '{"marker":""}', '{"marker":"x"}', '{"timestamp":1}']) {
    const local = fakeStorage({ [DISMISSED_KEY]: bad });
    assert.equal(shouldSuppressVersionPrompt("bbb222", { local }), false, bad);
  }
});

test("missing storage entirely is fine", () => {
  // Server-side render, or a browser that exposes nothing.
  assert.equal(shouldSuppressVersionPrompt("bbb222", { local: null, session: null }), false);
  assert.doesNotThrow(() => writeRecord(null, DISMISSED_KEY, "bbb222"));
});
