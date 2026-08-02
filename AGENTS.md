<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Repository rules

- `master` is the deployment branch: a push to it builds and deploys to
  InMotion. `dev` is the working branch — do development there and merge into
  `master` to ship. Do not commit directly to `master` for anything that is
  not itself a release. (Until 2026-08-02 this was inverted: `inmotion` was
  both the working and the deploy branch, and `master` was untouched.)
- Preserve unrelated local changes and stage explicit paths.
- Read `README.md`, `ARCHITECTURE.md`, and `CONTRIBUTING.md` before changing
  deployment, storage, wallet, marketplace, or relayer behavior.
- **Read `DESIGN.md` before any change to UI, layout, styling, or new pages.**
  It is the canonical source for color tokens, typography, spacing, the
  background-treatment split between marketing and app pages, the
  `data-market-shell` styling-boundary mechanism, and the plank-character-art
  brand rule. Component code must use the token names and mechanisms it
  documents, not ad hoc hexes or a competing naming scheme.
- **Vaults are an N-vault registry, not a hardcoded pair.** Resolve every vault
  through `lib/market/vault-registry.ts` by *address*, never by role — with more
  than one legacy, "the legacy vault" is ambiguous. Never remove a legacy from
  `NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESSES` until its `heldTokenCount` is `0`;
  doing so bricks every client call to it ("Blocked unsafe vault target").
- **Never render a vault version number in the UI.** `V1`/`V2`/`V3` are internal
  identity only. Users see product names — Driftwood, WormWood, Premium Plank
  Liquidity — from `VAULT_NAMES` in the registry.
- **Do not migrate users into V2.** Its LP primitive has a proven, externally
  drain (audit held privately, not in this repo). V3 is the destination.
- Never print, commit, or copy production secrets into release artifacts.
- `RELAYER_PRIVATE_KEY` is cron-only and must not be loaded by Passenger.
- PostgreSQL migrations are append-only and must remain compatible with the
  immediately previous release.
- Run `npm run lint:inmotion`, `npx tsc --noEmit`, `npm test`, and
  `npm run build` before shipping.
