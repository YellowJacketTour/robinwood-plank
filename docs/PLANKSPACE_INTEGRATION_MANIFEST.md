# PlankSpace Selective Integration Manifest

## Inputs

- Base: `origin/master` at `4ad4c09fb49f00fff9f227a6a8046de9e7cdc3f0`
- Source: `origin/plankspace-integration` at `d5bf69434598c06a2cf25c4ab740bd50c0040e18`
- Working branch: `release/plankspace-preview`
- Policy: current master is authoritative; no wholesale merge of the stale source branch.

## Classification Rules

- **PORT:** Existing PlankSpace product code, tests, assets, or documentation.
- **ADAPT:** Shared, deployment-sensitive, storage-sensitive, wallet-sensitive, configuration, or dependency files that require line-by-line reconciliation.
- **REJECT:** Temporary scripts, patch notes, backup files, and retired source.
- New portfolio tracking, trade tracking, and Fomo-style concepts are outside this diff and outside scope.

## Path Manifest

| Git status | Path | Decision | Reason |
| --- | --- | --- | --- |
| `M` | `.env.docker.example` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `M` | `.env.inmotion.example` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `M` | `.github/workflows/inmotion.yml` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `M` | `DESIGN.md` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `PRODUCT.md` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `README-APPLY-PATCH.txt` | REJECT | Temporary, backup, patch, or retired artifact; not production source. |
| `A` | `README-PLANKSPACE-STORAGE-FIX.txt` | REJECT | Temporary, backup, patch, or retired artifact; not production source. |
| `A` | `README-PLANKSPACE-WALLET-PROOF-FIX.txt` | REJECT | Temporary, backup, patch, or retired artifact; not production source. |
| `A` | `START-PLANKSPACE-LOCAL.bat` | REJECT | Temporary, backup, patch, or retired artifact; not production source. |
| `A` | `STOP-PLANKSPACE-LOCAL-DB.bat` | REJECT | Temporary, backup, patch, or retired artifact; not production source. |
| `A` | `VERIFY-PLANKSPACE-STORAGE.bat` | REJECT | Temporary, backup, patch, or retired artifact; not production source. |
| `A` | `_to_delete/plankspace-woodstock-live/live-directory.tsx` | REJECT | Temporary, backup, patch, or retired artifact; not production source. |
| `A` | `_to_delete/plankspace-woodstock-live/live-lounge.tsx` | REJECT | Temporary, backup, patch, or retired artifact; not production source. |
| `A` | `_to_delete/plankspace-woodstock-live/live-provider.tsx` | REJECT | Temporary, backup, patch, or retired artifact; not production source. |
| `A` | `_to_delete/plankspace-woodstock-live/live-room-card.tsx` | REJECT | Temporary, backup, patch, or retired artifact; not production source. |
| `A` | `_to_delete/plankspace-woodstock-live/profile-live.css` | REJECT | Temporary, backup, patch, or retired artifact; not production source. |
| `A` | `_to_delete/plankspace-woodstock-live/woodstock-directory.tsx` | REJECT | Temporary, backup, patch, or retired artifact; not production source. |
| `A` | `app/(plankspace)/about/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/(plankspace)/board-mail/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/(plankspace)/board-safety/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/(plankspace)/browse/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/(plankspace)/create-profile/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/(plankspace)/grain-policy/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/(plankspace)/help/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/(plankspace)/layout.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/(plankspace)/mood/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/(plankspace)/planks-list/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/(plankspace)/profile-editor/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/(plankspace)/search/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/(plankspace)/u/[handle]/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/(plankspace)/woodstock/[slug]/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/(plankspace)/woodstock/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/admin/content/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/admin/profiles/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/auth/challenge/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/auth/session/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/avatar/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/content/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/feed/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/friends/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/layout-asset/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/live-rooms/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/mail/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/mood/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/notifications/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/planks/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/plankspace-media/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/posts/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/profile-comments/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/profile-preferences/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/profile-visits/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/profiles/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/publications/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/relations/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/scores/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/tips/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/widget-market/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/widgets/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/x/callback/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/x/connect/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/x/disconnect/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/x/status/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/api/x/sync/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/not-found.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/plankspace/admin/content/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/plankspace/admin/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/plankspace/layout.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/plankspace/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `app/plankspace/terms/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `M` | `components/Footer.tsx` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `M` | `components/market/MarketView.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `components/plankspace/PlankSpaceFrame.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `deploy/inmotion/postgres/migrations/011_plankspace_native.sql` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `A` | `deploy/inmotion/postgres/migrations/033_plankspace_profile_seed_repair.sql` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `A` | `deploy/inmotion/postgres/migrations/034_plankspace_post_media.sql` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `A` | `deploy/inmotion/postgres/migrations/034_plankspace_profiles_social_woodstock.sql` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `A` | `deploy/inmotion/postgres/migrations/034_plankspace_widgets_woodstock.sql` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `A` | `deploy/inmotion/postgres/migrations/035_woodstock_live_schema_repair.sql` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `A` | `deploy/inmotion/postgres/migrations/081_plankspace_profile_customization.sql` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `A` | `deploy/inmotion/postgres/migrations/082_plankspace_x_integration.sql` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `A` | `deploy/inmotion/postgres/migrations/083_plankspace_x_action_limits.sql` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `M` | `docker-compose.inmotion.yml` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `A` | `docs/PLANKSPACE_X_SETUP.md` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `docs/superpowers/plans/2026-08-28-plankspace-profile-customization.md` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `docs/superpowers/plans/2026-08-28-plankspace-safe-widgets.md` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `docs/superpowers/plans/2026-08-28-plankspace-x-integration.md` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `docs/superpowers/specs/2026-08-28-plankspace-customization-widgets-x-design.md` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `M` | `eslint.config.mjs` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/about/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/admin-access-auth.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/admin-nav-link.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/admin/content/admin-content.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/admin/content/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/admin/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api-client.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/admin/profiles/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/auth/challenge/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/auth/hash.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/auth/session/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/auth/verify.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/avatar/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/content/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/feed/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/friends/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/layout-asset/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/live-rooms/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/mail/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/media-upload/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/mood/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/notifications/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/planks/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/posts/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/profile-comments/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/profile-preferences/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/profile-visits/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/profiles/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/publications/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/relations/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/scores/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/tips/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/widget-market/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/widgets/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/x/callback/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/x/connect/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/x/disconnect/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/x/status/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/api/x/sync/route.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/auth-client.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/board-mail/board-mail-client.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/board-mail/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/board-safety/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/bridge-notice.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/browse/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/chatgpt-auth.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/content-actions.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/create-profile/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/custom-profile-css-v2.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/custom-profile-css.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/customization/default-profile-css.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/customization/profile-css.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/customization/profile-customization.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/globals.css` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/grain-policy/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/help/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/home-feed.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/layout.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/lumberyard.css` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/mood/mood-editor.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/mood/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/owner-access-auth.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/plank-love-wallet.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/plank-page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/planks-list/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/planks-list/planks-list-client.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/plankspace-subnav.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/post-media-ui.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/post-media.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/profile-editor/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/profile-extras.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/profile-form.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/profile-social.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/profile-tools-visibility.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/profile-video-player.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/search/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/terms-gate.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/terms/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/top-eight-manager.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/u/[handle]/knock-form.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/u/[handle]/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/widget-live.css` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/widgets/external-widget-document.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/widgets/external-widget-frame.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/widgets/profile-widgets.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/widgets/widget-manager.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/widgets/widget-safety.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/widgets/widget-types.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/woodstock/[slug]/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/woodstock/page.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/x/account.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/x/crypto.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/x/policy.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/x/provider.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/x/settings.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/x/sync.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/app/x/x-connection-manager.tsx` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/db/index.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/db/schema.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `integrations/plankspace-app/db/schema.ts.before-widget-repair` | REJECT | Temporary, backup, patch, or retired artifact; not production source. |
| `M` | `lib/boards-store.ts` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `M` | `lib/constants.ts` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `M` | `lib/postgres.ts` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `M` | `lib/uploads.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `M` | `lib/wallet-context.tsx` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `M` | `next.config.ts` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `M` | `package-lock.json` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `M` | `package.json` | ADAPT | Production-sensitive or shared-master file; reconcile line by line against current master. |
| `A` | `public/images/plankspace/degenwaffle.png` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `public/plank-classic.jpeg` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `public/plank-robinwood.png` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `scripts/sync-plankspace-x.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `test/market/plankspace-default-profile-css.test.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `test/market/plankspace-profile-css.test.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `test/market/plankspace-profile-customization.test.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `test/market/plankspace-widget-safety.test.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `test/market/plankspace-x-account.test.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `test/market/plankspace-x-crypto.test.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `test/market/plankspace-x-discoverability.test.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `test/market/plankspace-x-policy.test.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `A` | `test/market/plankspace-x-provider.test.ts` | PORT | Existing PlankSpace product surface; port selectively and verify. |
| `M` | `tsconfig.json` | PORT | Existing PlankSpace product surface; port selectively and verify. |

## Baseline Verification

Results will be recorded before the first product-code port.

| Command | Result | Notes |
| --- | --- | --- |
| `npx --yes npm@11.6.2 ci` | Pass | Exact CI npm version required; npm 10.9.3 rejects the npm 11 lockfile. Existing audit output: 22 low, 10 moderate, 6 high. |
| `npm run lint:inmotion` | Pass | Exit 0 on current-master baseline. |
| `npx tsc --noEmit` | Pass | Exit 0 with no diagnostics. |
| `npm test` | Pass | Application: 1,084 pass, 0 fail, 33 skip. Contracts: 374 pass. Sandbox misreported Windows user lookup as ENOMEM; identical suite passed outside that restriction. |
| `npm run build` | Pass | Next.js 16.2.12 production build completed. Existing warning: parent-directory lockfile caused workspace-root inference and a broad NFT trace advisory. |

## Release Evidence

Final exact-SHA validation, screenshots, migration effects, rollback implications, and tester URLs will be recorded here before the preview branch is pushed.
