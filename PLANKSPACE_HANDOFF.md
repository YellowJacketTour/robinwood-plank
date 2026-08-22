# PlankSpace integration handoff

This archive is based on `YellowJacketTour/robinwood-plank` branch
`PlankSpace1`. It is a test-only merge package; it does not include `.git`,
secrets, deployment output, or a live deployment.

## Included

- `app/plankspace/page.tsx`: the new Plank.love tab route.
- `components/PlankSpaceBridge.tsx`: strict-origin wallet bridge using the
  existing shared `WalletProvider`, Robinhood Chain switch helper, and
  `personal_sign` implementation.
- `lib/constants.ts`: PlankSpace navigation entry.
- `next.config.ts`: CSP permission for the isolated PlankSpace frame.
- `integrations/plankspace-app/`: the complete current PlankSpace application,
  including every page, API route, migration, test, visual update, custom CSS
  sanitizer, social feed, friend requests, Top 8 controls, terms gate, game,
  YouTube module, and profile editor.
- `integrations/plankspace-app/exported-data/profiles-public.json`: full public
  state exported from all 11 active profiles, including DegenWaffle's bio,
  theme, module order, custom layout, mood, and featured video.
- `integrations/plankspace-app/exported-data/wallet-claims.json`: wallet claim
  mapping for all pre-created profiles.
- `integrations/plankspace-app/exported-data/avatars/degenwaffle.png`: the
  recovered live DegenWaffle profile picture.

## Authentication posture

All testing shortcuts were removed. There are no PIN pages, PIN APIs, session
cookies, hidden owner wallet substitutions, DegenWaffle test buttons, or
Sawtoshi test buttons. Profile editing requires a wallet challenge and
signature. DegenWaffle and Sawtoshi remain the two approved admin wallets, but
admin list/moderation actions also require fresh wallet signatures.

## Local test

1. Run the Plank.love repository normally.
2. In `integrations/plankspace-app`, run `npm ci` and `npm run dev`.
3. Set `NEXT_PUBLIC_PLANKSPACE_URL` in the Plank.love test environment to the
   PlankSpace test origin. Do not commit a populated production env file.
4. Open `/plankspace`; wallet state and signing are delegated to Plank.love.

The included standalone build was validated with `npm test`: production build
and all 10 tests passed. Before a PR, run the repository gates documented in
`AGENTS.md`: `npm run lint:inmotion`, `npx tsc --noEmit`, `npm test`, and
`npm run build` from a clean Node 22 installation.

## Persistence migration note

The current PlankSpace preview uses Cloudflare D1/R2. Plank.love production is
PostgreSQL on InMotion. The exported profile JSON and avatar are included so
the live-created state is not lost while the API storage adapter is ported to
PostgreSQL. Do not point the D1 build at production and do not add Redis,
Upstash, or a second production source of truth.
