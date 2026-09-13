# Native movement continuity

The client previously discarded observations while a request was outstanding. The next sample could then be more than one cell from the saved actor, causing a correction. Separately, periodic presence renewal advances the admission revision; the peer poll did not pass that revision to the movement client. An otherwise valid step could therefore be rejected and visibly corrected.

The adapter now retains up to 64 actual observations and serializes neighboring-cell requests with 100ms cardinal / 142ms diagonal pacing. It does not invent a route across missed cells. A correction clears queued pre-correction samples, and a changed native session invalidates old request results.

The actor poll updates admission metadata only for the same profile, region, epoch and geometry. It never overwrites the newer local committed cell or sequence. If a request races renewal, a read must prove that the intended step did not commit (identical previous cell and sequence, same context, newer admission) before one retry. Ambiguous committed moves, collisions, unsupported gaps and other rejections still recover from authoritative state.

Ten focused tests cover delayed adjacent observations, revision updates during a request, renewal retry, old-session completion, correction acknowledgments and uncertain commits. The browser verifier explicitly focuses and scrolls the native canvas; the previous sequence-zero result was not valid movement evidence because keyboard focus was outside the game.

This is synchronization repair for the current authored map. It does not establish collision parity for all native terrain, moving platforms, unsupported movement abilities or a seamless multi-map world.

Browser verification: 199 committed steps through left/right walking and a real automatic admission renewal; one409 recovered, and correction IDs remained0(unapplied) and1(initial spawn). No later corrective teleport occurred. Pacing now starts at response completion so variable latency cannot compress arrivals. This is a bounded local corridor check, not every terrain or device.
