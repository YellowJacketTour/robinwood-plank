# RobinWood ($PLANK)

[![InMotion Passenger CI/CD](https://github.com/YellowJacketTour/robinwood-plank/actions/workflows/inmotion.yml/badge.svg?branch=master)](https://github.com/YellowJacketTour/robinwood-plank/actions/workflows/inmotion.yml)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

The official RobinWood NFT collection and `$PLANK` application for
[Robinhood Chain](https://robinhoodchain.blockscout.com/) (chain ID `4663`).
It includes the collection site, mint and launch surfaces, a Uniswap-routed
trade widget, and Marketplank, a Seaport marketplace with a multi-vault Instant
Swap experience.

> [!IMPORTANT]
> `master` is the deployment branch — a push to it builds and deploys the
> InMotion application. `dev` is the working branch: open pull requests
> against `dev`, and merge `dev` into `master` to ship.

## What is in this repository

- Next.js 16 App Router, React 19, TypeScript, and Tailwind CSS 4.
- Uniswap-routed `$PLANK` quotes and swaps with a server-held API key.
- Seaport 1.6 listings, offers, cancellations, and fulfillment.
- PostgreSQL-backed signed-order storage and shared marketplace caches.
- An N-vault Marketplank registry (V1/V2 legacy, V3 primary) with drand-backed
  random redemption and a guided migration flow out of the legacy vaults.
- `MarketplankVaultV3`: proportional non-transferable LP, explicit reserves,
  ETH-denominated flat fees, and a 30 bps constant-product swap fee.
- A standalone drand relayer run by cPanel cron with a dedicated gas-only key.
- Docker Compose for local production-parity testing.
- GitHub Actions build, test, migration, immutable release, health check,
  rollback, data-cutover, and relayer-provisioning jobs.

## Current hosting model

```text
Cloudflare DNS / proxy / WAF
              |
              v
InMotion cPanel Apache + Passenger
              |
              +-- Next.js standalone server on Node.js 22
              +-- local PostgreSQL
              +-- cPanel cron -> standalone drand relayer
```

The InMotion application currently runs at
[`plank.tanggang.life`](https://plank.tanggang.life). `plank.love` is the
canonical product domain, but its final DNS/Worker cutover must be completed
and verified before GitHub build and health-check variables are changed.

Cloudflare is the public edge, not the application runtime. The production
application, persistent marketplace data, and scheduled relayer run on the
InMotion account. PostgreSQL is the only datastore; there is no KV, Upstash, or
Redis service.

See [Architecture](ARCHITECTURE.md) for the data and trust boundaries,
[Architecture Map](docs/ARCHITECTURE_MAP.md) for a diagrammed inventory of
wallet state, trading data flow, routes, and feature flags, and
[InMotion deployment](docs/INMOTION_DEPLOYMENT.md) for the operator runbook.

## Quick start

### Production-parity Docker environment

Docker Compose is the preferred local path because it exercises the same
PostgreSQL backend and migration sequence as Passenger.

```powershell
Copy-Item .env.docker.example .env.docker.local
# Set a unique local POSTGRES_PASSWORD in .env.docker.local.

docker compose --env-file .env.docker.local `
  -f docker-compose.inmotion.yml up -d --build

curl.exe --fail http://127.0.0.1:3000/api/health
```

Open [http://localhost:3000](http://localhost:3000). Stop the stack without
deleting its PostgreSQL volume:

```powershell
docker compose --env-file .env.docker.local `
  -f docker-compose.inmotion.yml down
```

### Native development

Use Node.js `22.22.3` and npm `11.6.2` to match CI.

```bash
npm ci
npm run dev
```

Native development can run without a durable backend, but the file and memory
fallback is local-only. Use Docker or configure PostgreSQL before testing
concurrency, persistence, Passenger restarts, or market-data migrations.

### Local vault harness

To exercise Instant Swap, liquidity, and the `/migrate` flow end-to-end without
touching mainnet, deploy the whole stack — mock NFT, mock drand beacon, V3 with a
real seeded pool, plus mock V1 and V2 so migration has something to migrate — to
a local Hardhat node:

```bash
npx hardhat node                                              # terminal 1
npx hardhat run scripts/local-v3-setup.ts --network localhost # terminal 2
```

Paste the printed `.env.local` block, restart `npm run dev`, add the Localhost
network to your wallet (`http://127.0.0.1:8545`, chain ID `31337`), and import a
printed test key. To add fresh positions later without redeploying — so your
`.env.local` addresses and wallet state survive:

```bash
PLAYER_ADDRESS=0xYourWallet npx hardhat run scripts/local-topup.ts --network localhost
```

These scripts are local-only and must never be pointed at real value.

## Validation commands

```bash
npm run lint:inmotion  # deployment-critical lint scope
npx tsc --noEmit       # TypeScript
npm run test:market    # marketplace, storage, wallet, and relayer tests
npm run test:contracts # Hardhat vault and drand tests
npm test               # both test suites
npm run build          # production standalone build
```

Pull requests to `dev` and `master` run the full CI gate. A successful push to
`master` deploys when `INMOTION_DEPLOY_ENABLED=true`.

## Configuration

Start from:

- [`.env.docker.example`](.env.docker.example) for Docker Desktop.
- [`.env.inmotion.example`](.env.inmotion.example) for the server runtime.

Never commit populated environment files.

### Public build values

Next.js embeds `NEXT_PUBLIC_*` values in browser bundles during CI. Changing
one requires a new build and deploy.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Canonical public origin used by the application. |
| `NEXT_PUBLIC_MARKET_ENABLED` | Feature gate for Marketplank. |
| `NEXT_PUBLIC_MARKET_VAULT_ADDRESS` | Primary vault — where new deposits, trades, and liquidity go. |
| `NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESSES` | Comma list of older vaults retained for existing positions. Do not remove one until it holds zero tokens. |
| `NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESS` | Deprecated singular form, still read for one release. Prefer the plural above. |
| `NEXT_PUBLIC_MARKET_VAULT_V1_KNOWN`, `NEXT_PUBLIC_MARKET_VAULT_V2_KNOWN` | Known prior deployments, used to derive a vault's generation and fee model from its address. Defaults are the production addresses below; override only for local test deployments. |
| `NEXT_PUBLIC_ROBINHOOD_RPC_URL` | Browser RPC for Robinhood Chain. |
| `NEXT_PUBLIC_RULES_RELAXED` | Enables the post-launch external venue behavior. |
| `NEXT_PUBLIC_TRADE_PAUSED` | Emergency trade-widget pause. |
| `NEXT_PUBLIC_TRADE_OPENS_AT` | ISO 8601 trade opening time. |
| `NEXT_PUBLIC_MINT_START_AT` | Optional ISO 8601 mint countdown target. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect/Reown project identifier. |

### Server-only runtime values

| Variable | Purpose |
| --- | --- |
| `DURABLE_KV_BACKEND=postgres` | Selects the InMotion production store. |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | Local cPanel PostgreSQL connection. |
| `PGPOOL_MAX`, `PGSSLMODE` | Passenger pool limit and PostgreSQL TLS mode. |
| `UNISWAP_API_KEY` | Quote/swap credential installed by CI as a mode-`600` runtime secret. |
| `CRON_SECRET` | Authorizes the legacy HTTP settlement endpoint, if retained. |
| `RPC_URL` | Private RPC provider (e.g. a keyed Alchemy endpoint) tried first for every server-side chain read — the `/api/rpc` proxy, the vault `fetch-rpc` path, and the order-signature verifier — before falling back to the public Robinhood Chain RPC, which is rate-limited and not recommended for production. |
| `BEACON_ADDRESS` | Server settlement and operator-script chain configuration. |

`RELAYER_PRIVATE_KEY` must not be placed in Passenger's `.env.production`.
The provisioning workflow installs it in a separate mode-`600` file read only
by the cPanel cron process.

## Data model

PostgreSQL stores:

- signed Seaport listings and offers;
- served-order attribution;
- durable marketplace cache values, hash fields, and set members;
- rarity and vault-activity snapshots;
- transactional Boards state.

Wallet ownership, NFT inventory, vault reserves, shares, redemption requests,
and settlement remain on-chain. PostgreSQL does not custody assets or execute
trades. The order relay can make signed orders available, but it cannot create
a valid maker signature.

## Fees

| Surface | Current rule |
| --- | --- |
| Official Uniswap-routed widget | `0.4207%` integrator fee (`42.07` bips) to `0xfa987d386c4f61b27cb67a1e4e1239866fe8d9ba` |
| RobinWood Seaport listings/offers | `0%` marketplace fee |
| Future approved collections | `0.5%` default, configured per collection |
| Vault mint / redeem / targeted redeem (V1, V2) | Immutable share-denominated parameters; deploy-tool defaults are `1%` / `1%` / `2.5%` premium |
| Vault mint / redeem / targeted redeem (V3) | Immutable flat **ETH** fees fixed at deployment, under wei ceilings enforced in the constructor. Deposit mints exactly one share; redeem burns exactly one — no share-fee dust |
| V3 pool swap | `30` bps, retained in the reserve so LPs earn |

The server injects the Uniswap integrator fee. Clients cannot override its fee
recipient or route.

## CI/CD and releases

The release unit is an immutable Git commit SHA:

1. GitHub Actions installs locked dependencies and starts PostgreSQL.
2. Lint, typecheck, migrations, tests, storage integration, build, and relayer
   bundling must pass.
3. CI uploads a standalone Passenger archive over verified SSH.
4. The server applies pending forward-only migrations.
5. A `current` symlink switches atomically to the new release.
6. Passenger restarts and public health, storage, trade API, and `/market`
   checks run.
7. A failed health gate restores the previous application symlink.

Database migrations are not rolled back by an application rollback. Read the
[release and versioning policy](docs/RELEASES.md) before shipping schema
changes.

## Security

The marketplace handles signed orders and calls immutable on-chain contracts.
Treat changes to wallet prompts, order validation, vault integration, RPC
boundaries, relayer logic, CI, and secrets as security-sensitive.

- Report vulnerabilities privately using the process in
  [SECURITY.md](SECURITY.md).
- Read [SECURITY.md](SECURITY.md) before testing production.
- Internal audits are documented under [`docs/marketplank`](docs/marketplank).
  They are not a substitute for an independent third-party audit.
- The current dependency posture is recorded in
  [dependency health](docs/DEPENDENCY_HEALTH.md), last verified 2026-08-07.

## Contracts and addresses

Always verify addresses in the repository and on the explorer before signing.

| Contract | Address |
| --- | --- |
| `$PLANK` token | `0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc` |
| RobinWood NFT | `0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156` |
| Seaport 1.6 | `0x0000000000000068F116a894984e2DB1123eB395` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Marketplank V3 vault ("Premium Plank Liquidity") | `0xacE28f72Fc3e15eA1671e689806694A9b0cE047D` |
| Marketplank V2 vault ("WormWood") | `0xc4B29D7a01603D2A5937b1FC86ea85E488d72e04` |
| Marketplank V1 vault ("Driftwood") | `0xb2019Fd4cA24502e812C0C73b751Fa49979BF708` |
| drand beacon | `0x87d584df130FED0Fe540954eD48CE2691A18D619` |

Multiple unrelated contracts on Robinhood Chain report the symbol `WETH`.
Never resolve the offer currency by symbol.

### Vault status

`MarketplankVaultV3` is **live on mainnet** at
`0xacE28f72Fc3e15eA1671e689806694A9b0cE047D` (verified on-chain:
`VAULT_VERSION() == 3`, share symbol `vROBIN`). It was deployed via
`.github/workflows/deploy-vault-v3.yml` following
[`docs/marketplank/DEPLOY-V3-RUNBOOK.md`](docs/marketplank/DEPLOY-V3-RUNBOOK.md).

The repository variables now point the primary at it, with V1 and V2 as
legacies. Note that `NEXT_PUBLIC_*` values are **baked at build time**: changing
`NEXT_PUBLIC_MARKET_VAULT_ADDRESS` has no effect on the running site until the
next build and deploy. The `.env.*.example` files still show the pre-V3 shape
and are illustrative, not the production source of truth — the repository
variables are.

**V2 must not receive new deposits or liquidity.** Its LP primitive has a
proven, externally exploitable flaw. It stays configured only so existing
depositors can exit through `/migrate`.

Version numbers are internal. The UI presents each vault by product name
(Driftwood, WormWood, Premium Plank Liquidity) via `lib/market/vault-registry.ts`.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Architecture Map (diagrams + inventory)](docs/ARCHITECTURE_MAP.md)
- [Complete documentation index](docs/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Release and versioning policy](docs/RELEASES.md)
- [InMotion deployment runbook](docs/INMOTION_DEPLOYMENT.md)
- [Dependency health](docs/DEPENDENCY_HEALTH.md)
- [Marketplank engineering specification](docs/marketplank/SPEC.md)
- [V3 internal audit](docs/marketplank/AUDIT-2026-08-01-v3-internal.md)
- [V3 deploy runbook](docs/marketplank/DEPLOY-V3-RUNBOOK.md)
- [Vault LP migration postmortem](docs/marketplank/POSTMORTEM-2026-07-29-vault-lp-migration.md)
- [Wallet-signed vault deployment tool (retired 2026-08-02, see its README)](scripts/deploy-tool/README.md)

## Contributing and license

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. This
repository currently has no open-source license. Public source availability
does not grant permission to copy, modify, or redistribute the code.

Nothing in this repository is financial advice. Verify the network, contract,
calldata, value, and approval scope in your wallet before signing.
