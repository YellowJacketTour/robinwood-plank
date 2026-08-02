## Outcome

Describe what changes for users or operators.

## Scope

- [ ] The PR targets `dev` (or `master` only if this is a release).
- [ ] The branch is current with `origin/dev`.
- [ ] Unrelated changes are excluded.

## Risk and rollback

Describe wallet, contract, database, relayer, CI/CD, caching, or secret impact.
State the application rollback and any separate data-recovery requirement.

## Verification

- [ ] `npm run lint:inmotion`
- [ ] `npx tsc --noEmit`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] PostgreSQL migration/storage tests, if applicable
- [ ] Desktop and mobile verification, if visible
- [ ] Wallet rejection/error paths, if transaction-facing

List the commands and production checks actually run:

```text

```

## Deployment

- [ ] No new environment values
- [ ] Public build variables documented
- [ ] Server secrets documented without including values
- [ ] Database migration is append-only and backward-compatible
- [ ] No Solidity or deployed-address change

Explain any checked item that does not apply.

## Screenshots

Required for visible UI changes.
