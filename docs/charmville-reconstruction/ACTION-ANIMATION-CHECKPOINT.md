# Action animation checkpoint — 2026-09-09

Playable local entry: http://localhost:3021/charmville/tutorial/

The native homestead now uses a 48-frame interaction sequence, with crop mutation at frame 28. Hero source poses use GetOriginalTile plus the equipment TileMod. Scene changes clear pose overrides. Movement and weapon input are suppressed during the interaction. The browser runtime aborts on GetOriginalFlip; do not reintroduce that call without an engine regression test.

Verified single-player sequence: till, plant, water, grow, harvest (1 crop, 10 prototype XP), toggle aura; no browser exceptions. These are session-only counters, not durable inventory.

Five original Universal LPC PNG sheets are staged with source paths and SHA-256 hashes by stage-action-sprites.mjs. Their browser filesystem loading succeeds (hoe width 832), but visual captures do NOT establish correct tool/hair rendering. Imported layers and the desired Super Saiyan transformation remain unfinished. Do not describe this as completed source-faithful animation.

Next: correct bitmap palette/rendering with a visible atlas diagnostic; align native hands and tools in all directions; replicate action phase and props to peers; add interruption/cancel checks. Then connect authenticated PlankSpace identities and authoritative persisted actions before a public friend playtest. Existing playtest-auth.ts provides PostgreSQL sessions; the guest WebSocket prototype is not that integration.

Broader requirements remain in the reconstruction handoff: coherent combat and tools, gathering and crafting, creature combat/capture with continuous status, private properties connected to shared regions, charms/social reactions and exchange economy. A native reference quest and guest poses do not constitute the complete MMO.
