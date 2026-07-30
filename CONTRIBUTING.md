# Contributing

Thank you for improving RobinWood and Marketplank. This application can prompt
wallet signatures and submit transactions, so small UI or API changes can have
real financial consequences.

## Branch policy

`inmotion` is the canonical branch.

- Branch from the latest `origin/inmotion`.
- Open pull requests with `base: inmotion`.
- Do not target or merge InMotion work into `master`.
- Do not force-push shared branches.
- Keep unrelated changes out of a pull request.

The repository's GitHub default branch may still display as `master` until the
owner changes that setting. Always check the PR base explicitly.

```bash
git fetch origin
git switch inmotion
git pull --ff-only origin inmotion
git switch -c <type>/<short-description>
```

## Prerequisites

- Node.js `22.22.3`
- npm `11.6.2`
- Docker Desktop with Docker Compose for production-parity storage testing
- A wallet only when manually testing wallet flows

Never use a wallet containing material funds for development.

## Install and run

```bash
npm ci
npm run dev
```

For PostgreSQL and deployment-parity testing:

```powershell
Copy-Item .env.docker.example .env.docker.local
# Set a unique local POSTGRES_PASSWORD.
docker compose --env-file .env.docker.local `
  -f docker-compose.inmotion.yml up -d --build
```

The file/memory order store is acceptable only for isolated local work.
Changes involving orders, Boards, snapshots, expiry, concurrency, migrations,
or Passenger restarts must be exercised against PostgreSQL.

## Required checks

Run the checks that match your change. Before requesting review, run the full
CI-equivalent set unless the pull request explains why a check is inapplicable.

```bash
npm run lint:inmotion
npx tsc --noEmit
npm test
npm run build
```

Storage changes also require:

```bash
npm run db:migrate
npm run test:postgres
```

Contract changes require clean Hardhat artifacts and:

```bash
npm run test:contracts
```

Do not update deployed contract addresses or Solidity as part of an unrelated
frontend, dependency, documentation, or deployment change.

## Pull requests

Keep the title short and use a conventional prefix:

- `feat:` user-visible behavior
- `fix:` defect correction
- `perf:` measured performance improvement
- `design:` visual/UX changes that keep behavior and data flow intact
- `security:` security-specific remediation
- `ops:` deployment or operations
- `chore:` dependencies and maintenance
- `docs:` documentation only
- `test:` tests only

The description should state:

1. what changes for users or operators;
2. the risk and rollback path;
3. tests that were actually run;
4. environment or migration changes;
5. screenshots for visible desktop or mobile changes; and
6. whether wallet, contract, database, relayer, or secret boundaries changed.

Use the repository pull-request template. Never paste a secret, private RPC
credential, database dump, wallet key, or production log containing one.

## Database changes

Migrations live in:

```text
deploy/inmotion/postgres/migrations/
```

Rules:

- Add a new, monotonically ordered SQL file. Never edit an applied migration.
- Make the schema usable by both the new release and its immediate predecessor.
- Keep data replacement and destructive cleanup out of automatic deploys.
- Test migration from the prior schema, not only from an empty database.
- Document backup and restore implications.

The deploy workflow runs migrations before switching the `current` symlink.
If application health fails, the code rolls back but the schema does not.

## Environment and secrets

- Public values use the `NEXT_PUBLIC_` prefix and are visible to users.
- Server secrets must never use `NEXT_PUBLIC_`.
- `.env.local`, `.env.docker.local`, and the real `.env.production` are not
  committed.
- The relayer key is gas-only and cron-only. It must not be loaded by
  Passenger.
- The Uniswap key is installed separately from the release archive.
- Use read-only Upstash credentials for inventory and migration.

When adding a variable, update the relevant example file, README table,
deployment runbook, workflow input, and validation code in the same pull
request.

## Marketplace and wallet changes

Every value displayed before a wallet signature must be derived from the
payload the wallet will execute. Do not trust client-supplied price, maker,
token, recipient, fee, or order-type labels.

For wallet flows:

- assert chain ID `4663` immediately before signing or sending;
- simulate transactions before broadcast;
- keep destinations and approval spenders allowlisted;
- prefer exact approvals;
- show value, recipient, token ID, and net proceeds before confirmation;
- test rejection, wrong-chain, insufficient-funds, and reverted-transaction
  paths; and
- verify both desktop extension and mobile WalletConnect behavior.

## UI acceptance

Visible changes should be checked at minimum at:

- 390 px mobile;
- 1280 px desktop;
- connected and disconnected wallet states;
- loading, empty, error, and success states; and
- a clean browser session after deploy to catch stale bundles.

Include before/after screenshots for layout fixes.

## Documentation and releases

Update the README or the relevant runbook when behavior, commands, variables,
hosting, data ownership, or operator steps change. Dated audits and
postmortems are historical records: add a supersession note instead of
rewriting their original evidence.

Releases are identified by commit SHA. Semantic versions and Git tags are cut
only through the process in [docs/RELEASES.md](docs/RELEASES.md).

## Reporting security issues

Do not open a public issue for a vulnerability. Follow
[SECURITY.md](SECURITY.md).
