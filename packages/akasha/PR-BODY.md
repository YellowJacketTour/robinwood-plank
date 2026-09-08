## Outcome

Adds `packages/akasha`, a parallel tip-owner for the multichain archive:
coverage object, topic-only EVM / Solana / Bitcoin adapters, announcement graph,
viewport-nonce hydrate, and typed claim kits.

Does not change `/market`, Seaport, vaults, relayer, or InMotion deploy.
Does not replace HyperSync discovery. Two writers must not share tables.

## Scope

- [x] The PR targets `dev` (or `master` only if this is a release).
- [x] The branch is current with `origin/dev`.
- [x] Unrelated changes are excluded.

## Risk and rollback

Risk: none to production if this package is not imported by the Next app
and no process is pointed at live `event`/`artifact` tables.

Rollback: close the PR / delete the package. No migration. No secret.
No contract. No relayer.

Do not boot `hose` against tables the current discovery cursor still writes.

## Verification

- [ ] `npm run lint:inmotion` (app; package is isolated)
- [ ] `npx tsc --noEmit` (app)
- [ ] `npm test` (app)
- [ ] `npm run build` (app)
- [x] Package tests: `node --experimental-strip-types --test packages/akasha/test/**/*.test.ts` (28 pass)
- [ ] PostgreSQL migration/storage tests — N/A (schema proposed only in packages/akasha/sql/schema.sql, not applied)
- [ ] Desktop and mobile verification — N/A (no UI)
- [ ] Wallet paths — N/A

```text
node --experimental-strip-types --test packages/akasha/test/**/*.test.ts
# 28 pass, 0 fail
```

## Deployment

- [x] No new environment values
- [x] Public build variables documented — N/A
- [x] Server secrets documented without including values — N/A
- [x] Database migration is append-only and backward-compatible — not applied
- [x] No Solidity or deployed-address change

Merging `dev` → `master` remains an explicit release decision.
This package must not ship as a second writer.

## Screenshots

N/A — no UI.

## Audit brief

See `packages/akasha/AUDIT_FOR_OPUS.md`.
