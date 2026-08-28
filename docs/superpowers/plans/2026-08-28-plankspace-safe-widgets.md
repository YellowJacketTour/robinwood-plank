# PlankSpace Safe External Widgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let owners paste third-party HTTPS widget snippets that visitors explicitly load inside permissionless isolated frames.

**Architecture:** The server analyzes and normalizes widget source, records detected HTTPS origins, and never executes it in the PlankSpace origin. A client consent component creates the sandboxed frame only after a visitor action and contains provider failures inside the module.

**Tech Stack:** React 19 client components, Next.js route handlers, PostgreSQL/Drizzle, iframe sandbox/CSP, Node tests.

**Spec:** `docs/superpowers/specs/2026-08-28-plankspace-customization-widgets-x-design.md`

## Global Constraints

- Widgets are click-to-load for the first release.
- Widget frames receive scripts but not same-origin, forms, popups, downloads, top navigation, wallet access, or PlankSpace storage.
- Only HTTPS external resources are accepted.
- Widget failure never prevents the rest of a profile from rendering.
- Preserve all existing first-party widget behavior.

---

### Task 1: Widget source analyzer and persistence

**Files:**
- Create: `deploy/inmotion/postgres/migrations/082_plankspace_external_widgets.sql`
- Modify: `integrations/plankspace-app/db/schema.ts`
- Modify: `integrations/plankspace-app/app/widgets/widget-safety.ts`
- Modify: `integrations/plankspace-app/app/widgets/widget-types.ts`
- Test: `test/market/plankspace-widget-safety.test.ts`

**Interfaces:**
- Produces: `analyzeExternalWidget(source: string): { source: string; origins: string[]; executable: boolean; errors: string[] }` and custom config `{ source, origins, executable, consentVersion: 1 }`.

- [ ] **Step 1: Write failing tests** for the supplied Elfsight snippet, HTTPS-origin extraction, non-HTTPS rejection, navigation/form/download rejection, event-handler removal, and size limits.
- [ ] **Step 2: Run** `npx tsx --test test/market/plankspace-widget-safety.test.ts` and confirm the analyzer is missing.
- [ ] **Step 3: Add migration 082** for normalized widget source, origins JSON, executable flag, and consent version without deleting existing `config_json` data.
- [ ] **Step 4: Implement analysis and update `sanitizeWidget`** so custom widgets retain approved external scripts instead of deleting every script tag.
- [ ] **Step 5: Run the targeted test and migration**, then commit with `feat: analyze external profile widgets`.

### Task 2: Click-to-load isolated widget runtime

**Files:**
- Create: `integrations/plankspace-app/app/widgets/external-widget-frame.tsx`
- Modify: `integrations/plankspace-app/app/widgets/profile-widgets.tsx`
- Modify: `integrations/plankspace-app/app/widget-live.css`
- Test: `test/market/plankspace-widget-frame.test.ts`

**Interfaces:**
- Consumes: normalized source and origin list.
- Produces: consent placeholder, generated CSP document, load/unload behavior, and contained error state.

- [ ] **Step 1: Write failing tests** asserting no iframe before consent; iframe `sandbox="allow-scripts"`; `referrerPolicy="no-referrer"`; CSP without forms, navigation, or PlankSpace origin; and visible detected domains.
- [ ] **Step 2: Run the targeted test** and verify failure due to the missing component/helpers.
- [ ] **Step 3: Implement `buildExternalWidgetDocument`** with `default-src 'none'`, HTTPS script/connect/img/style/font/frame policies limited to detected origins plus inline styles where required, and an inline error reporter that cannot message arbitrary parent data.
- [ ] **Step 4: Implement the consent component**; create the iframe only on click, add Unload, loading, timeout, and failure states, and omit wallet/session props entirely.
- [ ] **Step 5: Replace only the custom-widget branch** in `ProfileWidgets` and retain existing widget types unchanged.
- [ ] **Step 6: Run tests and commit** with `feat: isolate click-to-load profile widgets`.

### Task 3: Workshop preview and Elfsight compatibility

**Files:**
- Modify: `integrations/plankspace-app/app/widgets/widget-manager.tsx`
- Modify: `integrations/plankspace-app/app/api/widgets/route.ts`
- Create: `test/e2e/plankspace-external-widget.spec.ts`

**Interfaces:**
- Consumes: analyzer and runtime from Tasks 1–2.
- Produces: detected-domain review, sandbox preview, save validation, and end-to-end Elfsight flow.

- [ ] **Step 1: Add a failing end-to-end fixture** using the exact Elfsight snippet and a deterministic local substitute for its remote payload.
- [ ] **Step 2: Run the E2E test** and confirm scripts are still absent or no consent flow exists.
- [ ] **Step 3: Change the editor label to `HTTPS embed code`**, display origins and executable status, require a successful preview before save, and surface analyzer errors without consuming a wallet proof.
- [ ] **Step 4: Return normalized analysis from the widgets save route** and persist it only after the existing owner proof succeeds.
- [ ] **Step 5: Run the E2E test**, targeted unit tests, and `npx tsc --noEmit`.
- [ ] **Step 6: Commit** with `feat: support consented Elfsight widgets`.

