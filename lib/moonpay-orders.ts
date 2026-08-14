import crypto from "node:crypto";
import { postgresQuery } from "@/lib/postgres";

/**
 * MoonPay order tracking — the return path for the fiat ramp.
 *
 * lib/moonpay-server.ts builds a signed URL and the buyer leaves for
 * MoonPay's hosted checkout. Everything after that happens on MoonPay's
 * side; the ONLY way we learn what became of an order is the webhook this
 * module verifies and records (migration 011_moonpay_orders.sql).
 *
 * TRUST BOUNDARY. A webhook is an unauthenticated POST from the public
 * internet that asserts things about money. The signature is the entire
 * gate: an unsigned, mis-signed, stale, or unverifiable request writes
 * nothing. There is deliberately no "trust it if it looks like MoonPay"
 * fallback and no way to disable verification, because the failure mode is
 * an attacker writing arbitrary order rows that the UI then shows to users
 * as confirmed purchases.
 *
 * Scheme, per dev.moonpay.com/reference/reference-webhooks-signature:
 *   header  Moonpay-Signature-V2: t=<unix seconds>,s=<hex>
 *   signed  `${t}.${rawRequestBody}`
 *   hmac    HMAC-SHA256 with the ACCOUNT WEBHOOK KEY (wk_test_/wk_live_),
 *           which is a different secret from MOONPAY_SECRET_KEY (sk_*) used
 *           for URL signing — do not collapse the two.
 */

export const MOONPAY_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type MoonPayOrderDirection = "buy" | "sell" | "unknown";

export type MoonPayOrderRecord = {
  orderId: string;
  walletAddress: string | null;
  direction: MoonPayOrderDirection;
  status: string;
  baseCurrencyCode: string | null;
  baseCurrencyAmount: number | null;
  quoteCurrencyCode: string | null;
  quoteCurrencyAmount: number | null;
  lastEventAt: string;
};

export function isMoonPayWebhookConfigured(): boolean {
  return Boolean(process.env.MOONPAY_WEBHOOK_KEY);
}

export type SignatureVerdict =
  | { ok: true; signedAtSeconds: number }
  | { ok: false; error: "NOT_CONFIGURED" | "MALFORMED_HEADER" | "STALE" | "BAD_SIGNATURE" };

/**
 * Verify a MoonPay webhook signature over the RAW request body.
 *
 * Must be the raw bytes as received: JSON.parse + re-stringify reorders keys
 * and changes whitespace, and the HMAC is over the exact string MoonPay
 * hashed. This is why the route reads req.text() and parses afterwards
 * rather than using lib/security.ts's readJsonBody.
 */
export function verifyMoonPayWebhookSignature(
  header: string | null,
  rawBody: string,
  options?: { now?: number; toleranceSeconds?: number }
): SignatureVerdict {
  const webhookKey = process.env.MOONPAY_WEBHOOK_KEY;
  if (!webhookKey) return { ok: false, error: "NOT_CONFIGURED" };
  if (!header) return { ok: false, error: "MALFORMED_HEADER" };

  let timestamp: string | null = null;
  let signature: string | null = null;
  for (const part of header.split(",")) {
    const [key, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (key === "t") timestamp = value;
    if (key === "s") signature = value;
  }
  if (!timestamp || !signature || !/^\d+$/.test(timestamp) || !/^[0-9a-f]+$/i.test(signature)) {
    return { ok: false, error: "MALFORMED_HEADER" };
  }

  // Replay protection. Without this a captured-and-replayed webhook stays
  // valid forever, because the signature over a fixed body never expires.
  const nowSeconds = Math.floor((options?.now ?? Date.now()) / 1000);
  const tolerance = options?.toleranceSeconds ?? MOONPAY_WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - Number(timestamp)) > tolerance) {
    return { ok: false, error: "STALE" };
  }

  const expected = crypto
    .createHmac("sha256", webhookKey)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  // Length-check first: timingSafeEqual throws on a length mismatch, and an
  // attacker controls the length of what they send.
  const provided = signature.toLowerCase();
  if (provided.length !== expected.length) return { ok: false, error: "BAD_SIGNATURE" };
  const equal = crypto.timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  return equal
    ? { ok: true, signedAtSeconds: Number(timestamp) }
    : { ok: false, error: "BAD_SIGNATURE" };
}

/**
 * When the event actually happened, for the monotonic ordering guard.
 *
 * MUST NOT be server receive-time. Webhooks are retried, and a retry is
 * re-signed with a fresh header timestamp — so both "now" and the signature
 * time move forward on every redelivery, which would let a redelivered
 * "pending" overwrite a "completed" that landed in between. MoonPay's own
 * updatedAt/createdAt on the transaction is the only value that is stable
 * per event across retries. The signature time is the fallback when the
 * payload carries neither, and it is still better than now() because it at
 * least predates our processing.
 */
export function resolveEventAt(body: unknown, signedAtSeconds: number, now = Date.now()): Date {
  const data =
    body && typeof body === "object"
      ? ((body as Record<string, unknown>).data as Record<string, unknown> | undefined) ??
        (body as Record<string, unknown>)
      : undefined;

  for (const key of ["updatedAt", "createdAt"]) {
    const candidate = data?.[key];
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return new Date(parsed);
    }
  }
  if (Number.isFinite(signedAtSeconds) && signedAtSeconds > 0) {
    return new Date(signedAtSeconds * 1000);
  }
  return new Date(now);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/**
 * Pull the fields we store out of a webhook body, tolerating absence.
 *
 * Deliberately defensive: this integration cannot be exercised end-to-end
 * without a real card and real KYC, so treating any particular field as
 * guaranteed would mean a payload shape we never saw in testing throws
 * inside the handler and MoonPay retries it forever. Anything unrecognised
 * still lands in `payload` verbatim.
 */
export function parseMoonPayWebhook(body: unknown): {
  orderId: string | null;
  eventType: string | null;
  record: Omit<MoonPayOrderRecord, "lastEventAt"> | null;
} {
  if (!body || typeof body !== "object") return { orderId: null, eventType: null, record: null };
  const envelope = body as Record<string, unknown>;
  const eventType = asString(envelope.type);
  const data =
    envelope.data && typeof envelope.data === "object"
      ? (envelope.data as Record<string, unknown>)
      : envelope;

  const orderId = asString(data.id);
  if (!orderId) return { orderId: null, eventType, record: null };

  // externalCustomerId is what we set when building the URL (the destination
  // wallet). Falling back to the payload's own walletAddress covers an order
  // started outside our widget — which is itself worth recording, since that
  // is what use of our merchant key elsewhere looks like.
  const wallet = asString(data.externalCustomerId) ?? asString(data.walletAddress);

  // MoonPay uses separate transaction types for the two directions; the sell
  // flow's own field is baseCurrency (crypto in) vs buy's quoteCurrency
  // (crypto out). Infer conservatively and store "unknown" rather than guess.
  let direction: MoonPayOrderDirection = "unknown";
  if (eventType?.includes("sell")) direction = "sell";
  else if (eventType?.includes("transaction") || eventType?.includes("buy")) direction = "buy";

  return {
    orderId,
    eventType,
    record: {
      orderId,
      walletAddress: wallet ? wallet.toLowerCase() : null,
      direction,
      status: asString(data.status) ?? "unknown",
      baseCurrencyCode: asString(data.baseCurrencyCode),
      baseCurrencyAmount: asNumber(data.baseCurrencyAmount),
      quoteCurrencyCode: asString(data.quoteCurrencyCode),
      quoteCurrencyAmount: asNumber(data.quoteCurrencyAmount),
    },
  };
}

/**
 * Record a verified webhook event, idempotently and monotonically.
 *
 * Webhooks are retried and are NOT ordered — a retried "pending" can arrive
 * after "completed". The `last_event_at` guard in the WHERE clause of the
 * upsert's DO UPDATE means a late or duplicate event is a no-op instead of
 * walking a finished order backwards into a pending state the user then sees.
 */
export async function recordOrderEvent(
  record: Omit<MoonPayOrderRecord, "lastEventAt">,
  eventType: string | null,
  payload: unknown,
  eventAt: Date
): Promise<void> {
  await postgresQuery(
    `INSERT INTO moonpay_orders (
       order_id, wallet_address, direction, status,
       base_currency_code, base_currency_amount,
       quote_currency_code, quote_currency_amount,
       event_type, payload, last_event_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (order_id) DO UPDATE SET
       wallet_address        = COALESCE(EXCLUDED.wallet_address, moonpay_orders.wallet_address),
       direction             = CASE WHEN EXCLUDED.direction = 'unknown'
                                    THEN moonpay_orders.direction ELSE EXCLUDED.direction END,
       status                = EXCLUDED.status,
       base_currency_code    = COALESCE(EXCLUDED.base_currency_code, moonpay_orders.base_currency_code),
       base_currency_amount  = COALESCE(EXCLUDED.base_currency_amount, moonpay_orders.base_currency_amount),
       quote_currency_code   = COALESCE(EXCLUDED.quote_currency_code, moonpay_orders.quote_currency_code),
       quote_currency_amount = COALESCE(EXCLUDED.quote_currency_amount, moonpay_orders.quote_currency_amount),
       event_type            = EXCLUDED.event_type,
       payload               = EXCLUDED.payload,
       last_event_at         = EXCLUDED.last_event_at,
       updated_at            = NOW()
     WHERE EXCLUDED.last_event_at >= moonpay_orders.last_event_at`,
    [
      record.orderId,
      record.walletAddress,
      record.direction,
      record.status,
      record.baseCurrencyCode,
      record.baseCurrencyAmount,
      record.quoteCurrencyCode,
      record.quoteCurrencyAmount,
      eventType,
      JSON.stringify(payload ?? null),
      eventAt.toISOString(),
    ]
  );
}

/** Recent orders for one wallet — the panel's post-checkout status line. */
export async function getOrdersForWallet(
  walletAddress: string,
  opts?: { limit?: number }
): Promise<MoonPayOrderRecord[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 5, 25));
  const result = await postgresQuery<{
    order_id: string;
    wallet_address: string | null;
    direction: string;
    status: string;
    base_currency_code: string | null;
    base_currency_amount: string | null;
    quote_currency_code: string | null;
    quote_currency_amount: string | null;
    last_event_at: Date;
  }>(
    `SELECT order_id, wallet_address, direction, status,
            base_currency_code, base_currency_amount,
            quote_currency_code, quote_currency_amount, last_event_at
       FROM moonpay_orders
      WHERE wallet_address = $1
      ORDER BY last_event_at DESC
      LIMIT $2`,
    [walletAddress.toLowerCase(), limit]
  );

  return result.rows.map((row) => ({
    orderId: row.order_id,
    walletAddress: row.wallet_address,
    direction: (row.direction as MoonPayOrderDirection) ?? "unknown",
    status: row.status,
    baseCurrencyCode: row.base_currency_code,
    baseCurrencyAmount: row.base_currency_amount === null ? null : Number(row.base_currency_amount),
    quoteCurrencyCode: row.quote_currency_code,
    quoteCurrencyAmount:
      row.quote_currency_amount === null ? null : Number(row.quote_currency_amount),
    lastEventAt: new Date(row.last_event_at).toISOString(),
  }));
}
