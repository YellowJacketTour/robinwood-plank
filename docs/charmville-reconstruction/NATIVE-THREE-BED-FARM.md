# Three native farming beds

The native homestead now has three separated beds at x=24,56,88, y=88, rather than one invisible target beside the trees. Original Pokémon berry dirt marks every bed from arrival. Sprout, growing, flowering and ripe graphics retain the same ground anchors.

A compact clearing at native tile columns 1–6, rows 4–6 copies the scene's clear ground from cell 105, including active overlay layers and palette selections. Native combo flags are cleared in that footprint. This changes the actual scene composites rather than drawing soil over trees. The clearing avoids the large boulder and tree canopy, and its base solidity is checked in the browser verification. It is still an adaptation of the existing town, not a completed authored homestead map.

Each bed owns its growth stage, watering timestamp and fertilizer flag. The nearest bed is selected while idle and its number appears in the HUD. An active tool animation locks selection until completion; water particles and crops use the same selected bed coordinates. All three growth clocks advance independently. Harvests contribute to the same temporary local totals.

Testing also exposed a native-controller integration bug: turning from horizontal movement into a farming action aligned Link to the engine's 8-pixel grid, which the previous exact-position check treated as interruption. The script now accepts only the initial perpendicular-axis alignment below eight pixels while idle and undamaged. Damage, airborne state, later movement and incompatible native actions continue to interrupt work.

Verification commands:

- `node scripts/charmville/build-homestead.mjs --candidate` compiles without publishing.
- `node scripts/charmville/verify-crop-stages.mjs work/three-bed-farm` checks the original cycle, fertilizer accounting and visible initial soil.
- `node scripts/charmville/verify-three-beds.mjs` navigates using native directional controls, plants and waters each bed, waits for each to mature, and harvests all three. It waits for actual animation-completion events.

Limitations: local native progression remains temporary and separate from authenticated account inventory. There is no server-owned shared crop authority in this scene. Soil preparation and sowing still share the available dirt artwork; Link's work pose is adapted, not a newly authored complete farm animation bank. These three beds establish usable parallel farming, not the final farm layout or full agricultural system.
