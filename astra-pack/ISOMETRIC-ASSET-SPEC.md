# Charmville isometric asset production spec

Status: corrected direction after the owner rejected the generated painted garden and wheat.
This supersedes the earlier ?painted miniature garden? interpretation. The rejected images are not
approved art and must not enter the runtime. Existing vector crop portraits are prototypes too.

## Target

SimCity's spatial readability, RollerCoaster Tycoon's discrete scenery and consistent projection,
and FarmVille's readable crop appointments. Build a little simulation world from individually placed
assets. The supplied SimCity, RCT and farming references control the visual target; repository
examples teach construction. Natural green terrain and distinct crop colours belong in the world.
Wood/gold is the interface chrome. Do not wash the entire world brown or add painterly sunset haze.
The official Plank character assets remain the character reference, never substituted clipart faces.

Open [the actual source-art study](isometric-reference/index.html). Each image is an unchanged file
from a pinned repository, not generated imitation. The manifest records source path, commit, hash,
license, and attribution pointer. Blue pixels in legacy sheets are palette keys, not a world colour.

## Verified construction references

| Repository | Inspected evidence | What Charmville takes from it |
| --- | --- | --- |
| [FreeRCT](https://github.com/FreeRCT/FreeRCT/tree/d39154b32c9e0bd6f511da27fe112e50f6034557) | `graphics/sprites/scenery/objects/flowers.blend`, `64_flowers1.png`, `graphics/rcd/scenery/flowerbeds/flowerbed1.fms` | Model-to-sprite workflow, explicit 1 x 1 footprint, 64px tile width, origin offsets, separate dry state |
| [OpenGFX](https://github.com/OpenTTD/OpenGFX/tree/c51c904f4f6e7466ee73f907520ef7ea9a53bcbb) | `sprites/base/base-4090-farm-fields.pnml`, terrain sheets `field-08-temperate.png` and `field-58-temperate.png` | Connected farm terrain, stage variants, slope geometry and fence offsets |
| [OpenRCT2 OpenGraphics](https://github.com/OpenRCT2/OpenGraphics/tree/930b0140685f85db92147af832080e8df12d8d4e) | README, license, checked-in `.blend` scenery and object JSON files | Editable model sources, common render setup, per-object metadata; its Blender 2.79 helper is a historical pipeline reference, not a required runtime dependency |
| [Unknown Horizons](https://github.com/unknown-horizons/unknown-horizons/tree/af9c8ef5c7f6cf9ec0b8c9e7d172c555f2793615) | `as_potatofield0/idle/45/0.png`, `idle_full/45/0.png`, work frames and other views | Crop silhouettes, consistent camera across lifecycle states and rotations, crop beds that occupy real ground |

FreeRCT and OpenGFX publish GPL-2.0 terms; OpenGraphics publishes GPL-3.0 terms.
Unknown Horizons identifies its own audiovisual content as CC-BY-SA-3.0 in `doc/LICENSE`.
The copied study examples retain license and contributor files beside them. Any derivative shipped
asset must have its own attribution and applicable license/source material. A project's open engine
does not establish permission to redistribute the commercial game's assets: OpenRCT2's README says
it requires original RCT2 files. User screenshots are composition references, not sprite extraction sources.

## Charmville geometry ? proposed production contract

The following values are our engineering decisions, not claims that all reference games use them.

- Orthographic 2:1 dimetric grid. Base logical ground diamond: 64 x 32 pixels.
- Projection: screenX = originX + (cellX - cellY) * 32;
  screenY = originY + (cellX + cellY) * 16 - elevation * 16.
- All ground tiles share that diamond. Do not skew a CSS card and call it an isometric tile.
- Sprite anchors describe the ground-contact point independently of image height. A tall tree and a
  low crop occupy the same logical cell without moving the ground when the image changes.
- Art master renders at 4x (256 x 128 ground diamond). Export deliberate 1x/2x/4x variants with crisp
  silhouettes. Judge at actual board size; no browser-blurred upscaled 64px screenshot as final art.
- Use one fixed orthographic camera and shared lighting rig for all objects. A 45-degree azimuth and
  about 30-degree elevation are the starting rig for the 2:1 projection; verify rendered tile corners.
- Four orientations for asymmetric placeable objects. Symmetric soil can share frames.
- Sort object draw order by footprint depth; split foreground fence edges into separate drawables.
  Never let a front fence render behind a rear crop or let a tree's bounding box define ownership.
- Picking uses the ground diamond and object hit mask. Mobile selection gets a larger accessible
  hit target without visually enlarging the crop. Keyboard has equivalent named plot controls.

## Original asset pipeline

1. Create a reusable Blender scene: tile guide, unit cube, camera, light rig, alpha background,
   ground anchor, and export settings. Study the included FreeRCT flowers.blend and render notes.
2. Author original Plank crop bodies and scenery with simple modeled volume and deliberate material
   colours. Use official Plank art as the character input. Never generate a replacement mascot.
3. Render each state and orientation with identical rig and canvas. Export transparent PNG layers;
   inspect silhouettes at 1x. Pixel cleanup is deliberate, not a blur or generic oil-paint filter.
4. Separate ground, crop, shadow and selection/interaction overlays. Harvest changes the crop layer;
   it does not replace a whole garden backdrop.
5. Store source model, render recipe, author/license provenance and atlas metadata together.
6. Assemble a six-cell art proof at desktop and 390px against the actual personally themed board,
   including one tall prop, crops at different stages and front/back fence edges. Compare directly
   with the supplied game references before expanding the art set.

## First original atlas

| Asset | Required variants | Acceptance |
| --- | --- | --- |
| Grass | 4 restrained variations | Same diamond edges; no obvious checker repetition |
| Tilled soil | empty, planted | Dark furrows, same permanent footprint; no fee implication |
| Stalk | seedling, growing, ripe, compost | Golden crop rows readable at board size; official face expression belongs to the good |
| Splinter | seedling, growing, ripe, compost | Distinct wooden crop silhouette without relying on text or recolour |
| Scenery | fence edges/corners, path, pot, bench, small tree | Consistent scale, occlusion and placeable footprints |
| Care | subtle tended overlay | Does not conceal lifecycle state or claim yield changes |
| Harvest | short face-to-satchel motion, reduced-motion equivalent | Receipt drives result; animation never grants inventory |
| Satchel | closed pouch and seven inventory portraits | Stack counts and SEND remain live HTML; original Plank styling |

Only Stalk/Splinter lifecycle runs in Phase A. The other five portraits need designed expression
and inventory identity, but their farming rules must not be silently activated.

Each asset manifest entry: id, source, license, frame rectangle, anchor, logical footprint, orientation,
state, shadow layer, hit mask, atlas scale. Keep species/plot state in the server ledger, not in art files.

## Runtime integration

Replace the prototype rotated CSS plot cards with a projected scene inside the existing Porch.
Keep accessible DOM controls and satchel over/alongside the scene. Use a local renderer or positioned
sprite layer with camera/picking transforms; renderer choice follows scene requirements, not branding.
Six plots remain authoritative ids 0?5. Expanding the view adds camera/decorating room on the same URL.
Decorating drafts never mutate crop receipts. A future larger lot uses a separate paid expansion action.
Pause animation when the porch is offscreen or document hidden. WoodAmp stays mounted outside it.
No full-world animation loop on pages that do not display the yard.

## Rejection checklist

Reject painterly backgrounds pretending to be playable land, floating collectible-card plots,
random crop clipart faces, inconsistent camera angles, asset sheets with missing origins, and scenes
whose art only works at screenshot size. Do not promote reference sprites as official Plank art.
Do not claim final art approval merely because a source asset is correctly licensed.
