# Account entrance and builder checkpoint — 2026-09-09

Start: http://localhost:3017/charmville/start
Native tutorial: http://localhost:3021/charmville/tutorial/
Both links are local to this computer, not a public friend server.

## Implemented and verified
- New account entrance reuses PlankSpace wallet-signature sessions, profile creation/approval and the existing PostgreSQL-backed Porch. No separate PIN identity or invented wallet mapping.
- Browser regression uses an isolated local account: session restored, lot claimed, starter crop harvested, page reloaded and saved lot restored. Real external-wallet signing was not automated.
- Native tutorial adds a two-step welcome before the farming loop. Two browser players completed it and received each other's guest poses without exceptions.
- Community pack schema and validator check source provenance separately from rights, pinned dependencies, four-direction frames, bounds, anchors, contact timing, explicit flips, and optional PNG hashes/dimensions. Registry/review/editor integration is not yet built.
- Pure preparatory server action simulation checks timing, reservations, cancellation and retry deduplication. It is not connected to authentication, PostgreSQL or the native runtime and grants no live inventory.

## Validation
Repository lint and TypeScript passed. npm test: 212 contract tests passed; market tests 1326 passed, 50 skipped, zero failed. Production build passed. New pack/authority tests: 26 passed. Browser screenshots and verification are in the chat outputs/onboarding and outputs/onboarding-native directories. A final background-only page change followed the production build; scoped lint and browser check were repeated.

## Continue from here
First join the native action runtime to server-owned actions and existing PlankSpace identity, using short-lived scoped session transport, never bearer tokens in URLs. Do not trust native crop counters for inventory. Retain receipt/revision/transaction guarantees already in lib/charmville/store.ts. Resolve remaining native sprite rendering/flip/prop alignment before calling actions source-faithful. Then expand a connected playable loop: account, guide, private property, gathering, crafting, creature encounter/capture/follower, social charm use, exchange, shared settlement. Civilization and galaxy progression must extend the same entity, location and ownership model.

The requested complete polished multi-title MMO, public friend access, rich transformed character artwork, creature combat, source-faithful tools and collaborative editor are unfinished. This checkpoint improves the entry and validates reusable foundations; it is not completion of that vision.
