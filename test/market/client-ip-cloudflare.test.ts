import assert from "node:assert/strict";
import test from "node:test";
import { getClientIp, rateLimit } from "../../lib/security";

function req(headers: Record<string, string>): Request {
  return new Request("https://plank.love/api/x", { headers });
}

test("behind Cloudflare, the real client ip wins over the edge hop in x-forwarded-for", () => {
  const r = req({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7, 172.70.1.1" });
  assert.equal(getClientIp(r), "203.0.113.7");
});

test("without Cloudflare headers the previous rightmost-hop behaviour is unchanged", () => {
  assert.equal(getClientIp(req({ "x-forwarded-for": "10.0.0.1, 10.0.0.2" })), "10.0.0.2");
  assert.equal(getClientIp(req({ "x-real-ip": "10.9.9.9" })), "10.9.9.9");
  assert.equal(getClientIp(req({})), "unknown");
});

test("two visitors behind the same Cloudflare edge get separate rate-limit buckets", () => {
  const key = `zztest-cf-${Date.now()}`;
  const a = req({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "198.51.100.1, 172.70.1.1" });
  const b = req({ "cf-connecting-ip": "198.51.100.2", "x-forwarded-for": "198.51.100.2, 172.70.1.1" });
  for (let i = 0; i < 3; i++) assert.equal(rateLimit(a, { key, limit: 3, windowMs: 60_000 }), null);
  assert.notEqual(rateLimit(a, { key, limit: 3, windowMs: 60_000 }), null, "visitor A is now limited");
  assert.equal(rateLimit(b, { key, limit: 3, windowMs: 60_000 }), null, "visitor B is not");
});
