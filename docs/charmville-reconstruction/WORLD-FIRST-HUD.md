# World-first presentation

The joined Homestead now publishes a read-only crop presentation snapshot. A browser readout shows one short next-action line; Details reveals supply, XP or account quantities, nearby players and soil care. The former three-line32px native black footer is suppressed only while a browser lease is changing. Missing/stalled browser presentation restores the original footer after120 native frames. Introductory native dialogue remains unchanged.

Protocol: `1|welcome|task|bed|berries|xp|cuttings|guests|resourceMode|seeds|fed|canFeed|ticks|farmHere`. Negative1 indicates an unavailable XP or seed value, not zero. No input, resource grant, ownership, crop clock, actor placement or reward mutation is authorized by this file. It is presentation only. State and lease checks run every15 native frames; the browser polls every250ms, changes text only when needed, and hides stale/off-map guidance. Browser counters never replace server inventory authority.

The existing port3024/tab18 was reloaded, entered through both native introduction steps, and visibly displayed the compact readout with the native footer removed. Terrain formerly covered by that footer was visible. Details is an explicit disclosure, not a disguised action button. Source defaults return for runtimes without the bridge. This is not acceptance of every dialogue, gamepad remapping or mobile layout.

## Remaining frame constraints

The browser's default640x480 surface differs from the game's256x224 frame. Native integer scaling produces512x448 content with large sidebars. The native renderer also reserves6 logical vertical pixels. These are not CSS borders. Stretching or cropping the canvas would distort or remove source content.

An opt-in homestead frame adapter proposes768x690, preserving integer3x content and room for640x480 system dialogs. A browser-only change did not alter the live native surface because unfiltered rendering ignores the browser size helper. A matching native opt-in is therefore required before this counts as sidebar reduction. The wrapper adapter fails visibly if expected upstream code changes. It never changes the simulation viewport or reveals additional terrain.

The wider world camera remains a separate dependency: render/simulation coordinates, world targets, HUD conventions, lighting and script effects must be separated. Engine commit9e90ec7 extracts the final overlay phase and bounded frame copies. Its portable patch is in source-evidence. This source checkpoint alone does not certify runtime parity or zoom.

## Public event direction

Read [PUBLIC-EVENT-EXPERIENCE.md](PUBLIC-EVENT-EXPERIENCE.md). World cues lead: convoys, sky changes, distant effects and moving groups. A short objective and optional direction indicator support them. Charmdex holds detailed objectives and contribution records. Participation must refer to the exact event occurrence, preserve arrival/progress/custody, and distinguish crowd rendering from server simulation capacity. Hundreds of visible real players remains a measured implementation target, not demonstrated current behavior.

Candidate validation: the full linked native768x690 opt-in reduced the visible artwork further in the live browser. Rejected and restored the previous JS/WASM pair. The adapter is now gated behind CHARMVILLE_NATIVE_FRAME_CANDIDATE=1 for further investigation; it is not enabled for normal play. Compact HUD remains enabled. Native sizing is pending, not accepted.
