# Shipping Heart without development-mode production

This checkpoint wires a default-off production capability policy. It does not activate a package, change deployed configuration, mark a candidate accepted, or replace the existing alpha.

## Required immutable package evidence

The selected server `CHARMVILLE_RUNTIME_ROOT` / `CHARMVILLE_RUNTIME_RELEASE` must pass the existing completed-release/inventory hash check, have `readyToServe: true`, kind `charmville-runtime-release`, and account origin exactly `https://plank.love`. `CHARMVILLE_RUNTIME_READY=1` is the immediate runtime kill switch; turning it off suppresses the capability even during the bounded metadata cache.

The **new candidate's inventory**, before its acceptance hashes are produced, must contain:

```json
{
  "capabilities": {
    "burningHeart": {
      "nativeProtocol": 2,
      "familyEntitlement": "burning-heart-family-alpha-01",
      "socialProtocol": "social-items-v2",
      "schemaMigration": 148
    }
  }
}
```

This is an additional inventory property, not a replacement for the existing schema/files/completeInventory/issues fields. Both mirror and target must carry the same declaration. Adding it changes inventory identity and therefore requires fresh matching evidence. Never edit an accepted package or only rewrite its ready marker. Existing candidate builder/promotion callers must supply this declaration deliberately; this policy does not silently author it for them.

`BROWSER-ACCEPTANCE.json` must match the accepted marker's `acceptanceSha256` and exact target inventory hash. All existing eight browser checks must be true, plus an explicit `checks.burningHeartLifecycle: true`. That extra review means the operator observed family acceptance once, distinct native crop stages/selection, harvest conservation, inventory refresh, and explicit social consumption on the matched candidate. It is a reviewed record, not an automated guarantee of artwork quality.

Missing, malformed, candidate-only, wrong-origin, mismatched-hash or unreviewed packages leave production Heart off. Arbitrary Heart environment flags cannot override this. Metadata reads are coalesced for at most one second for the same immutable root/release; no player session, admission, balance or receipt is cached.

## Endpoint compatibility

- Family GET advertises availability only from this policy; POST still requires explicit version acceptance and current authenticated/admitted home owner. No GET grants.
- Native resources additionally require exact protocol2/crop headers. Legacy clients stay on the old contract and cannot misinterpret a Heart bed as Oran.
- Social additionally requires `social-items-v2`; all pin permission, stock debit and receipt checks remain in the transaction.
- Development keeps its explicit local flags for isolated acceptance. Never set production NODE_ENV to development.
- Migration147/148 application must precede activation. A declaration does not execute migrations or grant admin/player admission.

## Isolated merged-tree release checks

Do this after all intended feature commits have been integrated, not inside the worktree running Next on3018. Replace only the example branch/directory suffix if it already exists; retain the actual current feature head and fetched dev.

```powershell
git fetch origin dev master
git worktree add -b release/charmville-alpha02-check ../robinwood-plank-charmville-alpha02-check HEAD
```

In that **new** worktree:

```powershell
git merge --no-edit origin/dev
npm ci
npm run lint:inmotion
npx tsc --noEmit
npm test
npm run test:postgres
npm run build
```

Configure those tests against a separately named disposable local PostgreSQL database. Do not point them at production, the active acceptance player's database, or copy production environment files. Execute append-only migrations on that disposable database and record actual PostgreSQL test counts/skips. Recheck incoming commits and conflicts; at the previous audit, dev/master were f8d39386 and contributed unrelated arcade/table fixes that must be preserved.

After a new mirror/target have actually passed the required checks and the evidence file names their exact inventory hashes:

```powershell
node scripts/charmville/promote-private-runtime.mjs --mirror <new-local-candidate> --target <new-production-candidate> --acceptance <reviewed-evidence.json> --output <new-accepted-directory>
node scripts/charmville/stage-private-runtime-release.mjs --input <new-accepted-directory> --standalone <isolated-standalone-directory> --release <new-release-id> --inventory-sha256 <accepted-inventory-sha256>
```

The placeholders are intentional: do not substitute the old alpha01-r03 acceptance for new Heart bytes. Preserve the encrypted artifact upload workflow and feature→dev→master promotion. Current live health and deployment transport must be rechecked: the latest inspected upload failed with SSH connection resets before activation. This policy does not repair that host transport failure.

Verification for this increment: focused package/hash/origin/capability policy tests, existing runtime-release and local protocol tests, targeted ESLint and TypeScript. No live package was activated by this change.
