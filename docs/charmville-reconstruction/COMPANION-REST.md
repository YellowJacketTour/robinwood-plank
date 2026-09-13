# Server-timed companion rest

An owned companion can restore HP and supported move PP through `/api/charmville/companions/rest`. Rest requires the player's home and current actor, no active battle and depleted HP or PP. The server sets a 10-second ready time and a 60-second expiry. Movement or entering battle interrupts eligibility; client countdowns do not complete the action. There is no inventory charge or stat reroll.

The Party detail panel shows eligibility, a server-aligned countdown and explicit Finish/Cancel controls. Ambiguous responses retain their exact phase/request ID for retry. Successful completion triggers a read-only health refresh. Fully rested creatures have a disabled action with an explanation.

`verify-rest-panel.mjs` passed against the real service: a source-backed battle depletes HP/PP, the encounter is released, home rest completes after the server timer, HP is full, source PP is restored, and HP IV/maxHP remain unchanged. The test re-enters inspection before querying battle PP and waits for the committed mode transition. No user injury was fabricated. Focused lint and TypeScript passed; `work/rest-mobile.png` records the bounded UI.

PostgreSQL checks separately cover duplicate finish without a second heal, movement interruption, battle interruption and stable stats. This is home recovery for supported companions, not a complete clinic world/interior, revival economy, status-removal catalogue or full party storage system.
