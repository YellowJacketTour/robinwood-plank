# Scenery draft continuity

The Arrange editor keeps a device-local draft under the verified wallet and
profile handle. It restores only after the server confirms ownership. Changing
wallets immediately hides the draft and its placement controls; returning to the
owner restores it. Reloading the page retains the exact base layout revision.

If the saved layout has advanced, the draft stays visible and Save is disabled.
The owner can explicitly reload the saved scenery to begin from that revision,
or cancel the draft. A stale server rejection refreshes the saved revision so
the conflict controls appear immediately. Successful save and cancellation remove
the local draft.

Only validated tree IDs and lawn coordinates plus the base revision are stored.
These are public scenery metadata, not prose/media drafts, credentials, balances,
harvests or queued actions. Storage denial keeps editing available in memory and
explains that reloading cannot preserve the draft. Cross-device encrypted drafts
remain a separate requirement.

Validation:

- `npx tsx --test test/market/charmville-layout-draft.test.ts`
- `node scripts/charmville/verify-layout-draft.mjs` with local-only
  `CHARMVILLE_TEST_DATABASE_URL` and optional `CHARMVILLE_TEST_BASE_URL`.

The browser regression creates and removes its own profile and verifies reload,
wallet isolation, owner restoration, stale-save rejection, conflict persistence,
explicit reload, cancellation and successful-save cleanup against PostgreSQL.
