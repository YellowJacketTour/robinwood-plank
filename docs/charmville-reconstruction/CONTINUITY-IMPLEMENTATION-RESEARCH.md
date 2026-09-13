# Continuity, presentation and gameplay media

This supplements GLOBAL-SOCIAL-WORLD-RESEARCH.md and the approved completion contract. The immediate design question is how to expand the existing native game without letting camera, network retry, encounter ownership or viewing features become competing authorities. Findings below distinguish inspected source code, published engineering accounts and first-hand problem reports. Research and a compiled helper do not establish a completed feature.

## Separate what happened from how it is seen

Godot's official scene-replication example assigns the active camera to the local player and describes difficulties with ordinary scene replacement when players join or rejoin an ongoing multiplayer session. It demonstrates dedicated replication components and controlled scene loading. These are useful architectural comparisons, not an instruction to migrate Charmville to Godot. [Godot, scene replication](https://godotengine.org/article/multiplayer-in-godot-4-0-scene-replication/).

A developer's first-hand Godot 4.2 report describes directional sprites being selected using the remote character's camera instead of the observing player's camera. The reporter subsequently confirmed resolving the problem. This is a concrete presentation failure report, not a population-wide benchmark or proof of our implementation. [Godot forum, multiplayer animation sync](https://forum.godotengine.org/t/multiplayer-animation-sync-issues/70262).

For Charmville, the resulting design rule is to transmit or commit creature identity, facing, action phase and world position. Each authorized view chooses its own facing artwork and projection. The top-down view and a future staged battle view must not fight over a single replicated sprite-frame field. Camera rotation also cannot fabricate missing directional art; unavailable angles need authored alternatives or an explicitly constrained camera.

The native source audit adds a separate constraint: the current viewport affects sprite suspension and despawning. Merely widening it can change the simulation. The new presentation geometry helper leaves that viewport unchanged. It provides reversible world/display mapping and bounded zoom geometry, but is not wired into world rendering yet. See NATIVE-PRESENTATION-GEOMETRY-EVIDENCE.md and RENDERER-CUTOVER.md.

## Preserve native timing before introducing multiple views

Blizzard's GDC session describes using ECS to manage varied hero behaviors and determinism for responsive networked simulation. The inspected session description supports those high-level claims; the complete video was not watched in this pass, so its detailed algorithms are not treated as verified evidence. [Timothy Ford, Overwatch Gameplay Architecture and Netcode, GDC 2017](https://gdcvault.com/play/1024001/-Overwatch-Gameplay-Architecture-and).

A Blizzard community post links this talk as an explanation of engineering complexity. It is a discovery lead, not a technical validation or representative player review. [Overwatch forum, Game Architecture and Netcode](https://us.forums.blizzard.com/en/overwatch/t/game-architecture-and-netcode-gdc/301462).

The corresponding local finding is specific: the lens clock changes inside native drawing, before later layers and post-draw scripts. Moving it casually to the end of the game loop would change observable ordering. The implemented presentation-effects token preserves the original phase and allows a shared presentation operation to consume that clock effect once. Other drawing mutations and visual snapshots remain unresolved; repeated draw calls are still not certified safe.

The proposed improvement is an explicit presentation snapshot derived once from a committed simulation state, then consumed by the player's camera and permitted secondary views. Its acceptance requires identical simulation outcomes under different camera schedules, not merely similar screenshots. This is an engineering hypothesis built on established separation principles, not a claim of unprecedented invention.

## Recover operations without repeating their consequences

The inspected admission service already uses a revision and transaction. A lost response previously left the caller unable to distinguish successful arrival from failed travel. The bounded fix recognizes the immediately preceding revision only for the same active destination, after checking current home permissions. The client resends the same immutable request once on selected transient failures; it does not obtain a new revision and silently create a second journey.

This is not the full GLOBAL-07 protocol. It does not reserve destination capacity, persist a return point, introduce floor identity, or perform cross-worker authority transfer. Those require a coordinated schema and runtime change. Future transfer work must preserve one operation identity through reservation, commit and acknowledgment; no source and destination may settle the same action.

The encounter audit found another time-boundary defect: a failed capture changed the encounter turn but did not renew the controller lease. The fix renews control on a newly committed failed attempt, leaves successful capture terminal, and leaves receipt replays free of mutation. An additional assist check rejects assistance when the controller has departed the encounter geometry or range. These are tested application paths, not proof of distributed tick ordering or database concurrency under load.

## Capture game sound without capturing the player

Web Audio defines a media-stream destination as a graph endpoint that can supply an audio track. The browser API allows a source to connect to that endpoint. [W3C, Web Audio API](https://www.w3.org/TR/webaudio-1.0/); [MDN, createMediaStreamDestination](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/createMediaStreamDestination).

Disconnecting a particular destination is distinct from disconnecting every output. Capture teardown must remove only its branch so local speakers continue functioning. [MDN, AudioNode.disconnect](https://developer.mozilla.org/en-US/docs/Web/API/AudioNode/disconnect).

The inspected rebuilt zplayer.js exposes the SDL game output at Module.SDL2.audio.scriptProcessorNode, connected to its audio context destination. The new capture adapter branches this game-only node into one audio track alongside the canvas video. It never requests microphone or desktop capture and never reroutes the speaker connection. An unavailable engine output leaves the monitor explicitly video-only; failed attachment fails visibly and releases the created tracks.

The same browser tab displayed the active video-and-audio-source status and live game picture after reload. That establishes attachment and preview, not audible signal quality, lip synchronization, codec behavior over a network, or a remote viewer. The preview remains muted to avoid playing the same game twice. GLOBAL-15 still needs authenticated transport and a second device; GLOBAL-16 needs transport-level admission and active revocation.

## Experiments worth promoting

| Candidate | Required comparison | Rejection condition |
|---|---|---|
| Presentation snapshots | Same recorded actions with one and multiple cameras; compare positions, clocks, health and custody | Any simulation divergence or changed script ordering |
| Bounded border prefetch | Arrival latency, memory and transferred bytes against loading at crossing | Private content disclosure or mobile cost exceeding budget |
| Encounter authority grouping | Cross-worker message count and p95 command latency at concentrated fights | Unbounded migration cost, double settlement or unfair command ordering |
| Separate media subscriptions | Sender frame time and upload while viewer count grows | Viewer count increases game simulation work or leaks restricted content |
| AI-assisted regression discovery | Seeded real defects, detection rates and reviewer effort against baseline | Unmeasured confidence claims or automated privileged release |

These experiments complement the larger research dossier. Product reviews and social posts can reveal frustration, discoverability and social expectations; they cannot establish protocol safety or capacity. Search leads for Destiny's mission architecture and GDC videos were located, but the large Destiny slide PDF could not be opened in this pass. No claims about its internal algorithm are inferred from that failed fetch. Wider genre, art and gameplay research remains tracked in the existing dossier rather than being described as exhausted.
