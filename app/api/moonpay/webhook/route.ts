import {
  parseMoonPayWebhook,
  recordOrderEvent,
  resolveEventAt,
  verifyMoonPayWebhookSignature,
} from "@/lib/moonpay-orders";
import { MAX_BODY_BYTES, publicError, publicJson } from "@/lib/security";
import { TradeApiError } from "@/lib/uniswap-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * MoonPay order webhook — the only way we learn what happened after a buyer
 * leaves for the hosted checkout.
 *
 * NOT gated on NEXT_PUBLIC_MOONPAY_ENABLED, deliberately. That flag controls
 * whether we OFFER the ramp; orders opened before the flag was flipped off
 * still settle afterwards, and dropping their events would strand real
 * purchases with no record. The signature is what makes this endpoint safe,
 * not the feature flag.
 *
 * The raw body is read with req.text() rather than lib/security.ts's
 * readJsonBody because the HMAC covers the exact bytes MoonPay hashed —
 * parsing and re-serialising reorders keys and breaks verification.
 */
export async function POST(req: Request) {
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) {
      throw new TradeApiError(413, "BODY_TOO_LARGE", "Webhook body too large.");
    }

    const verdict = verifyMoonPayWebhookSignature(
      req.headers.get("moonpay-signature-v2"),
      raw
    );
    if (!verdict.ok) {
      // 503 for "we are not set up to verify" vs 401 for "this did not
      // verify" — an unconfigured server must never look like it accepted
      // the event, and MoonPay's retries should be able to tell the
      // difference between a misconfiguration on our side and a bad sender.
      const status = verdict.error === "NOT_CONFIGURED" ? 503 : 401;
      throw new TradeApiError(status, verdict.error, "Webhook rejected.");
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new TradeApiError(400, "BAD_JSON", "Webhook body was not valid JSON.");
    }

    const { orderId, eventType, record } = parseMoonPayWebhook(body);
    if (!orderId || !record) {
      // Signature was valid, so this genuinely came from MoonPay — it is just
      // an event shape we do not track (or one carrying no transaction id).
      // Acknowledge it: retrying will not make it parseable, and an endless
      // retry loop on an event we will never store is noise on both sides.
      return publicJson({ ok: true, ignored: true });
    }

    await recordOrderEvent(
      record,
      eventType,
      body,
      resolveEventAt(body, verdict.signedAtSeconds)
    );
    return publicJson({ ok: true });
  } catch (err) {
    return publicError(err, "Failed to process MoonPay webhook.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
