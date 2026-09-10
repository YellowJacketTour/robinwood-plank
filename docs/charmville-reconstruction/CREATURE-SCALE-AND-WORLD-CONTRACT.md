# Creature size across the shared world

## Design decision

Source height and weight belong in the Charmdex. World presentation uses a compressed, reviewed size profile so species remain recognizable on the current small pixel map. These are separate values. A sprite sheet's transparent cell is not a creature's body, and an attack pose must not change the species scale merely because a tail, flame or stretched limb fills more of the frame.

The current implementation retains original PNGs, normalizes against opaque walking bounds, and uses the same fixed per-species ratio for the supported attack sequences. Feet remain anchored through the transform. The first six species use 16, 18 or 20 pixel walking envelopes based on their 0.3, 0.4 or 0.5 metre source dimensions. This is stylized relative sizing: the short chibi hero is not a physical metre ruler, and the result is not literal human-to-Pokémon proportion.

Source: [pinned Emerald Pokédex entries](https://github.com/pret/pokeemerald/blob/5eff78649e7170a877b961ef0b3da13b81a16038/src/data/pokemon/pokedex_entries.h). The catalogue joins names to internal species IDs and preserves raw decimetres/hectograms plus source hashes. It covers 386 ordinary species; only six currently have reviewed world-size mappings. Catalogue presence does not mean a species is playable or its animation set is implemented.

## Required fields for future content

Keep species reference dimensions, individual traits, visual body bounds, ground anchor, collision footprint and move reach distinct. A visual skin cannot enlarge an attack's authorized area. A future individual size trait needs persisted provenance and explicit gameplay rules; scaling an image cannot mint a rare individual or improve its market value.

Long, low, flying and coiled bodies need an authored orientation profile rather than treating every Pokédex height as upright head height. Shadows and ground contacts describe elevation separately. All poses share the species scale; held objects and attack effects use their own attachment anchors and bounds. Evolution can replace the profile only after a committed state transition, preserving creature identity and inventory ownership.

## World and economic implications (planned)

Small companions should remain readable among crops and furniture. Large livestock and mounts need explicitly authored traversal clearance, pens, doors and boarding rules. A narrow house entrance can offer a visible wait/recall behavior; creatures must not silently clip through it. Travel and recall may change presentation but cannot duplicate a creature or bypass its active encounter obligations.

Large raid creatures need spacious encounter geography and camera framing, not unbounded scaling in the starter garden. World and staged battle views can frame the same entity differently while sharing its HP, statuses, cooldowns and ownership. Compression is a camera/presentation choice; collision and move reach require their own server-tested shapes.

Livestock capacity, feed consumption and carrying capacity may eventually use authored species/body categories. Weight alone must not automatically determine market price, combat strength or production yield. Those systems need conserved inputs, bounded production rates and explicit progression. Rare size traits should not become unlimited economic multipliers through breeding retries, recolouring or wallet changes.

## Acceptance boundaries

For each added species, inspect its idle, walking and supported action frames in all available directions next to the hero and representative terrain. Verify the same feet, readable silhouette, no attack-size pulse, and stable display after menu changes and reconnect. Native size changes must not change HP/PP or server collision. Giant species remain unavailable until their geography and behavior are authored; do not pretend a universal clamp completes them.

Current source-bound audit and native evidence are in SIX-SPECIES-NATIVE-FOLLOWERS.md and public/charmville/catalog/follower-opaque-bounds.json. Full collision-aware creature locomotion, giant-body routing, mounts and economic size traits are future work.
