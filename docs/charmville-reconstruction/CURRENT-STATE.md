# Current integration checkpoint

Updated 2026-09-09. This section supersedes the historical snapshots below. Read FEATURE-PROGRESS.md and the latest Git history for evidence; the older garden/frontier descriptions are not the current product direction.

The playable route is `/charmville/world?panel=play` on local port3017, with native runtime on3021. The standalone garden UI is retired. Authenticated native movement, bounded same-region peers, private Oran cultivation with conserved inventory, six-member isolated test rosters, persistent companion HP/PP, supported turn combat and home recovery are connected locally. A consented one-move helper now contributes to the same wild encounter without taking control. Two-account browser and PostgreSQL checks cover the assist, expiry, revocation and retries. Read SHARED-BATTLE-SCENE.md, SIX-MEMBER-TEST-PARTY.md and NATIVE-ECONOMIC-LOOP.md.

Native committed attack presentation is being integrated separately; consult NATIVE-WORLD-ENCOUNTER.md for its verified coverage rather than assuming every species or move has animation. Full raids, real-time sword authority, autonomous companion combat, capture/evolution/rewards, broad authored maps, shared status clocks and production-scale networking remain unfinished.

UNIFIED-COMBAT-RESEARCH.md and RESEARCH-OSRS-DIABLO.md, RESEARCH-PARTY-AND-PRESENTATION.md and RESEARCH-WORLD-OF-WARCRAFT.md distinguish source findings from proposed synthesis. SWARM-WORK-QUEUE.md maps the wider backlog; assignments and bars do not imply release readiness.

## Historical snapshots (superseded where inconsistent above)

Latest checkpoint: see ACCOUNT-AND-BUILDER-CHECKPOINT.md (2026-09-09). Account entrance at /charmville/start, native welcome, validated pack and preparatory authority modules.

Latest working build (2026-09-09): read [HOMESTEAD-PLAYTEST.md](HOMESTEAD-PLAYTEST.md). Native-212 authored quest now runs a till/plant/water/harvest loop, prototype XP, moving gold aura and two-player guest sprite presence after harvest. Real browser WebSocket traffic is verified. Earlier invalid-quest results included an HTTP compression mistake; native 219 still gives Version not supported after correcting it. Progress remains session-only and unauthenticated; Pokemon, account inventory/economy and full source animation fidelity remain missing. Continue from the working native tutorial and transport.

Latest audit (2026-09-09): [ANIMATION-AND-INTEGRATION-AUDIT.md](ANIMATION-AND-INTEGRATION-AUDIT.md) records native animation evidence and new source acquisitions. The actual browser editor is version 212 and rejects the `websocket` type with T047. Native version 219 compiles the probe, but its saved quest is rejected by this browser player. No network frames or combined farming/creature/skills gameplay have been demonstrated. First integration gate: use a matched editor/compiler/player build, then verify one authoritative planted plot and harvested inventory/XP transaction in the native world. The existing adventure remains an unmodified source quest in nonpersistent test mode.

Latest gameplay update: see [DIRECT-ADVENTURE.md](DIRECT-ADVENTURE.md). The active playtest now skips the source introduction and starts with equipment in Autumn Town. This is native test mode, not persistent MMO integration.

# Current state â€” read before resuming

Updated 2026-09-09 during account-transition preservation. Check subsequent Git commits and this file's latest version before acting.

## Product status

The full vision is NOT implemented. The completed work is an existing PlankSpace/market application, experimental garden/social components, a rejected visual frontier, a large acquired research/source collection, source indexing, and an original adventure runtime brought up locally. There is no verified combined Zelda/FarmVille/PokÃ©mon/OSRS multiplayer slice yet.

### Working or evidenced

- Main local app: http://localhost:3017/charmville/frontier; prior garden at `/charmville/play`.
- Frontier experiment: R3F scene, avatar movement, grass cutting, saved scenery, cosmetic UFO, source library and charm atlas. These controls passed earlier browser checks but art was rejected.
- Imported memoji registry contains **78 identities** (not 77 images, not seven crops). Some emoji strings are empty, and `uowo` has no dedicated pool. Preserve those rows. Registry is an osmo-test-5 source snapshot, not a verified complete current live market or owned inventory.
- Source library previously indexed 44,178 supported asset files; this count predates the latest ZQuest acquisitions. Do not use it as the total current collection size. Full per-file evidence for 16 selected repos is in `source-evidence/`; broader complete snapshots are in vault archives.
- Emerald source graph: 518 maps, 1,313 warp events, 2,776 object events. 45 destinations need special/dynamic mapping analysis. `public/charmville/library/emerald-worlds.json` stores parsed source data.
- ZQuest runtime at http://localhost:3021/play/?open=quests/purezc/139&name=Charmville&storage=idb starts The Hero of Dreams by Shoelace. Name entry and the original story sequence have been observed. Controls are upstream; no complete combat/dungeon playthrough certified.
- Initial missing MIDI instruments crash fixed by including `zquest-classic/timidity`.
- Embedded browser initialization failure reproduced: `/zquest_web.cfg` missing because engine startup raced the data loader. Fixed by ordering data scripts before the engine script. Verified actual in-app browser reaches name entry with `storage=idb`.
- Hosted upstream editor acquired at http://localhost:3021/create/. Basic boot only, not verified full editing/export. Existing authored quest protection may apply.
- Hero of Dreams, Lost Isle and Isle of Rebirth snapshots are under `zquest-quest-snapshots`. After backup completion, the server was adapted to serve these three quests and the local index with external connections blocked. Fresh/repeat browser-storage startup and original quest opening passed with zero external requests/page errors/HTTP failures. WASM and original quest files were not modified.
- New item reference browser: http://localhost:3017/charmville/catalog â€” 435 original definitions (377 Emerald table slots, including unused/default entries, plus 58 Solarus DX scripts), 510 preserved source artifacts including original PNGs, palettes and Lua scripts. The catalog connects identity, usage entry points, revisions, hashes and sprite anchors. It does not grant or implement gameplay items. Search/inspection of Master Ball capture behavior and Solarus bow behavior was browser-verified; typecheck/build/scoped lint passed.

### Critical missing or unverified

- Unified multiplayer region simulation, action validation, two-player visibility and conflict handling.
- Source-faithful mechanics migrated/adapted into a shared farming/capture/skills world.
- Shared authoritative inventory with social issuance, Grained Exchange and DeFi settlement.
- Complete original-game catalogs for all inspirations; copied source does not equal integrated catalog.
- Emerald runtime/toolchain and capture playthrough; Zelda3 original-resource extraction; Solarus engine/quest runtime benchmark.
- Full Graal Classic/Era client/world source. Graal Reborn server is only a partial substitute. Its nested wolfssl dependency fetch failed with corrupted/missing object `4fbd4fd36a21efd9d1a7e17aba390e91c78693b1`; do not call submodule initialization complete.
- ZQuest hosted binary equivalence to acquired Git source revision. Solarus source is explicitly pinned v2.1.3, not initial master 2.2 development.
- Final bespoke art direction, animation parity, community editor workflow and eventual production-scale world.

### Authoring integration investigation after the catalog checkpoint

Read ENGINE-INTEGRATION.md. The original native editor round-tripped 2,065 Hero of Dreams dialogue slots and 42 presentation fields with byte-identical re-export. The original native compiler accepts `WorldLink.zs` and emits WebSocket instructions. **The probe is not attached to a live quest and is not evidence of multiplayer.** The next executable gate is a supported script-assignment/build workflow and actual browser transport, followed by authoritative state validation. Native tools are an additional acquired source collection, preserved separately from the original immutable 41-archive release.

## Code entry points

- `app/charmville/frontier/{page.tsx,frontier.tsx,world.tsx,frontier.module.css}` â€” rejected experimental district + atlas/library + local source launch links.
- `app/charmville/play/`, `integrations/plankspace-app/app/charmville/` â€” prior garden and its integration.
- `lib/charmville/` and `app/api/charmville/` â€” existing domain, reputation, navigation, content and local playtest code. Read before replacing anything.
- `integrations/plankspace-app/app/api/posts/route.ts`, profile/search integrations â€” social/reputation work.
- `components/woodamp/WoodAmpProvider.tsx`, `lib/woodamp-continuity.ts` â€” music continuity work preserved from preceding development.
- `scripts/charmville/` â€” render/source/index/audit/verification/recovery scripts.
- `public/images/charmville/` â€” originals, editable Blender models, frames, packed caches, sourced art and credits.
- `public/charmville/library/` â€” derived source and memoji indexes. Full large source directories are siblings outside app.
- `app/charmville/catalog/`, `public/charmville/reference-items/`, `scripts/charmville/index-reference-items.mjs` â€” new source-aware item inspection pipeline.
- `scripts/charmville/verify-reference-runtime.mjs` â€” cold/warm storage and original-quest opening with all external network blocked.

## Preservation and validation

The main development checkpoint and private archive verification are recorded in `BACKUP-RECEIPT.md`. All 41 source-collection archives (6,139,960,649 compressed bytes) passed remote size/SHA-256 verification. Environment files, real credentials, browser saves and database state are intentionally excluded. Source archives are recovery assets, not a database backup.

The handoff checkpoint passed lint:inmotion, TypeScript, 212 contract tests, 1,326 market tests (50 skipped), build and scoped new-code lint. Those tests do not establish source-game fidelity or the full MMO behavior. Latest user additions are preserved in CREATURE-AND-QUEST-CONTRACT.md: one creature across action/staged combat, following, status/HP continuity, rich authored event reuse and private properties connected to world regions.

## Operational details

Local reference server binds 127.0.0.1:3021 and needs COOP/COEP headers for SharedArrayBuffer. Do not remove them. Development app 3017 is a preexisting process: do not kill unrelated servers. Runtime acquisition redownloads upstream current bytes; use archived snapshot for exact recovery. Main app live reload covers application edits; standalone upstream runtime edits require refreshing that page. No production deployment has been performed as part of this account-transition checkpoint.

Latest correction: enabled native sword slashing and spin/super-spin scrolls, then expanded the test kit to high-tier gear. See ENDGAME-AND-CROSSOVER-ABILITIES.md. Custom crossover powers remain planned, not implemented.

