# Bitcoin source health repair

Live production diagnostics on 2026-09-09 identified the screenshot warnings:

- `adapter-sync:bitcoin-mainnet` had recovered and recorded a real success.
- `opensea-stats:bitcoin-mainnet` remained in historical lane health despite no
  longer being a registered Bitcoin source. The banner treated it as an outage.
- Ordiscan discovery had retried 227 times and reported its local daily ceiling.
  The current public free plan is 1,000 requests/month and 100/minute:
  https://ordiscan.com/docs/api . The shared background budget is now 32/day
  (at most 992 in a 31-day month), used by both catalog and snapshot readers.

A typed capacity result now defers Ordiscan discovery until the shared UTC window
resets. Standing scheduler maintenance preserves that deadline and existing
failure cooldowns. Deferred lanes retain their last real success timestamp and
use the existing paused state. The banner distinguishes capacity waits from
failures and ignores historical sources absent from the current source matrix.

Targeted PostgreSQL tests exercise the actual exhausted-budget lane without HTTP,
prove that standing re-enqueue cannot undo a deferral, prove work becomes eligible
after its deadline, and verify that waits do not fabricate successful refreshes.

The missing 24-hour cells are not all failures. Live Ordinals Wallet responses for
bitcoin-frogs, sub-10k, metaconstructs, and bitcoinpunks reported `volume_day: null`.
Their `sales` field is cumulative, so it cannot be relabelled as 24-hour sales.
Existing CoinGecko/BestInSlot feeds and indexed settlement history supply windows
where available. Unknown values remain unknown; no new numbers are synthesized.
