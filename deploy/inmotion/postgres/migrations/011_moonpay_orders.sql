-- MoonPay fiat on/off-ramp order tracking (lib/moonpay-orders.ts,
-- app/api/moonpay/webhook/route.ts).
--
-- WHY THIS EXISTS
-- ---------------
-- The ramp shipped as a one-way door: we built a signed checkout URL, the
-- buyer left for MoonPay's hosted flow, and nothing ever came back. No
-- confirmation in the app, nothing to point at when someone asks where their
-- money went, and no way to see our merchant key being used to drive volume
-- we did not originate. This table is the return path.
--
-- NUMBERED 011, NOT 010
-- ---------------------
-- 010_referral_attribution.sql is claimed by an open PR. Migrations are
-- append-only and applied in filename order, so two branches landing the same
-- number is a merge conflict at deploy time, not at review time. Skipping to
-- 011 keeps both landable in either order.
--
-- SAFE AGAINST THE PREVIOUS RELEASE
-- ---------------------------------
-- Purely additive: a build that has never heard of this table simply never
-- queries it, and the ramp itself stays behind NEXT_PUBLIC_MOONPAY_ENABLED.

CREATE TABLE IF NOT EXISTS moonpay_orders (
  -- MoonPay's own transaction id. Natural primary key: webhooks are retried
  -- and can arrive more than once for the same transaction, so every write
  -- is an upsert keyed on this rather than an append.
  order_id              TEXT PRIMARY KEY,

  -- Lowercased wallet the order belongs to. Sourced from the webhook payload
  -- (externalCustomerId, which we set to the destination wallet when building
  -- the URL), never from a client request.
  wallet_address        TEXT,

  direction             TEXT NOT NULL DEFAULT 'unknown',
  status                TEXT NOT NULL,

  base_currency_code    TEXT,
  base_currency_amount  NUMERIC,
  quote_currency_code   TEXT,
  quote_currency_amount NUMERIC,

  -- The event type MoonPay sent, and the full payload it sent it in. Stored
  -- verbatim because this integration cannot be tested end-to-end without
  -- real card + KYC: when a live order behaves unexpectedly, the raw event is
  -- the only forensic record, and no amount of column design anticipates a
  -- field MoonPay adds later.
  event_type            TEXT,
  payload               JSONB NOT NULL,

  -- Webhook-supplied event time, used to reject OUT-OF-ORDER delivery.
  -- Webhooks are not ordered: a retried "pending" can land after "completed"
  -- and would otherwise walk a finished order backwards. Every update is
  -- guarded on this advancing (see lib/moonpay-orders.ts's recordOrderEvent).
  last_event_at         TIMESTAMPTZ NOT NULL,

  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "What are this wallet's orders" — the only read the app performs, for the
-- panel's post-checkout status line. Newest first.
CREATE INDEX IF NOT EXISTS moonpay_orders_wallet_idx
  ON moonpay_orders (wallet_address, last_event_at DESC);

-- "What has been happening lately" — operator-facing: an unexplained rise in
-- orders we did not originate is what merchant-key abuse looks like, and
-- without an index this becomes a full scan on the only table that could
-- show it.
CREATE INDEX IF NOT EXISTS moonpay_orders_recent_idx
  ON moonpay_orders (last_event_at DESC);
