# Charmville showcase checkpoint — September 8, 2026

Working branch: `robinwood-plank-charmville-slice-1`. Local changes are preserved;
no production deployment or master push occurred. This is a tested development
checkpoint, not completion of the full Charmville product.

## Open the build

- Persistent read-only synthetic board: http://localhost:3017/u/charmville_showcase
- Integrated Pine discovery: http://localhost:3017/search
- Seven portrait sources: http://localhost:3017/images/charmville/charms/preview.html
- Real local wallet entry: http://localhost:3017/profile-editor

The showcase has a separate local database and synthetic content. It grants no
owner session through its URL. The interactive synthetic browser opened by
`scripts/charmville/playtest.mjs --synthetic` has its own temporary owner session.
Its fixtures are removed when that browser closes.

Local verification database: host `127.0.0.1`, port `55417`, user `charmville`,
database `postgres`, trust authentication restricted to loopback. Data directory:
`C:/Users/k1rby/pg-local/charmville-showcase`. The historical database was not used.
Set `CHARMVILLE_TEST_DATABASE_URL` to this isolated database for the test scripts.

## Integrated changes

- Seven original editable Blender charm portraits. Stalk and Splinter now appear
  in satchel stacks, seed packets, selection and crop-specific harvest feedback.
  The other five portraits are art studies, not enabled economic goods.
- Broad modeled timber boardwalk, textured soil, softened worn entrance patches,
  larger mature Splinter crowns and leaf mass, and warm character palette renders.
  The sourced groundskeeper remains a development preview; it is not enabled in
  production. Its source, attribution, 136 directional frames and atlases remain.
- Owner-and-board-scoped device scenery drafts survive reload. Validation permits
  only scenery metadata. Wallet changes hide drafts; restoring the verified owner
  restores them. A changed server revision preserves the draft, disables Save,
  and offers explicit reload or cancel. Successful save/cancel clears the draft.
- WoodAmp restores the track, playback position, shuffle/repeat and zero volume
  on the current device, always paused. Changed/removed recordings do not inherit
  stale positions. Explicit playback seeks after media metadata arrives.
- Pine discovery uses real accepted stamp receipts and a repeatable-read snapshot.
  Nested ALL/ANY/NOT, at least/at most/exact/inclusive-range comparisons, current
  and lifetime totals/supporters, explicit sort and shareable URLs are integrated.
  Author/post moderation and authenticated two-way block lists filter results.
  Older result links fetch their exact approved Pine instead of relying on the
  default 30-post feed window.
- Satchel supports arrow-key movement, viewport resize clamping and focus return.
  Open the lot now fills the mobile viewport; Escape closes it and restores focus.
  Collapsed guide and combined toolbar leave more space for the garden.

## Verification

- Production `npm run build` passes. Existing Turbopack tracing warning in
  `next.config.ts` remains; this is not a warning-free build.
- `npx tsc --noEmit` passes.
- `npm run lint:inmotion` passes. Scoped UI/API/reputation lint has no errors and
  two existing Porch warnings (epoch cleanup and the small official image).
- Full `npm test`: 212 contract tests; 1,319 market tests passed, 50 skipped,
  zero failed. Separately, 20 targeted Charmville/WoodAmp tests passed with the
  isolated PostgreSQL tests enabled and no skips.
- Real local browser checks pass: claim, harvest, one-seed return, replant,
  interrupted-stamp recovery, wallet reattachment, persisted scenery, reduced
  motion, mobile satchel, keyboard movement, fullscreen lot and focus return.
- Dedicated browser checks pass for draft reload/wallet isolation/stale recovery
  and nested reputation searches/shared URL reload/older Pine navigation.
- WoodAmp browser check restored 0:43 paused, retained zero volume and playback
  preferences, then sought correctly after explicit Play.

Measured Chromium scheduling before the final small UI adjustments: p95 16.8ms
desktop and 16.7ms at 390px with 4x CPU throttling, no frames above 33.4ms during
the four-second samples. This is not physical-device GPU performance evidence.

## Visual review and remaining scope

Independent direction review progressed from 6 to 6.5/10, Tier 2 passed. It is
not an exact concept comparison or final art approval. Larger Splinter silhouettes
and broad boardwalk landed; surface richness, coherent character treatment and
mobile composition remain below the requested finish. The final entrance fade
was self-reviewed after the last independent verdict; it has no new judge score.

Reputation currently covers public Pines, at most the latest 1,000 text matches
and first 100 filtered results, explicitly disclosed. It does not yet cover
boards/comments/media adapters, saved-search accounts or snapshot pagination.
Current/lifetime values agree while stamps are permanent; no removal/refund policy
was invented. Reaction semantics and profile identity merge still need decisions.

The remaining unified vision includes the grain order book and escrow/collection,
many-key identity with primary-session authority, accepted outbound Pine intents
and human-owned caster delivery/reconciliation, client-encrypted cross-device
drafts and key recovery, cross-device continuity, public street/presence, later
crop recipes, civic/land progression, and final whole-board visual approval.
Existing specifications distinguish accepted rules from tuning proposals; this
checkpoint does not silently enable proposed financial or game-economy rules.

Parallel workers stopped when the workspace exhausted credits. Their landed
changes were reviewed and the final build/browser checks completed locally.
