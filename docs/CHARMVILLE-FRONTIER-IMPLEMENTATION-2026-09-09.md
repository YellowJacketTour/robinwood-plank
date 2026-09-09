# Frontier implementation — September 9, 2026

Local test: http://localhost:3017/charmville/frontier

This extends the existing checkout without replacing its account-aware garden or deploying the dirty worktree. The garden entry links to the frontier. Full intent is recorded in CHARMVILLE-FULL-PRODUCT-VISION-2026-09-09.md.

## Implemented

- Dedicated R3F district with original workshop GLBs, botanical sprites, animated Quaternius-derived character, orthographic camera, and mobile player following.
- Pointer and keyboard movement, cooldown-limited sword sweep, nearby grass clearing, and visit-local cutting count.
- Blossom placement, explicit device-local draft save, restoration, and reset.
- Camera reveal and UFO visual event. No authoritative destruction or salvage economy is implied.
- Searchable 78-identity memoji testnet snapshot. Empty emoji and absent pool fields are retained.
- Searchable 36,491-file index across 29 reference directories, with file hashes and source revisions where actually present. Full index loads only when the creator tab opens.
- 96 Kenney CC0 previews with source license notices and hash validation.
- Solarus MIT Starter and Trillium source acquisition in the adjacent references directory.

## Reproduce

Run from repository root:

```powershell
node scripts/charmville/ingest-library.mjs
node scripts/charmville/verify-library.mjs
node scripts/charmville/verify-frontier.mjs
```

The ingestion script defaults to `../charmville-references`, accepts a replacement root as its first argument, and never executes imported source. It excludes tooling, dependency trees and symlinks. It inventories supported art/model/audio formats; it is not yet a complete map/script converter. IDs use source plus relative path, while byte hashes identify content. Archive directories do not inherit the enclosing repository's git revision. Source-cleared does not mean art-direction-approved or runtime-integrated.

Browser verification checks movement, nine grass cuts on the tested path, one new placed object, saved draft, UFO toggle, atlas search, source filter and 390px layout. It fails on page exceptions. A physical phone/controller and multiplayer have not been tested.

## Remaining gaps

The scene is still sparse, with limited animation direction and no robust building collision. Cuttings are not durable inventory, scenery is not shared, and weapons do not affect server-owned entities. Bows, bombs, creature capture, skills, equipment, authoritative regions, player trading, civic construction, and DeFi settlement remain implementation work. The full specification preserves these requirements; do not mistake the current scene for an accepted visual target.

Do not expose the existing localhost-only playtest identity endpoint by removing its host or environment gates. This task has not created a public deployment, committed unrelated changes, or altered production balances/contracts.
