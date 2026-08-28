# PlankSpace Profile Customization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make profile CSS reversibly reskin and rearrange the canonical PlankSpace footprint while custom HTML lives in movable, sanitized modules.

**Architecture:** A structural CSS compiler scopes owner rules beneath one profile root and rejects protected targets. Explicit stable module classes form the public customization contract; clearing stored CSS removes the generated stylesheet and reveals the unchanged defaults.

**Tech Stack:** Next.js 16.2.12, React 19, TypeScript, PostgreSQL/Drizzle, PostCSS, Node test runner through `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-28-plankspace-customization-widgets-x-design.md`

## Global Constraints

- Preserve the canonical two-navigation, centered two-column PlankSpace footprint.
- Never allow owner CSS to target navigation, wallet, ownership, consent, report, or moderation controls.
- Customization source remains separate and removable; empty CSS restores defaults without data rewriting.
- PostgreSQL migrations are append-only and compatible with the immediately preceding release.
- Read `node_modules/next/dist/docs/` before changing Next.js routes or rendering behavior.
- Stage explicit paths and preserve unrelated local files.

---

### Task 1: Structural scoped-CSS compiler

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `integrations/plankspace-app/app/customization/profile-css.ts`
- Test: `test/market/plankspace-profile-css.test.ts`

**Interfaces:**
- Consumes: raw owner CSS and a fixed root selector.
- Produces: `compileProfileCss(source: string): { css: string; warnings: string[] }`.

- [ ] **Step 1: Write failing tests** for selector prefixing, grid/flex/spacing/animation retention, protected-selector rejection, `position:fixed` rejection, unsafe URL rejection, and empty input.

```ts
test("scopes layout CSS to the profile root", () => {
  const result = compileProfileCss(".module-feed{display:grid;gap:12px}");
  assert.match(result.css, /\.plankspace-profile \.module-feed/);
  assert.match(result.css, /display:grid/);
});

test("rejects protected and viewport-covering rules", () => {
  const result = compileProfileCss(".plankspace-nav{display:none}.module-feed{position:fixed;inset:0}");
  assert.equal(result.css, "");
  assert.ok(result.warnings.length >= 2);
});
```

- [ ] **Step 2: Run** `npx tsx --test test/market/plankspace-profile-css.test.ts` and confirm failures are caused by the missing compiler.
- [ ] **Step 3: Add direct `postcss` and `postcss-selector-parser` dependencies** with `npm install postcss postcss-selector-parser`.
- [ ] **Step 4: Implement the compiler** with AST traversal, `.plankspace-profile` prefixing, protected-marker checks, source/output/count limits, safe URL schemes, and deterministic warnings.
- [ ] **Step 5: Run the targeted test** and confirm it passes.
- [ ] **Step 6: Commit** only the dependency files, compiler, and test with `feat: add scoped PlankSpace CSS compiler`.

### Task 2: Append-only customization storage

**Files:**
- Create: `deploy/inmotion/postgres/migrations/081_plankspace_profile_customization.sql`
- Modify: `integrations/plankspace-app/db/schema.ts`
- Modify: `integrations/plankspace-app/app/api/profiles/route.ts`
- Test: `test/market/plankspace-profile-customization.test.ts`

**Interfaces:**
- Consumes: `customCss`, `customSections`, and existing `customHtml` profile payloads.
- Produces: profile fields `customCss`, `customSectionsJson`, and `customizationVersion` while retaining legacy reads.

- [ ] **Step 1: Write failing tests** proving legacy `<style>…</style>` content is separated on read, new fields are length-limited, malformed section JSON becomes an empty list, and clearing CSS returns an empty stored value.
- [ ] **Step 2: Run** `npx tsx --test test/market/plankspace-profile-customization.test.ts` and confirm the new normalization interface is absent.
- [ ] **Step 3: Add migration 081** with nullable-safe/defaulted columns `custom_css text not null default ''`, `custom_sections_json text not null default '[]'`, `customization_version integer not null default 1`, and `customization_warnings_json text not null default '[]'`.
- [ ] **Step 4: Update Drizzle schema and profile API normalization**; compile CSS before persistence and return warnings to the owner-only save response.
- [ ] **Step 5: Run the targeted test and** `node --env-file=.env.development.local scripts/migrate-postgres.mjs`.
- [ ] **Step 6: Commit** the migration, schema, route, and test with `feat: persist reversible profile customization`.

### Task 3: Stable PlankSpace footprint and custom-section rendering

**Files:**
- Modify: `integrations/plankspace-app/app/u/[handle]/page.tsx`
- Modify: `integrations/plankspace-app/app/lumberyard.css`
- Create: `integrations/plankspace-app/app/customization/custom-section.ts`
- Test: `test/market/plankspace-custom-sections.test.ts`

**Interfaces:**
- Consumes: compiled CSS and normalized custom-section records `{ id, title, html, visible, sortOrder }`.
- Produces: stable module hooks and inert sanitized Custom Space modules.

- [ ] **Step 1: Write failing sanitizer tests** that preserve headings, paragraphs, lists, images using HTTPS/data sources, and classes while removing scripts, event handlers, forms, iframes, objects, embeds, and executable URLs.
- [ ] **Step 2: Run the targeted test** and confirm it fails because `sanitizeCustomSectionHtml` does not exist.
- [ ] **Step 3: Implement `sanitizeCustomSectionHtml(html: string): string`** and `normalizeCustomSections(value: unknown)` with 12-section, 20,000-character-total limits.
- [ ] **Step 4: Add stable classes and protected markers** to the existing profile DOM without changing default visual output; render compiled CSS at the profile root and custom sections in the ordinary module stack.
- [ ] **Step 5: Run sanitizer tests, TypeScript, and inspect the uncustomized profile** to verify pixel-level structure remains the canonical default.
- [ ] **Step 6: Commit** with `feat: expose stable PlankSpace profile hooks`.

### Task 4: Profile Workshop code editor and starter guide

**Files:**
- Modify: `integrations/plankspace-app/app/profile-form.tsx`
- Modify: `integrations/plankspace-app/app/widget-live.css`
- Create: `integrations/plankspace-app/app/customization/default-profile-css.ts`
- Test: `test/market/plankspace-default-profile-css.test.ts`

**Interfaces:**
- Consumes: stable hooks from Task 3 and warning output from Task 2.
- Produces: CSS editor, section editor, “Copy Default Layout CSS,” preview warnings, and clear-to-default behavior.

- [ ] **Step 1: Write a failing contract test** asserting the starter CSS names every documented public hook and contains no internal-only selector.
- [ ] **Step 2: Run the test** and confirm the starter export is missing.
- [ ] **Step 3: Implement the starter stylesheet constant** with commented sections for canvas, columns, sidebar, main rail, and each module hook.
- [ ] **Step 4: Replace the combined textarea** with separate CSS and Custom Section controls, add copy/reset actions, show compiler warnings, and keep module order/visibility controls.
- [ ] **Step 5: Verify manually**: save cyberpunk CSS, view the canonical profile reskinned, clear CSS, and observe the original brown-and-cream default without reloading profile data.
- [ ] **Step 6: Run targeted tests and `npx tsc --noEmit`**, then commit with `feat: add PlankSpace layout workshop`.

### Task 5: Customization regression gate

**Files:**
- Create: `test/e2e/plankspace-customization.spec.ts`

**Interfaces:**
- Consumes: completed profile customization flow.
- Produces: browser-level proof of save, scoped rendering, clearing, mobile reflow, and protected UI.

- [ ] **Step 1: Add an end-to-end test** that loads a seeded owner profile, applies a test skin, asserts module rearrangement and unchanged navigation, clears CSS, and asserts default classes/styles return.
- [ ] **Step 2: Run** `npx playwright test test/e2e/plankspace-customization.spec.ts` and resolve only failures in this subsystem.
- [ ] **Step 3: Run** `npx tsx --test test/market/plankspace-profile-css.test.ts test/market/plankspace-profile-customization.test.ts test/market/plankspace-custom-sections.test.ts test/market/plankspace-default-profile-css.test.ts`.
- [ ] **Step 4: Commit** with `test: verify reversible PlankSpace customization`.

