# PlankSpace Mobile, Video, and X OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an uncongested PlankSpace mobile profile, visible selection for every saved YouTube video, and a rollback-safe production X OAuth configuration operation.

**Architecture:** Responsive PlankSpace chrome remains isolated beneath the existing PlankSpace roots and leaves shared `Nav` untouched. A focused video parser/player owns selection rather than relying on YouTube playlist controls. A manual GitHub Actions operation copies only server-side X configuration into InMotion's shared environment using the workflow's existing SSH, backup, restart, and health-check conventions.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind/CSS, Node test runner, GitHub Actions, InMotion Passenger, PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-09-04-plankspace-mobile-video-x-oauth-design.md`

## Global Constraints

- Begin from current `origin/master`; fetch and reconcile it again before release.
- Never force-push or develop directly on `master`.
- Scope UI changes to `.plankspace-native`, `[data-plankspace-subnav]`, or `.classic-profile`.
- Do not modify shared wallet behavior, shared `Nav`, or non-PlankSpace pages.
- Keep all X credentials server-only and out of logs, artifacts, URLs, and `NEXT_PUBLIC_*`.
- Preserve PostgreSQL as the only production datastore and keep migrations append-only.
- Every interactive target is at least 44 px; verify at 320, 390, 430, 768, and desktop widths.

---

### Task 1: Visible multi-video selection

**Files:**
- Create: `integrations/plankspace-app/app/profile-video-links.ts`
- Modify: `integrations/plankspace-app/app/profile-video-player.tsx`
- Modify: `integrations/plankspace-app/app/globals.css`
- Test: `test/market/plankspace-profile-videos.test.ts`

**Interfaces:**
- Produces: `parseYouTubeVideoIds(links: string): string[]`, returning at most eight unique valid IDs in saved order.
- Consumes: newline, comma, and whitespace-separated profile video links.

- [ ] **Step 1: Write the failing parser and component-contract tests**

Assert supported watch, short, embed, and `youtu.be` URLs; invalid URLs; stable deduplication; eight-item cap; real selector buttons; selected state; and one selected privacy-enhanced iframe.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --test test/market/plankspace-profile-videos.test.ts`

Expected: failure because `profile-video-links.ts` and selector markup do not exist.

- [ ] **Step 3: Implement the parser and controlled player**

Keep selected ID in React state, reset it when the saved ID list changes, render one `youtube-nocookie.com/embed/<id>` iframe, and render one labeled button per ID with `aria-pressed`. Do not add autoplay.

- [ ] **Step 4: Add PlankSpace-scoped responsive video styles**

Add a wrapping selector strip beneath the 16:9 player. Use existing profile variables and the 44 px touch target. Do not add unscoped element selectors.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `npx tsx --test test/market/plankspace-profile-videos.test.ts`

Expected: all tests pass.

- [ ] **Step 6: Commit explicit paths**

`git add integrations/plankspace-app/app/profile-video-links.ts integrations/plankspace-app/app/profile-video-player.tsx integrations/plankspace-app/app/globals.css test/market/plankspace-profile-videos.test.ts && git commit -m "fix(plankspace): expose every featured video"`

### Task 2: Compact PlankSpace mobile navigation and profile

**Files:**
- Modify: `integrations/plankspace-app/app/plankspace-subnav.tsx`
- Modify: `integrations/plankspace-app/app/u/[handle]/page.tsx`
- Modify: `integrations/plankspace-app/app/globals.css`
- Test: `test/market/plankspace-mobile-profile.test.ts`

**Interfaces:**
- Produces: a `Board menu` disclosure containing all eight PlankSpace destinations.
- Produces: mobile profile jump links targeting `#profile-feed`, `#video`, `#profile-friends`, and `#profile-about`.

- [ ] **Step 1: Write failing static contracts**

Assert the shared `components/Nav.tsx` remains unmodified by this feature, all destinations exist in the disclosure, jump targets exist, secondary information has native disclosure semantics, and every new CSS selector is PlankSpace-scoped.

- [ ] **Step 2: Run the test and verify RED**

Run: `npx tsx --test test/market/plankspace-mobile-profile.test.ts`

Expected: failure because the disclosure and profile anchors do not exist.

- [ ] **Step 3: Implement the mobile Board menu**

Use a button with `aria-expanded` and a referenced navigation panel. Close after route selection, Escape, outside pointer activation, and a change to desktop media width; return focus to the trigger.

- [ ] **Step 4: Implement compact profile hierarchy**

Add the four jump links after identity. On mobile, place contact details, URL, and interests in native `details` elements while preserving their current class hooks. Keep desktop content expanded through scoped responsive CSS and preserve saved module ordering.

- [ ] **Step 5: Add responsive styles**

At `max-width:760px`, hide the desktop link rail, show Board menu, reduce identity height, keep profile theme variables authoritative, and display primary social content before extended details. At wider widths preserve the current layout.

- [ ] **Step 6: Run the focused test and existing customization tests**

Run: `npx tsx --test test/market/plankspace-mobile-profile.test.ts test/market/plankspace-profile-css.test.ts test/market/plankspace-profile-customization.test.ts`

Expected: all tests pass.

- [ ] **Step 7: Commit explicit paths**

`git add integrations/plankspace-app/app/plankspace-subnav.tsx integrations/plankspace-app/app/u/[handle]/page.tsx integrations/plankspace-app/app/globals.css test/market/plankspace-mobile-profile.test.ts && git commit -m "feat(plankspace): streamline mobile profiles"`

### Task 3: Rollback-safe X OAuth secret installation

**Files:**
- Modify: `.github/workflows/inmotion.yml`
- Modify: `docs/PLANKSPACE_X_SETUP.md`
- Modify: `.env.inmotion.example`
- Test: `test/market/plankspace-x-deployment.test.ts`

**Interfaces:**
- Consumes GitHub Secrets: `X_CLIENT_ID`, `X_CLIENT_SECRET`, `PLANKSPACE_X_TOKEN_ENCRYPTION_KEY`.
- Consumes repository variable: `X_REDIRECT_URI`, defaulting to `https://plank.love/api/x/callback`.
- Produces manual workflow operation: `configure-plankspace-x`.

- [ ] **Step 1: Write the failing workflow security contract**

Assert the manual operation exists; secrets are referenced only through `secrets.*`; no X value is placed in global build env or `NEXT_PUBLIC_*`; the remote script validates the decoded encryption key is exactly 32 bytes; the old environment is backed up; replacement is atomic; Passenger restarts; health is checked; and failure restores the backup.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --test test/market/plankspace-x-deployment.test.ts`

Expected: failure because the workflow operation does not exist.

- [ ] **Step 3: Add the manual configuration job**

Follow existing workflow input and SSH patterns. Materialize secrets into temporary mode-600 files without echoing values, transfer them with verified host keys, atomically upsert only the five allowlisted X keys in shared `.env.production`, remove staging files, restart Passenger, and call `/api/health`.

- [ ] **Step 4: Add rollback and validation**

Reject missing client ID, client secret, or encryption key; validate the base64 key to 32 decoded bytes; constrain redirect URI to HTTPS `plank.love/api/x/callback`; back up before mutation; restore and restart on failed health.

- [ ] **Step 5: Update operator documentation**

Document X Developer Console settings: Web App, read/write, OAuth 2.0 PKCE, exact callback, required scopes, GitHub secret names, workflow operation, and credential rotation. Do not include example secret values.

- [ ] **Step 6: Run X tests and workflow lint contract**

Run: `npx tsx --test test/market/plankspace-x-deployment.test.ts test/market/plankspace-x-account.test.ts test/market/plankspace-x-provider.test.ts test/market/plankspace-x-policy.test.ts`

Expected: all tests pass.

- [ ] **Step 7: Commit explicit paths**

`git add .github/workflows/inmotion.yml .env.inmotion.example docs/PLANKSPACE_X_SETUP.md test/market/plankspace-x-deployment.test.ts && git commit -m "feat(plankspace): securely configure production X OAuth"`

### Task 4: Integrated verification and current-master reconciliation

**Files:**
- Modify only conflict-resolved files from Tasks 1–3 if current `master` changed them.

**Interfaces:**
- Consumes: completed Tasks 1–3 and latest `origin/master`.
- Produces: a clean, verified development branch suitable for review through `dev`.

- [ ] **Step 1: Run focused suites**

Run the three new test files plus all existing `plankspace-*.test.ts` files.

- [ ] **Step 2: Run mandatory repository checks**

Run `npm run lint:inmotion`, `npx tsc --noEmit`, `npm test`, and `npm run build`. Record exact pass/fail counts and preserve generated report files unless they are intentional outputs.

- [ ] **Step 3: Perform local mobile verification**

Run the app with production-like PostgreSQL configuration where available. Inspect 320, 390, 430, 768, and desktop widths for Lumberyard, Profile Editor, and a profile with multiple videos. Verify keyboard menu behavior and custom CSS isolation.

- [ ] **Step 4: Scan for credential exposure**

Scan tracked files and feature commits for private keys, bearer/access tokens, client secrets, encryption keys, populated environment files, and accidental workflow output. Allow only secret names and documented placeholders.

- [ ] **Step 5: Fetch and reconcile current master**

Run `git fetch origin master dev`, inspect incoming commits and touched paths, and integrate `origin/master` without force. Resolve conflicts by preserving current production behavior plus the scoped feature.

- [ ] **Step 6: Repeat every mandatory check**

Run the focused tests, `npm run lint:inmotion`, `npx tsc --noEmit`, `npm test`, `npm run build`, and the credential scan again on the exact reconciled commit.

- [ ] **Step 7: Prepare review handoff**

Push the feature branch, open or update a pull request targeting `dev`, and report the commit, test evidence, OAuth operator steps, and any inherited dependency advisories. Do not merge to `master` without explicit release approval.
