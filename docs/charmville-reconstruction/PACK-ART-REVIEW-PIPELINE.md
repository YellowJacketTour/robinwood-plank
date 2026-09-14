# Validated pack → offline artwork review

Run `node scripts/charmville/pack-review.mjs manifest.json asset-root new-output-directory`.

This uses the existing version-1 pack schema and `verifyPackFiles`: all four directions, exact PNG bytes and dimensions, frame regions, origins, grips, collisions, contact/recovery timing and provenance are validated before review output. Paths remain confined to the supplied pack root. No source files are rewritten and existing review files are not overwritten.

Outputs:

- `review.html`: standalone offline four-direction playback with exact millisecond scrubber, frame stepping, integer pixel scale, origin crosshair, grip and collision overlays. Flips occur around the declared origin. All PNGs are embedded; no remote images or libraries load.
- `contact-sheet.svg`: all frames arranged by action and direction, with the same origin, grip and collision marks. This is an inspection sheet, not a new item sprite or game atlas.
- `review.json`: manifest hash, source hashes, timing, provenance and explicit `visualAcceptance:false` / `gameplayAuthority:false`.

Inspect native-sized art as well as the contact sheet. A reviewer must judge silhouette, directional continuity, contact with the tool, feet, occlusion and intended effect. Validation alone cannot certify those qualities. Crop and combat authority remains on the server; playing or exporting a clip cannot grant a charm.

GIF/MP4 export is not implemented in this slice (no ffmpeg executable was available on the task PATH). The interactive review provides true source timing without inventing video output. Later exporters must consume this same manifest and respect frame duration, background/alpha requirements and source rights. The original SVG master for Burning Heart expresses Christian love, growth and generosity grounded in the gospels; that design intent is distinct from completed in-game dialogue and narrative acceptance.
