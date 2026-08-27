import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig } from "../../lib/postgres";
import { retryAfterMsFromHeaders } from "../../lib/market/multichain/discovery/opensea-key-pool";

/**
 * Real, live-verified 2026-08-27: OpenSea's actual response headers
 * (x-ratelimit-limit/x-ratelimit-remaining) genuinely decrement per real
 * request -- confirmed by bursting 40 real calls and watching remaining
 * count down 119->100 -- and Retry-After is a real header this app never
 * previously read, always guessing a blind 20-minute jail instead.
 */
test("retryAfterMsFromHeaders parses a real integer-seconds Retry-After", () => {
  const headers = new Headers({ "retry-after": "120" });
  assert.equal(retryAfterMsFromHeaders(headers), 120_000);
});

test("retryAfterMsFromHeaders parses a real HTTP-date Retry-After", () => {
  const future = new Date(Date.now() + 60_000).toUTCString();
  const headers = new Headers({ "retry-after": future });
  const ms = retryAfterMsFromHeaders(headers);
  assert.ok(ms !== null && ms > 55_000 && ms <= 60_000, `expected ~60000ms, got ${ms}`);
});

test("retryAfterMsFromHeaders returns null when the header is absent", () => {
  assert.equal(retryAfterMsFromHeaders(new Headers()), null);
});

test(
  "recordOpenSeaAccountFailure uses the real Retry-After header instead of the blind 20-minute default",
  { skip: !hasPostgresConfig() },
  async () => {
    const { recordOpenSeaAccountFailure, loadOpenSeaKeyPool } = await import("../../lib/market/multichain/discovery/opensea-key-pool");
    const { jailRemainingMs } = await import("../../lib/market/multichain/mesh/jail");
    const pool = await loadOpenSeaKeyPool();
    const target = pool[0].providerAccount;
    const fakeResponse = new Response(null, { status: 429, headers: { "retry-after": "45" } });
    await recordOpenSeaAccountFailure(target, true, fakeResponse);
    const remaining = await jailRemainingMs(target);
    // Real Retry-After (45s) must win over the blind 20-minute default --
    // allow generous slack for real test execution time, but it must be
    // nowhere near the old 20-minute (1,200,000ms) default.
    assert.ok(remaining > 0 && remaining <= 45_000, `expected <= 45000ms from the real header, got ${remaining}`);
  }
);
