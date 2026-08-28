# PlankSpace X Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect wallet-owned profiles to X, import their posts into the existing Lumberyard feed, and optionally publish individual PlankSpace posts to X.

**Architecture:** A provider interface separates X HTTP calls from application behavior and supplies an explicit development adapter for local testing. OAuth credentials remain encrypted server-side; imports and publications converge on idempotent PostgreSQL mappings attached to the existing feed.

**Tech Stack:** Next.js route handlers, OAuth 2.0 Authorization Code with PKCE, Web Crypto/Node crypto, PostgreSQL/Drizzle, existing InMotion cron, X API v2.

**Spec:** `docs/superpowers/specs/2026-08-28-plankspace-customization-widgets-x-design.md`

## Global Constraints

- Publishing to X is off by default and selected per post.
- X connection is subordinate to an existing wallet-owned PlankSpace profile.
- Tokens and secrets are server-only, encrypted at rest, and redacted from responses/logs.
- Imports and retries are idempotent and rate-limit aware.
- The development adapter is impossible to enable in production.
- Live X availability depends on configured developer credentials and plan access.

---

### Task 1: X data model and credential encryption

**Files:**
- Create: `deploy/inmotion/postgres/migrations/083_plankspace_x_accounts.sql`
- Modify: `integrations/plankspace-app/db/schema.ts`
- Create: `integrations/plankspace-app/app/x/crypto.ts`
- Test: `test/market/plankspace-x-crypto.test.ts`

**Interfaces:**
- Produces: `encryptXCredential(plaintext: string): string`, `decryptXCredential(ciphertext: string): string`, and tables for accounts, OAuth state, sync cursors, post mappings, and publish attempts.

- [ ] **Step 1: Write failing tests** for AES-256-GCM round trips, random nonces, tamper rejection, missing-key rejection, and sanitized error output.
- [ ] **Step 2: Run the test** and verify failure because the crypto module is missing.
- [ ] **Step 3: Add migration 083** with wallet/profile ownership keys, encrypted token columns, expiry, OAuth state/PKCE expiry and consumption, import cursor/retry fields, unique X post mappings, and unique publication idempotency keys.
- [ ] **Step 4: Implement encryption** using `PLANKSPACE_X_TOKEN_ENCRYPTION_KEY` decoded from 32-byte base64 and versioned ciphertext envelopes.
- [ ] **Step 5: Run the test and migration**, then commit with `feat: add encrypted PlankSpace X account storage`.

### Task 2: Provider boundary and local development adapter

**Files:**
- Create: `integrations/plankspace-app/app/x/provider.ts`
- Create: `integrations/plankspace-app/app/x/provider-live.ts`
- Create: `integrations/plankspace-app/app/x/provider-development.ts`
- Test: `test/market/plankspace-x-provider.test.ts`

**Interfaces:**
- Produces: `XProvider` with `authorizationUrl`, `exchangeCode`, `refresh`, `currentUser`, `listRecentPosts`, and `createPost`; `getXProvider()` selects live or development safely.

- [ ] **Step 1: Write failing contract tests** for deterministic development OAuth, imports, publishing, refresh, simulated rate limit, and refusal to use the development provider when `NODE_ENV=production`.
- [ ] **Step 2: Run the test** and confirm interfaces are missing.
- [ ] **Step 3: Implement the provider types and development adapter** behind `PLANKSPACE_X_PROVIDER=development`.
- [ ] **Step 4: Implement the live fetch adapter** for OAuth token exchange/refresh, current user, user timeline, and post creation; normalize provider errors and capture rate-limit headers.
- [ ] **Step 5: Run provider tests** and commit with `feat: add PlankSpace X provider boundary`.

### Task 3: Wallet-bound OAuth routes

**Files:**
- Create: `app/api/x/connect/route.ts`
- Create: `app/api/x/callback/route.ts`
- Create: `app/api/x/status/route.ts`
- Create: `app/api/x/disconnect/route.ts`
- Create: `integrations/plankspace-app/app/x/oauth.ts`
- Test: `test/market/plankspace-x-oauth.test.ts`

**Interfaces:**
- Consumes: existing single-use wallet proof verification, X provider, and credential crypto.
- Produces: owner-only connect URL, callback persistence, public-safe connection status, and credential deletion.

- [ ] **Step 1: Write failing tests** for wallet binding, state expiry, state replay, PKCE verifier use, profile mismatch, safe status shape, and disconnect deletion.
- [ ] **Step 2: Run the test** and verify expected missing-route/service failures.
- [ ] **Step 3: Implement connect** to consume a `x:connect` wallet proof, create 10-minute state and PKCE records, and return/redirect to the provider URL.
- [ ] **Step 4: Implement callback** to consume state once, exchange code, load X identity, encrypt credentials, and redirect to the Profile Workshop with a non-secret result code.
- [ ] **Step 5: Implement status/disconnect**; disconnect consumes `x:disconnect` proof and deletes tokens, cursors, and pending attempts while retaining already-imported public posts.
- [ ] **Step 6: Run tests and commit** with `feat: connect wallet-owned profiles to X`.

### Task 4: Scheduled idempotent X imports

**Files:**
- Create: `integrations/plankspace-app/app/x/sync.ts`
- Create: `scripts/sync-plankspace-x.ts`
- Modify: `package.json`
- Modify: `deploy/inmotion/passenger.cjs` only if required by the documented cron packaging path
- Test: `test/market/plankspace-x-sync.test.ts`

**Interfaces:**
- Produces: `syncConnectedXAccounts({ limit }: { limit: number }): Promise<SyncSummary>` and `npm run plankspace:x-sync`.

- [ ] **Step 1: Write failing tests** for initial import, cursor advance, duplicate replay, cross-published loop suppression, per-account rate-limit retry time, one-account failure isolation, and last-known-good retention.
- [ ] **Step 2: Run the test** and verify the sync service is absent.
- [ ] **Step 3: Implement bounded account selection and token refresh**, then upsert normalized imported posts into existing `plankspace_posts` with source metadata and X mapping rows.
- [ ] **Step 4: Add the standalone script and package command**; close the shared PostgreSQL pool on completion and produce secret-free summary output.
- [ ] **Step 5: Run the development adapter twice** and verify the second pass creates zero duplicates.
- [ ] **Step 6: Run tests and commit** with `feat: sync X posts into the Lumberyard`.

### Task 5: Optional per-post X publishing

**Files:**
- Modify: `integrations/plankspace-app/app/api/posts/route.ts`
- Modify: `integrations/plankspace-app/app/profile-extras.tsx`
- Create: `integrations/plankspace-app/app/x/publish.ts`
- Test: `test/market/plankspace-x-publish.test.ts`

**Interfaces:**
- Consumes: post payload field `alsoPostToX: boolean`, owner wallet proof, and X provider.
- Produces: local post plus `xPublishStatus: "not-requested" | "pending" | "published" | "failed"` and retry operation.

- [ ] **Step 1: Write failing tests** proving the default is local-only, opt-in publishes after local persistence, retries reuse one idempotency key, provider failure retains the local post, imported posts never republish, and successful mappings suppress later import duplicates.
- [ ] **Step 2: Run the test** and confirm the publish service/status fields are missing.
- [ ] **Step 3: Add an unchecked `Also post to X` control** visible only for a connected owner and include the choice in the wallet-signed post payload.
- [ ] **Step 4: Implement post-first publication orchestration** and an owner-proof retry route for failed attempts.
- [ ] **Step 5: Render source and status markers** in the existing feed without creating a second X-specific feed.
- [ ] **Step 6: Run tests and commit** with `feat: optionally publish PlankSpace posts to X`.

### Task 6: X connection UI and end-to-end verification

**Files:**
- Modify: `integrations/plankspace-app/app/profile-form.tsx`
- Modify: `integrations/plankspace-app/app/widget-live.css`
- Create: `test/e2e/plankspace-x-integration.spec.ts`
- Modify: `.env.inmotion.example`
- Modify: `.env.docker.example`

**Interfaces:**
- Consumes: OAuth/status/disconnect/import/publish flows.
- Produces: Workshop connection card, local development walkthrough, and deployment configuration contract.

- [ ] **Step 1: Add E2E coverage** for development connect, imported X post, default-off sharing, explicit sharing, failed publish retry, and disconnect.
- [ ] **Step 2: Run the E2E test** and confirm missing UI states.
- [ ] **Step 3: Implement the connection card** with Connected/Expired/Disconnected states and no token material.
- [ ] **Step 4: Document env names** `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI`, `PLANKSPACE_X_TOKEN_ENCRYPTION_KEY`, and `PLANKSPACE_X_PROVIDER`; leave secret values empty.
- [ ] **Step 5: Run E2E and targeted X tests**, then commit with `feat: finish PlankSpace X account experience`.

### Task 7: Full release verification

**Files:**
- Modify only files required to resolve failures introduced by these three plans.

**Interfaces:**
- Consumes: all customization, widget, and X slices.
- Produces: verified local development build.

- [ ] **Step 1: Run** `npm run lint:inmotion`.
- [ ] **Step 2: Run** `npx tsc --noEmit`.
- [ ] **Step 3: Run** `npm test`.
- [ ] **Step 4: Run** `node --env-file=.env.development.local scripts/migrate-postgres.mjs` and the environment-loaded `npm run test:postgres`.
- [ ] **Step 5: Run** `npm run build`.
- [ ] **Step 6: Start `npm run dev` and verify** default profile, cyberpunk CSS application/removal, mobile layout, Elfsight consent/loading, development X import, default-off post, explicit X post, retry, and disconnect.
- [ ] **Step 7: Commit only necessary verification fixes** with `fix: close PlankSpace integration regressions` if any changes were required.

