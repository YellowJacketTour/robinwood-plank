# Current camera work

The compact crop HUD is published on port3024. The native frame-sizing experiment failed live visual validation and was rolled back; normal play does not enable its adapter. Work now separates render-only viewport reads from simulation viewport reads. This is native source infrastructure, not a completed zoom feature. See WORLD-FIRST-HUD.md, WORLD-CAMERA-RESEARCH.md and RENDERER-CUTOVER.md. Public-event research is in PUBLIC-EVENT-EXPERIENCE.md. No capacity or full-camera acceptance gate has been promoted.
> Approved scope, 2026-09-13: Read [APPROVED-GLOBAL-COMPLETION-CONTRACT.md](APPROVED-GLOBAL-COMPLETION-CONTRACT.md) before planning or declaring completion. Its 25 GLOBAL acceptance gates supplement every retained earlier requirement. Adoption of a plan does not certify implementation; advanced experiments must beat documented baselines.

# September 13 parallel continuity implementation

The approved scope has executable metadata in `completion-gates.json`. Run `node scripts/charmville/check-completion.mjs --check` for structural validation and `--require-complete` for completion gating. Current result: 13 planned, 13 implementing, zero accepted, including retained prior vision. This prevents silent checklist reduction and acceptance without evidence metadata; it does not certify gameplay quality.

Implemented this round:

- Admission recognizes one lost-response replay for the same active destination and previous revision after current permission checks. The UI retries one transient failure with the same request; non-JSON HTTP failures retain their status. Return points, floors and reservations remain pending.
- Failed captures renew the active control lease; successful captures remain terminal and receipt replay remains mutation-free. Assistance checks the controller's current geometry/range. These are authorization snapshots, not distributed tick ordering.
- Canvas capture includes an optional native SDL game-output audio branch. No microphone/desktop capture is requested, and teardown preserves local speakers. Existing browser tab18/port3024 showed live picture and video-plus-audio-source status. Audible signal quality and remote delivery remain unverified; this is still local preview.
- Native presentation geometry and explicit lens-effect ownership compile. Sibling engine commit `eee0c5e` is preserved as `source-evidence/0001-refactor-zc-separate-presentation-geometry-and-lens-.patch`. Served WASM is unchanged; real zoom awaits world/HUD extraction.

Validation: application TypeScript check passed; 15 capture/preview tests passed; focused admission, capture lease, assist and ledger tests passed. Native helper WASM tests passed and normal maps.cpp/zelda.cpp objects compiled. PostgreSQL integration tests were extended but **not run** because no isolated test database URL was configured. No production database or wallet transaction was accessed. Main-app changes remain working-tree work, not a production release.

See [CONTINUITY-IMPLEMENTATION-RESEARCH.md](CONTINUITY-IMPLEMENTATION-RESEARCH.md) and [NATIVE-PRESENTATION-GEOMETRY-EVIDENCE.md](NATIVE-PRESENTATION-GEOMETRY-EVIDENCE.md). Next camera dependency: explicit world composition and immutable presentation state, then separate WASM candidate/parity checks. Next travel dependency: durable floor/return/reservation identity coordinated through schema, API, client and native admission.

# September 13 joined-world integration (working tree)

New research: [Global social world research](GLOBAL-SOCIAL-WORLD-RESEARCH.md) connects world allocation, homestead addresses, actual profile footage, theatres, media transport, creator packages and feature research coverage through20 cited sources. Recommendations are not implementation completion. Preserve the globally connected experience and explicit source/instance identity; never describe different combat copies as one shared encounter.

The active browser playtest is port3024, quest `/quests/charmville/homestead-region/r01/Homestead.qst`, dmap4/screen63, with `testParty=6`. Build using `node scripts/charmville/build-joined-homestead.mjs --publish`; this publishes a separate quest, preserving the previous account quest. This is the complete Homestead script in a native 512x352 joined region (origin46), not the earlier minimal RegionCandidate script.

Native full-loop evidence: `work/joined-motion/evidence.json` records 1,440 directional frames and 40 horizontal/vertical seam crossings with stable origin, no displacement over4px/frame, continuous six-follower trail, and moving camera. Two diagnostic setup placements precede those measurements. This is not a browser input or multiplayer load test.

Live browser evidence: the same tab starts the joined script, advances both introduction pages through accessible controls, displays six distinct followers, and accepts D and E for till/plant/water/harvest. A mature Oran and harvest counter were observed. Final browser cycle completed with three visible soil beds, mature crop, six companions clear of beds, and harvest1/XP10/cuttings1. Imported berry sprites now compile to8bit indexed masks; browser requests use runtime asset hashes and SHA256 validation to prevent stale4bit files mixing with new palette maps. A visible layer2 rectangle plus RT_CURRENT bitmap comparison isolated the phase-target issue; ground crops/tools and shared companion rendering now target RT_CURRENT. Background-layer, lens and overlay opacity hypotheses were ruled out. Headless pixel counts were zero while browser counts were69/148, so headless pixel counts are NOT rendering acceptance. ScriptDraws exposes hide bits in this engine revision; do not set them true to enable drawing.

Joined-region farming anchors now use fixed meadow-local coordinates plus current region offset; followers retain their trail across internal seams. Guest/peer and encounter presentation adapters translate room-local positions once. Account admission for the joined quest, true camera zoom, broad authored geography and production multiplayer remain pending. The local six-party query is a presentation fixture, not a grant of account creatures or inventory.

---
# September 12 recovery status

Baseline committed state inspected: `48124b5`. Read [REQUIREMENT-COVERAGE-AUDIT.md](REQUIREMENT-COVERAGE-AUDIT.md) for the full title/requirement mapping, queue inconsistencies and dependency gates. Current playable entry is `/charmville/world?panel=play`; the standalone garden remains retired.

Latest committed work covers the unified viewport/party shell and test-login continuity, native placement retry/reconnect handling, arrival recovery and persisted introduction presentation preference. These are bounded local integrations. Tutorial dismissal is not a completed harvest/quest milestone; ownership of berries is not proof of earning a tutorial receipt. Distinct authored home/public geography, general shared weapon/creature simulation and externally accessible friends MMO remain unfinished.

Integrated during this audit: admission overlay/input gating and home/public/friend entry controls; native introduction Continue control; authority correction for controller release when distant. Live fresh-account testing verified the arrival gate, public admission, both introduction pages, completion save and returning-player reload without replaying the introduction. The distant-release PostgreSQL regression passed. These checks establish bounded behavior, not a completed tutorial campaign or multiplayer world. See FEATURE-PROGRESS.md for validation evidence.

The historical integration checkpoint and snapshots below remain for provenance. Later dated checkpoints and actual source/tests supersede conflicting old descriptions (including two-second peer polling, no interpolation and no authenticated gameplay). Do not regenerate the work queue expecting it to incorporate appended checkpoints automatically.

---

# Current integration checkpoint

Updated 2026-09-09. This section supersedes the historical snapshots below. Read FEATURE-PROGRESS.md and the latest Git history for evidence; the older garden/frontier descriptions are not the current product direction.

The playable route is `/charmville/world?panel=play` on local port3017, with native runtime on3021. The standalone garden UI is retired. Authenticated native movement, bounded same-region peers, private Oran cultivation with conserved inventory, six-member isolated test rosters, persistent companion HP/PP, supported turn combat and home recovery are connected locally. A consented one-move helper now contributes to the same wild encounter without taking control. Two-account browser and PostgreSQL checks cover the assist, expiry, revocation and retries. Read SHARED-BATTLE-SCENE.md, SIX-MEMBER-TEST-PARTY.md and NATIVE-ECONOMIC-LOOP.md.

Native committed attack presentation maps all six test-party basic moves to source sequences; consult NATIVE-WORLD-ENCOUNTER.md for the distinction between synthetic directional playback and authenticated battle evidence. Local sandbox capture now settles finite balls, retaliation and preserved creature ownership; read CAPTURE-INTEGRATION-CONTRACT.md for its remaining visual and release gates. Full raids, real-time sword authority, autonomous companion combat, evolution/rewards, broad authored maps, shared status clocks and production-scale networking remain unfinished.

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

## Continuation scheduling

App heartbeat `continue-charmville-build` is active every15minutes for this task. It checks active agents/builds before selecting the next checklist dependency, preserves dirty work, avoids duplicate automations and reports meaningful progress or genuine blockers. Scheduling is not a guarantee of uninterrupted execution or unlimited usage. Latest partial native evidence is recorded under GLOBAL-02; no global acceptance status was promoted.

## Illustrated companion continuation — 2026-09-13

The account party surface now uses the approved teal device frame, paper roster and details, source-art portrait well and warm selection cursor. Keyboard focus selects the corresponding companion. Desktop inspection preserves page position; mobile inspection retains an explicit detail/return flow. Existing account requests and custody operations remain intact. TypeScript passed. The keyboard verification script now derives mobile column count from the actual grid; its syntax passed, but browser execution and authenticated visual acceptance remain pending.

The same native playtest tab (22) remained open during this continuation and was observed at the Plant a seed step. Observation is not an authenticated party-interface playtest. Camera integration remains staged; source compilation is not live visual acceptance.

Menu continuity follow-up: Charmdex now has one keyboard tab stop within its catalogue and preserves search/category navigation for controllers. Voice and Charmdex defer focus restoration, avoid stealing focus from a newly opened dialog, and fall back to the canvas when a header trigger is hidden. Source review completed; runtime visual/input acceptance is still required after reload. No recording or posting was performed.

## Five-minute continuation — 2026-09-13

Confirmed existing automation continue-charmville-build is ACTIVE with a five-minute interval and failed-runs-only notifications, as changed by the user. No duplicate automation created. Immediate work resumed: separate renderer allocation extents and explicit darkness initialization are assigned independently. Main game menu now releases held Q/W inputs before opening, matching Voice and Charmdex; JavaScript syntax passed. Live input acceptance remains pending. Preserve the existing test tab and avoid overlapping changes on scheduled runs.

## Actual live pilot — 2026-09-13

Used existing CUA tab22, without navigation/reload/newtab: D advanced Plant→Water, then Water→Gather, then Gather→Plant. Opened Enter game menu, selected Charmdex, visually inspected its loaded illustrated catalogue, closed with Escape, and verified canvas focus. Direction key taps were sent, but these short taps do not establish sustained movement or seam correctness. Six companion sprites were visible. No account custody/multiplayer acceptance claimed. Marked tab as deliverable; this mark must be repeated each turn to prevent automatic cleanup. Scheduled runs must actually perform and observe relevant UI actions, not count AX inspection alone as piloting.

## Camera dependency progression — 2026-09-13

Committed native ef0096b (independent scene/background/darkness/light extents), efa4002 (explicit Region/Sprite script-light targets) and c1445cc (38 direct scene script-light callsites). Allocation fault assertions and relevant WASM object compilations passed as recorded by implementation agents; reviewed source preserves legacy default coordinates and targets. Portable patches retained. Indirect layer/sprite paths and target lifecycle still prevent safe alternate-buffer activation. None of these source milestones certifies live full-map zoom.

Live tab22 was reused and marked to survive this turn. Enter→Voice notebook→Escape returned focus to canvas; no microphone permission or recording was used. The loaded runtime still labels itself Local adventure with temporary progress. Guest persistence and live observer availability are being audited separately; this local session must not be represented as the completed shared world.

The scheduled continuation remains PAUSED at the user's request. Work proceeds within active runs; no reply-triggered continuation exists.

Native72093a3 routes scene freeform-combo drawing through paired light targets, including UNDER/OVER script layers and their original IDs and scope-exit timing. maps.cpp/ffc.cpp native object compilation passed. Hero/enemy/item/weapon/base-sprite nested script paths and target lifecycle remain pending before activation.

Live observer-source check: existingtab22 Settings→Gameplay video→Preview showed the game picture and the status Local game video and audio source active. The preview was stopped and settings closed. This validates the local capture source only, not broadcasting, privacy admission, remote decoding, or theatres. No newtab or microphone capture was used.

Account integration: centralized runtime iframe/origin configuration across world.tsx, movement, resources, contact observation and tutorial modules. TypeScript passed. Defaultlegacy3021 retained; rebuilt3024 requires explicit public build setting and coordinated admission verification. No remote exposure/deployment or wallet action performed.

## Parallel dependency pass

- Native f851e09 adds explicit paired sprite glow/moving-block torch targets while retaining legacy virtual entry points; player/editor object checks passed. Portable patch saved. Full draw context/lifecycle activation remains pending.
- Trusted native-topology module now backs duplicated client room checks and server reciprocal adjacency checks. Supported rooms remain dmap4/screens62,63; 28 topology/movement tests passed with none skipped. This does not grant unverified world access.
- Spectator settings now clear their loaded revision on account/context change, disable editing until the matching settings load, and ignore stale save completions. TypeScript passed; account-switch browser verification is pending.
- Local gameplay capture/source lifecycle:15 focused tests passed. No remote broadcast acceptance.
- Existingtab22 kept and marked deliverable; Enter/Escape menu return verified with canvas focus. Harvest key was sent but immediate state still said Gather, so this pass does not claim harvest completion.
- Completion metadata validation passed; no global gate promoted to accepted merely for source compilation.

### Priority execution: full-world camera and live footage
The current pass prioritizes GLOBAL-02 camera activation and actual gameplay broadcast integration. Commit ca166e5 adds a server-only resolver binding broadcast authorization to current approved account sessions and current spectator policy; three focused tests passed and TypeScript passed. Commit fe3a277 contains the browser WebRTC media peer and bounded session lifecycle (eight tests passed). Neither commit enables public streaming. Required remaining proof includes gateway wiring, profile playback, server-enforced delivery revocation, and two-device transport. The existing 3024 game tab was piloted and marked to stay open; its live renderer package remains unchanged while the candidate links. No completion gate is accepted from compilation alone.

Native checkpoint 53e4bc5: explicit world-light targets now propagate through 94 sprite drawing/helper definitions and 183 nested calls, preserving derived enemy dispatch. Full zplayer.js compile/link passed; player and shared/editor objects passed. Forty-six compile-time dispatch contracts added. Portable patch is source-evidence/0001-refactor-zc-propagate-world-lighting-through-sprite-.patch. Live package was not replaced. Camera activation still requires owned target initialization before START_FRAME plus world/HUD final composition and lens handling.

Broadcast checkpoint 76cf05e: authenticated subscriber discovery and normalized real gameplay-peer signaling envelopes now interoperate. Eight protocol/session tests passed, including actual peer-module offer/answer/ICE flow with mocked RTCPeerConnection. This is not two-device media proof; gateway, relay privacy enforcement and profile playback remain incomplete.

## Live camera release — supersedes earlier staged-camera notes
Native 0b80f9c and application 8b9fc5b are live on port 3024. Real 0.5–1 world zoom changes visible terrain extent while keeping the canvas and HUD fixed; full authored-map overview is available. See LIVE-CAMERA-RELEASE.md for verified screenshots, procedure and limits. This is not acceptance of global simulation, remote guests, or world-scale multiplayer. GLOBAL-02 remains implementing pending device and broader gameplay parity checks.

