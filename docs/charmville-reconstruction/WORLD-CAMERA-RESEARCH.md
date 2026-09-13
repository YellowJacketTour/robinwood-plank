# One world, multiple views

The required result is one spatially continuous, persistent world viewed through a gameplay camera, a minimap, a world map and permitted spectator cameras. They must refer to the same places and entity identities. A larger canvas does not create that world. A minimap is a useful projection of it, but is not evidence that offscreen combat or multiplayer simulation exists.

## Evidence and implementation decision

[Phaser's camera documentation](https://docs.phaser.io/phaser/concepts/cameras) distinguishes the screen viewport from the world rectangle seen through it. Multiple cameras can show the same scene, while inverse transforms map pointer input back to world positions. Charmville needs that separation without replacing its authored combat behavior.

[Godot's coordinate-system documentation](https://docs.godotengine.org/en/stable/engine_details/architecture/2d_coordinate_systems.html) describes the canvas transform used by Camera2D separately from object/world coordinates. This supports a presentation transform over stable simulation coordinates rather than modifying player positions to imitate camera movement.

[Phaser's tilemap layer documentation](https://docs.phaser.io/api-documentation/class/tilemaps-tilemaplayer) describes camera culling of visible tiles. Charmville should select terrain intersecting the presentation rectangle, with a small drawing margin, rather than rendering an entire universe each frame. This is a rendering choice, not permission to stop persistent simulation outside the player's view.

The local engine already joins source screens into regions. `calculate_viewport` still assigns 256 by 176 logical pixels (232 in extended mode). Sprite drawing subtracts this same viewport, while gameplay also consults it. `weapons.cpp` uses viewport bounds for projectile lifetime and wind behavior; `guys.cpp` uses them during enemy spawning. `weapon::draw` can advance graphics under the old-animation quest rule. Repeatedly drawing offset copies is therefore not a valid way to assemble a larger frame.

The implementation path is a separate drawing rectangle, one bounded enlarged world composition pass, then a fixed-size interface pass. The simulation viewport remains unchanged until server simulation replaces its activation responsibilities explicitly. No global viewport swapping across scripts, no repeated world updates, and no camera-dependent loot or creature life cycle.

## Continuity across scale

| View or boundary | Shared identity | Presentation or authority rule |
| --- | --- | --- |
| Gameplay and minimap | Same region, entity IDs and world positions | Different transforms; no separate movement model |
| Whole-world map | Stable place IDs and authored connections | Summarized terrain and events; does not fabricate visible actors |
| House floor or basement | Place ID plus explicit entry and return anchors | Interior transition preserves party, inventory and progression |
| Friend's homestead | Owner's persistent place ID | Access checked before transfer; visitor actions obey permissions |
| Public event | One occurrence ID and phase in its location | Every participant sees the same outcome and reward eligibility |
| Server handoff | Persistent entity identity and transfer sequence | Exactly one simulation owner; client rejects stale pre-transfer state |
| Spectator view | Authorized player's stream or world subscription | Privacy enforced before transmission, not merely hidden in UI |

For zoomed-out crowds, first retain positions and movement silhouettes; reduce distant animation and cosmetic detail before losing direction or event cues. Nearby combat keeps readable telegraphs and authoritative outcomes. Capacity must be measured with realistic players, companions and effects, not inferred from an empty-map frame rate.

## Completion evidence

The decisive visual proof is a fixed-size game surface showing additional neighboring terrain and actors as camera zoom decreases, with HUD and dialogue unchanged in size. A repeatable input sequence must retain the same simulation results across zoom schedules. Region crossings, overhead layers, shadows, thrown objects, companions and pointer targeting must remain aligned. The current work has not passed this complete gate.

This document connects the renderer cutover to the existing public-event and global-world requirements. It does not claim a new engine, deployed MMO capacity, or completed camera implementation.
