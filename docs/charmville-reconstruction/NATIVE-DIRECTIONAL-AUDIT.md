# Native directional action audit

`verify-four-direction-tools.mjs` navigates around the first bed with actual native arrow-key movement in four fresh browser sessions. It prepares soil, plants and waters from north, south, east and west. No player-coordinate or crop-state injection is used.

The completed run verified that every facing emitted all eight hoe frames and the distinct watering frames 0, 1, 4 and 5, with all actions completing and no cancellation or browser errors. This adds native runtime coverage beyond the earlier atlas-presence checks. The action script reports frame changes to support regression investigation.

Three screenshots are sampled during each hoe and watering action. These are **not exact contact-frame captures**: browser screenshot latency can advance the engine between the request and the rendered image. Initial evidence filenames used phase labels, but the verifier now labels these sample 1–3 to avoid claiming synchronization.

Visual inspection of the four-direction samples did not establish a universal correct hand attachment. The imported LPC hoe/watering poses and Link's adapted standing/stabbing body poses were authored for different characters. Some side-facing samples still look mismatched. The initial audit did not claim finished animation fidelity or add speculative offsets/particles to hide the issue. Accurate completion needs explicit per-frame hand sockets and a compatible character work-pose bank, followed by frame-synchronized visual inspection.

The earlier fixes remain: binary-transparent indexed assets, source-defined watering frame sequence, complete hoe sequence, foreground/background layers, ground anchor adjustment, and the first-frame native movement-grid alignment correction. No new art substitution is introduced by this audit.

## Tool contact reach

The action gate in `Homestead.zs` previously accepted a 32-pixel radius while rendering tools in a 32-pixel cell around the actor. It could therefore complete farm work from two tiles away. The gate now requires at most 20 pixels center distance and at most 8 pixels perpendicular offset to the chosen cardinal direction. It does not teleport the actor or stretch the tool. The four-direction verifier now first tries working from two tiles north and asserts rejection without a crop action completing, then tests all existing reachable cardinal positions.

Remaining conformance work is explicit: planting/fertilizing/harvesting still reuse generic body poses instead of dedicated source work cycles; hoe and watering need per-frame hand sockets; tool collision is a proximity/ground/action gate rather than a sampled tool hitbox against the bed; source crop palettes need refreshed mapping after palette-changing travel; interrupt-after-contact keeps the already-applied crop result, while interrupt-before-contact must not grant it. Fishing, tree-cutting loops, mining, livestock care and construction do not yet have native implementations in this script. Acceptance requires directional source sprites, contact-timed authoritative action results, interruption tests and actual visual comparison for each activity, not an added menu entry.

## Source-grounded corrective pass

The native source maps hero sprite ID 6 to LSprpoundspr in src/zc/ffscript.h and getHeroOTile in src/zc/ffscript.cpp. The native hammer renderer selects ls_pound during its windup in src/zc/hero.cpp. Farming now uses this existing directional raised-tool pose for the first 14 hoe ticks, followed by the existing stab/contact pose and recovery. This replaces the ordinary shield-carrying walk pose during preparation without modifying source artwork or forcing a native attack. Watering retains its previous body sequence. Per-frame hand sockets and complete bespoke farm poses remain unfinished.
