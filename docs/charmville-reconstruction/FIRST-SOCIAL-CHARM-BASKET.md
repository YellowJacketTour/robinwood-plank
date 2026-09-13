# First social charm basket

September 13, 2026. Required next integration; not a claim that friends can already spend the proposed items on posts.

The basket is an account inventory view of game objects, not an emoji keyboard or a new currency ledger. Prioritize recognizable item artwork. The world pickup, Satchel entry, Exchange entry and post manifestation share a stable item identity; different resolutions or animation treatments do not create another unit.

## Initial set and availability

| Identity | Purpose | Current boundary |
|---|---|---|
| Oran Berry | Harvest, companion care, gift of support | Account harvest and inventory exist. Verify and extend post stamping before enabling social use. |
| Burning Heart | First family crop; everyday love reaction | Proposed. Requires distinct crop, issuance, artwork and social spend integration. Do not rename Oran. |
| Bouquet | Crafted appreciation from grown flowers | Proposed recipe and ingredients; no current balance should be implied. |
| Prepared meal | Care from farming, fishing and cooking | Proposed; recipe consumes exact ingredients and creates defined output. |

Show only supported, owned, spendable items in the default basket. Future/discovered items belong in the Charmdex, clearly separated from custody. Legacy Stalk/Splinter balances retain their identities; they are not silently converted or used as the new visual direction.

## Effort and supply model

Use a measured production budget, not a claim of intrinsic money value. For each recipe, record active work seconds A, occupancy seconds O, bounded capacity K, expected successful output Y, ingredient quantities q, and ingredient production costs C. A balancing estimate is C_output = (A + w * O / K + sum(q * C)) / Y, with documented tuning weight w. All inputs must share the same normalized effort unit. This estimate informs pacing, not an enforced Exchange price or a reward for remaining logged in.

Keep active effort, elapsed growth time and game energy distinct in telemetry and player language. Parallel plots, automation, failed yields, offline growth and returned seeds affect actual supply. Record them explicitly. Never calculate issuance from a client's reported time. Avoid recursive recipe-cost loops; solve or reject cyclic dependencies and audit profitable conversion cycles against actual input/output quantities.

Burning Hearts should be easy to replenish through care, with bounded production capacity and a real social-use sink. Scarcity of advanced items can come from recipes, progression, habitats and effort. Measure units produced, consumed, held and traded before tuning rates. There is no promise that every item sells or that supply growth produces monotonically rising prices.

## Post interaction

### Fullscreen game interaction

The canonical interaction must work inside the Charmdex without leaving fullscreen, navigating the game frame, or restarting the renderer. Mount the feed, basket and confirmation under the fullscreen application container, not outside it. Keep the live world visible behind a compact side panel on desktop; use a readable bottom sheet on phones with safe-area spacing. HD video and the world remain mounted when switching post details.

Flow: open Social → choose a visible friend's post → open its charm basket → select an owned item → confirm “Pin 1 [item]”. Display the exact quantity and remaining balance. On acknowledgment, animate the same item onto the post and update the account balance from the receipt. Pending is not success. An uncertain response offers retry with the same request ID; do not create another spend. No default recipient, automatic tutorial posting or accidental hold-to-repeat spending.

Keep the selected post ID and revision stable while new feed events arrive. A new post must not move another post beneath the confirmation target. Preserve scroll and focus on close. Route keyboard/gamepad input exclusively to the open menu and clear previously held movement keys; closing restores game focus without synthesizing movement. The shared world continues running, so the panel must not claim that multiplayer combat is paused.

Fullscreen acceptance: keyboard, touch and controller each pin a charm without a document navigation or fullscreen exit; the game renderer survives; one receipt updates both basket and post; a live feed insertion does not change the target; cancel spends nothing. Verify video quality adaptation under load rather than promising HD on every connection. Social event transport, gameplay updates and video require independent backpressure so watching a clip cannot delay an inventory acknowledgment or movement tick.

Open basket from a post or the in-game social view; choose owned item; preview art, quantity and remaining balance; explicitly send. A successful social stamp consumes the chosen units and leaves a durable, non-spendable display on the post. A gift transfer, if later supported, must be a separately labeled operation. The recipient's reputation is a projection of accepted receipts, not newly minted inventory.

Server transaction must validate session, post visibility, blocks, moderation, supported item and available unreserved balance; debit and append stamp receipt atomically. Retries reuse the same request ID. Concurrent market reservation, companion feeding and stamping cannot spend the same unit. Rejection retains inventory. Deleting a post must have an explicit receipt/display policy and must not mint an accidental refund.

Never auto-send a reaction from tutorial completion or browser piloting. The player chooses the destination and confirms the spend.

## Observed integration gaps

The current repo includes accepted stamp/reputation adapters and a legacy integration porch that describes Stalk stamps. That is not evidence that arbitrary Oran/Burning Heart stamps work on friends' posts. The current visible 3024 tab identifies itself as temporary local adventure, not authenticated account inventory. Connect through the account application before claiming saved social transactions.

Acceptance requires two test accounts: harvest a supported item, view it in both game and profile basket, stamp an authorized friend's post, refresh both accounts, then retry and race against another spend. Exactly one intended debit and one corresponding stamp must survive. Verify hidden/blocked posts reject without loss. Public user posting is not part of automated validation without explicit authorization.
