<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Repository rules

- `inmotion` is the canonical development and deployment branch. Do not target
  `master` with InMotion work.
- Preserve unrelated local changes and stage explicit paths.
- Read `README.md`, `ARCHITECTURE.md`, and `CONTRIBUTING.md` before changing
  deployment, storage, wallet, marketplace, or relayer behavior.
- **Read `DESIGN.md` before any change to UI, layout, styling, or new pages.**
  It is the canonical source for color tokens, typography, spacing, the
  background-treatment split between marketing and app pages, the
  `data-market-shell` styling-boundary mechanism, and the plank-character-art
  brand rule. Component code must use the token names and mechanisms it
  documents, not ad hoc hexes or a competing naming scheme.
- Never print, commit, or copy production secrets into release artifacts.
- `RELAYER_PRIVATE_KEY` is cron-only and must not be loaded by Passenger.
- PostgreSQL migrations are append-only and must remain compatible with the
  immediately previous release.
- Run `npm run lint:inmotion`, `npx tsc --noEmit`, `npm test`, and
  `npm run build` before shipping.
