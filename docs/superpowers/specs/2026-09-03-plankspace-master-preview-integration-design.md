# PlankSpace Master Preview Integration Design

## Objective

Integrate the existing `plankspace-integration` product into the current
`master` codebase without releasing it publicly. The result will be a
reviewable preview branch whose PlankSpace routes can be opened by direct URL,
while public discovery remains disabled until the owner approves release.

## Scope

Included:

- Existing PlankSpace pages, profile editor, profile customization, widgets,
  X integration, and supporting API/storage behavior already committed to
  `plankspace-integration`.
- Compatibility work required for those features to run against current
  master architecture, PostgreSQL storage, wallet context, Next.js version,
  deployment workflow, and security boundaries.
- An unlisted preview mode that removes PlankSpace entry points from the
  homepage and shared navigation, omits it from discovery metadata, and marks
  preview pages `noindex` while retaining direct tester URLs.

Excluded:

- Fomo-style portfolio tracking, trade tracking, social trading, or other
  concepts discussed after the existing PlankSpace work.
- Any new wallet subsystem. Current master's shared wallet context remains
  authoritative; PlankSpace may consume it but may not fork or replace it.
- A push or merge to `master` during the preview phase.

## Integration Strategy

Work on `release/plankspace-preview`, created from the current `origin/master`
SHA. Treat current master as authoritative and port the PlankSpace changes
forward selectively. Do not merge the stale branch wholesale: it has 17 unique
commits but is 440 commits behind master and includes obsolete deployment and
temporary artifacts.

Review every PlankSpace-only commit and file. Preserve product behavior while
adapting it to current interfaces. Exclude temporary launch scripts, patch
instructions, backup files, `_to_delete` content, and deployment-workflow
changes unless a line-by-line review proves they are required.

## Storage and Migrations

PostgreSQL remains the only production durable store. PlankSpace repositories
and API routes must use the current durable-storage abstractions and must not
introduce a second production store.

All PlankSpace migrations will be audited for ordering, duplicate numbering,
idempotency, and compatibility with both the preview application and the
immediately previous live release. Migrations remain append-only. No migration
may delete, rename, or destructively transform live data. Preview deployment
must stop if schema compatibility cannot be proven.

## Wallet and Authentication

`WalletProvider` mounted by the root layout remains the single client wallet
source of truth. PlankSpace connection and signature flows must consume that
shared state and current server-side signature verification. A PlankSpace page
must not create an independent connected-account state that can disagree with
the main navigation.

Wallet tests will cover connection propagation, account and chain changes,
disconnect, cancelled signatures, invalid signatures, replay/expiry behavior,
and session restoration. No private key, bearer token, database password, or
server secret may enter source, logs, browser bundles, or release artifacts.

## Preview Visibility

Preview routes remain reachable by direct URL for testers. Public homepage,
primary navigation, footer, sitemap, and other discovery surfaces will not link
to PlankSpace. Preview pages will advertise `noindex, nofollow` where supported.
This is unlisted access, not authentication: anyone who receives the URL can
open it. Existing wallet/signature authorization continues to protect private
or mutating actions.

The visibility mechanism will be controlled by one documented build-time flag
with a safe production default. Enabling public navigation later should require
only changing that flag and rebuilding, not rewriting routes.

## X and Widget Boundaries

Only the X and widget functionality already present on the integration branch
is in scope. Server credentials stay server-only. External widgets remain
profile-scoped and consent-to-load; custom CSS/HTML must remain contained inside
the PlankSpace profile boundary and must not alter shared Plank.love navigation
or unrelated pages.

## Validation Gates

Before pushing the preview branch:

1. Review the final diff against current master and confirm excluded artifacts
   and unrelated concepts are absent.
2. Run migration and PostgreSQL integration checks using non-production data.
3. Run `npm run lint:inmotion`, `npx tsc --noEmit`, `npm test`, and
   `npm run build` at the exact preview SHA.
4. Test wallet, profile persistence, X error handling, widgets, and CSS/HTML
   containment locally on desktop and mobile widths.
5. Confirm `/api/health` reports the expected deployment SHA and PostgreSQL
   storage in a production-shaped local environment.
6. Perform secret scanning and inspect browser/server logs for credential or
   private-data exposure.
7. Push only `release/plankspace-preview` and provide direct tester URLs.

Before any later master release, require green CI at the exact head SHA,
resolved review conversations, screenshots, migration/rollback notes, and the
owner's explicit approval. Deployment health must be checked without relying on
browser or Cloudflare cache. A failed health check permits application rollback
only; migrations are never represented as automatically rolled back.

## Success Criteria

- Current Plank.love behavior outside PlankSpace is unchanged.
- Existing PlankSpace functions on current master infrastructure.
- Wallet state is consistent across the shared navigation and PlankSpace.
- Profile and social data persist through PostgreSQL and survive restarts.
- PlankSpace is absent from public discovery but works through direct links.
- The preview branch passes all repository release checks.
- No master push or live release occurs without a separate explicit approval.
