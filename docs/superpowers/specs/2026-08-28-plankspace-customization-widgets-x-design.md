# PlankSpace Customization, Safe Widgets, and X Integration

Date: 2026-08-28
Status: Approved design, awaiting implementation-plan review

## Objective

Make PlankSpace feel like an owner-controlled old-school social profile without losing the recognizable PlankSpace product. A profile owner can paste CSS, remove it to return immediately to the default theme, add isolated third-party widgets, connect an X account, import X posts, and optionally share individual PlankSpace posts to X.

## Product invariants

The current PlankSpace profile is the canonical footprint. Every customized profile retains:

- RobinWood and PlankSpace navigation;
- the compact centered board and two-column desktop structure;
- identity, contact, URL, interests, Lounge, status, music, video, game, collection, blurbs, Top 8, feed, widget, and comment concepts;
- wallet-ownership indicators, reporting controls, consent prompts, and safety controls; and
- the existing PlankSpace terminology and interaction behavior.

The owner may restyle and rearrange the profile canvas and ordinary modules. User code cannot alter the global navigation, wallet controls, ownership indicators, consent UI, reporting UI, or moderation controls.

## 1. Reversible profile customization

### Storage

Keep the owner's custom source separate from the default application CSS and component markup. Saving custom code updates only the profile customization record. Clearing it removes the generated scoped stylesheet and restores the default immediately, without attempting a reverse migration.

The existing `custom_html` value remains readable during migration. New explicit fields separate concerns:

- custom profile CSS;
- custom-section HTML;
- customization schema version; and
- last validation result.

The migration is append-only and compatible with the preceding release. Existing combined HTML/CSS values are parsed into the new representation on read until they are next saved.

### Stable customization contract

Expose documented, stable selectors for the profile canvas and modules. Initial hooks include:

- `.plankspace-profile`
- `.profile-columns`
- `.profile-sidebar`
- `.profile-main`
- `.module-identity`
- `.module-contact`
- `.module-interests`
- `.module-lounge`
- `.module-status`
- `.module-music`
- `.module-video`
- `.module-game`
- `.module-collection`
- `.module-about`
- `.module-friends`
- `.module-feed`
- `.module-widgets`
- `.module-comments`
- `.custom-section`

The editor provides a copyable default stylesheet that documents these hooks and the default structure. Internal implementation classes remain private and are not part of the compatibility promise.

### CSS compiler

Replace the current small visual-property allowlist with a profile-scoped CSS compiler. It must:

1. parse CSS structurally rather than with declaration-splitting regular expressions;
2. prefix every selector with the current profile root;
3. reject selectors that target protected elements or escape the profile root;
4. allow layout properties needed for MySpace-style themes, including grid, flex, sizing, spacing, transforms, transitions, and animation;
5. reject active-content and browser-escape mechanisms, including imports, executable URLs, external font loading, behavior properties, and unsafe resource schemes;
6. limit source length, selector count, declaration count, nesting depth, animation duration, and generated output size; and
7. return actionable validation warnings to the editor.

CSS custom properties are permitted only inside the profile root. Fixed and sticky positioning are rejected for owner-controlled elements so custom content cannot cover navigation or safety controls. Extreme z-index values, pointer-event suppression on protected descendants, and selectors matching protected markers are rejected.

### HTML sections

Custom HTML renders as movable Custom Space modules within the normal module stack. It does not replace the application document or the protected shell. HTML is sanitized to remove scripts, event handlers, forms, embedded browsing contexts, executable URLs, and unsafe attributes. Multiple custom sections may be added, titled, reordered, shown, or hidden using the existing module-management model.

## 2. Safe third-party widgets

### Owner experience

A Custom Widget editor accepts an HTTPS embed snippet. Before saving, PlankSpace displays:

- detected external domains;
- whether the snippet contains executable scripts;
- a sandboxed preview; and
- a clear statement that visitors must choose to load it.

The owner can set title, visibility, desktop/mobile visibility, order, and existing widget presentation settings.

### Visitor experience

Third-party widgets initially render as a consent placeholder showing the provider domains. The visitor must click **Load external widget**. Consent is per widget for the first release and is not silently persisted across unrelated providers.

After consent, the widget runs in a unique-origin iframe with scripts enabled but without same-origin access, forms, popups, downloads, top navigation, wallet injection, or access to PlankSpace cookies and storage. The frame uses `referrerPolicy="no-referrer"` and a generated content-security policy. Parent-to-frame communication is absent unless a later provider adapter defines a narrow validated message contract.

The server stores the original snippet, a sanitized rendering form, and the detected origin set. It rejects non-HTTPS scripts and resources, inline event handlers, browser-navigation primitives, wallet-provider requests, and oversized payloads. The initial compatibility target includes the supplied Elfsight X-feed embed.

### Failure behavior

Blocked or failed widgets show a contained error inside their module. They never prevent the rest of the profile from rendering. Visitors can unload an active external widget and return it to the consent state.

## 3. X account integration

### Connection and authorization

X linking is separate from wallet authentication. The profile owner must first prove wallet ownership, then complete X OAuth user authorization. Use OAuth 2.0 Authorization Code with PKCE for user-context read/write access and request only the scopes required for profile identity, post reading, optional post creation, and refresh access.

OAuth state and PKCE verifiers are short-lived, single-use, bound to the wallet-owned profile, and stored server-side. Access and refresh credentials are encrypted at rest with a dedicated server-only key. Tokens and application secrets are never returned to clients, logged, included in build artifacts, or exposed through public profile APIs.

### Import from X

The initial production path uses a bounded scheduled importer compatible with the existing InMotion cron model. It reads recent posts for connected accounts, advances a per-account cursor, and upserts imported items by immutable X post ID. Imported posts appear in the existing Lumberyard feed with an X source marker and link.

The importer is idempotent, rate-limit aware, and retains last-known-good content during X outages. It records retry timing from X rate-limit headers and does not turn one account failure into a full-run failure.

Real-time Account Activity webhooks are a later deployment option because they require a public HTTPS callback, webhook verification, plan access, and subscription capacity. The data model supports later webhook ingestion through the same idempotent upsert path.

### Optional publishing to X

Every PlankSpace composer defaults **Also post to X** to off. The owner must enable it for each post. Before wallet signing, the UI summarizes both effects: create the PlankSpace post and request publication to X.

The PlankSpace post is the primary record. After it is accepted, the server attempts X publication with that owner's user token and stores pending, published, or failed status plus the resulting X post ID. An X failure does not delete or duplicate the PlankSpace post. The owner can retry a failed cross-post explicitly. Idempotency keys prevent duplicate X posts during retries.

Posts imported from X are never automatically sent back to X. Posts already cross-published are deduplicated during later imports by X post ID.

### Local testing

Provide a development-only X adapter selected by an explicit non-production environment flag. It simulates OAuth completion, imports deterministic sample posts, refreshes tokens, publishes optional cross-posts, and exercises failure/retry states without production credentials. Production fails closed if X credentials are absent; it never silently enables the development adapter.

Live operation requires X developer access and server-only client credentials. Current X documentation states that API endpoints are plan-metered, OAuth refresh tokens require `offline.access`, and webhooks require a publicly accessible HTTPS endpoint.

## 4. PostgreSQL data model

Append-only migrations add tables for:

- profile custom sections and compiled-style metadata;
- external widget source, sanitized source, detected domains, and consent version;
- X account identity linked to wallet and profile;
- encrypted X access/refresh credentials and expiry;
- single-use OAuth state/PKCE records;
- per-account import cursors and retry state;
- imported/cross-published X post mappings; and
- cross-publication attempt status and idempotency keys.

Every ownership-sensitive table keys back to both normalized wallet address and profile handle. Public reads exclude credentials, OAuth state, internal errors, and provider metadata that could reveal secrets.

## 5. Application boundaries

- Profile rendering owns the protected shell, stable hooks, module placement, and scoped-style attachment.
- The customization compiler owns CSS parsing, scoping, limits, and diagnostics.
- The custom-section sanitizer owns inert owner HTML.
- The widget runtime owns external-snippet analysis, consent, iframe policy, and contained failures.
- The X OAuth service owns authorization state, token exchange, refresh, encryption, and revocation.
- The X sync service owns import/publish adapters, idempotency, cursors, and provider errors.
- Existing PlankSpace feed storage remains the canonical feed surface and gains provider/source metadata without creating a second feed.

## 6. Security and privacy

- Never execute user scripts in the PlankSpace origin.
- Never expose EIP-1193 wallet providers to custom frames.
- Never grant custom frames same-origin, form, popup, download, or top-navigation sandbox capabilities.
- Never allow custom CSS to cover or disable protected UI.
- Treat third-party widgets as trackers and require visitor activation.
- Encrypt X credentials at rest and redact provider errors before public display.
- Bind all owner writes to existing wallet proofs and consume proofs once.
- Validate X webhook signatures if webhook ingestion is enabled later.
- Provide disconnect/revoke behavior and delete stored X credentials when an owner disconnects.

## 7. Testing and verification

Test-driven implementation must cover:

- CSS scoping, supported layout declarations, protected-selector rejection, limits, and clearing back to defaults;
- legacy combined custom-code compatibility;
- HTML sanitization and multiple custom-section ordering;
- widget-domain detection, save normalization, click-to-load state, iframe attributes, CSP construction, Elfsight compatibility, and failure containment;
- OAuth state/PKCE expiry and replay rejection;
- credential encryption/decryption and public-response redaction;
- X import cursors, rate-limit behavior, deduplication, deletion handling, and outage resilience;
- per-post opt-in publishing, idempotent retry, and loop prevention; and
- development-adapter isolation from production.

Before completion, run the repository-required gates:

1. targeted tests for each implementation slice;
2. `npm run lint:inmotion`;
3. `npx tsc --noEmit`;
4. `npm test`;
5. `npm run db:migrate` and `npm run test:postgres`;
6. `npm run build`; and
7. browser verification of default, customized, cleared, mobile, widget-consent, and X-sharing states.

## 8. Delivery sequence

1. Reversible scoped customization and stable default-layout guide.
2. Multiple inert Custom Space modules.
3. Click-to-load isolated third-party widgets, including Elfsight verification.
4. X OAuth and account-linking foundation.
5. Scheduled X import into the existing feed.
6. Optional per-post publishing to X.
7. Full regression, PostgreSQL, production build, and browser verification.

Each slice remains independently testable. X configuration absence must not block profile customization or custom widgets.

## External constraints

- X OAuth user access: https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token
- X API overview and plan availability: https://docs.x.com/x-api/overview
- X rate limits: https://docs.x.com/x-api/fundamentals/rate-limits
- X webhook requirements: https://docs.x.com/x-api/webhooks/introduction
- X Account Activity: https://docs.x.com/x-api/account-activity/introduction

