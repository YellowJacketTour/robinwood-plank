# Native committed defeat presentation

The current Poochyena encounter formerly remained standing at zero HP. Native presentation now detects a positive-HP to zero-HP snapshot, plays the explicit source **Faint** sequence, holds its last frame for18ticks, and removes the body. A Defeated label remains while the authoritative zero-HP encounter is projected. Initial already-defeated snapshots and repeated zero-HP snapshots do not replay the animation. Capture/off clears it; leaving the supported map cancels playback. No reward, XP or damage calculation happens in this renderer.

`build-faint-sprites.mjs` preserves PMDCollab/SpriteCollab commit `db1928346e452e1a36b8ecff62f7e4d195504763` Poochyena0261 Faint animation/shadow/offset PNGs and records their hashes. The source sequence is four32x48 frames with durations8,12,4,10, totaling34ticks. All32 ground markers across eight directions are validated; the current stationary wild uses its existing south-facing row. Fixed species scaling is retained. The original source art is unchanged.

Candidate and published native compilation pass. `verify-native-party-projection.mjs --defeat` passes an explicitly synthetic native snapshot test: baseline zero does not replay, positive-to-zero plays once and completes, duplicate zero does not restart, and off does not trigger defeat. Sampled faint/held/disappeared screenshots were inspected. This review caught and fixed a SCREEN-origin label offset; Defeated now appears above the world creature rather than in the HUD. The analogous capture-result text offset was corrected too. These sampled images do not establish every source frame's fidelity or real server reward behavior.

Playback follows committed HP snapshots rather than precisely aligning with a possibly queued final attack-contact frame. Defeat sound, particles, reward pickup animation, roaming corpse logic and other species' faint sequences are not added by this change. Actual fight/reward verification remains a separate account/backend test.


The actual account fight verifier also passed with real winning damage and native DEFEAT_START/COMPLETE, alongside the server's15XP receipt and exact replay check. Renderer code does not award that XP.
