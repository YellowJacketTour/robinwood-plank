# PlankSpace audit — 2026-08-22

## Verified and included

- 11 pre-created profiles and wallet claims.
- DegenWaffle profile picture, bio, interests, custom layout, module order,
  mood, and featured YouTube link.
- Unique handles; editable profiles; avatars; moods; configurable Top 8;
  friends and requests; default DegenWaffle and Sawtoshi friendships; global
  and connections feeds; feed avatars; compact scrollable profile feed;
  knocks, likes, reports, notifications, Board Mail, mini-game, terms gate,
  public browse/search pages, and safe custom HTML/CSS application.
- Full-page custom CSS translation/sanitization, including legacy MySpace
  selectors, CRT overlays, background images, and blocked executable or
  layout-breaking declarations.
- All public navigation destinations resolve to real pages.

## Removed

- DegenWaffle passcode and owner-session API.
- Sawtoshi PIN and delegated-session API.
- Floating bypass controls, special login links, and shortcut profile access.
- Server-side signature bypass branches for profiles, posts, likes, comments,
  moods, mail, notifications, feeds, relations, friend requests, scores,
  preferences, reports, and moderation.
- The test-access attempt table is dropped by migration
  `0019_remove_test_access.sql`.

## Integration boundary

- Plank.love remains the wallet source of truth through its existing shared
  wallet context.
- The frame bridge accepts messages only from the configured exact origin,
  verifies that requested signing address equals the connected wallet, and
  signs only messages beginning with `PlankSpace authorization`.
- Profile data remains off-chain; wallet signatures authorize changes but do
  not imply token transactions or custody.
- A PostgreSQL storage adapter is still required before a production merge;
  this package intentionally preserves the current isolated D1/R2 test app and
  exports all state needed for that port instead of silently creating a second
  production datastore.
