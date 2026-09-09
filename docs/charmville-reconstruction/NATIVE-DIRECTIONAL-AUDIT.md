# Native directional action audit

`verify-four-direction-tools.mjs` navigates around the first bed with actual native arrow-key movement in four fresh browser sessions. It prepares soil, plants and waters from north, south, east and west. No player-coordinate or crop-state injection is used.

The completed run verified that every facing emitted all eight hoe frames and the distinct watering frames 0, 1, 4 and 5, with all actions completing and no cancellation or browser errors. This adds native runtime coverage beyond the earlier atlas-presence checks. The action script reports frame changes to support regression investigation.

Three screenshots are sampled during each hoe and watering action. These are **not exact contact-frame captures**: browser screenshot latency can advance the engine between the request and the rendered image. Initial evidence filenames used phase labels, but the verifier now labels these sample 1–3 to avoid claiming synchronization.

Visual inspection of the four-direction samples did not establish a universal correct hand attachment. The imported LPC hoe/watering poses and Link's adapted standing/stabbing body poses were authored for different characters. Some side-facing samples still look mismatched. The initial audit did not claim finished animation fidelity or add speculative offsets/particles to hide the issue. Accurate completion needs explicit per-frame hand sockets and a compatible character work-pose bank, followed by frame-synchronized visual inspection.

The earlier fixes remain: binary-transparent indexed assets, source-defined watering frame sequence, complete hoe sequence, foreground/background layers, ground anchor adjustment, and the first-frame native movement-grid alignment correction. No new art substitution is introduced by this audit.

## Source-grounded corrective pass

The native source maps hero sprite ID 6 to LSprpoundspr in src/zc/ffscript.h and getHeroOTile in src/zc/ffscript.cpp. The native hammer renderer selects ls_pound during its windup in src/zc/hero.cpp. Farming now uses this existing directional raised-tool pose for the first 14 hoe ticks, followed by the existing stab/contact pose and recovery. This replaces the ordinary shield-carrying walk pose during preparation without modifying source artwork or forcing a native attack. Watering retains its previous body sequence. Per-frame hand sockets and complete bespoke farm poses remain unfinished.
