# Repeatable habitat encounter UI

Terminal encounters show the server’s next-spawn deadline and current habitat budget. Remaining time is calculated from serverNow and nextSpawnAt, so a skewed client clock does not invent readiness. The existing encounter poll updates the countdown and receives a fresh encounter UUID when the server permits it; the page and native iframe remain mounted. Current controller capture receipts remain visible through their terminal checkpoint, until a genuinely new encounter replaces that context.

`verify-repeatable-encounter.mjs` passed an actual local account fight and the real 60-second cooldown without SQL edits, fake clocks or page reload. It verified fresh UUID, full new HP, incremented spawn count, unchanged experience after old battle receipt replay/rejection, and access to the new battle. `work/habitat-countdown.png` was inspected. The UI renders the actual server budget rather than hardcoding a spawn limit.

The native source-scene reset and broader habitat generation are separate concerns; this UI does not claim arbitrary species, unlimited spawn accumulation or a global procedural world.
