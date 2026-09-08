# Charmville: isometric game and asset research

Research date: 2026-09-07. This is a documented survey of twelve relevant repositories plus primary
creator/tool documentation and content libraries. It is not a claim to have found every public clone.
Exact repository revisions and inspected files are in CHARMVILLE-SOURCE-CATALOG.json.

## Original games: verified stack versus inference

| Work | Verified evidence | Consequence for Charmville |
| --- | --- | --- |
| RollerCoaster Tycoon | [Chris Sawyer's tool list](https://www.chrissawyergames.com/faq3.htm): assembler/C and DirectX, with graphics produced using modeling/rendering and paint software including Lightwave, Raydream and Photoshop. His [frame explanation](https://www.chrissawyergames.com/feature1.htm) confirms pre-rendered angles/frames. | Author spatial models, render consistent transparent sprite frames, retain origins and view metadata. We do not need to reproduce its assembler runtime. |
| SimCity 4 content creation | [BAT tutorial](https://community.simtropolis.com/omnibus/simcity-4/bat-lot-editor-tutorials/bat-essentials-part-4-r125/) documents the gmax/BAT camera-light rig. [BAT4Blender](https://github.com/memo33/BAT4Blender) documents Blender/Cycles, zooms/rotations, supersampling, PNG/LOD export and fshgen. | Adopt the fixed-camera model-to-image workflow. The BAT evidence concerns the content-authoring ecosystem; it is not proof of every tool Maxis used internally. SC4Model/FSH packaging is unnecessary for our browser renderer. |
| Original FarmVille / Zynga social games | [Zynga's GDC Online 2010 architecture talk](https://media.gdcvault.com/gdconline10/slides/11457-Scalability_For_Social_Game.pdf) describes Flash/HTML clients and web-stack PHP/HTTP patterns, including state/write ordering. The 2010 Game Developer article is indexed as documenting FarmVille's Flash client; full PDF retrieval failed in this session, so it is not the sole implementation basis. | Keep rendered interaction separate from authoritative server actions. No Flash dependency. A complete original FarmVille art-tool inventory was not verified; do not guess Maya/3ds Max from later FarmVille titles or unrelated portfolio work. |
| SimCity Classic / Micropolis | [MicropolisCore](https://github.com/SimHacker/MicropolisCore) documents its Classic lineage and current C++/WASM engine, SvelteKit and WebGL frontend. | Useful simulation-boundary reference. Classic is not the SimCity 4 isometric asset set. Do not confuse a released Classic engine with permission to redistribute SC4 graphics. |

## Public clones and related projects inspected

| Project | Observed stack / asset pipeline | Decision |
| --- | --- | --- |
| LinCity-NG | Current checkout C++ and SDL3 dependencies; checked-in Blender models, render scripts, PNG tiles and XML image anchors. Data dual GPL/CC BY-SA 2.0. | Terrain/tree source adopted with credits. Its historical render.py uses an old Blender API; inspected, not executed or copied. |
| FreeRCT | C++ runtime; Blender model renders; explicit footprint/anchor and frame metadata; 64/128/256px source conventions. GPL-2.0. | Pipeline and scenery reference; copied source study retains GPL and contributors. |
| OpenRCT2 / OpenGraphics | Open engine and separate GPL-3.0 replacement-graphics project, with Blender helper pipeline. Engine still requires original RCT files. | Study replacement models/metadata; no commercial RCT sprite extraction. |
| OpenGFX / OpenGFX2 | Complete open base graphics lineage, PNG sheets, terrain/farm variants, code-defined sprite offsets. OpenGFX2 distinguishes classic and 4x high-definition asset coverage. GPL-2.0. | Large coherent terrain/city reference library; do not mix every pack's camera/palette into one yard. |
| Unknown Horizons | Python + FIFE; repository has crop states, rotated views and work sequences. Own audiovisual content CC BY-SA 3.0. | Soil sprite adopted; stage/rotation structure informs renderer. |
| dacousb/feiok | Go 1.18, Ebiten v2.3.4, explicit wheat stage enum and four stage sprites; MIT. | Concrete small multiplayer isometric farming reference. Its README admits safety/UI gaps; not a production backend to transplant. |
| ksc3899/Farmville-Clone | Unity 2018.3.11f1 / C# project. No declared repository license found. | Inspected structure only; do not import its art/code as free content. |
| dgreenheck/simcity-threejs-clone | Three.js 0.155 / Vite 4.4 manifest; MIT project. | Modern browser spatial-simulation reference; separate architecture, not a replacement home app. |
| Simutrans pak128 | Separate 128px graphics package; Artistic License 2.0. | Large scenery/transport/city candidate; preserve package-specific terms if later selected. |
| BAT4Blender | Blender add-on; Cycles, batch renders, alpha PNG, zoom/rotation export; GPL-3.0 tool. | Current authoring reference; no need to load the add-on or its SC4-specific export in production. |

## Large content sources

These are open-content libraries, not official free versions of FarmVille/SimCity artwork.

- [OpenGFX](https://github.com/OpenTTD/OpenGFX), [OpenGFX2](https://github.com/OpenTTD/OpenGFX2),
  [Simutrans pak128](https://github.com/simutrans/pak128): substantial coordinated simulation graphics.
- [LinCity-NG](https://github.com/lincity-ng/lincity-ng) and
  [Unknown Horizons](https://github.com/unknown-horizons/unknown-horizons): model/tile/crop repositories.
- [Hansjorg Malthaner's isometric crops](https://opengameart.org/content/isometric-crops-and-farmland):
  wheat plus vegetables and field assemblies; multiple offered licenses, CC BY 4.0 selected for the
  copied reference. The four wheat patches are random variants, NOT four animation frames.
- [Kenney Isometric Miniature Farm](https://kenney.nl/assets/isometric-miniature-farm): 60 files, CC0.
  [Nature Kit](https://kenney.nl/assets/nature-kit): 330 files, CC0. Useful editable/kit candidates;
  their simpler visual style must be reconciled with the chosen renderer before adoption.
- [Quaternius Farm Buildings](https://quaternius.com/packs/farmbuildings.html): 13 models, FBX/OBJ/Blend,
  CC0. A building source option for later lot scenery. Website availability is not evidence all models
  are animated; inspect each downloaded asset before promising motions.

## Implemented asset pipeline

`public/images/charmville/manifest.json` records copied source PNGs, licenses and hashes.
`CREDITS.html` is reachable from the porch. Source PNGs are unchanged; display composes them.

Original crops now use `scripts/charmville/render_crops.py`, executed with portable Blender 4.5.9 LTS:

- Authored Stalk stalks/leaves/grain heads and woody Splinter shoots; no copied reference meshes.
- Shared orthographic camera, 30-degree elevation, fixed light rig and transparent 256 x 192 renders.
- Three actual geometry/material stages per species; eight separately rendered wind poses per stage.
- Two editable .blend files and 48 PNG frames. `pack-crops.mjs` builds six 2048 x 192 atlases.
- Ground anchor exported from the camera projection, recorded in the manifest. Runtime reads
  the generated manifest for anchor, frame dimensions, timing and atlas travel.
- Source-library wheat is retained as study/reference material; the runtime crop animation is original.

The inline board renderer now has projected ground cells, depth-sorted objects, independent picking,
selected-plot controls, zoom, horizontal touch navigation and frame animations that pause offscreen.
Server timestamps select growth/ripe/compost stages. Effects follow accepted receipts. Reduced-motion
users get stable stills and the same textual receipt. Existing inventory and planting rules remain online.

## Remaining visual scope

This establishes a working model-to-sprite crop pipeline and integrates it into the actual board.
It does not mean every decorative prop, seven unique face expression sets, rotation view, sound,
layout editor or future market asset is finished or visually approved. Expanding the lot currently
expands viewing space; persistent decoration placement remains unfinished Phase A work.
