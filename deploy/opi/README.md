# OPI canonical Bitcoin substrate

Marketplank uses OPI as a self-hosted, Apache-2.0 canonical inscription and
metaprotocol substrate. OPI is not a marketplace and must never be counted as
proof of a listing, bid, or sale; those remain separate ORD.NET, UniSat,
Ordinals Wallet, and historical venue lanes.

## Pinned upstream

- Repository: `https://github.com/bestinslot-xyz/OPI.git`
- Audited commit: `0a09b987c87692ec3cabd404c8bcc7367707ee9a`
- License: Apache-2.0
- Required substrate: fully synchronized Bitcoin Core with transaction index,
  OPI's fork of `ord`, PostgreSQL, Rust, Python, and Node runtimes.

Clone the audited source outside this application checkout:

```powershell
git clone https://github.com/bestinslot-xyz/OPI.git C:\services\marketplank-opi
git -C C:\services\marketplank-opi checkout 0a09b987c87692ec3cabd404c8bcc7367707ee9a
```

Follow upstream `INSTALL.ubuntu.md`; do not copy its databases into the web
application container. Bind APIs to loopback/private networking and expose
them through an authenticated Marketplank ingestion worker.

## Lossless provenance requirement

Upstream defaults `INDEX_TX_LIMIT` to retain only the first two transfers.
That is sufficient for several metaprotocol validity checks but is explicitly
insufficient for Marketplank's complete provenance objective. A production
deployment must set and capacity-test a retention policy that preserves every
transfer needed by the canonical ledger. Until the OPI node has reported
genesis-to-tip continuity and reorg replay tests pass, its registry coverage
must remain `planned`, never silently promoted to complete.

The OPI block and cumulative hashes should be recorded as evidence checkpoints
alongside the application cursor. Keep `REPORT_TO_INDEXER=false` unless the
operator intentionally opts into upstream telemetry.

## Environment contract

The future ingestion worker consumes private URLs rather than public upstream
services:

```text
OPI_BRC20_API_URL=http://127.0.0.1:8001
OPI_BITMAP_API_URL=http://127.0.0.1:8001
OPI_SNS_API_URL=http://127.0.0.1:8002
OPI_RUNES_API_URL=http://127.0.0.1:8003
```

Port overlap in upstream defaults means modules must be placed on distinct
hosts or assigned explicit `API_PORT` values. Health, indexed height,
cumulative hash, and Bitcoin Core tip must all agree before a lane is healthy.

## ORD.NET complement

Set `ORDNET_SESSION_TOKEN` to a server-only bearer token issued by ORD.NET's
wallet challenge flow, and optionally `ORDNET_COLLECTION_SLUG_MAP` to a JSON
map from Marketplank canonical collection keys to ORD.NET slugs. The live
listing route then adds ORD.NET to the Bitcoin book without replacing the
other venues. Session creation requires the wallet/payment conditions in the
official ORD.NET documentation and cannot be fabricated by deployment code.
