# Architecture

This document describes the runtime and release architecture of the canonical
`inmotion` branch. It separates data that belongs in PostgreSQL from data that
is authoritative on Robinhood Chain.

## System view

```text
Users and wallets
      |
      v
Cloudflare DNS / proxy / WAF
      |
      v
InMotion Apache + Passenger
      |
      +-- Next.js standalone application
      |     +-- pages and browser bundles
      |     +-- market order-relay API
      |     +-- Uniswap quote/swap API
      |     +-- RPC and IPFS proxy routes
      |     +-- health and public read APIs
      |
      +-- PostgreSQL on localhost
      |     +-- signed Seaport orders
      |     +-- durable KV compatibility tables
      |     +-- snapshots and attribution
      |     +-- Boards state
      |
      +-- cPanel cron
            +-- bundled drand relayer
            +-- cron-only gas wallet
            +-- structured status log

GitHub Actions
      |
      +-- tests and builds on every PR to inmotion
      +-- immutable SHA releases on pushes to inmotion
      +-- SSH upload, migrations, activation, health, rollback
      +-- manual migration and relayer operations

Robinhood Chain
      |
      +-- $PLANK and RobinWood NFT
      +-- canonical Seaport 1.6
      +-- Marketplank V1 and V2 vaults
      +-- DrandBeacon
```

## Runtime responsibilities

### Cloudflare

Cloudflare supplies DNS, TLS proxying, caching controls, and WAF features. It
does not own the durable marketplace store or run the Passenger application.
A Cloudflare Tunnel is not required for the current shared-hosting model
because cPanel already exposes Apache/Passenger through the account's public
origin.

During the domain cutover, `plank.tanggang.life` remains the verified InMotion
origin while `plank.love` still points at the earlier Cloudflare Worker. The
cutover order is documented in
[INMOTION_DEPLOYMENT.md](docs/INMOTION_DEPLOYMENT.md).

### Passenger application

Passenger starts `passenger.js`, which is installed from
`deploy/inmotion/passenger.cjs`. The launcher:

1. resolves the immutable release behind the `current` symlink;
2. loads `shared/.env.production`;
3. loads the separately installed Uniswap API key when cPanel has not supplied
   one;
4. sets the deployment version from the release SHA; and
5. runs Next.js' generated standalone `server.js`.

Passenger owns the port and process lifecycle. The repository does not run
PM2, Redis, Docker, or a custom reverse proxy on InMotion.

### PostgreSQL

The production selector is `DURABLE_KV_BACKEND=postgres`. PostgreSQL provides
one shared durable store across Passenger workers.

| Table | Responsibility |
| --- | --- |
| `plank_schema_migrations` | Applied forward-only migration filenames. |
| `market_orders` | Indexed signed listings and offers with expiry. |
| `plank_kv_values` | JSON values and optional TTLs. |
| `plank_kv_hash_fields` | Redis-hash-compatible fields. |
| `plank_kv_set_members` | Redis-set-compatible members. |
| `served_order_hashes` | Orders attributed to this interface. |
| `boards_state` | Transactional singleton Boards state. |

PostgreSQL is not a matching engine, signing service, wallet, or custody layer.
The server verifies and indexes maker-signed Seaport orders. Settlement occurs
against Seaport on-chain.

Rarity and vault-activity snapshots are last-known-good data and intentionally
survive normal cache expiry. Daily maintenance deletes expired cache values and
expired orders.

### On-chain state

The following remain authoritative on Robinhood Chain and are not migrated
from Upstash:

- NFT ownership and transfers;
- vault-held token IDs and reserves;
- share balances and total supply;
- pending redemption state;
- drand rounds accepted by the beacon;
- Seaport order cancellation and fulfillment status;
- transaction receipts and emitted events.

Application APIs may cache or index this information for speed. A cache is not
proof of ownership or settlement.

### Durable KV adapters

`lib/market/durable-kv.ts` exposes the small KV surface used by marketplace
consumers:

- PostgreSQL for InMotion production;
- Redis or Valkey for a conventional VPS;
- Upstash REST for legacy deployments and migration input.

If no backend is configured, orders fall back to `.data/market-orders.json`
and process memory. That path is for local development only.

### Random-redemption relayer

Random redemption requests target an exact future drand round. The relayer:

1. reads both V1 and V2 vault states;
2. waits when a requested round is not yet available;
3. fetches and validates the exact drand round;
4. submits or reuses the beacon round;
5. pins and claims the request when actionable; and
6. records structured status and gas information.

Contract submission and settlement are permissionless. The dedicated wallet
holds gas only and has no custody or administrative authority.

The production artifact lives under the stable release symlink:

```text
current/ops/drand-relayer/relay-drand.mjs
```

The key lives outside Passenger:

```text
shared/runtime-secrets/relayer.env
```

The cPanel cron is the intended production scheduler. The GitHub scheduled
workflow remains a temporary fallback until the 24-hour InMotion verification
job disables it.

## Request and trade flows

### Seaport listing

```text
Seller builds order in browser
  -> wallet signs EIP-712 order
  -> API verifies signature and order fields
  -> PostgreSQL stores signed payload
  -> buyers fetch live order
  -> buyer browser re-validates payload
  -> wallet fulfills against Seaport
  -> chain state becomes authoritative
```

The server cannot forge a valid maker signature. It can affect availability,
so relay integrity and liveness still matter.

### Instant Swap

Vault reads and transactions go directly to the configured V2 or legacy V1
contract. PostgreSQL caches expensive inventory, rarity, activity, and sales
reads, but contract storage and receipts decide the result.

### Uniswap trade widget

Browser requests go to server routes. The server injects
`UNISWAP_API_KEY`; the key never enters a public bundle or response. Wallet
transaction simulation, chain checks, destination allowlists, and approval
scope are enforced before send.

## Release architecture

```text
PR -> inmotion
      |
      v
lint + typecheck + migrations + tests + build + relayer bundle
      |
      v
push to inmotion
      |
      v
passenger-<SHA>.tgz
      |
      v
SSH upload -> releases/<SHA> -> database migrations
      |
      v
atomic current symlink -> Passenger restart
      |
      v
/api/health + trade status + /market
      |
      +-- pass: keep SHA active
      +-- fail: restore previous application symlink
```

The health endpoint must report:

- `ok: true`;
- `storage: "postgres"`; and
- the expected commit SHA as `version`.

An application rollback does not reverse a PostgreSQL migration. Migrations
must therefore be backward-compatible with the immediately previous release.

## Secret boundaries

| Secret | Storage | Consumer |
| --- | --- | --- |
| PostgreSQL password | `shared/.env.production`, mode `600` | Passenger and maintenance scripts |
| Uniswap API key | GitHub Actions secret, installed mode `600` | Passenger launcher |
| Relayer private key | GitHub Actions secret, provisioned once to `relayer.env` | cPanel cron only |
| Deployment SSH key | GitHub Actions secret | CI SSH/SCP only |
| Upstash read token | Temporary migration input | Manual inventory/cutover job only |

`NEXT_PUBLIC_*` values are not secrets. They are embedded during the build and
must be assumed readable by every visitor.

## Design constraints

- `inmotion` is the branch of record. `master` is not a deployment source.
- Production writes require a durable backend.
- Schema migrations are append-only and forward-only.
- Release directories are immutable after activation.
- Vault contract and deployment-address changes require a separate security
  review and are outside routine application releases.
- Private keys must never be printed, committed, placed in Passenger's env, or
  included in release archives.
