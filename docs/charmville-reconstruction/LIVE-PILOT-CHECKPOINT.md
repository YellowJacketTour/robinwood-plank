# Live pilot checkpoint

## September 13 — harvest, battle, XP and care connected live

Follow-up: corrected home rest's battle exclusion to consider only living, uncaptured turn encounters with a current lease. Two isolated PostgreSQL rest tests passed, including living-battle blocking, defeated/captured eligibility without changing leases, recovery and retry behavior. In this same browser account, started ten-second home rest, waited until Ready to recover, and committed Finish rest. UI reported Fully rested and HP and move PP restored. TypeScript and scoped lint passed. This live rest occurred after the original encounter lease may have elapsed; the immediate post-victory lease case is established by integration checks, not that timing in the browser.

Continued tab 17 and `local_demo_b24e4e57061a`; no new account or tab. Engaged the previously existing home Poochyena (preserved by the safe-home migration policy), entered staged battle, and issued three Pound commands. Visible wild HP changed 13→7→1→0; Treecko HP changed 20→18→16 and PP decreased. Victory displayed +15 XP saved, 150 total XP and 29 to next level. This establishes the staged battle path, not native sword-to-authority damage or seamless perspective switching.

Added explicit Begin companion battle wording (previously Inspect), creature-specific Meet labels, completion guidance and Review party & care navigation. The new link opened the same owned Treecko with 16/20 HP and 150 XP. In Care, Feed Oran Berry consumed the one berry harvested in the preceding checkpoint and restored HP to20/20; the interface showed0 berries remaining. This verifies the harvest→owned consumable→battle injury→care chain in one account. The item was not replaced by a fixture grant.

During the UI edit an encoding error temporarily broke the dev page; repaired UTF-8 and misdecoded punctuation, then resumed the same account. No content or save reset was performed. Broader art polish, sustained movement, six-party combat and complete expedition traversal remain open.

## September 13 — first complete visible account crop loop

At the next turn the browser inventory had zero tabs. Opened replacement tab 17 through the visible local launcher; its new synthetic profile is `local_demo_b24e4e57061a`. This is not the previous tab/account. Claimed home, selected Treecko, entered home, and advanced both native introduction pages through visible UI.

Actual canvas D presses then completed till → plant → water → ripe → harvest. The rendered prompt changed from prepare soil to water seed to gather crop. Satchel displayed Oran Berry ×1 and Oran seed ×3. Read-only inspection of the explicitly local PostgreSQL instance confirmed four `charmville_native_actions` rows (till, plant, water, harvest), all `committed`, all `oran-berry`; the harvest receipt contained `{face:"oran-berry",quantity:1,seedQuantity:1}`. Native logs also showed watering lifecycle begin/contact (`ID 3`, phases 0/1). This supersedes the previous checkpoint's unresolved input-to-farming observation for this fresh opening path. It does not certify every animation frame or directional pose.

Found and fixed returning-player focus continuity: players who skip the completed introduction had no final introduction button to focus the canvas. `tutorial-bridge.js` now remembers an explicit Enter-world click, waits for native arrival and completed narrative, and focuses the canvas only if the player has not selected another control/app. Reloaded this same account, entered without replaying the introduction, observed canvas focus, and a D press immediately entered Working. The next crop stage and the previously earned berry remained visible after reload.

Opened Treecko's owned record, selected Walk with me, observed walking count change 0→1, returned to play and saw its sprite. Sustained movement, six-party formation, border travel, injury/care and the hybrid battle loop remain unaccepted. No claim of complete single-player or multiplayer acceptance.

Parallel fixes: the upstream touch BUTTON_MAP does not define Ex3/Ex4. Replaced those nonfunctional extra touch controls with explicit native D/C buttons handling hold/release/cancel and keyboard activation. Six focused adapter tests passed. New private homes no longer create wild encounters on polling and home habitats no longer automatically respawn; existing home encounters are preserved. The isolated PostgreSQL encounter lifecycle check passed. This test account was created before that change, so its existing encounter remains visible by design. TypeScript passed. No production deployment.

## September 13 — retained world and solo-first acceptance

Retained in-app tab 15, `/charmville/world?panel=play`, profile `local_demo_a72e9c1cbf01`; no new test account or world was created. Tab 16 is signed out, so the two visible tabs did not establish competing authenticated actors. The browser was explicitly made visible. A real tab reload restored the same profile after hydration, and Enter the world resumed its home, Torchic follower and three seeds. Screenshots showed the native autumn scene and soil prompt. This is visual presence evidence, not a completed farming/combat playthrough.

Added localhost-only `CHARMVILLE_MOVEMENT` diagnostics with placement/correction cause, observed and target coordinates, sample/correction counters and queue length. They contain no token or profile identity and cannot interrupt correction delivery. The live console showed arrival placement from (232,72) to saved (56,56); this is now distinguishable from nonadjacent observations and failed-step recovery. Do not conclude that later movement glitches are fixed from these arrival records.

Added 40ms minimum retention for extremely short native action taps (z/x/d/c), preserving long holds and leaving movement/menu keys untouched. Five focused adapter checks passed; 23 movement-client checks and TypeScript passed. Direct canvas quick taps still did not yield a native INTERACT or ACTION log in this pilot, so input-to-farming acceptance remains unresolved. No successful harvest, sustained walking, six-party motion or multiplayer acceptance is claimed.

`SINGLE-PLAYER-ACCEPTANCE.md` is the ordered player-facing completion gate. Solo-first means a coherent journey on the current authoritative account services, not a second guest economy. Next acceptance work must demonstrate actual input delivery and one full crop lifecycle, with its committed receipt and matching inventory, in this retained session.

Follow-on visible pilot: local profile local_demo_8f80654e6e1f claimed its home and selected Torchic through visible UI. Migration 129 is now applied to the local database. Beds and pending actions persist server-owned crop identity; existing Oran identity, yield and timing remain unchanged. The resource response includes per-bed cropId and growthDurationMs, and client growth art follows that duration with legacy fallback. Two isolated PostgreSQL resource tests and five client lifecycle/projection tests passed. Burning Heart remains unavailable until its issuance, inventory, presentation and gifting are actually connected. These are local working changes, not a production release.

September 12, 2026. Verified local listeners for the app (3017), native runtime (3021), socket service (3023) and PostgreSQL (55417). Created a separate local profile through the visible launcher, entered the world, selected public admission, started the native runtime and observed the rendered welcome screen. Browser inspection and visible controls are available. Native desktop app automation, physical controllers, real phones and external multiplayer capacity are not established by this check.

Local working change: explicit successful travel increments an arrival generation even when returning to the same region. This restarts native arrival reconciliation; background inventory/presence refreshes do not. It closes the previously documented hook dependency gap where selecting the already-active region did not initiate recovery. Targeted UI lint and 15 existing movement client tests pass. End-to-end off-map re-entry for this specific wiring is still unverified. No full suite or production release was performed for this local iteration.

Next implementation dependency: BURNING-HEART-CATALOG-CONTRACT.md maps the existing heart-on-fire discovery identity to the missing crop identity, ledger, gift and artwork support. Burning Heart is not yet a live crop. The authored family opening and social transfer must share real account custody, not rename Oran or replay local effects as rewards.

Visible pilot follow-up: profile local_demo_61bfb447f5ad entered Public meadow and completed both introduction pages. Canvas clicking opened the upstream native system menu and paused play. Confirmed upstream behavior in zquest-classic/src/zc/zc_sys.cpp; corrected tutorial-bridge.js to focus the canvas only after the final introduction request is acknowledged, without clicking and without stealing focus from another control. Syntax check passed. Runtime was reloaded and is running again. Automated instantaneous key presses have not demonstrated character displacement; native held-key polling can miss these pulses. Do not report successful movement or combat playtesting from this session. Real-time combat remains local, as the interface explicitly states.

## 2026-09-13 movement continuation

- Retained browser tab 17 and local_demo_b24e4e57061a. Reloaded this tab, entered the world, then clicked visible Resume keyboard play; accessibility focus confirmed canvas. Runtime shell no longer nests this button in Settings & help.
- Retained movement diagnostics at inspection contained one initial placement (05:56:03 UTC), from source spawn to saved position. This is not a sustained-walking acceptance result.
- Background presence renewal regression: five executable callback/timer tests pass, preserving explicit travel and permission revocation behavior.
- Added transport-independent input reconciliation with bounded pending history, replay, snapshot revision ordering, explicit epoch reset and defensive copies. Six tests pass, including 36,000 synthetic ticks at 250 ms delayed acknowledgment. Native source reducer and authoritative input receiver are NOT integrated.
- TypeScript and focused ESLint pass. Existing server validation remains enabled. No production deployment or completed-MMORPG claim.

## 2026-09-13 parallel continuity integration

- Focus channel: canvas-only arrow default prevention preserves native event delivery and UI/dialog shortcuts. Seven controller tests and two tutorial-bridge tests passed. Existing visible Resume button retained.
- Encounter channel: defeated targets no longer render battle, assist or capture actions; completion label, habitat recovery and party care remain. Captured-owner receipt remains available. Focused rendered-tree scenarios and lint passed.
- Movement observability: queued count, high-water, dropped-path count, last/max request time and oldest queue age emit locally every 10 seconds. No identity or credentials. 24 movement-client tests, TypeScript and focused lint passed.
- Retained tab17 reloaded and entered, canvas focused. Short Up/Down input issued. Logs from 06:06:24 through 06:06:58 UTC show one initial placement, no subsequent correction, no dropped path, zero backlog and 23ms recorded request. This idle/short-input sample does NOT establish sustained-walk acceptance.
- Native parity channel: see ../NATIVE-LOCOMOTION-PARITY.md. Native walking action and off-grid continuation precede new direction processing, including reversal. Required engine entry/exit instrumentation is specified; no speculative reducer was wired.
- Remaining gate: instrument a matching native build, prove turning/collision/action parity, connect input authority and replay with authentication/durability, then repeat actual long-walk/border/follower acceptance. Existing authority remains active.

## 2026-09-13 playable atlas controls

Added 1x/2x/4x zoom, Find me, Whole map, bounded pointer drag and keyboard pan to the existing two-area atlas. Map summary distinguishes own homestead, visited homestead and public occupancy from terrain name. This does not expand authored geography or alter the native camera. Retained browser tab17 verified opening map and zooming to 4x with upper bound disabled. Touch dragging and keyboard panning still require device-specific acceptance. TypeScript and scoped lint passed.

## 2026-09-13 live border inspection and authoring route

Retained tab17: focused canvas, issued Left inputs from the meadow's west edge; observed source scroll animation, then World map changed to Western path. Link and Treecko were visible on the destination side. This is connected-screen traversal, not seamless region acceptance. Issued Right inputs to return; final destination must be observed separately.

Native integration discovery: distributed runtime/include/bindings/mapdata.zh documents writable canonical mapdata RegionID (versionadded 3.0). It may be written only through Game->LoadMapData. Source core/mapscr.h defines contiguous rectangular regions with IDs 1–9, zero for standalone screens. This provides a script-authoring path worth compiling in a candidate quest before editing live region data. Determine actual map index from DMap data; do not assume dmap4 means map4. Configure before region loading and adapt all world-space consumers before live activation. Current native actors still validate screen-local bounds, so enabling it alone would break saved movement.

## 2026-09-13 joined-region candidate proof

Built scripts/charmville/region-candidate-build.mjs and region-candidate.zs in an isolated runtime. Native and browser logs both confirm DMap4 resolves map10, origin62, region1, 512x176, 2x1 screens. Browser loader initially failed because candidate was absent from the quest manifest; optional candidate metadata registration fixed it and runtime server was restarted. Protected live/template/include hashes stayed unchanged.

Same tab17 temporarily navigated to the standalone candidate. Browser screenshots show camera following Link while western river terrain moves out and meadow terrain comes into view together. Short repeated directional inputs were used, not a held-input duration test. Candidate remains standalone without account gameplay integration.

Separate --motion native proof: X240 -> X288, HeroScreen62 ->63, origin62 unchanged, cameraX120 ->168 after36 right-input frames. No warp/position write during measured input. Evidence work/region-candidate-motion/evidence.json. This is native harness evidence, separate from browser observation.

Joined raw geometry now expands the actor footprint after stitching; all authored placements checked, including passable seam, with four tests passing. TypeScript/lint pass. Full quest migration remains governed by REGION-CUTOVER.md; do not flip live account quest before its crops, combo indices, followers, authority and correction protocol migrate.

## 2026-09-13 north/south candidate correction

User correctly reported other directions leaving the joined area. Candidate now joins authored screens46,47,62,63 (origin46,512x352). Native audit checks nonempty/valid room data before region assignment, region IDs1..9, and publishing requires fresh motion proof. Horizontal62->63 and vertical47->63->47 native input/camera tests pass without collision changes. Source room map resolved from DMap4 remains10. Live account quest remains untouched; four-screen candidate is not the full world. Root reloaded the same browser tab for the update.
