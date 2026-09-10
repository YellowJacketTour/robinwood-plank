# Committed capture interface

Capture controls use the authenticated server availability and finite ball count. Trusted local test profiles can explicitly claim three ordinary test balls once. Throw uses an idempotent request ID; uncertain responses retain that exact command for retry. Capture is never shown as successful before a committed receipt. The receipt refreshes the owned roster and health; captured creatures can be assigned through Party organization without replacing an occupied slot.

`verify-capture-panel.mjs` passed an actual isolated account: source combat first, explicit finite supply, capture receipt, one ball debit in the recorded successful run, new owned Poochyena, exact receipt replay, terminal battle controls removed and the native iframe retained. Source RNG can produce failed attempts; the verifier checks availability before proceeding and does not force success. The successful capture panel screenshot is `work/capture-committed.png`.

A terminal transition exposed duplicate React sibling keys between Battle and Assist panels. Distinct keys now prevent orphaned combat controls after capture.

This checkpoint validates committed UI and ownership, not a complete source throw animation or all ball types. Overworld capture and native visual receipts are subsequent integration work and must be verified independently.


## Overworld receipt playback

The final actual account regression throws directly after approaching the creature, without opening staged battle. One recorded run broke free on its first attempt and succeeded on the second, consuming two of the three finite balls. Both committed receipts reached native START, OPEN and RESULT logs, and the final native acknowledgment matched the successful sequence. The captured creature was saved, exposed in Party organization, and the native iframe remained mounted. `work/capture-native-committed.png` is a post-animation screenshot. The test uses server RNG and no injected capture event.

Native delivery initially failed because the new bridge module was absent from the server route allowlist; that route was corrected and the fresh regression passed. The initial receipt-only checkpoint has now been extended to authorized nearby spectator playback as described below. The ordinary ball sequence is the only ball visual in this checkpoint.


## Authorized spectator playback

Encounter snapshots now expose a bounded, server-filtered capture event stream to authorized nearby players. The parent view establishes a sequence baseline on first snapshot, encounter change and range reentry, so old captures do not play when joining. Direct initiating receipts and snapshot events share UUID deduplication. Events received before the native frame is ready are not replayed later; current world state remains the source of truth. These are cosmetic messages and grant no capture or inventory authority.

`verify-spectator-capture.mjs` passed with two actual local accounts in an invited private home: a committed throw played in the spectator native view, native completion acknowledged the same success/failure result, exact receipt replay produced no second start, and the spectator had no capture availability. Reloading the spectator view baselined the prior capture: native sequence remained zero and no historical start logged. Three stream tests cover ordering, validation, deduplication and leaving/reentering range. `work/spectator-capture.png` was inspected as post-animation state.
