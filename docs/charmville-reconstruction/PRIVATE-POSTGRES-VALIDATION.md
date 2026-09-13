# Private-alpha PostgreSQL validation

Verified 2026-09-13 against an isolated PostgreSQL **16.15** server in WSL Ubuntu 24.04. Docker Desktop was unavailable; PostgreSQL Ubuntu packages were downloaded and extracted into `/var/tmp/charmville-pg-validation-20260913`, without installing a system service or opening a production database.

The temporary server listens only on `127.0.0.1:55419`, as the unprivileged `nobody` operating-system user. Its synthetic database role is `charmtest`. Local trust authentication is limited to this disposable development cluster; it is not a deployment authentication configuration.

## Actual result

**12 passed, zero failed, zero skipped.**

- Oran social pins: shared custody conservation, idempotent receipt replay, bidirectional block enforcement, and concurrent attempts to spend the last unit.
- Invitations: plaintext token absent from database/listing, competing redeemers cannot both succeed, same-account replay does not extend access, recipient binding, revoked token/grant denial, issuer authority removal, and expiry while waiting on a database row lock.
- Runtime tickets: hashed issuance, bounded expiry, renewal preserves the ticket instead of allocating another, original-session expiry/deletion invalidates access, current admission revocation invalidates access, and session deletion cascades ticket removal.
- Associated parser, configuration, cookie and authorization tests also passed.

Each PostgreSQL integration test creates a uniquely named schema and drops only that schema on completion. No live PlankSpace accounts, posts or balances were used.

## Reproduce while the isolated server is running

From the repository in PowerShell:

```powershell
$env:CHARMVILLE_TEST_DATABASE_URL='postgres://charmtest@127.0.0.1:55419/postgres'
$env:NODE_ENV='development'
npx tsx --test test/market/charmville-social.test.ts test/market/charmville-invites.test.ts test/market/charmville-runtime-session.test.ts
```

The development environment preserves legacy local social fixtures. Invitation/runtime production-private policy tests supply explicit private-mode environments; separate admission-policy tests verify production defaults closed.

## CI wiring still required

The existing `.github/workflows/inmotion.yml` build job already provides a PostgreSQL 16 service at `127.0.0.1:5432` with its public CI-only fixture credentials. It does **not** currently set `CHARMVILLE_TEST_DATABASE_URL`. Its `npm run test:postgres` invokes the general storage verifier, not these Charmville integration tests.

Add an explicit step on the proposed commit/PR using the existing service:

```yaml
- name: Charmville private alpha PostgreSQL gates
  env:
    NODE_ENV: development
    CHARMVILLE_TEST_DATABASE_URL: postgres://plankapp:github-actions-postgres@127.0.0.1:5432/plank
  run: npx tsx --test test/market/charmville-social.test.ts test/market/charmville-invites.test.ts test/market/charmville-runtime-session.test.ts
```

Keep these fixture variables scoped to the test step. This local run validates backend behavior, not public deployment, proxy/cache isolation, complete native runtime packaging, or end-to-end guest gameplay.
