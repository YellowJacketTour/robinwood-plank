# Artwork continuity — September 14

## Visible edge fix

The Emerald item masters used by the menu are 24×24. Enlarging them to 32×32 with nearest-neighbour sampling gives uneven one/two-pixel stair steps. Menu PNGs now remain 24×24; item previews use 72×72. Original 32-grid Heart previews use 96×96 on desktop and 64×64 on narrow screens. The detached CSS drop shadow was removed from item previews. Original reference files and their credits remain unchanged: the loose coins in Coin Case and the Berry Pouch strap belong to those source silhouettes, not corrupt pixels.

Burning Heart is original SVG artwork. It now has one connected heart/flame silhouette and a two-pixel transparent border, with no floating green fragments. The same URL serves Bag and Social, preserving item identity and custody. Its symbolism follows the creator's Christian foundation: love, generosity, living growth, warmth, and conviction in Christ's teachings. This art pass does not claim a completed story or impose a belief check on players.

## A master, not unrelated versions

Each item needs a canonical identity, provenance, native grid, pivot, collision footprint, layer role and motion clips. Inventory icon, world pickup, held prop, planting sprite and social sticker are views of that identity. They must not each invent a different item. Crop rendering currently uses a separate native atlas; its alignment with this Heart still requires visual acceptance.

Keep the editable SVG/pixel master and palette. Sprite clips require named semantic phases (anticipation, action/contact, recovery), duration, direction, anchor and event frame. A GIF or MP4 is a presentation export, never the authority for combat, harvest timing or inventory changes. Animated SVG must have a static reduced-motion equivalent and must contain no scripts, external references or executable markup. Preserve animation timing in a manifest instead of inferring it from video frames.

## Acceptance before publishing an asset

- Inspect alpha bounds and silhouette at native size, integer enlarged size, and actual menu size on both light and dark surfaces.
- Keep the feet/hand/tool anchor stable across every direction and animation frame; test occlusion against walls, trees, crops and other actors.
- Do not bake selection glow, status, rarity or UI shadows into source artwork. Those are semantic presentation layers.
- Source newer game art only when its provenance and permitted distribution are recorded. A public repository is not proof of a reusable asset licence.
- Produce SVG/PNG sprite sheets from the master first. Animated GIF/MP4 exports need frame-for-frame inspection, alpha/background policy and duration checks before they are offered as finished stickers.
- Verify no crop, harvest, capture, transfer or pin is triggered merely by playing an animation.

This pass fixes menu sampling and Heart silhouette. It does not provide complete sprite clips, animated stickers, GIF/MP4 export tools, native crop replacement or all-frame game acceptance.
