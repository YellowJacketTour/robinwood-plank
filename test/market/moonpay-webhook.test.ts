import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

/**
 * Webhook verification is the ENTIRE trust boundary for order tracking: a
 * request that verifies gets to write rows the UI then shows users as
 * confirmed purchases. These tests are about what must be rejected, not
 * what must be accepted.
 *
 * Pure-function coverage only — recordOrderEvent/getOrdersForWallet need a
 * live Postgres and are exercised by the migration + test:postgres path.
 */
process.env.MOONPAY_WEBHOOK_KEY = "wk_test_fixture";

const {
  MOONPAY_WEBHOOK_TOLERANCE_SECONDS,
  isMoonPayWebhookConfigured,
  parseMoonPayWebhook,
  resolveEventAt,
  verifyMoonPayWebhookSignature,
} = await import("../../lib/moonpay-orders");

const WALLET = "0x1111111111111111111111111111111111111111";
const NOW = 1_786_700_000_000;
const NOW_SECONDS = Math.floor(NOW / 1000);

function sign(rawBody: string, timestamp = NOW_SECONDS, key = "wk_test_fixture"): string {
  const s = crypto.createHmac("sha256", key).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},s=${s}`;
}

const BODY = JSON.stringify({
  type: "transaction_updated",
  data: {
    id: "mp_order_1",
    status: "completed",
    externalCustomerId: WALLET,
    baseCurrencyCode: "usd",
    baseCurrencyAmount: 50,
    quoteCurrencyCode: "usdg",
    quoteCurrencyAmount: 49.2,
    updatedAt: "2026-08-14T12:00:00.000Z",
  },
});

test("a correctly signed webhook verifies", () => {
  const verdict = verifyMoonPayWebhookSignature(sign(BODY), BODY, { now: NOW });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok && verdict.signedAtSeconds, NOW_SECONDS);
});

test("a body tampered with after signing is rejected", () => {
  // The whole point: an attacker who intercepts a real webhook cannot change
  // the amount or the destination and still have it verify.
  const header = sign(BODY);
  const tampered = BODY.replace('"baseCurrencyAmount":50', '"baseCurrencyAmount":50000');
  assert.notEqual(tampered, BODY);
  const verdict = verifyMoonPayWebhookSignature(header, tampered, { now: NOW });
  assert.equal(verdict.ok, false);
});

test("a signature from the wrong key is rejected", () => {
  // Specifically guards against wiring MOONPAY_SECRET_KEY (sk_*) here by
  // mistake -- URL signing and webhook verification use different secrets.
  const header = sign(BODY, NOW_SECONDS, "sk_test_fixture");
  assert.equal(verifyMoonPayWebhookSignature(header, BODY, { now: NOW }).ok, false);
});

test("a replayed webhook outside the tolerance window is rejected", () => {
  const stale = NOW_SECONDS - MOONPAY_WEBHOOK_TOLERANCE_SECONDS - 1;
  const verdict = verifyMoonPayWebhookSignature(sign(BODY, stale), BODY, { now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.error, "STALE");
  // Just inside the window still verifies.
  const fresh = NOW_SECONDS - MOONPAY_WEBHOOK_TOLERANCE_SECONDS + 1;
  assert.equal(verifyMoonPayWebhookSignature(sign(BODY, fresh), BODY, { now: NOW }).ok, true);
});

test("malformed or absent signature headers are rejected, never bypassed", () => {
  for (const header of [
    null,
    "",
    "garbage",
    `t=${NOW_SECONDS}`,
    "s=abc",
    `t=notanumber,s=${"a".repeat(64)}`,
    `t=${NOW_SECONDS},s=nothex!!`,
  ]) {
    assert.equal(verifyMoonPayWebhookSignature(header, BODY, { now: NOW }).ok, false);
  }
});

test("a signature of the wrong length cannot crash verification", () => {
  // crypto.timingSafeEqual throws on length mismatch, and the length is
  // attacker-controlled -- a throw here would be a 500 on every forged call.
  const verdict = verifyMoonPayWebhookSignature(`t=${NOW_SECONDS},s=abcd`, BODY, { now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.error, "BAD_SIGNATURE");
});

test("an unconfigured server rejects rather than accepting unsigned events", () => {
  const saved = process.env.MOONPAY_WEBHOOK_KEY;
  delete process.env.MOONPAY_WEBHOOK_KEY;
  try {
    assert.equal(isMoonPayWebhookConfigured(), false);
    const verdict = verifyMoonPayWebhookSignature(sign(BODY), BODY, { now: NOW });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false && verdict.error, "NOT_CONFIGURED");
  } finally {
    process.env.MOONPAY_WEBHOOK_KEY = saved;
  }
});

test("payload parsing keys the order to the wallet and survives sparse events", () => {
  const parsed = parseMoonPayWebhook(JSON.parse(BODY));
  assert.equal(parsed.orderId, "mp_order_1");
  assert.equal(parsed.record?.walletAddress, WALLET.toLowerCase());
  assert.equal(parsed.record?.status, "completed");
  assert.equal(parsed.record?.baseCurrencyAmount, 50);

  // An event with nothing but an id must still record, not throw: an
  // unparseable shape would otherwise be retried by MoonPay forever.
  const sparse = parseMoonPayWebhook({ type: "transaction_updated", data: { id: "x" } });
  assert.equal(sparse.record?.status, "unknown");
  assert.equal(sparse.record?.walletAddress, null);

  // No id at all = nothing to key on; caller acknowledges and ignores.
  assert.equal(parseMoonPayWebhook({ type: "ping", data: {} }).record, null);
  assert.equal(parseMoonPayWebhook(null).record, null);
});

test("event time comes from the payload, not from receive time", () => {
  // The ordering guard depends on this. A retry is re-signed with a fresh
  // header timestamp, so using signature-time or now() would let a
  // redelivered "pending" overwrite a "completed" that landed in between.
  const at = resolveEventAt(JSON.parse(BODY), NOW_SECONDS, NOW);
  assert.equal(at.toISOString(), "2026-08-14T12:00:00.000Z");

  // Falls back to signature time, then to now, when the payload has neither.
  const noTimes = resolveEventAt({ data: { id: "x" } }, NOW_SECONDS, NOW);
  assert.equal(noTimes.getTime(), NOW_SECONDS * 1000);
  assert.equal(resolveEventAt({ data: { id: "x" } }, 0, NOW).getTime(), NOW);
});

test("outgoing checkout URLs carry the externalCustomerId the webhook keys on", async () => {
  process.env.NEXT_PUBLIC_MOONPAY_ENABLED = "true";
  process.env.MOONPAY_API_KEY = "pk_test_fixture";
  process.env.MOONPAY_SECRET_KEY = "sk_test_fixture";
  process.env.MOONPAY_ENV = "sandbox";
  const { buildBuyWidgetUrl, buildSellWidgetUrl } = await import("../../lib/moonpay-server");

  // Without this the webhook has nothing to attribute an order to, and the
  // whole tracking path silently records orders against a null wallet.
  for (const { url } of [buildBuyWidgetUrl(WALLET), buildSellWidgetUrl(WALLET)]) {
    assert.equal(
      new URL(url).searchParams.get("externalCustomerId"),
      WALLET.toLowerCase()
    );
  }
});
