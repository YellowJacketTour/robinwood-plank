# Architecture

This document describes the runtime and release architecture of the
deployment branch, `master`. It separates data that belongs in PostgreSQL from data that
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
      +-- tests and builds on every PR to dev or master
      +-- immutable SHA releases on pushes to master
      +-- SSH upload, migrations, activation, health, rollback
      +-- manual migration and relayer operations

Robinhood Chain
      |
      +-- $PLANK and RobinWood NFT
      +-- canonical Seaport 1.6
      +-- Marketplank vaults (V1, V2 retired-in-place, V3 primary)
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

The following remain authoritative on Robinhood Chain and are never stored in
PostgreSQL as a source of truth:

- NFT ownership and transfers;
- vault-held token IDs and reserves;
- share balances and total supply;
- pending redemption state;
- drand rounds accepted by the beacon;
- Seaport order cancellation and fulfillment status;
- transaction receipts and emitted events.

Application APIs may cache or index this information for speed. A cache is not
proof of ownership or settlement.

### RPC provider chain

`lib/server/rpc-urls.ts` builds the ordered RPC list used by every
server-side chain read: the private `RPC_URL` provider (e.g. a keyed Alchemy
endpoint) first, then the public Robinhood Chain fallbacks from
`ROBINHOOD_RPC_URLS`. The public endpoint is rate-limited and not
recommended for production, which was the source of intermittent 502/429s
during order verification.

Consumers are the `/api/rpc` proxy, the vault `fetch-rpc` path, and the
order-signature verifier, which walks every provider in the list on each
retry pass instead of hammering a single URL. `RPC_URL` is never
`NEXT_PUBLIC_`, so it cannot reach the browser; clients only ever call the
same-origin `/api/rpc` proxy, and the separate client-shared
`ROBINHOOD_RPC_URLS` list is unaffected.

### Durable KV adapters

`lib/market/durable-kv.ts` exposes the small KV-shaped surface used by
marketplace consumers. **PostgreSQL is the only datastore** — every environment
sets `DURABLE_KV_BACKEND=postgres`.

The module still contains Redis and Upstash branches inherited from the
pre-PostgreSQL design. They are dead: unconfigured, unused, and slated for
removal. Do not write new code against them, and do not reintroduce
`KV_REST_API_*`, `@vercel/kv`, or `REDIS_URL`. See §11 of the InMotion
deployment runbook for how the cutover was performed.

If no backend is configured, orders fall back to `.data/market-orders.json`
and process memory. That path is for local development only.

### Vault generations and the N-vault registry

Marketplank is not a single vault, and it is not a hardcoded V1/V2 pair. It is a
registry of *N* vaults resolved by address:

| Generation | Product name | Fee model | Role |
| --- | --- | --- | --- |
| V1 | Driftwood | Share-denominated | Legacy — redeem only |
| V2 | WormWood | Share-denominated | Legacy — **withdraw and leave** |
| V3 | Premium Plank Liquidity | ETH-denominated | Primary — deposit, trade, LP |

`lib/market/vault-registry.ts` is the single resolution point. Two rules follow
from it and are load-bearing:

- **Selection is by address, not by role.** With more than one legacy, "the
  legacy vault" is ambiguous. `getVaultByAddress()` is the primitive;
  `getVaultByRole()` exists only for back-compat.
- **Generation is derived from the address**, by comparing against the two known
  production deployments (`MARKET_VAULT_V1_KNOWN`, `MARKET_VAULT_V2_KNOWN`).
  Anything else configured is current-generation. This is what let the client
  stop grepping deployed bytecode for function selectors.

Version numbers are internal identity and are never rendered. Users see the
product names above, because a `V1 → V2 → V3` ladder reads to a holder as "two
prior mistakes" rather than three distinct pools.

A legacy vault must stay configured in
`NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESSES` until its `heldTokenCount` reaches
zero. Removing it early makes the client reject the address as an unsafe target
and strands every remaining depositor.

### Why V3 exists

V2's only addition over V1 — `contributeLiquidity` / `removeLiquidity` with
*absolute* LP credits — carries a critical, externally exploitable flaw in its
LP accounting. It is not mitigable by fee level or by `nonReentrant`, which is
why V2 accepts no new liquidity and why nobody is migrated into it. The audit
that establishes this, and the executable proof, are held privately and are
deliberately not in this repository.

`contracts/MarketplankVaultV3.sol` closes it and fixes the fee model, keeping the
drand commit-reveal random-redeem machinery unchanged:

- **Proportional LP.** `addLiquidity` is ETH-driven and pulls matching shares at
  the current ratio; there is no one-sided contribution primitive.
  `removeLiquidity` pays pro-rata of *current* reserves, so a contributor absorbs
  any price move they cause. LP bookkeeping is internal and non-transferable.
- **Explicit `shareReserve` / `ethReserve`,** not live balances. A raw transfer
  into the vault is inert dead capital, which closes donation-inflation. There is
  no `receive()`.
- **ETH-denominated flat fees.** Deposit mints exactly `1e18`; redeem burns
  exactly `1e18`. This ends the V1/V2 `0.99` / `1.01` dust trap where a lone
  deposit could never fund its own redeem. Fees accrue to a counter drained by a
  permissionless `withdrawFees()` that can only pay the immutable treasury — a
  reverting treasury bricks that one call, never deposits or the redeem slot.
- **Seed lock.** `openPool()` mints `sqrt(E*S)` LP to `address(0)` permanently,
  so reserves stay strictly positive and removal can never brick the pool.
- **Fee ceilings are enforced in wei at construction**, so a predatory-fee
  deployment is impossible rather than merely unintended.
- No oracle, no external AMM, no owner-mutable fees, no upgradeability, no admin
  withdrawal of pool ETH, no pause.

Two invariants are asserted after every relevant call:

```text
solvency:    totalSupply() + pendingRedeemCount * SHARE_UNIT
                 == heldTokenIds.length * SHARE_UNIT
ETH backing: address(this).balance >= ethReserve + accruedFees
```

`capabilities()` and `poolComposition()` views plus a `VAULT_VERSION` marker
exist so the client reads capability from the contract instead of sniffing it.

### Migration out of the legacy vaults

`lib/market/migration.ts` is a pure planner — no chain calls, no React — so the
economics are unit-testable. Given a wallet's position across the legacy vaults
it computes, per source and ordered newest-first (V2 before V1, since V2 carries
the live drain exposure):

1. whether a V2 LP position must be withdrawn first, and whether current pool
   reserves can actually cover that withdrawal;
2. LP credit the pool *cannot* cover yet, surfaced separately as stuck rather
   than folded into the redeemable total — folding it in produced a redeem that
   always reverted with no withdraw step offered, an inescapable loop;
3. how many NFTs the spendable share balance can redeem; and
4. leftover dust below one redeem's worth.

Migration is defined as *exiting* V1/V2. Depositing the recovered NFTs into V3 is
optional and user-selected, not forced. The user-facing flow is `app/migrate`,
with a site-wide banner driven by `lib/market/useLegacyPosition.ts`.

### Random-redemption relayer

Random redemption requests target an exact future drand round. The relayer:

1. reads every configured vault's state;
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

Vault reads and transactions go directly to whichever configured vault the user
selected, resolved by address through the registry above. Browser reads route
through the same-origin `/api/rpc` proxy, including reads of legacy vaults.
PostgreSQL caches expensive inventory, rarity, activity, and sales reads, but
contract storage and receipts decide the result.

On the primary (V3) vault the surface is: deposit an NFT for exactly one share,
trade shares against ETH on the constant-product pool at a 30 bps swap fee,
provide liquidity for a proportional claim, and redeem a share for an NFT —
targeted for an ETH premium, or random via drand commit-reveal. `depositMany` and
`redeemTargetMany` batch up to `MAX_BATCH` per transaction.

### Uniswap trade widget

Browser requests go to server routes. The server injects
`UNISWAP_API_KEY`; the key never enters a public bundle or response. Wallet
transaction simulation, chain checks, destination allowlists, and approval
scope are enforced before send.

## Release architecture

```text
PR -> dev
      |
      v
lint + typecheck + migrations + tests + build + relayer bundle
      |
      v
merge dev -> master
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
| `RPC_URL` (private RPC provider) | `shared/.env.production`, mode `600`; not `NEXT_PUBLIC_` | `/api/rpc` proxy, vault `fetch-rpc`, order-signature verifier |
| Uniswap API key | GitHub Actions secret, installed mode `600` | Passenger launcher |
| Relayer private key | GitHub Actions secret, provisioned once to `relayer.env` | cPanel cron only |
| Deployment SSH key | GitHub Actions secret | CI SSH/SCP only |

`NEXT_PUBLIC_*` values are not secrets. They are embedded during the build and
must be assumed readable by every visitor.

## Design constraints

- `master` is the deployment source and the branch of record. `dev` is where
  work lands before a release.
- Production writes require a durable backend.
- Schema migrations are append-only and forward-only.
- Release directories are immutable after activation.
- Vault contract and deployment-address changes require a separate security
  review and are outside routine application releases. Vault deployment runs
  through its own workflow (`.github/workflows/deploy-vault-v3.yml`) and the
  [V3 deploy runbook](docs/marketplank/DEPLOY-V3-RUNBOOK.md), not the InMotion
  application pipeline.
- A legacy vault stays configured until it holds zero tokens. Vault
  configuration is append-and-retire, not replace.
- No user may be migrated into V2. It is drainable by design and exists in the
  registry only so existing depositors can get out.
- Private keys must never be printed, committed, placed in Passenger's env, or
  included in release archives.
