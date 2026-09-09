# Current state — read before resuming

Updated 2026-09-09 during account-transition preservation. Check subsequent Git commits and this file's latest version before acting.

## Product status

The full vision is NOT implemented. The completed work is an existing PlankSpace/market application, experimental garden/social components, a rejected visual frontier, a large acquired research/source collection, source indexing, and an original adventure runtime brought up locally. There is no verified combined Zelda/FarmVille/Pokémon/OSRS multiplayer slice yet.

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
- Hero of Dreams, Lost Isle and Isle of Rebirth quest resource snapshots, manuals/metadata where supplied, have been acquired under `zquest-quest-snapshots` for preservation. The current player still requests the upstream quest manifest/content; offline wiring remains outstanding.

### Critical missing or unverified

- Unified multiplayer region simulation, action validation, two-player visibility and conflict handling.
- Source-faithful mechanics migrated/adapted into a shared farming/capture/skills world.
- Shared authoritative inventory with social issuance, Grained Exchange and DeFi settlement.
- Complete original-game catalogs for all inspirations; copied source does not equal integrated catalog.
- Emerald runtime/toolchain and capture playthrough; Zelda3 original-resource extraction; Solarus engine/quest runtime benchmark.
- Full Graal Classic/Era client/world source. Graal Reborn server is only a partial substitute. Its nested wolfssl dependency fetch failed with corrupted/missing object `4fbd4fd36a21efd9d1a7e17aba390e91c78693b1`; do not call submodule initialization complete.
- ZQuest hosted binary equivalence to acquired Git source revision. Solarus source is explicitly pinned v2.1.3, not initial master 2.2 development.
- Final bespoke art direction, animation parity, community editor workflow and eventual production-scale world.

## Code entry points

- `app/charmville/frontier/{page.tsx,frontier.tsx,world.tsx,frontier.module.css}` — rejected experimental district + atlas/library + local source launch links.
- `app/charmville/play/`, `integrations/plankspace-app/app/charmville/` — prior garden and its integration.
- `lib/charmville/` and `app/api/charmville/` — existing domain, reputation, navigation, content and local playtest code. Read before replacing anything.
- `integrations/plankspace-app/app/api/posts/route.ts`, profile/search integrations — social/reputation work.
- `components/woodamp/WoodAmpProvider.tsx`, `lib/woodamp-continuity.ts` — music continuity work preserved from preceding development.
- `scripts/charmville/` — render/source/index/audit/verification/recovery scripts.
- `public/images/charmville/` — originals, editable Blender models, frames, packed caches, sourced art and credits.
- `public/charmville/library/` — derived source and memoji indexes. Full large source directories are siblings outside app.

## Preservation and validation

The main development checkpoint and private archive verification are recorded in `BACKUP-RECEIPT.md` when complete. Do not infer completion from a draft release or a partially written manifest. Environment files, real credentials, browser saves and database state are intentionally excluded. Source archives are recovery assets, not a database backup.

Prior to handoff, the previous frontier checkpoint passed lint:inmotion, TypeScript, 212 contract tests, 1,326 market tests (50 skipped), and build. Current handoff checks are being rerun; their final result belongs in BACKUP-RECEIPT.md. Those tests do not establish source-game fidelity or the full MMO behavior.

## Operational details

Local reference server binds 127.0.0.1:3021 and needs COOP/COEP headers for SharedArrayBuffer. Do not remove them. Development app 3017 is a preexisting process: do not kill unrelated servers. Runtime acquisition redownloads upstream current bytes; use archived snapshot for exact recovery. Main app live reload covers application edits; standalone upstream runtime edits require refreshing that page. No production deployment has been performed as part of this account-transition checkpoint.
