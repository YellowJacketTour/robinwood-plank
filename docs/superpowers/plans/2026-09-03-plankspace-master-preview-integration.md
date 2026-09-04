# PlankSpace Master Preview Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the existing PlankSpace integration onto current master, keep it unlisted for direct-link testing, and prove its storage, wallet, customization, widget, and X behavior without releasing master.

**Architecture:** Current master remains authoritative. PlankSpace code is selectively ported from `origin/plankspace-integration` into `release/plankspace-preview`; stale workflow, temporary, backup, and unrelated feature files are rejected. PlankSpace consumes master's shared wallet and PostgreSQL boundaries and is exposed through direct routes behind one public-discovery flag.

**Tech Stack:** Next.js 16.2, React 19, TypeScript, Node test runner, PostgreSQL, ethers, OAuth 2.0/PKCE for X, InMotion Passenger build.

**Spec:** `docs/superpowers/specs/2026-09-03-plankspace-master-preview-integration-design.md`

## Global Constraints

- Work only on `release/plankspace-preview`; never commit or push `master`.
- Exclude Fomo-style portfolio tracking, trade tracking, and recent conceptual wallet features.
- Current master's `WalletProvider`, PostgreSQL abstractions, deployment workflow, and configuration are authoritative.
- Production durable storage remains PostgreSQL; migrations are append-only and compatible with the immediately previous release.
- Preview routes are direct-link accessible but absent from homepage, shared navigation, footer, sitemap, and indexing.
- Never copy secrets into source, fixtures, logs, browser bundles, commits, or release artifacts.
- Preserve unrelated working-tree changes and stage explicit paths only.

---

### Task 1: Establish the selective-port manifest and clean baseline

**Files:**
- Create: `docs/PLANKSPACE_INTEGRATION_MANIFEST.md`
- Modify: none
- Test: repository status and baseline release checks

**Interfaces:**
- Consumes: `origin/master`, `origin/plankspace-integration`, and the approved design spec.
- Produces: an auditable allowlist/denylist used by every later task.

- [ ] **Step 1: Record exact branch inputs**

Run:

```powershell
git rev-parse origin/master
git rev-parse origin/plankspace-integration
git log --reverse --format="%H %s" origin/master..origin/plankspace-integration
```

Expected: master starts from `4ad4c09fb49f00fff9f227a6a8046de9e7cdc3f0`; integration ends at `d5bf69434598c06a2cf25c4ab740bd50c0040e18`. If remotes changed, stop and refresh the spec inputs before porting.

- [ ] **Step 2: Write the manifest**

Create a table listing every path from:

```powershell
git diff --name-status origin/master...origin/plankspace-integration
```

Classify each path `PORT`, `ADAPT`, or `REJECT`, with a reason. The denylist must include `_to_delete/**`, `*.before-widget-repair`, `README-APPLY-PATCH.txt`, `README-PLANKSPACE-*-FIX.txt`, `START-PLANKSPACE-LOCAL.bat`, `STOP-PLANKSPACE-LOCAL-DB.bat`, and `VERIFY-PLANKSPACE-STORAGE.bat`. Classify `.github/workflows/inmotion.yml`, `lib/postgres.ts`, `lib/wallet-context.tsx`, `next.config.ts`, `package.json`, and `package-lock.json` as `ADAPT`, never blind replacement.

- [ ] **Step 3: Run the master baseline**

Run:

```powershell
npm ci
npm run lint:inmotion
npx tsc --noEmit
npm test
npm run build
```

Expected: all commands pass. Record command, result, duration, and any existing warnings in the manifest. If the baseline fails, stop and separate the pre-existing failure from PlankSpace work.

- [ ] **Step 4: Commit the manifest**

```powershell
git add -- docs/PLANKSPACE_INTEGRATION_MANIFEST.md
git commit -m "docs: define selective PlankSpace port manifest"
```

### Task 2: Port the PlankSpace shell with unlisted preview visibility

**Files:**
- Create/Adapt: `app/(plankspace)/layout.tsx`
- Create/Adapt: `app/plankspace/layout.tsx`
- Create/Adapt: `app/plankspace/page.tsx`
- Create/Adapt: `components/plankspace/PlankSpaceFrame.tsx`
- Modify: `lib/constants.ts`
- Modify: `components/Nav.tsx`
- Modify: `components/Footer.tsx`
- Modify: `app/sitemap.ts`
- Modify: `app/robots.ts`
- Test: `test/market/plankspace-preview-visibility.test.ts`

**Interfaces:**
- Consumes: `NEXT_PUBLIC_PLANKSPACE_DISCOVERABLE` with missing/anything-other-than-`true` treated as false.
- Produces: `PLANKSPACE_DISCOVERABLE: boolean` and direct PlankSpace routes with preview robots metadata.

- [ ] **Step 1: Write the failing visibility test**

The test must read the relevant source modules and assert that the flag defaults false, Nav/Footer links are conditional, sitemap omits `/plankspace` when false, and the PlankSpace layout exports `robots: { index: false, follow: false }` in preview mode. Also assert direct route files exist.

- [ ] **Step 2: Verify the test fails before the port**

```powershell
node --test --import tsx test/market/plankspace-preview-visibility.test.ts
```

Expected: FAIL because the flag/routes do not yet exist.

- [ ] **Step 3: Port only the route shell and add the flag**

Adapt the route wrappers and frame from `origin/plankspace-integration`. In `lib/constants.ts`, export:

```ts
export const PLANKSPACE_DISCOVERABLE =
  process.env.NEXT_PUBLIC_PLANKSPACE_DISCOVERABLE === "true";
```

Wrap public entry links with this constant. Filter sitemap entries by it. Keep direct routes mounted. Export conditional metadata from the PlankSpace layout so preview mode is `noindex, nofollow`; public mode may index.

- [ ] **Step 4: Pass focused checks**

```powershell
node --test --import tsx test/market/plankspace-preview-visibility.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- app components/Nav.tsx components/Footer.tsx components/plankspace lib/constants.ts test/market/plankspace-preview-visibility.test.ts
git commit -m "feat(plankspace): add unlisted preview shell"
```

### Task 3: Port routes, PostgreSQL repositories, and append-only migrations

**Files:**
- Create/Adapt: `integrations/plankspace-app/db/**`
- Create/Adapt: `integrations/plankspace-app/app/**`
- Create/Adapt: `app/api/profiles/**`, `app/api/posts/**`, `app/api/friends/**`, `app/api/mail/**`, `app/api/widgets/**`, `app/api/profile-preferences/**`, `app/api/profile-comments/**`
- Create/Adapt: PlankSpace SQL files under `deploy/inmotion/postgres/migrations/`
- Modify only if required: `lib/boards-store.ts`, `lib/postgres.ts`, `.env.docker.example`, `.env.inmotion.example`, `docker-compose.inmotion.yml`
- Test: `test/market/plankspace-postgres-storage.test.ts`
- Test: `test/market/migration.test.ts`

**Interfaces:**
- Consumes: master's PostgreSQL pool and transaction helpers.
- Produces: profile/post/social repositories that return typed data and persist across process restarts.

- [ ] **Step 1: Inventory migration identities**

Compare migration names and SQL on both branches. Resolve duplicate numeric prefixes by assigning new monotonically increasing filenames after master's highest migration. Do not edit a migration already present on master.

- [ ] **Step 2: Write failing storage tests**

Add tests that create a unique profile, update preferences, create a post, add a profile comment, close/reopen the pool, and verify every record remains. Add an idempotency test that runs the migration command twice and compares applied migration rows.

- [ ] **Step 3: Verify failure**

```powershell
node --test --import tsx test/market/plankspace-postgres-storage.test.ts
node --test --import tsx test/market/migration.test.ts
```

Expected: focused PlankSpace test fails because repositories/schema are absent; existing master migration assertions continue passing.

- [ ] **Step 4: Port and adapt the minimum storage code**

Port repository/schema code without the backup file. Replace any independent connection construction with master's PostgreSQL helpers. Ensure API routes use repository interfaces rather than process memory or local JSON in production. Preserve file/memory backends only where master already allows them for local tests.

- [ ] **Step 5: Verify persistence and backward compatibility**

Run the Docker PostgreSQL migration path twice, then run the new storage test and the complete migration test. Verify the immediately previous master application can still read pre-existing tables after the new migrations are applied.

- [ ] **Step 6: Commit**

```powershell
git add -- integrations/plankspace-app/db integrations/plankspace-app/app app/api deploy/inmotion/postgres/migrations lib/boards-store.ts lib/postgres.ts .env.docker.example .env.inmotion.example docker-compose.inmotion.yml test/market/plankspace-postgres-storage.test.ts test/market/migration.test.ts
git commit -m "feat(plankspace): integrate PostgreSQL profile storage"
```

### Task 4: Integrate wallet identity and signed sessions with master's provider

**Files:**
- Create/Adapt: `app/api/auth/**`
- Create/Adapt: PlankSpace authentication modules under `integrations/plankspace-app/app/**`
- Modify only if required: `lib/wallet-context.tsx`
- Test: `test/market/plankspace-wallet-integration.test.ts`
- Existing regression: `test/market/wallet-proof.test.ts`
- Existing regression: `test/market/audit-wallet.test.ts`

**Interfaces:**
- Consumes: `useWallet()` from `lib/wallet-context.tsx` and current wallet-proof verification.
- Produces: wallet-bound PlankSpace session endpoints with nonce, expiry, domain/origin binding, and replay rejection.

- [ ] **Step 1: Write failing identity tests**

Cover one shared connected account, account change, disconnect, cancelled signature, wrong signer, wrong origin/domain, expired nonce, and replayed nonce. Assert no PlankSpace component directly owns a second provider account state or adds a competing `accountsChanged` listener.

- [ ] **Step 2: Verify failure**

```powershell
node --test --import tsx test/market/plankspace-wallet-integration.test.ts
```

Expected: FAIL because the PlankSpace auth/session flow is not ported.

- [ ] **Step 3: Port auth routes and adapt consumers**

Use master's root `WalletProvider`. PlankSpace components call `useWallet()` for address, connection, disconnect, and provider adoption. Server routes issue single-use expiring nonces and verify signatures using current origin/domain rules. Do not add another wallet bundle or expose server configuration through `NEXT_PUBLIC_*`.

- [ ] **Step 4: Pass focused and existing wallet tests**

```powershell
node --test --import tsx test/market/plankspace-wallet-integration.test.ts test/market/wallet-proof.test.ts test/market/audit-wallet.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- app/api/auth integrations/plankspace-app/app lib/wallet-context.tsx test/market/plankspace-wallet-integration.test.ts
git commit -m "feat(plankspace): share wallet identity and signed sessions"
```

### Task 5: Port profile customization and consent-based widgets

**Files:**
- Create/Adapt: PlankSpace profile/editor components and CSS under `integrations/plankspace-app/app/**`
- Create/Adapt: `app/api/widget-market/**`, `app/api/layout-asset/**`, `app/api/plankspace-media/**`
- Adapt tests: `test/market/plankspace-default-profile-css.test.ts`
- Adapt tests: `test/market/plankspace-profile-css.test.ts`
- Adapt tests: `test/market/plankspace-profile-customization.test.ts`
- Adapt tests: `test/market/plankspace-widget-safety.test.ts`

**Interfaces:**
- Consumes: stored profile customization and widget definitions from Task 3.
- Produces: profile-scoped CSS/HTML and click-to-load external widget frames that cannot style or script the shared shell.

- [ ] **Step 1: Port tests first and verify failure**

Bring the four existing integration tests onto the preview branch. Add assertions that global navigation remains unchanged, unsafe script execution is rejected/sandboxed, external requests do not occur before consent, and removing custom CSS restores defaults.

```powershell
node --test --import tsx test/market/plankspace-default-profile-css.test.ts test/market/plankspace-profile-css.test.ts test/market/plankspace-profile-customization.test.ts test/market/plankspace-widget-safety.test.ts
```

Expected: FAIL before implementation.

- [ ] **Step 2: Port customization and widget code**

Adapt the latest integration implementation through commit `d5bf6943`, keeping customization rooted under the profile boundary. Preserve both plain CSS input and `<style>...</style>` extraction. Render external widgets in a restrictive iframe/sandbox and require per-visitor click-to-load consent.

- [ ] **Step 3: Pass focused checks**

Run the four tests plus TypeScript. Inspect a malicious fixture containing `body`, `nav`, `script`, and remote widget content and verify it cannot alter the shared Plank.love shell or load before consent.

- [ ] **Step 4: Commit**

```powershell
git add -- integrations/plankspace-app/app app/api/widget-market app/api/layout-asset app/api/plankspace-media test/market/plankspace-default-profile-css.test.ts test/market/plankspace-profile-css.test.ts test/market/plankspace-profile-customization.test.ts test/market/plankspace-widget-safety.test.ts
git commit -m "feat(plankspace): port isolated customization and widgets"
```

### Task 6: Port existing X integration without expanding scope

**Files:**
- Create/Adapt: `app/api/x/**`
- Create/Adapt: X modules under `integrations/plankspace-app/app/**`
- Create/Adapt: `scripts/sync-plankspace-x.ts`
- Create/Adapt: `docs/PLANKSPACE_X_SETUP.md`
- Adapt tests: `test/market/plankspace-x-account.test.ts`
- Adapt tests: `test/market/plankspace-x-crypto.test.ts`
- Adapt tests: `test/market/plankspace-x-discoverability.test.ts`
- Adapt tests: `test/market/plankspace-x-policy.test.ts`
- Adapt tests: `test/market/plankspace-x-provider.test.ts`

**Interfaces:**
- Consumes: wallet-bound session from Task 4 and PostgreSQL account/post storage from Task 3.
- Produces: optional OAuth account link, rate-limited import, and explicit opt-in cross-posting using server-only credentials.

- [ ] **Step 1: Port the existing X tests and add error-contract assertions**

Assert OAuth state/PKCE verification, encrypted-at-rest tokens, JSON responses for upstream errors, five-minute posting cooldown for ordinary users, daily import limit of the latest 20 posts, explicit per-post opt-in, and the existing PlankSpace attribution footer. Assert secrets never appear in serialized client props or logs.

- [ ] **Step 2: Verify tests fail**

```powershell
node --test --import tsx test/market/plankspace-x-account.test.ts test/market/plankspace-x-crypto.test.ts test/market/plankspace-x-discoverability.test.ts test/market/plankspace-x-policy.test.ts test/market/plankspace-x-provider.test.ts
```

Expected: FAIL because X routes/modules are absent.

- [ ] **Step 3: Port the latest existing X implementation**

Adapt only functionality present on `origin/plankspace-integration`. Keep credentials server-only, bind OAuth state to the signed session, return structured JSON on every route failure, and preserve the existing rate limits and footer behavior. Do not add portfolio or trade ingestion.

- [ ] **Step 4: Pass tests and document configuration**

Run the five tests and TypeScript. Update setup documentation with variable names and callback shapes only—never values. Include local, preview, and production callback URL requirements.

- [ ] **Step 5: Commit**

```powershell
git add -- app/api/x integrations/plankspace-app/app scripts/sync-plankspace-x.ts docs/PLANKSPACE_X_SETUP.md test/market/plankspace-x-account.test.ts test/market/plankspace-x-crypto.test.ts test/market/plankspace-x-discoverability.test.ts test/market/plankspace-x-policy.test.ts test/market/plankspace-x-provider.test.ts
git commit -m "feat(plankspace): integrate existing X connection"
```

### Task 7: Production-shaped audit and browser validation

**Files:**
- Modify: `docs/PLANKSPACE_INTEGRATION_MANIFEST.md`
- Modify only when proven necessary: `next.config.ts`, `package.json`, `package-lock.json`, `.env.inmotion.example`
- Test: all repository and PlankSpace tests

**Interfaces:**
- Consumes: completed Tasks 2–6.
- Produces: exact-SHA release evidence and a clean preview candidate.

- [ ] **Step 1: Audit the final diff and dependencies**

Run:

```powershell
git diff --stat origin/master...HEAD
git diff --name-status origin/master...HEAD
git diff origin/master...HEAD -- .github/workflows/inmotion.yml lib/postgres.ts lib/wallet-context.tsx next.config.ts package.json package-lock.json
git grep -n -E "Bearer |PRIVATE_KEY|CLIENT_SECRET|PGPASSWORD=" HEAD -- . ':!package-lock.json'
```

Expected: no denied artifact, portfolio/trade-tracking file, secret, or unexplained deployment change. Keep master's workflow unless the manifest identifies and tests a required change.

- [ ] **Step 2: Run all release checks**

```powershell
npm run lint:inmotion
npx tsc --noEmit
npm test
npm run build
```

Expected: exit code 0 for every command.

- [ ] **Step 3: Run production-shaped PostgreSQL checks**

Start the documented Docker InMotion stack with a local secret file. Verify:

```powershell
curl.exe --fail --header "Cache-Control: no-cache" http://127.0.0.1:3000/api/health
curl.exe --fail http://127.0.0.1:3000/market
curl.exe --fail http://127.0.0.1:3000/plankspace
```

Expected: health returns `ok: true`, `storage: "postgres"`, and the exact preview SHA; both pages return 200.

- [ ] **Step 4: Perform browser acceptance checks**

At desktop and 390px width, verify homepage/Nav/Footer contain no PlankSpace discovery link, direct `/plankspace`, `/create-profile`, `/profile-editor`, and `/u/<tester>` routes load, wallet state agrees with shared navigation, profile edits survive refresh/restart, custom CSS remains scoped, widgets wait for click, X failures render structured messages, and console/network logs expose no secrets.

- [ ] **Step 5: Record evidence and commit**

Add exact commands, SHA, results, screenshots, known limitations, migration effects, and rollback implications to the manifest.

```powershell
git add -- docs/PLANKSPACE_INTEGRATION_MANIFEST.md
git commit -m "docs: record PlankSpace preview verification"
```

### Task 8: Push the preview branch and stop before release

**Files:**
- Modify: none
- Test: remote branch identity and CI status

**Interfaces:**
- Consumes: verified preview commit from Task 7.
- Produces: a tester branch and direct URLs; no master mutation.

- [ ] **Step 1: Reconfirm branch and cleanliness**

```powershell
git branch --show-current
git status --short
git log -1 --format="%H %s"
```

Expected: branch is `release/plankspace-preview`, status is clean, and HEAD is the verified SHA.

- [ ] **Step 2: Push only the preview branch**

```powershell
git push -u origin release/plankspace-preview
```

Expected: remote branch created; no update to `refs/heads/master`.

- [ ] **Step 3: Verify CI and provide tester links**

Confirm required checks target the exact pushed SHA. Provide the direct preview root and profile/editor URLs plus a statement that the link is unlisted, not access-controlled.

- [ ] **Step 4: Stop at the release gate**

Do not open or merge a master release PR until the owner reports tester acceptance and explicitly authorizes the release. At that later point, re-run all Task 7 checks at the final SHA and follow `docs/RELEASES.md`.
