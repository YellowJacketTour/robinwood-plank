import { test } from "node:test";
import assert from "node:assert/strict";
import { bootRuntimeSession, renewRuntimeSession, RuntimeBootError } from "../../app/charmville/world/runtime-boot";

const token = "a".repeat(64), now = Date.parse("2026-09-13T12:00:00Z"), expiresAt = "2026-09-13T12:10:00Z";
const fixture = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as typeof fetch;
test("runtime boot only POSTs to fixed sameorigin endpoint and exposes expiry alone", async () => {
  let sends = 0;
  const fetcher = (async (url, options) => {
    sends++; assert.equal(url, "/api/charmville/runtime-session"); assert.equal(options?.method, "POST");
    assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${token}`);
    assert.equal(options?.credentials, "same-origin"); assert.equal(options?.redirect, "error"); assert.equal(options?.cache, "no-store"); assert.equal(options?.body, undefined);
    return Response.json({ expiresAt, ticket: "never-propagate" });
  }) as typeof fetch;
  assert.deepEqual(await bootRuntimeSession({ token, fetcher, now: () => now }), { expiresAt }); assert.equal(sends, 1);
});
test("invalid expired and implausible session expiries never authorize navigation", async () => {
  for (const body of [null, [], {}, { expiresAt: 42 }, { expiresAt: "bad" }, { expiresAt: new Date(now).toISOString() }, { expiresAt: new Date(now + 631_000).toISOString() }])
    await assert.rejects(bootRuntimeSession({ token, fetcher: fixture(body), now: () => now }), error => error instanceof RuntimeBootError && error.status === 502);
});
test("HTTP and network errors send once and do not expose response content", async () => {
  for (const status of [401, 403, 429, 503]) {
    let sends = 0; const fetcher = (async () => { sends++; return Response.json({ error: token }, { status }); }) as typeof fetch;
    await assert.rejects(bootRuntimeSession({ token, fetcher }), error => error instanceof RuntimeBootError && error.status === status && !error.message.includes(token));
    assert.equal(sends, 1);
  }
  let sends = 0;
  await assert.rejects(bootRuntimeSession({ token, fetcher: (async () => { sends++; throw new TypeError(token); }) as typeof fetch }), error => error instanceof RuntimeBootError && error.status === 503 && !error.message.includes(token));
  assert.equal(sends, 1);
});
test("cancelled or superseded accounts cannot accept late boot replies", async () => {
  const abort = new AbortController(); abort.abort(); let sends = 0;
  await assert.rejects(bootRuntimeSession({ token, signal: abort.signal, fetcher: (async () => { sends++; return Response.json({ expiresAt }); }) as typeof fetch }), { name: "AbortError" }); assert.equal(sends, 0);
  let current = true;
  await assert.rejects(bootRuntimeSession({ token, isCurrent: () => current, fetcher: (async () => { current = false; return Response.json({ expiresAt }); }) as typeof fetch }), { name: "AbortError" });
});
test("boot timeout aborts outstanding request without retry", async () => {
  let sends = 0;
  const fetcher = ((_url, options) => new Promise<Response>((_resolve, reject) => { sends++; options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }); })) as typeof fetch;
  await assert.rejects(bootRuntimeSession({ token, fetcher, timeoutMs: 5 }), error => error instanceof RuntimeBootError && error.status === 504);
  assert.equal(sends, 1);
});
test("invalid credentials do not reach the network", async () => {
  let sends = 0;
  await assert.rejects(bootRuntimeSession({ token: "not-a-session", fetcher: (async () => { sends++; return Response.json({ expiresAt }); }) as typeof fetch }), error => error instanceof RuntimeBootError && error.status === 401);
  assert.equal(sends, 0);
});
test("renewal uses the existing cookie path and never calls issuance", async () => {
  const urls: string[] = [];
  const fetcher = (async (url, options) => {
    urls.push(String(url)); assert.equal(options?.method, "POST"); assert.equal(options?.credentials, "same-origin");
    assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${token}`);
    return Response.json({ expiresAt });
  }) as typeof fetch;
  assert.deepEqual(await renewRuntimeSession({ token, fetcher, now: () => now }), { expiresAt });
  assert.deepEqual(urls, ["/charmville/runtime/session"]);
});
test("failed renewal does not silently issue a replacement ticket", async () => {
  let sends = 0;
  await assert.rejects(renewRuntimeSession({ token, fetcher: (async url => { sends++; assert.equal(url, "/charmville/runtime/session"); return Response.json({}, { status: 401 }); }) as typeof fetch }), error => error instanceof RuntimeBootError && error.status === 401);
  assert.equal(sends, 1);
});
