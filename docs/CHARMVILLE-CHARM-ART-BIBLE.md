# Charmville charm and garden art brief

2026-09-08. Production brief; assets below are not represented as finished.

Each crop yields its own expressive charm. Plank is the host and mascot, not a
generic resource portrait. The existing repeated Plank head with a tiny crop
badge fails this distinction and must be replaced. Crafting may later evolve
charms; it does not change the guaranteed one-seed return or basic Stalk loop.

| Inventory id | Readable silhouette | Expression and material | Motion direction |
| --- | --- | --- | --- |
| stalk | Golden cereal ear with two leaves | Welcoming, soft grain lobes | Gentle nod; short harvest bounce |
| splinter | Short irregular wood chip | Cheeky, visible end grain | Small spring and settle |
| knock | Stubby wooden mallet | Determined, rounded handle | One cushioned knock |
| hum | Small rounded radio | Content, speaker cheeks | Restrained beat pulse |
| pith | Round orange/heartwood center | Warm, juicy cut surface | Soft squash and recover |
| gleam | Curled golden shaving with sparkle | Delighted, warm highlights | Brief glint, then still |
| knot | Round knothole and concentric grain | Curious, asymmetric eyes | Blink and tiny tilt |

These are art directions, not new recipes, durations or economy rules. Only
implemented crops appear as plantable choices. Do not substitute arbitrary token
portraits from the Unicorn registry for this authored catalog.

## Production and readability

Create source models and reusable materials, then render transparent sprites from
one fixed orthographic camera. Keep terrain at a 2:1 diamond footprint, stable
ground anchors, consistent light direction and contact shadows. Preserve source
files, render settings and attribution beside the export pipeline. Use actual
source asset geometry where appropriate; record the source and modifications.

Crop growth and harvested charm are separate silhouettes. Show seedling, growing,
ripe and compost states clearly. Never communicate readiness through color alone.
Inventory portraits must remain distinguishable at 32px without a text label;
validate seed packets, stack counts and selection at actual mobile scale.

Animation should reward an action: anticipation, action, visible result, settle.
Keep idle motion quiet. Reduced motion gets an immediate state change and readable
receipt. A pending animation never implies the server accepted a harvest or stamp.

## Garden composition

Study the compact arrangement in
[Iso Middle Earth](https://github.com/hasanharman/isomiddleearth): an entrance,
small building, orchard, carts and beds form a recognizable place. Study
[IsoCity](https://github.com/amilich/isometric-city) for coherent tile boundaries,
layering and infrastructure. These are references, not claims of equivalent
performance or finished Charmville features.

Build one compact scene with a purposeful entrance, a short connected path,
the six permanent beds, a sheltered sitting/work corner and two tree clusters.
Keep silhouettes clear around interactive beds. Avoid evenly scattered props,
an oversized empty grass sheet or a road that leads nowhere. Decorative buildings
must not imply unavailable gameplay. The board remains the home; opening the lot
enlarges the same garden and keeps WoodAmp alive.

Use a coherent source family. Evaluate
[Quaternius crops](https://quaternius.com/packs/ultimatecrops.html), buildings and
animals together before mixing them with existing Kenney scenery. The published
crop pack provides growth stages; wind animation still needs authored work.

## Acceptance captures

Capture desktop and 390px mobile: first visit, ripe bed selected, harvest receipt,
replant, open satchel, stamp selection, visitor view and wallet reattachment.
Review motion as well as stills. Require distinct charm silhouettes, readable
counts, stable scroll, reachable controls and preserved music. Record measured
frame timing with device conditions; desktop CPU throttling is not a physical
phone performance result.

See [research and evidence](CHARMVILLE-FARMVILLE-MEMOJI-RESEARCH-2026-09-08.md)
and [reputation contract](PLANKSPACE-MEMOJI-REPUTATION.md). Reputation exposes
current/lifetime face totals and current/lifetime unique supporters explicitly.
