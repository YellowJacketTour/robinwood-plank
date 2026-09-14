# Co-op, source art and guide acceptance

Observed on localhost:3018 in the existing Codex tab on September 14, 2026. This report covers local work; it is not a production completion claim.

## Player-visible changes

The unified menu names shared travel Co-op and keeps post interaction in Social. Co-op offers one travel or invitation page at a time. Its current empty state explains how to invite a friend. Existing `panel=friends` deep links continue to work.

The Journal contains an original four-wing orb guide with three local appearance choices and reduced-motion support. Its next action follows saved journey receipts. Reading can be advanced with Right/A, closed with B without leaving Journal, and resumed at the same page. A successful new home claim routes to Journal before the default companion-selection flow. The actual native soulbound follower and healing ability have not been implemented by this UI work.

The in-game Dex browses 308 mapped, non-placeholder entries from 435 source definitions. Its palette pipeline produces 319 item presentations and records 377 original-game descriptions. Source entries do not grant ownership, capture ability, economic value or a new gameplay effect. The live review confirmed distinct Ice Heal, Awakening, Parlyz Heal and potion colors after the native palette correction. Selecting an item with arrows updates art and description together.

## Browser evidence

- Same visible tab: Co-op travel and invitations; Journal opening page 1 → Father page 2 using Right; B closed only the reader and Continue became available; fairy appearance changed to Warm gold; Dex Burn Heal → Ice Heal using Right.
- Separate fresh synthetic account: home claim → Journal → opening controls → home admission → soil instruction. No companion or gift was implicitly granted. Generated accounts were removed; existing profile 26 remained unchanged. See `scripts/charmville/verify-fresh-guide-browser.mjs` and local `work/fresh-guide-browser/`.
- Mobile menu-only review at 390×844: native runtime deliberately blocked, guide padding top/bottom 0px, width 332px, no horizontal overflow. Screenshots in release-integration `work/compact-mobile-review/`. This is not mobile gameplay acceptance.
- Four isolated browser contexts received twelve actual local WebRTC video feeds with decoded frames and source-color continuity. The sources were explicitly labeled synthetic canvases. See `FOUR-PROFILE-MEDIA-ACCEPTANCE-20260914.md`.

## Verification

The repository suite passed: contract tests, 2,026 market tests with 126 explicit environment skips, and 250 Akasha tests. Separate targeted asset tests verified PNG chunk CRCs, preserved pixel indices/transparency and palette identity. Fresh-account and four-profile PostgreSQL/browser checks ran against isolated local synthetic data. InMotion lint, TypeScript and the production build passed. Native candidate verification is tracked separately in `NATIVE-ASPECT-IMPLEMENTATION-20260914.md`.

## Release limits

The accepted runtime has not been replaced. Native wide output is experimental, not certified across all effects or devices. Kakariko source maps, full cinematic/avatar parity, native fairy following/healing, four rendered game participants, production SFU/TURN broadcasting, and broad animation coverage remain open. The staged release follows feature → dev → master; this pass does not claim master deployment.
