# Scale and camera contract

Camera changes are presentation operations. They must not alter simulation interest, creature suspension, spawning, rewards, capture ownership, physics or persistent entity identity. Native source currently couples some of these to viewport bounds; decouple before expanding visual coverage.

Persist every owned creature independently of whether it is deployed. A six-member active party is not a limit on stored roster size. Load roster pages on demand; only deployed, nearby creatures require animation and movement replication. Cosmetic distance/detail limits must never remove authoritative combat effects.

World coordinates are stable within an admitted place. Homesteads, public zones and dungeon instances have separate ownership/access scopes. Partition simulation spatially with one authoritative owner per entity; handoffs transfer ownership once with an epoch, preventing double actions or drops. Parties, competing parties, PvP and PvE share this rule.

Clients receive bounded nearby subscriptions, revisioned snapshots and sequenced deltas. A zoomed-out overview may use aggregate markers instead of individual animated sprites, but should say when details are aggregated. Rendering camera movement cannot expand a client's permissions. Avoid all-to-all replication and browser mesh consensus for authoritative inventory/capture decisions.

Large-population claims require measured tests: active entities versus stored roster size, hot-zone density, subscriptions per client, server tick p95/p99, bytes/client/sec, correction rate, frame time on low-end mobile, reconnection and cross-partition handoff loss/duplication. No unlimited population or capacity has been proven.

Toolchain checkpoint: installed local Emscripten6.0.6 matching source configure script, CMake4.4.3 and Ninja1.13.2 in sibling references/tooling. emcc sanity/version succeeds. Baseline CMake configuration is being brought up in zquest-classic/build_charmville_web; this is not a playable rebuilt runtime or zoom patch. Existing browser runtime remains unchanged.
