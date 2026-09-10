# Committed capture interface

Capture controls use the authenticated server availability and finite ball count. Trusted local test profiles can explicitly claim three ordinary test balls once. Throw uses an idempotent request ID; uncertain responses retain that exact command for retry. Capture is never shown as successful before a committed receipt. The receipt refreshes the owned roster and health; captured creatures can be assigned through Party organization without replacing an occupied slot.

`verify-capture-panel.mjs` passed an actual isolated account: source combat first, explicit finite supply, capture receipt, one ball debit in the recorded successful run, new owned Poochyena, exact receipt replay, terminal battle controls removed and the native iframe retained. Source RNG can produce failed attempts; the verifier checks availability before proceeding and does not force success. The successful capture panel screenshot is `work/capture-committed.png`.

A terminal transition exposed duplicate React sibling keys between Battle and Assist panels. Distinct keys now prevent orphaned combat controls after capture.

This checkpoint validates committed UI and ownership, not a complete source throw animation or all ball types. Overworld capture and native visual receipts are subsequent integration work and must be verified independently.


## Overworld receipt playback

The final actual account regression throws directly after approaching the creature, without opening staged battle. One recorded run broke free on its first attempt and succeeded on the second, consuming two of the three finite balls. Both committed receipts reached native START, OPEN and RESULT logs, and the final native acknowledgment matched the successful sequence. The captured creature was saved, exposed in Party organization, and the native iframe remained mounted. `work/capture-native-committed.png` is a post-animation screenshot. The test uses server RNG and no injected capture event.

Native delivery initially failed because the new bridge module was absent from the server route allowlist; that route was corrected and the fresh regression passed. Receipt playback currently belongs to the acting player's view; spectator capture animation is not yet replicated. The ordinary ball sequence is the only ball visual in this checkpoint.
