# Joined-world play acceptance — 2026-09-13

Active URL: http://localhost:3024/play/?test=%2Fquests%2Fcharmville%2Fhomestead-region%2Fr01%2FHomestead.qst&dmap=4&screen=63&storage=idb&testParty=6

The existing IAB tab18 was reused throughout. Final browser log: `CHARMVILLE_PRESENTATION_READY` at09:25:33UTC, till stage1 at09:25:55, plant stage2 at09:26:18, and `CHARMVILLE_HARVEST 1 XP 10` at09:27:46. Screenshot after harvest showed Berry1, XP10, Cuttings1, three ground beds and six companions above/left of the farming area. E and D both performed interactions after Resume keyboard play. Native intro Continue/Begin exploring buttons acknowledged their corresponding pages.

Implemented this integration: full Homestead script in native512x352 region; room-local farm anchors; continuous follower trails; collision-aware initial six-creature formation avoiding crop art bounds; room-to-region guest/encounter projection; 8bit indexed berry assets with generated palettes; explicit current render target for ground and depth-sensitive sprite draws; content-versioned, digest-checked browser assets; accessible standalone introduction and retained E taps.

A comparison with a layer2 outline, layer2 RT_CURRENT dirt, and layer6 controls verified the ground draw target. Those probes were removed. Headless bitmap pixel sampling returned zeros while browser sampling saw69dirt/148sprout pixels; do not use headless startup to claim visible art correctness.

Validation:15 focused JS tests passed (sprite4/controller7/follower4). Native full-loop movement evidence in work/joined-motion/evidence.json records40seam crossings over1440frames, all6followers, monotonic trail, and camera movement. It identifies its tested source hash; later rendering edits are not a second movement test. Builder verifies joined startup and the post-palette ready marker.

Not established: all-direction tool-frame visual acceptance, physical controller/mobile hardware acceptance, all three beds independently harvested in the browser, shared account admission for this joined quest, economic persistence here, true camera zoom, combat/raid/capture acceptance in this standalone session, or production MMO scale. This local progression is temporary. The earlier account-backed quest is preserved separately.
