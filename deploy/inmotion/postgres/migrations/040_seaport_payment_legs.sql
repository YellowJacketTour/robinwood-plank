-- Preserve every currency used by a Seaport fulfillment. A single order may
-- pay seller, royalties, and fees in more than one token; raw atomic amounts
-- with different decimals are never arithmetically comparable.
ALTER TABLE plank_seaport_fills
  ADD COLUMN IF NOT EXISTS payment_legs JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN plank_seaport_fills.payment_legs IS
  'All paying-side currencies as [{token:null|address,amountAtomic:string}]. Token metadata and USD valuation are resolved separately and must fail closed.';
